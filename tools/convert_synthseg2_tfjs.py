#!/usr/bin/env python3
"""Converte os modelos do SynthSeg 2.0 (Keras h5, repo BBillot/SynthSeg, Apache 2.0)
para TensorFlow.js LayersModel com quantização float16.

Padrão "traga seus pesos": os .h5 NÃO são redistribuídos com o SegmentaRM. Clone
https://github.com/BBillot/SynthSeg, baixe os pesos como o README oficial manda e
rode este conversor localmente sobre `models/synthseg_2.0.h5`,
`models/synthseg_robust_2.0.h5`, `models/synthseg_parc_2.0.h5` e
`models/synthseg_qc_2.0.h5`.

As arquiteturas são reconstruídas em tf.keras exatamente como em
SynthSeg/predict_synthseg.py (`build_model`, linhas 486-690) sobre
ext/neuron/models.py (`unet` = `conv_enc` + `conv_dec`, e `conv_enc` sozinho para o
QC). Os pesos entram por nome (`load_weights(..., by_name=True)`), então CADA nome
de camada aqui tem de bater caractere a caractere com o do repositório oficial:
  {prefix}_conv_downarm_{level}_{conv}   {prefix}_bn_down_{level}
  {prefix}_maxpool_{level}               {prefix}_up_{nb_levels+level}
  {prefix}_merge_{nb_levels+level}       {prefix}_conv_uparm_{nb_levels+level}_{conv}
  {prefix}_bn_up_{level}                 {prefix}_likelihood
e, só quando use_residuals=True (rede de QC):
  {prefix}_expand_down_merge_{level}     {prefix}_res_down_merge_{level}
  {prefix}_res_down_merge_act_{level}

Duas armadilhas do código oficial que este conversor respeita:

1. O argumento `input_shape` passado a `unet`/`conv_enc` NÃO define o número de
   canais quando existe `input_model`: nesse caso `conv_enc` usa o tensor de saída
   do modelo anterior e só aproveita `input_shape` para calcular `ndims`. Os canais
   reais de entrada saem da transição argmax→one_hot→concat feita em `build_model`
   (ver constantes IN_CH abaixo) — é isso que fixa o kernel da primeira conv.

2. `nb_labels` é o número de rótulos ÚNICOS, não o tamanho do .npy. Em `predict()`
   tanto o ramo `np.unique(...)` (linha 91) quanto `get_flip_indices` (predict.py
   linha 573) devolvem `labels_segmentation` já passado por `np.unique`. Por isso
   `synthseg_segmentation_labels_2.0.npy` tem 55 entradas mas a rede tem 33 saídas
   — exatamente como o synthseg_1.0.h5 tem `unet_likelihood` com 32 canais para um
   .npy de 54 entradas.

Modos (`--which`):
  robust  synthseg_robust_2.0.h5 — contém as TRÊS sub-redes casadas por nome. Como
          as transições entre elas são argmax → one_hot (e concat com a imagem), que
          não sobrevivem à serialização do tfjs, a saída é dividida em três pastas:
          {out}/s1 (unet), {out}/denoiser (l2l) e {out}/s2 (unet2). O worker JS faz
          argmax + one-hot + concatenação entre elas.
  seg     synthseg_2.0.h5   — a unet única do modo não-robusto.
  parc    synthseg_parc_2.0.h5 — parcelação cortical, 3 canais de entrada.
  qc      synthseg_qc_2.0.h5   — regressor de QC (conv_enc residual).

Uso:
  python3 tools/convert_synthseg2_tfjs.py --which seg \\
      --h5 SynthSeg/models/synthseg_2.0.h5 --out models/synthseg2 [--f32]
  python3 tools/convert_synthseg2_tfjs.py --which robust \\
      --h5 SynthSeg/models/synthseg_robust_2.0.h5 --out models/synthseg2_robust

Autoteste (não precisa dos pesos do 2.0):
  python3 tools/convert_synthseg2_tfjs.py --selftest-build
  python3 tools/convert_synthseg2_tfjs.py \\
      --selftest-unet-naming SynthSeg/models/synthseg_1.0.h5
"""
import argparse
import json
import os

import numpy as np
import tensorflow as tf
from tensorflow.keras import layers as KL, Model

