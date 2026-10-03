#!/usr/bin/env python3
"""
Normas próprias, etapa 4 (OFFLINE): relatório de validação docs/validacao/normas.md, gerado por
script a partir de
  - tabela.csv           (tools/normas_preparar.mjs: volumes e z do pipeline atual por exame)
  - loso_z.csv           (tools/normas_ajuste.R: z de cada exame com o seu sítio fora do ajuste)
  - normas_segmentarm.json

  python3 tools/normas_relatorio.py --tabela tabela.csv --loso loso_z.csv \
      --normas models/normative/normas_segmentarm.json --saida docs/validacao/normas.md

Comparação nos MESMOS exames e nos MESMOS sítios deixados de fora:
  própria  = normas SegmentaRM ajustadas sem o sítio (curva populacional, sítio não visto)
  atual    = BrainChart/CentileBrain + recentragem pelo DLBS (o padrão do app até aqui)
  cru      = BrainChart/CentileBrain sem recentragem
A recentragem foi ajustada no DLBS: nesse sítio o "atual" está dentro da amostra; as métricas
saem com e sem o DLBS. Adaptação local: desloca o z pela média de k controles sorteados do próprio
sítio (como a calibração do app) e mede nos demais exames do sítio (200 sorteios).
"""
import argparse, json, math
import numpy as np
import pandas as pd

GLOB = ['CortexVol', 'CerebralWhiteMatterVol', 'SubCortGrayVol', 'VentricleVol', 'TCV']
SUB = ['Thalamus', 'Caudate', 'Putamen', 'Pallidum', 'Hippocampus', 'Amygdala', 'Accumbens-area']
COMUNS = GLOB + [f'{h}-{s}' for s in SUB for h in ('Left', 'Right')]
EXTRAS = [f'{h}-{s}' for s in ('Inf-Lat-Vent', 'Lateral-Ventricle') for h in ('Left', 'Right')] + ['CerebellumVol', 'BrainStemVol', 'vic']
NOMES = {'CortexVol': 'Córtex cerebral', 'CerebralWhiteMatterVol': 'Substância branca', 'SubCortGrayVol': 'Cinzenta subcortical',
         'VentricleVol': 'Ventrículos', 'TCV': 'Cérebro total (GMV+WMV)', 'CerebellumVol': 'Cerebelo', 'BrainStemVol': 'Tronco',
         'vic': 'VIC (eTIV)', 'Thalamus': 'Tálamo', 'Caudate': 'Caudado', 'Putamen': 'Putâmen', 'Pallidum': 'Pálido',
         'Hippocampus': 'Hipocampo', 'Amygdala': 'Amígdala', 'Accumbens-area': 'Accumbens', 'Inf-Lat-Vent': 'Corno temporal',
         'Lateral-Ventricle': 'Ventrículo lateral'}


def nome(k):
    if k in NOMES:
        return NOMES[k]
    h, b = k.split('-', 1)
    return f"{NOMES.get(b, b)} {'E' if h == 'Left' else 'D'}"


def f(v, c=2, sinal=False):
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return '—'
    s = f'{v:+.{c}f}' if sinal else f'{v:.{c}f}'
    return s.replace('-', '−').replace('.', ',')


def pct(v):
    return '—' if v is None or not math.isfinite(v) else f'{100 * v:.1f}'.replace('.', ',') + '%'


def metricas(z, sitios):
    z = pd.Series(z).astype(float)
    ok = z.notna()
    z, s = z[ok], pd.Series(sitios)[ok.values]
    if len(z) < 5:
        return None
    ms = z.groupby(s.values).mean()
    return dict(n=len(z), media=z.mean(), dp=z.std(), fora=(z.abs() > 1.96).mean(),
                rms_sitio=float(np.sqrt((ms ** 2).mean())), abaixo=(z < -1.96).mean(), acima=(z > 1.96).mean())


