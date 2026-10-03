#!/usr/bin/env python3
"""
Preparação offline das referências do MESMO método a partir do Dallas Lifespan Brain Study —
OpenNeuro ds004856 (CC0); Park DC et al., Sci Data 2025;12:846, doi:10.1038/s41597-025-04847-7.

Tudo aqui é OFFLINE: imagens e tabelas do DLBS ficam na máquina de quem roda; só coeficientes
entram em models/normative/. Passos:

  1. baixe participants.tsv, derivatives/brainsummary/Template_Structural_MRI.xlsx e os T1 MPRAGE
     (run-1) de https://s3.amazonaws.com/openneuro.org/ds004856/ (ver tools/dlbs_selecao.py);
  2. rode o SynthSeg do app em lote: node tools/lote_synthseg_node.mjs <pasta T1> <pasta res>;
  3. python3 tools/referencias_dlbs.py --res <pasta res> --fs Template_Structural_MRI.xlsx \
        --selecao selecao.json --trabalho <pasta> [--piloto <res externo> --piloto-fs <aseg.stats>]
     → models/normative/referencia_mesmo_metodo.json (assimetria e HOC por idade) e, na pasta de
       trabalho, os volumes por sujeito (SynthSeg e FreeSurfer) e o diagnóstico da comparação
       SynthSeg × FreeSurfer 5.3;
  4. node tools/recentragem_dlbs.mjs --trabalho <pasta>
     → models/normative/recentragem_synthseg.json (nível A) e docs/validacao/dlbs.md.

A comparação com o FreeSurfer 5.3 (editado à mão no DLBS) mede o viés de método por estrutura e
idade; ela NÃO vira um tradutor para a escala do FreeSurfer: controles saudáveis medidos pelo
próprio FreeSurfer ficam, contra as normas embarcadas, longe de z = 0 (ver o relatório) — a
recentragem do nível A é feita contra as próprias normas.
"""
import argparse, glob, json, math, os, sys
import numpy as np
import pandas as pd

GLOBAIS = {
    # chave do app → (rótulos SynthSeg somados, colunas FreeSurfer 5.3 somadas)
    'CortexVol': (['Left-Cerebral-Cortex', 'Right-Cerebral-Cortex'], ['CortexVol']),
    'CerebralWhiteMatterVol': (['Left-Cerebral-White-Matter', 'Right-Cerebral-White-Matter'], ['CortWMVol']),
    'SubCortGrayVol': ([f'{h}-{s}' for h in ('Left', 'Right') for s in ('Thalamus', 'Caudate', 'Putamen', 'Pallidum', 'Hippocampus', 'Amygdala', 'Accumbens-area', 'VentralDC')], ['SubCortGMVol']),
    'VentricleVol': (['Left-Lateral-Ventricle', 'Right-Lateral-Ventricle', 'Left-Inf-Lat-Vent', 'Right-Inf-Lat-Vent', '3rd-Ventricle', '4th-Ventricle'],
                     ['LhLatVentVol', 'RhLatVentVol', 'LhInfLatVentVol', 'RhInfLatVentVol', 'ThirdVentVol', 'FourthVentVol']),
    # TCV do BrainChart = GMV + WMV (sem a cinzenta subcortical): a mediana tabelada acompanha
    # GMV + WMV em todas as idades (−1% a +1,7%) e o N do modelo é o da WMV, não o da sGMV
    'TCV': (['Left-Cerebral-Cortex', 'Right-Cerebral-Cortex', 'Left-Cerebral-White-Matter', 'Right-Cerebral-White-Matter'],
            ['CortexVol', 'CortWMVol']),
}
SUB_FS = {'Thalamus': 'ThalamusProper', 'Caudate': 'Caudate', 'Putamen': 'Putamen', 'Pallidum': 'Pallidum',
          'Hippocampus': 'Hippocampus', 'Amygdala': 'Amygdala', 'Accumbens-area': 'Accumbens'}
for s, f in SUB_FS.items():
    for h, fh in (('Left', 'Lh'), ('Right', 'Rh')):
        GLOBAIS[f'{h}-{s}'] = ([f'{h}-{s}'], [f'{fh}{f}Vol'])