# ---- contagens de rótulos (todas com np.unique, ver armadilha 2 do docstring) ----
# len(np.unique(synthseg_denoiser_labels_2.0.npy))      -> n_groups do denoiser
N_GROUPS = 5
# len(np.unique(synthseg_segmentation_labels_2.0.npy))  -> n_labels_seg
N_LABELS_SEG = 33
# len(np.unique(synthseg_parcellation_labels.npy))      -> n_labels_parcellation
N_LABELS_PARC = 69
# len(np.unique(synthseg_qc_labels_2.0.npy[unique_idx])) -> n_labels_qc
N_LABELS_QC = 9

# ---- canais de entrada REAIS de cada sub-rede (ver armadilha 1 do docstring) ----
# s1: a imagem normalizada
IN_CH_S1 = 1
# l2l: one_hot(argmax(s1), depth=n_groups)
IN_CH_L2L = N_GROUPS
# unet2: concat([imagem, one_hot(argmax(l2l), depth=n_groups)]); o corte x[..., 1:]
# de build_model só vale para n_groups <= 2, e aqui n_groups = 5
IN_CH_S2 = 1 + N_GROUPS
# unet_parc: concat([imagem, one_hot(máscara de córtex, depth=2)])
IN_CH_PARC = 1 + 2
# qc: one_hot(rótulos de QC, depth=n_labels_qc)
IN_CH_QC = N_LABELS_QC


def _down_arm(x, prefix, nb_levels, nb_conv_per_level, conv_size, nb_features,
              feat_mult, activation, use_residuals):
    """Ramo descendente — ext/neuron/models.py: conv_enc, com batch_norm=-1.

    Devolve (tensor, skips), onde cada skip é a saída da ÚLTIMA conv do nível.
    É esse tensor, ANTES do BatchNorm (e antes do merge residual), que o conv_dec
    recupera com get_layer('{prefix}_conv_downarm_{lvl}_{nb_conv_per_level-1}').
    """
    skips = []
    for level in range(nb_levels):
        lvl_first = x
        feats = int(np.round(nb_features * feat_mult ** level))
        for conv in range(nb_conv_per_level):
            # com use_residuals a última conv do nível sai SEM ativação: a ativação
            # vem depois do add residual (conv_enc, linhas 315-318)
            act = None if (use_residuals and conv == nb_conv_per_level - 1) else activation
            x = KL.Conv3D(feats, conv_size, padding='same', activation=act,
                          name=f'{prefix}_conv_downarm_{level}_{conv}')(x)
        skips.append(x)
        if use_residuals:
            convarm = x
            add_layer = lvl_first
            ch_in = int(lvl_first.shape[-1])
            # conv de expansão só existe quando os canais não batem (conv_enc l.334)
            if ch_in > 1 and feats > 1 and ch_in != feats:
                add_layer = KL.Conv3D(feats, conv_size, padding='same', activation=activation,
                                      name=f'{prefix}_expand_down_merge_{level}')(lvl_first)
            x = KL.add([add_layer, convarm], name=f'{prefix}_res_down_merge_{level}')
            x = KL.Activation(activation, name=f'{prefix}_res_down_merge_act_{level}')(x)
        x = KL.BatchNormalization(axis=-1, name=f'{prefix}_bn_down_{level}')(x)
        if level < nb_levels - 1:
            x = KL.MaxPooling3D(pool_size=2, padding='same', name=f'{prefix}_maxpool_{level}')(x)
    return x, skips


def _up_arm(x, skips, prefix, nb_levels, nb_conv_per_level, conv_size, nb_features,
            feat_mult, activation, skip_n_concatenations):
    """Ramo ascendente — ext/neuron/models.py: conv_dec (use_residuals sempre False
    nas unets do SynthSeg). Com skip_n_concatenations=n, os n níveis do TOPO ficam
    sem concatenação: o merge só acontece quando level < nb_levels - n - 1 (l.430).
    """
    for level in range(nb_levels - 1):
        feats = int(np.round(nb_features * feat_mult ** (nb_levels - 2 - level)))
        x = KL.UpSampling3D(size=2, name=f'{prefix}_up_{nb_levels + level}')(x)
        if level < (nb_levels - skip_n_concatenations - 1):
            x = KL.concatenate([skips[nb_levels - 2 - level], x], axis=-1,
                               name=f'{prefix}_merge_{nb_levels + level}')
        for conv in range(nb_conv_per_level):
            x = KL.Conv3D(feats, conv_size, padding='same', activation=activation,
                          name=f'{prefix}_conv_uparm_{nb_levels + level}_{conv}')(x)
        x = KL.BatchNormalization(axis=-1, name=f'{prefix}_bn_up_{level}')(x)
    return x


