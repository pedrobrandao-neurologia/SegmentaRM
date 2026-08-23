#!/usr/bin/env python3
"""Converte os checkpoints FastSurferCNN v1 (Epoch_30_training_state.pkl, torch legacy)
para o formato binário do SegmentaRM: models/fastsurfer/{vista}.bin (float16) + manifest.

A rede (Henschel et al., NeuroImage 2020; Deep-MI/FastSurfer, Apache 2.0) é a CNN
volumétrica 2.5D usada pelo FastSurfer para gerar o aparc.DKTatlas+aseg — a fonte da
parcelação que o recon-surf depois refina em superfícies. Aqui todas as BatchNorm são
DOBRADAS nas convoluções vizinhas (exato em modo eval):
  conv→bn:  w' = w·γ/σ ; b' = (b−μ)·γ/σ + β        (bn1, bn2, bn3 após conv0/1/2)
  bn→conv:  w'[o,i] = w[o,i]·s[i] ; b' = b + Σ w·t   (bn0 de entrada, s=γ/σ, t=β−μ·γ/σ)
O grafo restante fica: conv + PReLU escalar + maxout + maxpool(índices)/unpool.

Uso: python3 tools/convert_fastsurfer_tfjs.py <dir com fastsurfercnn_{axial,coronal,sagittal}_epoch30.pkl>
Sem o torch instalado — o leitor do formato legacy está embutido.
"""
import json
import pickle
import sys
from pathlib import Path

import numpy as np

MAGIC = 0x1950A86A20F9469CFC6C
EPS = 1e-5
DTYPES = {'FloatStorage': np.float32, 'DoubleStorage': np.float64, 'HalfStorage': np.float16,
          'LongStorage': np.int64, 'IntStorage': np.int32, 'ByteStorage': np.uint8}


class _Storage:
    def __init__(self, kind, numel):
        self.kind, self.numel, self.data = kind, numel, None


class _Tensor:
    def __init__(self, storage, offset, size, stride):
        self.storage, self.offset, self.size, self.stride = storage, offset, size, stride

    def numpy(self):
        a = self.storage.data
        return np.lib.stride_tricks.as_strided(
            a[self.offset:], shape=tuple(self.size),
            strides=tuple(s * a.itemsize for s in self.stride)).copy()


def _rebuild(storage, offset, size, stride, *rest):
    return _Tensor(storage, offset, list(size), list(stride))


class _Unpickler(pickle.Unpickler):
    def __init__(self, f, storages):
        super().__init__(f, encoding='latin1')
        self.storages = storages

    def find_class(self, module, name):
        if name in DTYPES:
            return name
        if name in ('_rebuild_tensor_v2', '_rebuild_tensor'):
            return _rebuild
        if name == 'OrderedDict':
            import collections
            return collections.OrderedDict
        if name == '_rebuild_parameter':
            return lambda data, *a: data
        return lambda *a, **k: None

    def persistent_load(self, pid):
        kind, key, numel = pid[1], pid[2], pid[4]
        if key not in self.storages:
            self.storages[key] = _Storage(kind, numel)
        return self.storages[key]


def load_state_dict(path):
    with open(path, 'rb') as f:
        assert pickle.load(f) == MAGIC, 'não é um checkpoint torch legacy'
        pickle.load(f); pickle.load(f)
        storages = {}
        obj = _Unpickler(f, storages).load()
        for key in pickle.load(f):
            st = storages[key]
            numel = int(np.frombuffer(f.read(8), dtype=np.int64)[0])
            dt = DTYPES[st.kind]
            st.data = np.frombuffer(f.read(numel * np.dtype(dt).itemsize), dtype=dt)
    sd = obj['model_state_dict']
    return {k: v.numpy() for k, v in sd.items() if isinstance(v, _Tensor)}


def fold_conv_bn(w, b, bn_g, bn_b, bn_m, bn_v):
    s = bn_g / np.sqrt(bn_v + EPS)
    return w * s[:, None, None, None], (b - bn_m) * s + bn_b


