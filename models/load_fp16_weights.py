"""
Carrega o checkpoint float16 da U-Net SynthSurf em um modelo Keras.

O upcast fp16 -> fp32 e feito explicitamente porque algumas versoes do TF
levantam erro de dtype ao atribuir arrays float16 a variaveis float32.

Uso:
    from load_fp16_weights import load_fp16_weights
    load_fp16_weights(model, 'synthsurf_v10_fp16.h5')
"""
import h5py
import numpy as np


def load_fp16_weights(model, path, by_name=True, verbose=True):
    """
    Parameters
    ----------
    model : keras.Model
        Modelo ja construido com a mesma topologia (ou apenas o ramo U-Net).
    path : str
        Caminho do .h5 reduzido.
    by_name : bool
        True casa as camadas por nome -- necessario se voce reconstruiu apenas
        a U-Net de inferencia, sem o ramo gerativo de treino.
    """
    with h5py.File(path, 'r') as f:
        g = f['model_weights'] if 'model_weights' in f else f
        available = {n.decode() if isinstance(n, bytes) else n
                     for n in g.attrs['layer_names']}

        loaded, skipped = [], []
        for layer in model.layers:
            if not layer.weights:
                continue
            if layer.name not in available:
                skipped.append(layer.name)
                continue

            lg = g[layer.name]
            names = [n.decode() if isinstance(n, bytes) else n
                     for n in lg.attrs['weight_names']]
            values = [np.asarray(lg[n]).astype(np.float32) for n in names]

            expected = [tuple(w.shape) for w in layer.weights]
            got = [v.shape for v in values]
            if expected != got:
                raise ValueError(
                    f"shape incompativel em '{layer.name}': "
                    f"modelo {expected} vs arquivo {got}")

            layer.set_weights(values)
            loaded.append(layer.name)

    if verbose:
        print(f"carregadas {len(loaded)} camadas com pesos")
        if skipped:
            print(f"sem correspondencia no arquivo ({len(skipped)}): "
                  f"{', '.join(skipped[:8])}"
                  f"{' ...' if len(skipped) > 8 else ''}")
    return loaded, skipped


if __name__ == '__main__':
    import sys
    with h5py.File(sys.argv[1], 'r') as f:
        g = f['model_weights']
        n = 0
        for ln in g.attrs['layer_names']:
            ln = ln.decode() if isinstance(ln, bytes) else ln
            for wn in g[ln].attrs.get('weight_names', []):
                wn = wn.decode() if isinstance(wn, bytes) else wn
                d = g[ln][wn]
                n += d.size
                print(f"{wn:<50} {str(d.shape):<24} {d.dtype}")
        print(f"\ntotal: {n:,} parametros")