# pares para a assimetria do mesmo método (nome-base SynthSeg = p.base no app)
PARES = ['Thalamus', 'Caudate', 'Putamen', 'Pallidum', 'Hippocampus', 'Amygdala', 'Accumbens-area', 'VentralDC',
         'Lateral-Ventricle', 'Inf-Lat-Vent', 'Cerebral-Cortex', 'Cerebral-White-Matter', 'Cerebellum-Cortex', 'Cerebellum-White-Matter']
PAR_FS = {'Thalamus': 'ThalamusProper', 'Caudate': 'Caudate', 'Putamen': 'Putamen', 'Pallidum': 'Pallidum', 'Hippocampus': 'Hippocampus',
          'Amygdala': 'Amygdala', 'Accumbens-area': 'Accumbens', 'VentralDC': 'VentralDC', 'Lateral-Ventricle': 'LatVent',
          'Inf-Lat-Vent': 'InfLatVent', 'Cerebellum-Cortex': 'CerebellumCortex', 'Cerebellum-White-Matter': 'CerebellumWM'}
IDADE_REF = 60.0


def mq_quad(t, v):
    X = np.column_stack([np.ones_like(t), t, t * t])
    beta, *_ = np.linalg.lstsq(X, v, rcond=None)
    return beta, v - X @ beta


def carregar(args):
    sel = pd.DataFrame(json.load(open(args.selecao)))
    xl = pd.ExcelFile(args.fs)
    g = xl.parse('GlobalVariables-W1').set_index('S#')
    sc = xl.parse('SubcorticalVolume-W1').set_index('S#')
    linhas = []
    for _, s in sel.iterrows():
        p = os.path.join(args.res, s['id'] + '.json')
        if not os.path.exists(p) or s['onda'] != 1 or s['num'] not in g.index:
            continue
        r = json.load(open(p))
        fs = {**g.loc[s['num']].to_dict(), **sc.loc[s['num']].to_dict()}
        if fs.get('HasData', 1) != 1:
            continue
        linhas.append({'id': s['id'], 'idade': float(s['idade']), 'sexo': s['sexo'], 'ss': r['soft'], 'ssr': r['hard'], 'fs': fs})
    return linhas


def robusto_ok(v):
    """falhas grosseiras: |v − mediana| > 5 DP robustos (1,4826·MAD)"""
    med = np.median(v); mad = 1.4826 * np.median(np.abs(v - med))
    return np.abs(v - med) <= 5 * mad if mad > 0 else np.ones_like(v, bool)


def mq(X, v):
    beta, *_ = np.linalg.lstsq(X, v, rcond=None)
    return beta, v - X @ beta


def desenho(t, sx):
    """termos do deslocamento: 1, t, t², sexo masculino"""
    return np.column_stack([np.ones_like(t), t, t * t, sx])


def ajustar(d, t, sx):
    """deslocamento log(FS/SS) = a + c·t + d·t² + e·[M]  (b = 1: a escala do z é a da norma)"""
    beta, res = mq(desenho(t, sx), d)
    return beta, res


def norma_sigma(chave, idade, sexo, bc, sb):
    """σ em log da norma na idade/sexo, pelo IQR dos quantis tabelados (só para o diagnóstico)"""
    fen = {'CortexVol': 'GMV', 'CerebralWhiteMatterVol': 'WMV', 'SubCortGrayVol': 'sGMV', 'VentricleVol': 'Ventricles', 'TCV': 'TCV'}
    if chave in fen:
        tb = bc['fenotipos'][fen[chave]][sexo]; ids = bc['idades']
    else:
        h, base = chave.split('-', 1)
        tb = sb['estruturas'][base]['L' if h == 'Left' else 'R'][sexo]; ids = sb['idades']
    k = min(range(len(ids)), key=lambda i: abs(ids[i] - idade))
    q = tb['q'][k]
    return (math.log(q[7]) - math.log(q[5])) / 1.349