def build_unet(prefix, n_labels, in_channels=1, conv_size=3, nb_features=24,
               nb_levels=5, nb_conv_per_level=2, feat_mult=2, activation='elu',
               skip_n_concatenations=0):
    """A `unet` do neurite: conv_enc + conv_dec + likelihood 1³ + softmax."""
    inp = KL.Input(shape=(None, None, None, in_channels), name=f'{prefix}_input')
    x, skips = _down_arm(inp, prefix, nb_levels, nb_conv_per_level, conv_size,
                         nb_features, feat_mult, activation, use_residuals=False)
    x = _up_arm(x, skips, prefix, nb_levels, nb_conv_per_level, conv_size,
                nb_features, feat_mult, activation, skip_n_concatenations)
    x = KL.Conv3D(n_labels, 1, activation=None, name=f'{prefix}_likelihood')(x)
    # o oficial usa KL.Lambda(keras.activations.softmax, axis=-1); em channels_last
    # a Activation('softmax') é idêntica e, ao contrário do Lambda, serializa p/ tfjs
    out = KL.Activation('softmax', name=f'{prefix}_prediction')(x)
    return Model(inputs=inp, outputs=out, name=prefix)


def build_qc(n_labels_qc=N_LABELS_QC):
    """Regressor de QC: conv_enc residual de 4 níveis + maxpool + duas convs 5³.

    O `tf.reduce_mean(x, axis=[1, 2, 3])` final ('qc_final_pred', predict_synthseg.py
    linha 674) NÃO entra na topologia exportada — é um Lambda sem pesos que o tfjs não
    desserializa. O worker JS faz a média espacial dos 9 canais da saída desta rede,
    que é exatamente a mesma conta. Lembre também que o pipeline oficial alimenta o QC
    com a segmentação recortada/preenchida a 224³ (input_shape_qc=224).
    """
    inp = KL.Input(shape=(None, None, None, n_labels_qc), name='qc_input')
    x, _ = _down_arm(inp, 'qc', nb_levels=4, nb_conv_per_level=2, conv_size=5,
                     nb_features=24, feat_mult=2, activation='relu', use_residuals=True)
    # continua a numeração dos maxpools do conv_enc (que para no qc_maxpool_2)
    x = KL.MaxPooling3D(pool_size=2, padding='same', name='qc_maxpool_3')(x)
    x = KL.Conv3D(n_labels_qc, 5, padding='same', activation='relu', name='qc_final_conv_0')(x)
    out = KL.Conv3D(n_labels_qc, 5, padding='same', activation='relu', name='qc_final_conv_1')(x)
    return Model(inputs=inp, outputs=out, name='qc')


# ---- as quatro configurações de build_model, cada uma como (subpasta, construtor) ----

def nets_for(which):
    """Devolve [(subpasta_relativa, modelo), ...] para o modo pedido."""
    if which == 'robust':
        return [
            # S1: primeira segmentação, agrupada em n_groups classes
            ('s1', build_unet('unet', N_GROUPS, IN_CH_S1, conv_size=3, nb_features=24)),
            # D: denoiser label-to-label — conv 5³, 16 feats, sem os 2 skips do topo
            ('denoiser', build_unet('l2l', N_GROUPS, IN_CH_L2L, conv_size=5,
                                    nb_features=16, skip_n_concatenations=2)),
            # S2: segmentação final, guiada pela imagem + rótulos denoised
            ('s2', build_unet('unet2', N_LABELS_SEG, IN_CH_S2, conv_size=3, nb_features=24)),
        ]
    if which == 'seg':
        return [('', build_unet('unet', N_LABELS_SEG, IN_CH_S1, conv_size=3, nb_features=24))]
    if which == 'parc':
        return [('', build_unet('unet_parc', N_LABELS_PARC, IN_CH_PARC, conv_size=3,
                                nb_features=24))]
    if which == 'qc':
        return [('', build_qc())]
    raise SystemExit(f'modo desconhecido: {which}')


def clean_config(cfg):
    """Remove chaves do Keras 2.15 que o tfjs não conhece."""
    drop = {'groups', 'synchronized', 'registered_name', 'module', 'build_config'}
    if isinstance(cfg, dict):
        return {k: clean_config(v) for k, v in cfg.items() if k not in drop}
    if isinstance(cfg, list):
        return [clean_config(v) for v in cfg]
    return cfg