def fold_bn_conv(bn_g, bn_b, bn_m, bn_v, w, b):
    s = bn_g / np.sqrt(bn_v + EPS)
    t = bn_b - bn_m * s
    w2 = w * s[None, :, None, None]
    b2 = b + np.einsum('oihw,i->o', w, t)
    return w2, b2


def fold_block(sd, pre, is_input):
    """Devolve [(w,b) conv0, conv1, conv2, alpha] com as BNs dobradas."""
    g = lambda n: sd[f'{pre}.{n}']
    w0, b0 = g('conv0.weight'), g('conv0.bias')
    if is_input:  # bn0 antes de conv0
        w0, b0 = fold_bn_conv(g('bn0.weight'), g('bn0.bias'), g('bn0.running_mean'), g('bn0.running_var'), w0, b0)
    w0, b0 = fold_conv_bn(w0, b0, g('bn1.weight'), g('bn1.bias'), g('bn1.running_mean'), g('bn1.running_var'))
    w1, b1 = fold_conv_bn(g('conv1.weight'), g('conv1.bias'),
                          g('bn2.weight'), g('bn2.bias'), g('bn2.running_mean'), g('bn2.running_var'))
    w2, b2 = fold_conv_bn(g('conv2.weight'), g('conv2.bias'),
                          g('bn3.weight'), g('bn3.bias'), g('bn3.running_mean'), g('bn3.running_var'))
    return [w0, b0, w1, b1, w2, b2, np.float32(sd[f'{pre}.prelu.weight'][0])]


def export_view(sd, out_bin):
    order = []
    blobs = []

    def put(name, arr):
        arr = np.ascontiguousarray(arr, dtype=np.float32)
        order.append({'name': name, 'shape': list(arr.shape)})
        blobs.append(arr.astype(np.float16))

    for pre in ('encode1', 'encode2', 'encode3', 'encode4', 'bottleneck',
                'decode4', 'decode3', 'decode2', 'decode1'):
        w0, b0, w1, b1, w2, b2, alpha = fold_block(sd, pre, pre == 'encode1')
        # torch OIHW → HWIO (NHWC do tfjs)
        put(pre + '.w0', np.transpose(w0, (2, 3, 1, 0))); put(pre + '.b0', b0)
        put(pre + '.w1', np.transpose(w1, (2, 3, 1, 0))); put(pre + '.b1', b1)
        put(pre + '.w2', np.transpose(w2, (2, 3, 1, 0))); put(pre + '.b2', b2)
        put(pre + '.alpha', np.array([alpha]))
    put('classifier.w', np.transpose(sd['classifier.conv.weight'], (2, 3, 1, 0)))
    put('classifier.b', sd['classifier.conv.bias'])

    off = 0
    for o, a in zip(order, blobs):
        o['offset'] = off
        o['length'] = a.size
        off += a.size
    with open(out_bin, 'wb') as f:
        for a in blobs:
            f.write(a.tobytes())
    return order, off


# LUT do espaço de 79 rótulos → códigos FreeSurfer (load_neuroimaging_data.map_label2aparc_aseg)
LUT79 = [0, 2, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 24, 26, 28, 31, 41, 43, 44,
         46, 47, 49, 50, 51, 52, 53, 54, 58, 60, 63, 77,
         1002, 1003, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015, 1016,
         1017, 1018, 1019, 1020, 1021, 1022, 1023, 1024, 1025, 1026, 1027, 1028, 1029, 1030,
         1031, 1034, 1035,
         2002, 2005, 2010, 2012, 2013, 2014, 2016, 2017, 2021, 2022, 2023, 2024, 2025, 2028]

# remapeia predição sagital (51 classes) para o espaço completo (79)
SAG2FULL = [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 1, 2, 3, 14, 15, 4, 16,
            17, 18, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
            20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
            37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 20, 22, 27,
            29, 30, 31, 33, 34, 38, 39, 40, 41, 42, 45]