def comparar_fs(linhas, B, rng, raiz_normas):
    """
    Viés de método SynthSeg × FreeSurfer 5.3 (editado) por medida: média geométrica de V_SS/V_FS,
    por terço de idade, correlação dos resíduos, DP de cada ferramenta e da norma, e o deslocamento
    FS/SS que um ajuste por lado daria contra o ajuste com os dois lados juntos (o artefato E/D do
    FreeSurfer do DLBS). Só diagnóstico: o app não traduz para a escala do FreeSurfer.
    """
    bc = json.load(open(os.path.join(raiz_normas, 'brainchart.json')))
    sb = json.load(open(os.path.join(raiz_normas, 'subcortical.json')))
    diag = {}
    idades = np.array([l['idade'] for l in linhas]); t_all = idades - IDADE_REF
    sx_all = np.array([1.0 if l['sexo'] == 'M' else 0.0 for l in linhas])
    grupos = {}
    for chave in GLOBAIS:
        base = chave.split('-', 1)[1] if chave.startswith(('Left-', 'Right-')) else chave
        grupos.setdefault(base, []).append(chave)
    for base, chaves in grupos.items():
        blocos = []
        for chave in chaves:
            rs, cf = GLOBAIS[chave]
            xs = np.array([sum(l['ss'].get(k, 0) for k in rs) for l in linhas], float)
            ys = np.array([sum(float(l['fs'].get(c, np.nan)) for c in cf) for l in linhas], float)
            ok = (xs > 0) & np.isfinite(ys) & (ys > 0)
            blocos.append((chave, np.where(ok)[0], np.log(xs), np.log(ys)))
        # linhas empilhadas (sujeito, lado); exclusão de falhas grosseiras pelo resíduo robusto
        suj = np.concatenate([idx for _, idx, _, _ in blocos])
        x = np.concatenate([xl[idx] for _, idx, xl, _ in blocos]); y = np.concatenate([yl[idx] for _, idx, _, yl in blocos])
        lado = np.concatenate([np.full(len(idx), k) for k, (_, idx, _, _) in enumerate(blocos)])
        t = t_all[suj]; sx = sx_all[suj]; d = y - x
        _, r0 = ajustar(d, t, sx)
        keep = robusto_ok(r0)
        suj, x, y, lado, t, sx, d = suj[keep], x[keep], y[keep], lado[keep], t[keep], sx[keep], d[keep]
        beta, res = ajustar(d, t, sx)
        terc = np.quantile(t_all, [1 / 3, 2 / 3])
        for k, (chave, _, _, _) in enumerate(blocos):
            sel = lado == k
            n = int(sel.sum())
            tt = t[sel]; xx = x[sel]; yy = y[sel]; ss = sx[sel]
            faixas = [tt <= terc[0], (tt > terc[0]) & (tt <= terc[1]), tt > terc[1]]
            _, rx = mq(desenho(tt, ss), xx); _, ry = mq(desenho(tt, ss), yy)
            sn = float(np.mean([norma_sigma(chave, v + IDADE_REF, 'M' if s else 'F', bc, sb) for v, s in zip(tt, ss)]))
            # deslocamento que um ajuste só deste lado daria (mostra o artefato E/D do FreeSurfer do DLBS)
            b_lado, _ = ajustar(d[sel], tt, ss)
            diag[chave] = {
                'n': n, 'excluidos': int((~keep[np.concatenate([np.full(len(idx), kk) for kk, (_, idx, _, _) in enumerate(blocos)]) == k]).sum()),
                'r_residuos': round(float(np.corrcoef(rx, ry)[0, 1]), 3),
                'vies_ss_pct': round(float(100 * (np.exp(np.mean(xx - yy)) - 1)), 1),
                'vies_ss_pct_tercos': [round(float(100 * (np.exp(np.mean(xx[q] - yy[q])) - 1)), 1) for q in faixas],
                'dp_ss_log': round(float(np.std(rx, ddof=1)), 3), 'dp_fs_log': round(float(np.std(ry, ddof=1)), 3), 'sigma_norma_log': round(sn, 3),
                'b_equiparacao_nao_usado': round(float(np.std(ry, ddof=1) / np.std(rx, ddof=1)), 2),
                'dp_razao_individual_pct': round(float(100 * np.std(res[sel], ddof=1)), 1),
                'fs_ss_so_deste_lado_pct': round(float(100 * (np.exp(b_lado[0]) - 1)), 1),
                'fs_ss_lados_juntos_pct': round(float(100 * (np.exp(beta[0]) - 1)), 1),
                'tercos_idade': [round(float(v + IDADE_REF), 1) for v in terc],
            }
    return diag


