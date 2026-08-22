#!/usr/bin/env python3
"""
Converte um modelo do SynthSeg (Keras .h5) para ONNX e gera o descritor .json
que o aplicativo espera.

Rode isto na sua máquina, num ambiente que já execute o SynthSeg:

    git clone https://github.com/BBillot/SynthSeg
    # baixe os pesos conforme o README do repositório (pasta models/)
    pip install tensorflow tf2onnx onnx onnxruntime numpy

    python convert_synthseg.py \
        --model  SynthSeg/models/synthseg_2.0.h5 \
        --labels SynthSeg/data/labels_classes_priors/synthseg_segmentation_labels_2.0.npy \
        --out    build/synthseg_aseg \
        --name   "SynthSeg 2.0 aseg"

Depois arraste `synthseg_aseg.onnx` e `synthseg_aseg.json` juntos para o slot
"Segmentação principal" do aplicativo.

Antes de redistribuir os pesos convertidos, confira a licença do SynthSeg e do
FreeSurfer. Converter para uso próprio é uma coisa; publicar os arquivos é outra.
"""
import argparse
import json
import os
import sys


def find_labels(model_path, given):
    if given:
        return given
    root = os.path.dirname(os.path.dirname(os.path.abspath(model_path)))
    cands = []
    for dirpath, _, files in os.walk(root):
        for f in files:
            if f.endswith('.npy') and 'label' in f.lower():
                cands.append(os.path.join(dirpath, f))
    if cands:
        print('Arquivos de rótulo encontrados (escolha um com --labels):')
        for c in cands:
            print('   ', c)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True, help='caminho do .h5')
    ap.add_argument('--labels', help='.npy com a lista de rótulos na ordem dos canais')
    ap.add_argument('--out', required=True, help='prefixo de saída, sem extensão')
    ap.add_argument('--name', default=None, help='nome exibido no aplicativo')
    ap.add_argument('--tile', type=int, default=0, help='tamanho do bloco; 0 = volume inteiro')
    ap.add_argument('--overlap', type=int, default=16)
    ap.add_argument('--opset', type=int, default=13)
    ap.add_argument('--task', default='segment', choices=['segment', 'regress'])
    args = ap.parse_args()

    import numpy as np
    import tensorflow as tf
    import tf2onnx

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or '.', exist_ok=True)

    print(f'Carregando {args.model} …')
    model = tf.keras.models.load_model(args.model, compile=False)
    in_shape = model.inputs[0].shape
    out_shape = model.outputs[0].shape
    print('  entrada:', in_shape)
    print('  saída  :', out_shape)

    n_out = int(out_shape[-1]) if out_shape[-1] is not None else None
    print(f'  canais de saída: {n_out}')

    labels = None
    if args.task == 'segment':
        lab_path = find_labels(args.model, args.labels)
        if lab_path is None:
            sys.exit('Informe --labels com o .npy da lista de rótulos. '
                     'Sem ele o mapa de canais para rótulos fica errado.')
        labels = np.load(lab_path).astype(int).tolist()
        print(f'  rótulos: {len(labels)} (de {lab_path})')
        if n_out is not None and len(labels) != n_out:
            sys.exit(f'Incompatível: {len(labels)} rótulos para {n_out} canais de saída. '
                     'Verifique se este .npy corresponde a este modelo.')

    # eixos dinâmicos: o app envia blocos de tamanhos variados
    rank = len(in_shape)
    spec = (tf.TensorSpec([None] * rank, tf.float32, name='input'),)

    onnx_path = f'{args.out}.onnx'
    print('Convertendo para ONNX …')
    tf2onnx.convert.from_keras(
        model, input_signature=spec, opset=args.opset, output_path=onnx_path
    )
    size_mb = os.path.getsize(onnx_path) / 1048576
    print(f'  {onnx_path} ({size_mb:.1f} MB)')

    try:
        import onnxruntime as ort
        sess = ort.InferenceSession(onnx_path, providers=['CPUExecutionProvider'])
        iname = sess.get_inputs()[0].name
        oname = sess.get_outputs()[0].name
        t = 64
        x = np.zeros((1, t, t, t, 1), dtype=np.float32)
        y = sess.run([oname], {iname: x})[0]
        print(f'  teste 64³ ok: saída {y.shape}')
    except Exception as e:  # noqa: BLE001
        iname, oname = 'input', 'output'
        print(f'  aviso: não consegui testar localmente ({e})')

    descriptor = {
        'name': args.name or os.path.basename(args.out),
        'task': args.task,
        'layout': 'NDHWC',
        'inputName': iname,
        'outputName': oname,
        'tile': args.tile,
        'overlap': args.overlap,
        'labels': labels,
        'source': os.path.basename(args.model),
        'opset': args.opset,
    }
    json_path = f'{args.out}.json'
    with open(json_path, 'w', encoding='utf-8') as fh:
        json.dump(descriptor, fh, indent=2)
    print(f'  {json_path}')
    print('\nPronto. Arraste os dois arquivos juntos para o slot no aplicativo.')


if __name__ == '__main__':
    main()
