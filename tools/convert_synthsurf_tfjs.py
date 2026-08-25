#!/usr/bin/env python3
"""Converte o SynthDist / mri_synth_surf (rede de SDFs do recon-all-clinical;
Gopinath et al., Medical Image Analysis 2025) para TensorFlow.js float16.

Os pesos NÃO são redistribuídos com o SegmentaRM: a licença do FreeSurfer não
permite. Obtenha-os você mesmo — o arquivo `synthsurf_v10_230420.h5` acompanha
qualquer instalação do FreeSurfer >= 7.4 em `$FREESURFER_HOME/models/`
(tamanho: 159.148.696 bytes; sha256
f02f70dacb753c019ea590f5ca36617dc8ace32eb571c74ffc648c926ad7bbbc).

Arquitetura (lida do mri_synth_surf.py, código FreeSurfer, branch dev): o
mesmo `unet` do neurite usado pelo SynthSeg/SynthSR — 5 níveis, 2 convs 3³ por
nível, 24 filtros ×2 por nível, ELU, BatchNorm por nível, saída LINEAR de
9 canais (0..3 = SDF lh-white, lh-pial, rh-white, rh-pial, recorte ±5 mm; os
demais canais não são usados pelo pipeline oficial).

Uso:
  python3 tools/convert_synthsurf_tfjs.py \
      --h5 $FREESURFER_HOME/models/synthsurf_v10_230420.h5 --out models/synthsurf

Depois, sirva/copie a pasta `models/synthsurf/` junto do aplicativo: o passo 05
detecta o model.json e passa a usar a rede em vez do fallback por EDT.
"""
import argparse
import json
import os

import numpy as np
import tensorflow as tf
from tensorflow.keras import layers as KL, Model

N_LEVELS = 5
N_CONV = 2
FEAT0 = 24
MULT = 2
N_OUT = 9


def build_unet(input_shape=(None, None, None, 1)):
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
    out = KL.Conv3D(N_OUT, 1, activation=None, name='unet_likelihood')(x)
    return Model(inputs=inp, outputs=out, name='unet')


def clean_config(cfg):
    drop = {'groups', 'synchronized', 'registered_name', 'module', 'build_config'}
    if isinstance(cfg, dict):
        return {k: clean_config(v) for k, v in cfg.items() if k not in drop}
    if isinstance(cfg, list):
        return [clean_config(v) for v in cfg]
    return cfg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--h5', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--f32', action='store_true')
    ap.add_argument('--shard-mb', type=int, default=4)
    args = ap.parse_args()

    net = build_unet()
    net.load_weights(args.h5, by_name=True)

    import h5py
    with h5py.File(args.h5, 'r') as f:
        h5_layers = {n for n in f.attrs['layer_names'].astype(str) if len(f[n]) > 0} if 'layer_names' in f.attrs else {k for k in f.keys() if len(f[k]) > 0}
    model_layers = {l.name for l in net.layers if l.weights}
    missing = {n for n in h5_layers if n not in model_layers}
    if missing:
        raise SystemExit(f'pesos do h5 sem camada correspondente: {missing}')
    print(f'todas as {len(model_layers)} camadas com pesos casaram com o h5')

    rng = np.random.default_rng(7)
    x = rng.random((1, 32, 32, 32, 1), dtype=np.float32)
    y = net.predict(x, verbose=0)
    print('saída de teste:', y.shape, 'faixa', float(y.min()), float(y.max()))

    os.makedirs(args.out, exist_ok=True)
    np.save(os.path.join(args.out, 'parity_input.npy'), x)
    np.save(os.path.join(args.out, 'parity_output.npy'), y.astype(np.float32))

    topo = json.loads(net.to_json())
    topo['class_name'] = 'Model'
    topo = clean_config(topo)
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
        # variâncias de BatchNorm podem exceder o alcance do float16 (65504)
        if args.f32 or np.abs(arr).max() > 6e4:
            specs.append({'name': name, 'shape': list(arr.shape), 'dtype': 'float32'})
            blobs.append(arr.tobytes())
        else:
            specs.append({'name': name, 'shape': list(arr.shape), 'dtype': 'float32',
                          'quantization': {'dtype': 'float16'}})
            blobs.append(arr.astype(np.float16).tobytes())

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
        'generatedBy': 'segmentarm convert_synthsurf_tfjs.py',
        'convertedBy': 'manual (keras 2.15)',
        'modelTopology': topo,
        'weightsManifest': [{'paths': paths, 'weights': specs}]
    }
    with open(os.path.join(args.out, 'model.json'), 'w') as fo:
        json.dump(model_json, fo)

    total = sum(os.path.getsize(os.path.join(args.out, p)) for p in paths)
    print(f'tfjs salvo em {args.out}: {n_shards} shards, {total / 1e6:.1f} MB, '
          f'{"float32" if args.f32 else "float16 quantizado"}')
    print('valide no navegador: o passo 05 com "rede SynthDist" deve reportar '
          'motor "rede SynthDist" na linha do tempo/proveniência.')


if __name__ == '__main__':
    main()