def ref_assimetria(linhas, fonte_guadalupe):
    t_all = np.array([l['idade'] for l in linhas]) - IDADE_REF
    out = {}; diag = {}
    gua = {}
    if fonte_guadalupe and os.path.exists(fonte_guadalupe):
        nomes = {'Núcleo accumbens': 'Accumbens-area', 'Amígdala': 'Amygdala', 'Núcleo caudado': 'Caudate', 'Globo pálido': 'Pallidum',
                 'Hipocampo': 'Hippocampus', 'Putâmen': 'Putamen', 'Tálamo': 'Thalamus'}
        for e in json.load(open(fonte_guadalupe)):
            if e['estrutura'] in nomes:
                gua[nomes[e['estrutura']]] = {'media': e['media_ai_pct'], 'dp': e['dp_ai_pct']}
    for base in PARES:
        L = np.array([l['ss'].get('Left-' + base, np.nan) for l in linhas], float)
        R = np.array([l['ss'].get('Right-' + base, np.nan) for l in linhas], float)
        ok = (L > 0) & (R > 0)
        ai = 200 * (L[ok] - R[ok]) / (L[ok] + R[ok]); t = t_all[ok]
        X = np.column_stack([np.ones_like(t), t])
        keep = robusto_ok(ai - np.median(ai))
        beta, *_ = np.linalg.lstsq(X[keep], ai[keep], rcond=None)
        res = ai[keep] - X[keep] @ beta
        # DP dependente da idade: E|resíduo| = √(2/π)·σ(t), σ linear na idade
        g, *_ = np.linalg.lstsq(X[keep], np.abs(res), rcond=None)
        k = math.sqrt(math.pi / 2)
        dp0, dp1 = k * g[0], k * g[1]
        tmin, tmax = t.min(), t.max()
        dpmin = max(0.1, 0.5 * min(dp0 + dp1 * tmin, dp0 + dp1 * tmax))
        out[base] = {'media0': round(float(beta[0]), 4), 'media1': round(float(beta[1]), 5), 'dp0': round(float(dp0), 4), 'dp1': round(float(dp1), 5),
                     'dpMin': round(float(dpmin), 3), 'n': int(keep.sum())}
        # comparação: FreeSurfer 5.3 nos mesmos sujeitos e ENIGMA (Guadalupe 2017)
        d = {'n': int(keep.sum()), 'excluidos': int((~keep).sum()), 'media': round(float(np.mean(ai[keep])), 2), 'dp': round(float(np.std(ai[keep], ddof=1)), 2),
             'inclinacao_por_decada': round(float(10 * beta[1]), 2)}
        if base in PAR_FS:
            fl = np.array([float(l['fs'].get('Lh' + PAR_FS[base] + 'Vol', np.nan)) for l in linhas], float)
            fr = np.array([float(l['fs'].get('Rh' + PAR_FS[base] + 'Vol', np.nan)) for l in linhas], float)
            okf = (fl > 0) & (fr > 0)
            aif = 200 * (fl[okf] - fr[okf]) / (fl[okf] + fr[okf])
            kf = robusto_ok(aif - np.median(aif))
            d['fs53'] = {'media': round(float(np.mean(aif[kf])), 2), 'dp': round(float(np.std(aif[kf], ddof=1)), 2)}
        if base in gua:
            d['guadalupe2017'] = gua[base]
            out[base]['guadalupe2017'] = gua[base]
        diag[base] = d
    return out, diag


def ref_hoc(linhas):
    t_all = np.array([l['idade'] for l in linhas]) - IDADE_REF
    out = {}
    for lado, pre in (('E', 'Left'), ('D', 'Right')):
        h = np.array([l['ss'].get(pre + '-Hippocampus', np.nan) for l in linhas], float)
        v = np.array([l['ss'].get(pre + '-Inf-Lat-Vent', np.nan) for l in linhas], float)
        ok = (h > 0) & (v >= 0)
        hoc = h[ok] / (h[ok] + v[ok]); t = t_all[ok]
        beta, res = mq_quad(t, hoc)
        keep = robusto_ok(res)
        beta, res = mq_quad(t[keep], hoc[keep])
        X = np.column_stack([np.ones(keep.sum()), t[keep]])
        g, *_ = np.linalg.lstsq(X, np.abs(res), rcond=None)
        k = math.sqrt(math.pi / 2)
        tt = t[keep]
        dpmin = max(0.002, 0.5 * min(k * (g[0] + g[1] * tt.min()), k * (g[0] + g[1] * tt.max())))
        out[lado] = {'media0': round(float(beta[0]), 5), 'media1': round(float(beta[1]), 7), 'media2': round(float(beta[2]), 9),
                     'dp0': round(float(k * g[0]), 5), 'dp1': round(float(k * g[1]), 7), 'dpMin': round(float(dpmin), 4), 'n': int(keep.sum())}
    return out


