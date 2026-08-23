#!/usr/bin/env python3
"""Converte o SynthSeg 1.0 (Keras h5, repo BBillot/SynthSeg, Apache 2.0) para
TensorFlow.js LayersModel, com quantização opcional em float16.

A arquitetura é reconstruída em tf.keras exatamente como em ext/neuron/models.py
(unet: 5 níveis, 2 convs/nível, 3³, 24 feats ×2/nível, ELU, BatchNorm por nível,
skips pré-BN, likelihood 1³ → softmax) e os pesos são carregados por nome.

Uso:
  python3 tools/convert_synthseg1_tfjs.py \
      --h5 SynthSeg/models/synthseg_1.0.h5 \
      --labels SynthSeg/data/labels_classes_priors/synthseg_segmentation_labels.npy \
      --names  SynthSeg/data/labels_classes_priors/synthseg_segmentation_names.npy \
      --out models/synthseg1 [--f32]
"""
import argparse, json, os
import numpy as np
import tensorflow as tf
from tensorflow.keras import layers as KL, Model

N_LEVELS = 5
N_CONV = 2
FEAT0 = 24
MULT = 2


def build_unet(n_labels, input_shape=(None, None, None, 1)):
    inp = KL.Input(shape=input_shape, name='unet_input')
    x = inp
    skips = []
    for level in range(N_LEVELS):
        feats = FEAT0 * MULT ** level
        for c in range(N_CONV):
            x = KL.Conv3D(feats, 3, padding='same', activation='elu',
                          name=f'unet_conv_downarm_{level}_{c}')(x)
        skips.append(x)  # skip é a saída da conv, ANTES do BatchNorm
        x = KL.BatchNormalization(axis=-1, name=f'unet_bn_down_{level}')(x)
        if level < N_LEVELS - 1:
            x = KL.MaxPooling3D(pool_size=2, padding='same', name=f'unet_maxpool_{level}')(x)
    for level in range(N_LEVELS - 1):
        feats = FEAT0 * MULT ** (N_LEVELS - 2 - level)
        x = KL.UpSampling3D(size=2, name=f'unet_up_{N_LEVELS + level}')(x)
        x = KL.concatenate([skips[N_LEVELS - 2 - level], x], axis=-1,
                           name=f'unet_merge_{N_LEVELS + level}')
        for c in range(N_CONV):
            x = KL.Conv3D(feats, 3, padding='same', activation='elu',
                          name=f'unet_conv_uparm_{N_LEVELS + level}_{c}')(x)
        x = KL.BatchNormalization(axis=-1, name=f'unet_bn_up_{level}')(x)
    x = KL.Conv3D(n_labels, 1, activation=None, name='unet_likelihood')(x)
    out = KL.Activation('softmax', name='unet_prediction')(x)
    return Model(inputs=inp, outputs=out, name='unet')


