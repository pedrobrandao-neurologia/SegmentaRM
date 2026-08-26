"""
Reduz um checkpoint Keras/TF (.h5) de U-Net 3D removendo o estado do otimizador
e convertendo os pesos de convolução para float16, preservando as estatísticas
de BatchNormalization em float32.
"""
import h5py, numpy as np, sys

SRC = '/mnt/user-data/uploads/synthsurf_v10_230420.h5'
DST = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/out/synthsurf_v10_230420_fp16.h5'
GZIP = int(sys.argv[2]) if len(sys.argv) > 2 else 9

# Tensores que NUNCA devem ser reduzidos: estatisticas de BN alimentam
# 1/sqrt(var+eps); perda de precisao aqui propaga por toda a rede.
KEEP_FP32 = ('moving_variance', 'moving_mean', 'gamma', 'beta')

def keep_fp32(name):
    return any(k in name for k in KEEP_FP32)

report = []

with h5py.File(SRC, 'r') as src, h5py.File(DST, 'w') as dst:
    # 1) atributos da raiz (model_config, keras_version, backend) -- sem training_config
    for k, v in src.attrs.items():
        if k == 'training_config':
            continue          # descarta config do Adam
        dst.attrs[k] = v

    g_src = src['model_weights']
    g_dst = dst.create_group('model_weights')
    for k, v in g_src.attrs.items():
        g_dst.attrs[k] = v    # layer_names precisa ser preservado exatamente

    for lname in g_src.attrs['layer_names']:
        ln = lname.decode() if isinstance(lname, bytes) else lname
        lg_src = g_src[ln]
        lg_dst = g_dst.create_group(ln)
        for k, v in lg_src.attrs.items():
            lg_dst.attrs[k] = v   # weight_names

        wnames = lg_src.attrs.get('weight_names', [])
        for wn in wnames:
            w = wn.decode() if isinstance(wn, bytes) else wn
            ds = lg_src[w]
            a = ds[()]
            if keep_fp32(w) or a.dtype != np.float32:
                out, tgt = a, a.dtype
            else:
                out = a.astype(np.float16)
                # erro relativo da reconstrucao
                back = out.astype(np.float32)
                denom = np.abs(a).max() or 1.0
                report.append((w, a.size,
                               float(np.abs(back - a).max() / denom),
                               int(np.sum((back == 0) & (a != 0)))))
                tgt = np.float16

            # cria o dataset no caminho aninhado (ex.: "layer/kernel:0")
            parts = w.split('/')
            node = lg_dst
            for p in parts[:-1]:
                node = node.require_group(p)
            node.create_dataset(parts[-1], data=out, dtype=tgt,
                                compression='gzip', compression_opts=GZIP,
                                shuffle=True)

print(f"escrito: {DST}")
print(f"\n{'tensor':<45}{'params':>12}{'err.rel.max':>14}{'underflow':>11}")
for w, n, e, u in sorted(report, key=lambda r: -r[1])[:8]:
    print(f"{w:<45}{n:>12,}{e:>14.2e}{u:>11,}")
tot_u = sum(r[3] for r in report); tot_n = sum(r[1] for r in report)
print(f"\nconvertidos p/ fp16: {tot_n:,} params | zerados por underflow: {tot_u:,} ({100*tot_u/tot_n:.4f}%)")
print(f"erro relativo maximo global: {max(r[2] for r in report):.2e}")