def externo(args):
    """conjunto externo (adultos jovens do OpenNeuro com FreeSurfer 6.0): volumes SS e FS por medida"""
    if not args.piloto:
        return []
    part = {}
    for tsv in glob.glob(os.path.join(args.piloto_fs, '*_participants.tsv')):
        ds = os.path.basename(tsv).split('_')[0]
        for l in open(tsv).read().splitlines()[1:]:
            c = l.split('\t'); part[f'{ds}_{c[0]}'] = (float(c[2]), c[1].strip(' ,').upper())
    out = []
    for p in sorted(glob.glob(os.path.join(args.piloto, '*.json'))):
        sid = os.path.basename(p)[:-5]
        st = os.path.join(args.piloto_fs, sid + '_aseg.stats')
        if not os.path.exists(st) or sid not in part:
            continue
        r = json.load(open(p))
        m, tab = {}, {}
        for l in open(st):
            if l.startswith('# Measure'):
                f = [x.strip() for x in l[len('# Measure'):].split(',')]; m[f[1]] = float(f[3])
            elif not l.startswith('#') and l.strip():
                c = l.split(); tab[c[4]] = float(c[3])
        fs6 = {'CortexVol': m['CortexVol'], 'CerebralWhiteMatterVol': m['CerebralWhiteMatterVol'], 'SubCortGrayVol': m['SubCortGrayVol'],
               'VentricleVol': sum(tab[k] for k in ('Left-Lateral-Ventricle', 'Right-Lateral-Ventricle', 'Left-Inf-Lat-Vent', 'Right-Inf-Lat-Vent', '3rd-Ventricle', '4th-Ventricle')),
               'TCV': m['CortexVol'] + m['CerebralWhiteMatterVol']}
        for s_, f_ in (('Thalamus', 'Thalamus-Proper'), ('Caudate', 'Caudate'), ('Putamen', 'Putamen'), ('Pallidum', 'Pallidum'), ('Hippocampus', 'Hippocampus'), ('Amygdala', 'Amygdala'), ('Accumbens-area', 'Accumbens-area')):
            for h in ('Left', 'Right'):
                fs6[f'{h}-{s_}'] = tab[f'{h}-{f_}']
        ss = {chave: sum(r['soft'].get(k, 0) for k in rs) for chave, (rs, _) in GLOBAIS.items()}
        idade, sexo = part[sid]
        out.append({'id': sid, 'idade': idade, 'sexo': sexo, 'ss': ss, 'fs': fs6})
    return out


NOMES = {'CortexVol': 'Córtex cerebral', 'CerebralWhiteMatterVol': 'Substância branca cerebral', 'SubCortGrayVol': 'Cinzenta subcortical',
         'VentricleVol': 'Ventrículos', 'TCV': 'Cérebro total (GMV+WMV)'}
PT = {'Thalamus': 'Tálamo', 'Caudate': 'Caudado', 'Putamen': 'Putâmen', 'Pallidum': 'Pálido', 'Hippocampus': 'Hipocampo', 'Amygdala': 'Amígdala',
      'Accumbens-area': 'Accumbens', 'VentralDC': 'Diencéfalo ventral', 'Lateral-Ventricle': 'Ventrículo lateral', 'Inf-Lat-Vent': 'Corno temporal',
      'Cerebral-Cortex': 'Córtex cerebral', 'Cerebral-White-Matter': 'SB cerebral', 'Cerebellum-Cortex': 'Córtex cerebelar', 'Cerebellum-White-Matter': 'SB cerebelar'}


def nome(chave):
    if chave in NOMES:
        return NOMES[chave]
    h, b = chave.split('-', 1)
    return f"{PT.get(b, b)} {'E' if h == 'Left' else 'D'}"


def f1(v, s=True):
    return ('+' if s and v > 0 else '') + f'{v:.1f}'.replace('.', ',').replace('-', '−')


def f2(v, casas=2):
    return f'{v:.{casas}f}'.replace('.', ',').replace('-', '−')