# nome aparc por código%1000 (FreeSurferColorLUT, atlas DKT — sem bankssts/frontalpole/temporalpole)
APARC_NAMES = {2: 'caudalanteriorcingulate', 3: 'caudalmiddlefrontal', 5: 'cuneus', 6: 'entorhinal',
               7: 'fusiform', 8: 'inferiorparietal', 9: 'inferiortemporal', 10: 'isthmuscingulate',
               11: 'lateraloccipital', 12: 'lateralorbitofrontal', 13: 'lingual', 14: 'medialorbitofrontal',
               15: 'middletemporal', 16: 'parahippocampal', 17: 'paracentral', 18: 'parsopercularis',
               19: 'parsorbitalis', 20: 'parstriangularis', 21: 'pericalcarine', 22: 'postcentral',
               23: 'posteriorcingulate', 24: 'precentral', 25: 'precuneus', 26: 'rostralanteriorcingulate',
               27: 'rostralmiddlefrontal', 28: 'superiorfrontal', 29: 'superiorparietal', 30: 'superiortemporal',
               31: 'supramarginal', 34: 'transversetemporal', 35: 'insula'}


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
    out = Path(__file__).resolve().parent.parent / 'models' / 'fastsurfer'
    out.mkdir(parents=True, exist_ok=True)
    manifest = {'format': 'segmentarm-fastsurfercnn-v1', 'dtype': 'float16', 'numFilters': 64,
                'kernel': 5, 'thickness': 7, 'views': {}, 'lut79': LUT79, 'sag2full': SAG2FULL,
                'license': 'Apache-2.0 (Deep-MI/FastSurfer); Henschel et al., NeuroImage 2020'}
    # parcela DKT (nome) → índice no espaço do modelo 104 do brainchop (1..34 = ordem DK)
    dk_order = ['bankssts', 'caudalanteriorcingulate', 'caudalmiddlefrontal', 'cuneus', 'entorhinal',
                'fusiform', 'inferiorparietal', 'inferiortemporal', 'isthmuscingulate', 'lateraloccipital',
                'lateralorbitofrontal', 'lingual', 'medialorbitofrontal', 'middletemporal', 'parahippocampal',
                'paracentral', 'parsopercularis', 'parsorbitalis', 'parstriangularis', 'pericalcarine',
                'postcentral', 'posteriorcingulate', 'precentral', 'precuneus', 'rostralanteriorcingulate',
                'rostralmiddlefrontal', 'superiorfrontal', 'superiorparietal', 'superiortemporal',
                'supramarginal', 'frontalpole', 'temporalpole', 'transversetemporal', 'insula']
    # classe (0..78) → [parcela 1..34 ou 0, hemi 0=nenhum 1=E 2=D 3=compartilhada-E-por-padrão]
    cls2parcel = []
    for c, code in enumerate(LUT79):
        if 1000 <= code < 3000:
            name = APARC_NAMES[code % 1000]
            parcel = dk_order.index(name) + 1
            rh_specific = 2000 + (code % 1000) in LUT79
            if code >= 2000:
                cls2parcel.append([parcel, 2])
            else:
                cls2parcel.append([parcel, 1 if rh_specific else 3])
        else:
            cls2parcel.append([0, 0])
    manifest['cls2parcel'] = cls2parcel

    for view, ckpt in (('coronal', 'fastsurfercnn_coronal_epoch30.pkl'),
                       ('axial', 'fastsurfercnn_axial_epoch30.pkl'),
                       ('sagittal', 'fastsurfercnn_sagittal_epoch30.pkl')):
        sd = load_state_dict(src / ckpt)
        order, total = export_view(sd, out / f'{view}.bin')
        manifest['views'][view] = {'bin': f'{view}.bin', 'classes': int(sd['classifier.conv.weight'].shape[0]),
                                   'tensors': order, 'totalValues': total}
        print(f'{view}: {total * 2 / 1e6:.1f} MB f16, {manifest["views"][view]["classes"]} classes')
    (out / 'manifest.json').write_text(json.dumps(manifest))
    print('manifest salvo em', out / 'manifest.json')


if __name__ == '__main__':
    main()