def clean_config(cfg):
    """Remove chaves do Keras 2.15 que o tfjs não conhece."""
    drop = {'groups', 'synchronized', 'registered_name', 'module', 'build_config'}
    if isinstance(cfg, dict):
        return {k: clean_config(v) for k, v in cfg.items() if k not in drop}
    if isinstance(cfg, list):
        return [clean_config(v) for v in cfg]
    return cfg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--h5', required=True)
    ap.add_argument('--labels', required=True)
    ap.add_argument('--names', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--f32', action='store_true', help='sem quantização float16')
    ap.add_argument('--shard-mb', type=int, default=4)
    args = ap.parse_args()

    labels_raw = np.load(args.labels)
    names_raw = np.load(args.names)
    labels, uidx = np.unique(labels_raw, return_index=True)
    names = [str(names_raw[i]) for i in uidx]
    n_labels = len(labels)
    print(f'{n_labels} rótulos únicos: {list(labels)}')

    net = build_unet(n_labels)
    net.load_weights(args.h5, by_name=True)

    # confere que TODOS os grupos do h5 foram consumidos
    import h5py
    with h5py.File(args.h5, 'r') as f:
        h5_layers = {n for n in f.attrs['layer_names'].astype(str) if len(f[n]) > 0} if 'layer_names' in f.attrs else set(f.keys())
    model_layers = {l.name for l in net.layers if l.weights}
    missing = {n for n in h5_layers if n not in model_layers}
    if missing:
        raise SystemExit(f'pesos do h5 sem camada correspondente: {missing}')
    print(f'todas as {len(model_layers)} camadas com pesos casaram com o h5')

    # fixture de paridade: entrada aleatória fixa 32³ e saída esperada
    rng = np.random.default_rng(42)
    x = rng.random((1, 32, 32, 32, 1), dtype=np.float32)
    y = net.predict(x, verbose=0)
    print('saída de teste:', y.shape, 'soma softmax ~1:', float(y[0, 0, 0, 0].sum()))

    os.makedirs(args.out, exist_ok=True)
    np.save(os.path.join(args.out, 'parity_input.npy'), x)
    np.save(os.path.join(args.out, 'parity_output.npy'), y.astype(np.float32))

    # ---- monta o LayersModel tfjs ----
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
        name = w.name[:-2] if w.name.endswith(':0') else w.name  # unet_conv.../kernel
        arr = w.numpy().astype(np.float32)
        if args.f32:
            spec = {'name': name, 'shape': list(arr.shape), 'dtype': 'float32'}
            blobs.append(arr.tobytes())
        else:
            f16 = arr.astype(np.float16)
            spec = {'name': name, 'shape': list(arr.shape), 'dtype': 'float32',
                    'quantization': {'dtype': 'float16'}}
            blobs.append(f16.tobytes())
        specs.append(spec)

    data = b''.join(blobs)
    shard_size = args.shard_mb * 1024 * 1024
    paths = []
    n_shards = (len(data) + shard_size - 1) // shard_size
    for i in range(n_shards):
        p = f'group1-shard{i + 1}of{n_shards}.bin'
        with open(os.path.join(args.out, p), 'wb') as fo:
            fo.write(data[i * shard_size:(i + 1) * shard_size])
        paths.append(p)

    model_json = {
        'format': 'layers-model',
        'generatedBy': 'segmentarm convert_synthseg1_tfjs.py',
        'convertedBy': 'manual (keras 2.15)',
        'modelTopology': topo,
        'weightsManifest': [{'paths': paths, 'weights': specs}]
    }
    with open(os.path.join(args.out, 'model.json'), 'w') as fo:
        json.dump(model_json, fo)

    # labels.json (índice do canal → nome canônico FreeSurfer) e mapeamento p/ códigos
    canon = {
        'background': 'BG', '3rd ventricle': '3rd-Ventricle', '4th ventricle': '4th-Ventricle',
        'brain-stem': 'Brain-Stem'
    }
    def canonical(nm):
        if nm in canon:
            return canon[nm]
        parts = nm.replace('left ', 'Left-').replace('right ', 'Right-')
        parts = parts.replace('cerebral white matter', 'Cerebral-White-Matter')
        parts = parts.replace('cerebral cortex', 'Cerebral-Cortex')
        parts = parts.replace('lateral ventricle', 'Lateral-Ventricle')
        parts = parts.replace('inferior Lateral-Ventricle', 'Inf-Lat-Vent')
        parts = parts.replace('Left-inferior', 'Left-Inf-Lat-Vent@').replace('Right-inferior', 'Right-Inf-Lat-Vent@')
        if '@' in parts:
            parts = parts.split('@')[0]
        parts = parts.replace('cerebellum white matter', 'Cerebellum-White-Matter')
        parts = parts.replace('cerebellum cortex', 'Cerebellum-Cortex')
        parts = parts.replace('thalamus', 'Thalamus').replace('caudate', 'Caudate')
        parts = parts.replace('putamen', 'Putamen').replace('pallidum', 'Pallidum')
        parts = parts.replace('hippocampus', 'Hippocampus').replace('amygdala', 'Amygdala')
        parts = parts.replace('accumbens area', 'Accumbens-area').replace('ventral DC', 'VentralDC')
        return parts
    labels_json = {str(i): canonical(names[i]) for i in range(n_labels)}
    with open(os.path.join(args.out, 'labels.json'), 'w') as fo:
        json.dump(labels_json, fo, indent=1)
    with open(os.path.join(args.out, 'fs_codes.json'), 'w') as fo:
        json.dump({str(i): int(labels[i]) for i in range(n_labels)}, fo)

    total = sum(os.path.getsize(os.path.join(args.out, p)) for p in paths)
    print(f'tfjs salvo em {args.out}: {n_shards} shards, {total / 1e6:.1f} MB, '
          f'{"float32" if args.f32 else "float16 quantizado"}')


if __name__ == '__main__':
    main()