def relatorio_md(caminho, diag, diag_a, hoc):
    L = ['## SynthSeg × FreeSurfer 5.3 editado: o viés de método', '',
         'Viés do SynthSeg = média geométrica de V_SS / V_FS − 1, no total e por terço de idade; r = correlação dos resíduos '
         '(idade e sexo) entre as ferramentas; DP (log, depois de idade e sexo) do SynthSeg, do FreeSurfer e o σ da própria norma nas '
         'mesmas idades; DP individual = DP de log(V_FS/V_SS). A última coluna compara o deslocamento FS/SS de um ajuste só deste lado '
         'com o de E e D juntos — a diferença é o artefato E/D do FreeSurfer do DLBS (ver a tabela de assimetria). Estes números '
         'explicam os z crus; o app não traduz para a escala do FreeSurfer (ver acima).', '',
         '| Medida | n | r | viés SS | viés por terço de idade | DP SS · FS · norma (log) | DP individual | FS/SS só deste lado · E e D juntos |',
         '|---|---:|---:|---:|---|---|---:|---|']
    for k, d in diag.items():
        L.append(f"| {nome(k)} | {d['n']} | {f2(d['r_residuos'])} | {f1(d['vies_ss_pct'])}% | {' · '.join(f1(v) for v in d['vies_ss_pct_tercos'])} | "
                 f"{f2(d['dp_ss_log'], 3)} · {f2(d['dp_fs_log'], 3)} · {f2(d['sigma_norma_log'], 3)} | "
                 f"{f2(d['dp_razao_individual_pct'], 1)}% | {f1(d['fs_ss_so_deste_lado_pct'])}% · {f1(d['fs_ss_lados_juntos_pct'])}% |")
    t = next(iter(diag.values()))['tercos_idade']
    L += ['', f'Terços de idade: até {t[0]:.0f} · {t[0]:.0f}–{t[1]:.0f} · acima de {t[1]:.0f} anos.', '']
    L += ['## Assimetria do mesmo método', '',
          'IA = 200·(E − D)/(E + D) do volume suave do SynthSeg; média e DP por idade no JSON. Comparação com o FreeSurfer 5.3 nos '
          'mesmos sujeitos e com o ENIGMA (Guadalupe et al., Brain Imaging Behav 2017; FreeSurfer 4–5.3; DP intra-dataset).', '',
          '| Estrutura | n | IA médio (SS) | DP (SS) | inclinação/década | IA FS 5.3 | DP FS 5.3 | ENIGMA média ± DP |', '|---|---:|---:|---:|---:|---:|---:|---:|']
    for b, d in diag_a.items():
        fs = d.get('fs53'); g = d.get('guadalupe2017')
        L.append(f"| {PT.get(b, b)} | {d['n']} | {f1(d['media'])} | {f2(d['dp'], 1)} | {f1(d['inclinacao_por_decada'])} | "
                 f"{f1(fs['media']) if fs else '—'} | {f2(fs['dp'], 1) if fs else '—'} | {(f1(g['media']) + ' ± ' + f2(g['dp'], 1)) if g else '—'} |")
    L += ['', '## Ocupação hipocampal (HOC) do mesmo método', '', 'HOC = V_hip / (V_hip + V_corno temporal), volume suave; média quadrática e DP linear na idade.', '',
          '| Lado | n | HOC aos 30 | aos 60 | aos 85 | DP aos 60 |', '|---|---:|---:|---:|---:|---:|']
    for lado, e in hoc.items():
        m = lambda a: e['media0'] + e['media1'] * (a - IDADE_REF) + e['media2'] * (a - IDADE_REF) ** 2
        L.append(f"| {'esquerdo' if lado == 'E' else 'direito'} | {e['n']} | {m(30):.3f} | {m(60):.3f} | {m(85):.3f} | {e['dp0']:.3f} |".replace('.', ','))
    open(caminho, 'w').write('\n'.join(L) + '\n')
    return caminho


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--res', required=True); ap.add_argument('--fs', required=True); ap.add_argument('--selecao', required=True)
    ap.add_argument('--trabalho', required=True, help='pasta (fora do repositório) para os volumes por sujeito e o diagnóstico')
    ap.add_argument('--guadalupe', default=None, help='JSON com as médias do ENIGMA (Guadalupe et al. 2017), só para comparação')
    ap.add_argument('--piloto', default=None, help='resultados do lote em um conjunto externo (<conjunto>_<sujeito>.json)')
    ap.add_argument('--piloto-fs', default=None, help='aseg.stats e <conjunto>_participants.tsv do conjunto externo')
    ap.add_argument('--semente', type=int, default=20260927)
    ap.add_argument('--saida', default=os.path.join(os.path.dirname(__file__), '..', 'models', 'normative'))
    ap.add_argument('--normas', default=os.path.join(os.path.dirname(__file__), '..', 'models', 'normative'), help='pasta com brainchart.json e subcortical.json (σ da norma no diagnóstico)')
    ap.add_argument('--minimo', type=int, default=30, help='mínimo de exames pareados (só para testar o script com menos)')
    args = ap.parse_args()
    rng = np.random.default_rng(args.semente)
    linhas = carregar(args)
    if len(linhas) < args.minimo:
        sys.exit(f'só {len(linhas)} exames com SynthSeg e FreeSurfer — são necessários ≥ {args.minimo}')
    os.makedirs(args.trabalho, exist_ok=True)
    idades = np.array([l['idade'] for l in linhas])
    faixa = [float(idades.min()), float(idades.max())]
    diag = comparar_fs(linhas, 0, rng, args.normas)
    asym, diag_a = ref_assimetria(linhas, args.guadalupe)
    hoc = ref_hoc(linhas)
    fonte = ('Dallas Lifespan Brain Study (OpenNeuro ds004856 v1.3.0, CC0; Park DC et al., Sci Data 2025;12:846) — onda 1, '
             'T1 MPRAGE Philips 3 T; FreeSurfer 5.3 com edição manual e revisão independente (derivatives/brainsummary)')
    import datetime
    comum = {'versao': '1.0', 'gerado': datetime.date.today().isoformat(), 'fonte': fonte, 'fonteCurta': 'DLBS (OpenNeuro ds004856, CC0)', 'n': len(linhas), 'idadeRef': IDADE_REF,
             'idadeFaixa': [round(faixa[0]), round(faixa[1])], 'sexo': {'F': int(sum(l['sexo'] == 'F' for l in linhas)), 'M': int(sum(l['sexo'] == 'M' for l in linhas))}}
    json.dump({**comum,
               'metodo': 'IA = 200·(E − D)/(E + D) do volume suave do SynthSeg 1.0 do SegmentaRM; média linear na idade; DP linear na idade (E|resíduo| = √(2/π)·σ); exclusão de |resíduo| > 5 DP robustos',
               'assimetria': {'estruturas': asym, 'diagnostico': diag_a},
               'hoc': {'definicao': 'HOC = V_hipocampo / (V_hipocampo + V_corno_temporal), volume suave; média quadrática e DP linear na idade', 'lados': hoc}},
              open(os.path.join(args.saida, 'referencia_mesmo_metodo.json'), 'w'), ensure_ascii=False, indent=1)
    # volumes por sujeito (SynthSeg suave e FreeSurfer) para a recentragem em Node, com as normas do app
    pares = [{'id': l['id'], 'idade': l['idade'], 'sexo': l['sexo'],
              'ss': {ch: sum(l['ss'].get(k, 0) for k in rs) for ch, (rs, _) in GLOBAIS.items()},
              'fs': {ch: (sum(float(l['fs'].get(c, float('nan'))) for c in cf)) for ch, (_, cf) in GLOBAIS.items()}} for l in linhas]
    for p in pares:
        p['fs'] = {k: (None if not np.isfinite(v) else v) for k, v in p['fs'].items()}
    json.dump({**comum, 'pares': pares}, open(os.path.join(args.trabalho, 'dlbs_pares.json'), 'w'))
    json.dump({'conjunto': 'OpenNeuro ds000001/ds000005 (FreeSurfer 6.0.1 dos derivados públicos do OpenNeuro; adultos jovens)', 'pares': externo(args)}, open(os.path.join(args.trabalho, 'externo_pares.json'), 'w'))
    json.dump({**comum, 'comparacaoFS': diag, 'assimetria': diag_a, 'hoc': hoc}, open(os.path.join(args.trabalho, 'dlbs_diag.json'), 'w'), ensure_ascii=False, indent=1)
    relatorio_md(os.path.join(args.trabalho, 'dlbs_parte_py.md'), diag, diag_a, hoc)
    print(f"{len(linhas)} exames ({faixa[0]:.0f}–{faixa[1]:.0f} anos) → {args.trabalho}")


if __name__ == '__main__':
    main()