def h5_weighted_layers(path):
    """Nomes dos grupos do h5 que realmente carregam pesos."""
    import h5py
    with h5py.File(path, 'r') as f:
        if 'layer_names' in f.attrs:
            return {n for n in f.attrs['layer_names'].astype(str) if len(f[n]) > 0}
        return {k for k in f.keys() if len(f[k]) > 0}


def check_coverage(h5_path, nets):
    """Confere que h5 e modelos construídos casam nos DOIS sentidos.

    load_weights(by_name=True) é silencioso: pesos do h5 sem camada ficam de fora e
    camadas sem pesos no h5 permanecem com inicialização aleatória. Ambos os casos
    são erro — no modo robust os três modelos dividem o mesmo h5, daí a união.
    """
    h5_layers = h5_weighted_layers(h5_path)
    model_layers = set()
    for net in nets:
        model_layers |= {l.name for l in net.layers if l.weights}
    missing = {n for n in h5_layers if n not in model_layers}
    if missing:
        raise SystemExit(f'pesos do h5 sem camada correspondente: {sorted(missing)}')
    extra = {n for n in model_layers if n not in h5_layers}
    if extra:
        raise SystemExit(f'camadas construídas sem pesos no h5: {sorted(extra)}')
    print(f'todas as {len(model_layers)} camadas com pesos casaram com o h5')


def export_tfjs(net, out_dir, f32, shard_mb, seed):
    """model.json + shards + fixture de paridade, no mesmo formato dos outros conversores."""
    os.makedirs(out_dir, exist_ok=True)

    # fixture de paridade: entrada aleatória fixa 32³ e saída esperada
    in_ch = int(net.inputs[0].shape[-1])
    rng = np.random.default_rng(seed)
    x = rng.random((1, 32, 32, 32, in_ch), dtype=np.float32)
    y = net.predict(x, verbose=0)
    print(f'  saída de teste: {y.shape} faixa [{float(y.min()):.4f}, {float(y.max()):.4f}]')
    np.save(os.path.join(out_dir, 'parity_input.npy'), x)
    np.save(os.path.join(out_dir, 'parity_output.npy'), y.astype(np.float32))

    topo = json.loads(net.to_json())
    topo['class_name'] = 'Model'  # tfjs entende Model; Functional é sinônimo
    topo = clean_config(topo)
    # o BatchNormalization do tfjs não aceita rank 5 → camada própria congelada
    for layer in topo['config']['layers']:
        if layer['class_name'] == 'BatchNormalization':
            layer['class_name'] = 'FrozenBatchNorm3D'
            layer['config'] = {'name': layer['config']['name'],
                               'epsilon': layer['config'].get('epsilon', 1e-3),
                               'trainable': False}

    specs = []
    blobs = []
    for w in net.weights:
        name = w.name[:-2] if w.name.endswith(':0') else w.name
        arr = w.numpy().astype(np.float32)
        # variâncias de BatchNorm podem exceder o alcance do float16 (65504):
        # esses tensores ficam em float32 pleno para não virarem Infinity
        if f32 or np.abs(arr).max() > 6e4:
            specs.append({'name': name, 'shape': list(arr.shape), 'dtype': 'float32'})
            blobs.append(arr.tobytes())
        else:
            specs.append({'name': name, 'shape': list(arr.shape), 'dtype': 'float32',
                          'quantization': {'dtype': 'float16'}})
            blobs.append(arr.astype(np.float16).tobytes())

    data = b''.join(blobs)
    shard_size = shard_mb * 1024 * 1024
    paths = []
    n_shards = (len(data) + shard_size - 1) // shard_size
    for i in range(n_shards):
        p = f'group1-shard{i + 1}of{n_shards}.bin'
        with open(os.path.join(out_dir, p), 'wb') as fo:
            fo.write(data[i * shard_size:(i + 1) * shard_size])
        paths.append(p)

    model_json = {
        'format': 'layers-model',
        'generatedBy': 'segmentarm convert_synthseg2_tfjs.py',
        'convertedBy': 'manual (keras 2.15)',
        'modelTopology': topo,
        'weightsManifest': [{'paths': paths, 'weights': specs}]
    }
    with open(os.path.join(out_dir, 'model.json'), 'w') as fo:
        json.dump(model_json, fo)

    total = sum(os.path.getsize(os.path.join(out_dir, p)) for p in paths)
    print(f'  tfjs salvo em {out_dir}: {n_shards} shards, {total / 1e6:.1f} MB, '
          f'{"float32" if f32 else "float16 quantizado"}')


