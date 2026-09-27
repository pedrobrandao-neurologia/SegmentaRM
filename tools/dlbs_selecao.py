#!/usr/bin/env python3
"""
Seleção estratificada do Dallas Lifespan Brain Study (OpenNeuro ds004856, CC0) para construir o
tradutor SynthSeg → FreeSurfer e as referências do mesmo método (tools/tradutor_dlbs.py).

  python3 tools/dlbs_selecao.py --participantes participants.tsv --fs Template_Structural_MRI.xlsx \
      --saida selecao.json --urls urls.txt

Fontes (https://s3.amazonaws.com/openneuro.org/ds004856/): participants.tsv;
derivatives/brainsummary/Template_Structural_MRI.xlsx (FreeSurfer 5.3 editado). Cotas por década
(onda 1, com dados de FreeSurfer): 20–29: 15, 30–39: 15, 40–49: 15, 50–59: 25, 60–69: 30,
70–79: 40, ≥ 80: todos — idosos sobre-representados porque é onde o viés entre ferramentas mais
varia (atrofia, hipointensidades da substância branca). Sexo equilibrado dentro da década;
semente fixa. O arquivo de URLs lista os T1 MPRAGE (run-1) para baixar (curl/wget).
"""
import argparse, json
import numpy as np
import pandas as pd

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument('--participantes', required=True); ap.add_argument('--fs', required=True)
ap.add_argument('--saida', default='selecao.json'); ap.add_argument('--urls', default=None)
ap.add_argument('--semente', type=int, default=20260927)
a = ap.parse_args()
p = pd.read_csv(a.participantes, sep='\t')
x = pd.ExcelFile(a.fs)
g1 = x.parse('GlobalVariables-W1')
tem1 = set(g1.loc[g1['HasData'] == 1, 'S#'].astype(int))
p['num'] = p['participant_id'].str.replace('sub-', '').astype(int)
p['a1'] = pd.to_numeric(p['AgeMRI_W1'], errors='coerce')
rng = np.random.default_rng(a.semente)
# sub-752 fica de fora (exclusão da seleção original deste tradutor)
w1 = p[p['num'].isin(tem1) & p['a1'].notna() & (p['num'] != 752)]
cotas = {20: 15, 30: 15, 40: 15, 50: 25, 60: 30, 70: 40, 80: 999}
sel = []
for dec, q in cotas.items():
    d = w1[(w1['a1'] >= dec) & (w1['a1'] < dec + 10)]
    pick = []
    for sx in ('f', 'm'):
        ds = d[d['Sex'] == sx]
        k = min(len(ds), (q + 1) // 2 if q < 999 else len(ds))
        pick += list(ds.sample(n=k, random_state=int(rng.integers(1e9)))['num'])
    if q < 999 and len(pick) < q:
        rest = d[~d['num'].isin(pick)]
        pick += list(rest.sample(n=min(len(rest), q - len(pick)), random_state=1)['num'])
    sel += pick
out = []
for n in sel:
    r = p[p['num'] == n].iloc[0]
    out.append({'id': f'sub-{n}_w1', 'num': int(n), 'onda': 1, 'idade': float(r['a1']), 'sexo': r['Sex'].upper()})
json.dump(out, open(a.saida, 'w'), indent=0)
if a.urls:
    with open(a.urls, 'w') as f:
        for o in out:
            n = o['num']
            f.write(f"https://s3.amazonaws.com/openneuro.org/ds004856/sub-{n}/ses-wave1/anat/sub-{n}_ses-wave1_acq-MPRAGE_run-1_T1w.nii.gz {o['id']}_T1w.nii.gz\n")
print(len(out), 'exames')