def adaptacao(df, col, k, B=200, seed=20261003):
    """desloca o z de cada sítio pela média de k controles sorteados e mede nos demais"""
    rng = np.random.default_rng(seed)
    medias, dps, foras = [], [], []
    for s, g in df.groupby('sitio'):
        z = g[col].dropna().values
        if len(z) < k + 10:
            continue
        for _ in range(B):
            i = rng.permutation(len(z))
            zz = z[i[k:]] - z[i[:k]].mean()
            medias.append(zz.mean()); dps.append(zz.std(ddof=1)); foras.append((np.abs(zz) > 1.96).mean())
    if not medias:
        return None
    return dict(rms=float(np.sqrt(np.mean(np.square(medias)))), dp=float(np.mean(dps)), fora=float(np.mean(foras)))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--tabela', required=True); ap.add_argument('--loso', required=True)
    ap.add_argument('--normas', required=True); ap.add_argument('--saida', required=True)
    a = ap.parse_args()
    t = pd.read_csv(a.tabela)
    L = pd.read_csv(a.loso)
    N = json.load(open(a.normas))
    zp = L.pivot_table(index='id', columns='fenotipo', values='z')
    t = t.set_index('id')
    t['decada'] = (t.idade // 10 * 10).clip(upper=80).astype(int)
    linhas = []
    w = linhas.append

    w('# Normas SegmentaRM — validação deixando um sítio de fora')
    w('')
    w(f"Gerado por `tools/normas_relatorio.py` em {N.get('gerado', '')} (normas versão {N.get('versao', '')}). "
      'Não edite à mão: rode o pipeline de `docs/normas-proprias.md` §4.')
    w('')
    w('## 1. Amostra')
    w('')
    w(f"{len(t)} exames de {t.sitio.nunique()} sítios (sítio = scanner × protocolo); "
      f"idades {f(t.idade.min(), 0)}–{f(t.idade.max(), 0)} anos; {int((t.sexo == 'F').sum())} F / {int((t.sexo == 'M').sum())} M. "
      'Volumes SUAVES do SynthSeg 1.0 do app (bloco 128³, espelhamento E/D); VIC = eTIV afim do app.')
    w('')
    w('| Sítio | Base | Scanner | n | Idades | F/M |')
    w('|---|---|---|---|---|---|')
    for s, g in t.groupby('sitio'):
        w(f"| {s} | {g.base.iloc[0]} | {g.fabricante.iloc[0]} {g.modelo.iloc[0] if isinstance(g.modelo.iloc[0], str) else ''} {f(g.campo.iloc[0], 0) if pd.notna(g.campo.iloc[0]) else ''}T | {len(g)} | "
          f"{f(g.idade.min(), 0)}–{f(g.idade.max(), 0)} | {int((g.sexo == 'F').sum())}/{int((g.sexo == 'M').sum())} |")
    w('')
    ct = pd.crosstab(t.decada, t.sexo)
    w('Por década (F/M): ' + ' · '.join(f"{d}{'+' if d == 80 else 's'} {int(r.get('F', 0))}/{int(r.get('M', 0))}" for d, r in ct.iterrows()) + '.')
    w('')
    w('## 2. Modelos')
    w('')
    w('GAMLSS por fenótipo: ln V ~ SHASHo (ou normal, pelo BIC); μ = P-spline da idade + sexo + sítio aleatório; '
      'σ = P-spline da idade + sexo. σ_sítio = DP do efeito de sítio; em z, dividido pelo σ aos 60 anos (F). '
      'Erro da curva = erro-padrão do μ populacional por bootstrap de sítios, em z, aos 60 e aos 85 anos.')
    w('')
    w('| Fenótipo | Família | n | Excluídos (\\|z\\| > 5) | σ_sítio (z) | Erro da curva 60 / 85 anos (z) |')
    w('|---|---|---|---|---|---|')
    I = N['idades']
    for k, e in N['fenotipos'].items():
        s60 = e['F']['sigma'][I.index(60)]
        ep = e.get('epMuZ')
        epx = f"{f(ep['F'][I.index(60)])} / {f(ep['F'][I.index(85)])}" if ep else '—'
        w(f"| {nome(k)} | {e['familia']} | {e['n']} | {e['excluidos']} | {f(e['sigmaSitio'] / s60)} | {epx} |")
    w('')

    # ---- comparação
    df = t.join(zp, how='left')
    w('## 3. Sítio não visto: própria × pipeline atual')
    w('')
    w('Mesmos exames, cada sítio com n ≥ 10 deixado de fora do ajuste das normas próprias. Ideal num sítio '
      'não visto: média ≈ 0, DP ≈ √(1 + σ_sítio²) e |z| > 1,96 em ≈ 5% × o excesso pelo sítio. "RMS sítio" = '
      'raiz da média dos quadrados das médias por sítio (viés típico de um sítio). A recentragem do pipeline '
      'atual foi ajustada no DLBS, por isso as métricas saem também sem ele.')
    w('')
    for semDLBS in (False, True):
        d = df[df.sitio != 'dlbs'] if semDLBS else df
        w(f"### {'Sem o DLBS' if semDLBS else 'Todos os sítios'} ({len(d)} exames)")
        w('')
        w('| Medida | Própria: média · DP · \\|z\\|>1,96 · RMS sítio | Atual (recentrado) | BrainChart/CentileBrain cru |')
        w('|---|---|---|---|')
        agg = {'p': [], 'r': [], 'b': []}
        for k in COMUNS:
            cols = [(k, 'p'), (f'zr_{k}', 'r'), (f'zb_{k}', 'b')]
            cel = []
            for c, tag in cols:
                m = metricas(d[c], d.sitio) if c in d else None
                if m:
                    agg[tag].append(m)
                cel.append('—' if not m else f"{f(m['media'], 2, True)} · {f(m['dp'])} · {pct(m['fora'])} · {f(m['rms_sitio'])}")
            w(f"| {nome(k)} | " + ' | '.join(cel) + ' |')
        res = []
        for tag in ('p', 'r', 'b'):
            ms = agg[tag]
            res.append('—' if not ms else f"{f(np.mean([abs(m['media']) for m in ms]))} · {f(np.mean([m['dp'] for m in ms]))} · {pct(np.mean([m['fora'] for m in ms]))} · {f(np.mean([m['rms_sitio'] for m in ms]))}")
        w('| **Média das medidas** (\\|média\\|) | ' + ' | '.join(f'**{x}**' for x in res) + ' |')
        w('')
    w('Medidas só das normas próprias (sem equivalente no pipeline atual):')
    w('')
    w('| Medida | média · DP · \\|z\\|>1,96 · RMS sítio |')
    w('|---|---|')
    for k in EXTRAS:
        m = metricas(df[k], df.sitio) if k in df else None
        if m:
            w(f"| {nome(k)} | {f(m['media'], 2, True)} · {f(m['dp'])} · {pct(m['fora'])} · {f(m['rms_sitio'])} |")
    w('')

    # ---- subgrupos
    w('## 4. Por década, sexo e fabricante (sítio não visto)')
    w('')
    chaves = ['CortexVol', 'TCV', 'VentricleVol', 'Left-Hippocampus', 'Right-Hippocampus']
    for grupo, rot in (('decada', 'Década'), ('sexo', 'Sexo'), ('fabricante', 'Fabricante')):
        w(f'| {rot} | n | ' + ' | '.join(f'{nome(k)}: própria / atual' for k in chaves) + ' |')
        w('|---|---|' + '---|' * len(chaves))
        for gv, g in df.groupby(grupo):
            cel = []
            for k in chaves:
                p = g[k].dropna() if k in g else pd.Series(dtype=float)
                r = g[f'zr_{k}'].dropna() if f'zr_{k}' in g else pd.Series(dtype=float)
                cel.append(f"{f(p.mean(), 2, True)} ({f(p.std())}) / {f(r.mean(), 2, True)} ({f(r.std())})" if len(p) > 2 else '—')
            rot_g = f'{gv}+' if grupo == 'decada' and gv == 80 else (f'{gv}s' if grupo == 'decada' else gv)
            w(f"| {rot_g} | {len(g)} | " + ' | '.join(cel) + ' |')
        w('')
    w('Valores: média do z (DP).')
    w('')

    # ---- adaptação
    w('## 5. Com controles locais (calibração do app)')
    w('')
    w('O z de cada sítio é deslocado pela média de k controles sorteados do próprio sítio; métricas nos demais '
      'exames do sítio (sítios com n ≥ k + 10; 200 sorteios). Ideal: RMS da média → 0, DP → 1, |z| > 1,96 → 5%.')
    w('')
    w('| k | Própria: RMS média · DP · \\|z\\|>1,96 | Atual (recentrado) |')
    w('|---|---|---|')
    for k in (0, 5, 10, 20, 30):
        cel = []
        for pref in ('', 'zr_'):
            ms = []
            for c in COMUNS:
                col = pref + c
                if col not in df:
                    continue
                if k == 0:
                    m = metricas(df[col], df.sitio)
                    if m:
                        ms.append(dict(rms=m['rms_sitio'], dp=m['dp'], fora=m['fora']))
                else:
                    m = adaptacao(df.reset_index(), col, k)
                    if m:
                        ms.append(m)
            cel.append('—' if not ms else f"{f(np.mean([m['rms'] for m in ms]))} · {f(np.mean([m['dp'] for m in ms]))} · {pct(np.mean([m['fora'] for m in ms]))}")
        w(f"| {k if k else 'sem'} | " + ' | '.join(cel) + ' |')
    w('')
    w('Médias sobre as medidas comuns (globais e subcorticais E/D).')
    w('')
    w('## 6. Leitura')
    w('')
    w('Ver a seção "Validação" de `docs/normas-proprias.md` para a interpretação e as limitações.')
    open(a.saida, 'w').write('\n'.join(linhas) + '\n')
    print('→', a.saida)


if __name__ == '__main__':
    main()