# --------------------------------- autotestes ---------------------------------

def selftest_unet_naming(h5_path):
    """Valida o construtor de `unet` (que serve a S1, S2 e parc) contra o h5 REAL do
    SynthSeg 1.0: mesma família de arquitetura, só muda nb_labels (32 no 1.0).
    """
    net = build_unet('unet', 32, IN_CH_S1, conv_size=3, nb_features=24)
    h5_layers = h5_weighted_layers(h5_path)
    model_layers = {l.name for l in net.layers if l.weights}
    missing = sorted(n for n in h5_layers if n not in model_layers)
    extra = sorted(n for n in model_layers if n not in h5_layers)
    print(f'{h5_path}: {len(h5_layers)} camadas com pesos no h5, '
          f'{len(model_layers)} no modelo construído')
    if missing:
        print(f'  pesos do h5 sem camada correspondente: {missing}')
    if extra:
        print(f'  camadas construídas sem pesos no h5: {extra}')
    if missing or extra:
        raise SystemExit('autoteste de nomenclatura FALHOU')
    # carrega de fato e confere que as formas também batem
    net.load_weights(h5_path, by_name=True)
    print(f'autoteste OK: 100% das camadas casaram e os pesos carregaram '
          f'({net.count_params():,} parâmetros)')


def selftest_build():
    """Constrói as quatro redes sem pesos e imprime a tabela de conferência."""
    groups = [('robust', 'robust'), ('seg', 'seg'), ('parc', 'parc'), ('qc', 'qc')]
    for _, which in groups:
        for sub, net in nets_for(which):
            wl = [l.name for l in net.layers if l.weights]
            tag = f'{which}/{sub}' if sub else which
            print(f'\n=== {tag} (prefixo "{net.name}", entrada '
                  f'{net.inputs[0].shape[-1]} canal(is), saída {net.outputs[0].shape[-1]}) ===')
            print(f'  camadas com pesos: {len(wl)}   parâmetros: {net.count_params():,}')
            print(f'  5 primeiras: {wl[:5]}')
            print(f'  5 últimas:   {wl[-5:]}')


def main():
    ap = argparse.ArgumentParser(description='SynthSeg 2.0 → TensorFlow.js float16')
    ap.add_argument('--which', choices=['robust', 'seg', 'parc', 'qc'],
                    help='qual dos quatro modelos converter (obrigatório)')
    ap.add_argument('--h5', help='caminho do .h5 oficial correspondente (obrigatório)')
    ap.add_argument('--out', help='pasta de saída (obrigatório)')
    ap.add_argument('--f32', action='store_true', help='sem quantização float16')
    ap.add_argument('--shard-mb', type=int, default=4)
    ap.add_argument('--selftest-unet-naming', metavar='H5',
                    help='valida os nomes da unet contra um h5 (ex.: synthseg_1.0.h5) e sai')
    ap.add_argument('--selftest-build', action='store_true',
                    help='constrói as quatro redes sem pesos e imprime a tabela')
    args = ap.parse_args()

    if args.selftest_unet_naming:
        selftest_unet_naming(args.selftest_unet_naming)
        return
    if args.selftest_build:
        selftest_build()
        return

    faltando = [f for f, v in (('--which', args.which), ('--h5', args.h5),
                               ('--out', args.out)) if not v]
    if faltando:
        ap.error('argumentos obrigatórios ausentes: ' + ', '.join(faltando))

    nets = nets_for(args.which)
    for _, net in nets:
        net.load_weights(args.h5, by_name=True)
    check_coverage(args.h5, [net for _, net in nets])

    for i, (sub, net) in enumerate(nets):
        out_dir = os.path.join(args.out, sub) if sub else args.out
        print(f'[{net.name}] → {out_dir}')
        export_tfjs(net, out_dir, args.f32, args.shard_mb, seed=42 + i)

    if args.which == 'robust':
        print('as três sub-redes saíram separadas: s1 (unet) → argmax/one-hot → '
              'denoiser (l2l) → argmax/one-hot + concat com a imagem → s2 (unet2); '
              'essas transições ficam no worker JS.')


if __name__ == '__main__':
    main()
