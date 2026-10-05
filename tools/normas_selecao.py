#!/usr/bin/env python3
"""
Manifesto do nível A das normas próprias (docs/normas-proprias.md): exames T1 de adultos saudáveis
em bases CC0 do OpenNeuro, baixados anonimamente do S3 público
(https://s3.amazonaws.com/openneuro.org/<ds>/). Nada aqui roda no app.

  python3 tools/normas_selecao.py --cache <pasta> --saida manifesto.json [--dlbs selecao_dlbs.json]

A pasta de cache guarda participants.tsv, a listagem do S3 e os sidecars JSON (baixados se
faltarem). Para cada base: inclusão de saudáveis, primeira sessão, aquisição padrão; o SÍTIO é
scanner × protocolo (o que o modelo trata como efeito aleatório). Dentro do sítio, amostragem
estratificada por faixa de 5 anos e sexo (semente fixa), até a cota. A ordem final intercala os
sítios na proporção das cotas e, dentro de cada sítio, as faixas etárias: qualquer prefixo do
lote cobre todos os sítios e a faixa etária toda (o lote pode parar a qualquer momento).

Fica de fora, de propósito:
  - LEMON (ds000221): idade só em faixas de 5 anos e T1 MP2RAGE (contraste e ruído de fundo
    diferentes do MPRAGE/SPGR);
  - ON-Harmony (ds004712): reservado para validar o efeito de scanner;
  - MR-ART com movimento (acq-headmotion1/2): servem para testar o QC, não para a norma.
O DLBS (ds004856) entra pela seleção já usada na recentragem (tools/dlbs_selecao.py, --dlbs).
"""
import argparse, json, os, re, ssl, urllib.parse, urllib.request
import numpy as np
import pandas as pd

S3 = 'https://s3.amazonaws.com/openneuro.org'
CTX = ssl.create_default_context(cafile=os.environ.get('SSL_CERT_FILE') or None)

# base → licença, DOI e metadados do scanner quando o sidecar não traz
BASES = {
    'ds007522': dict(nome='PAN / Healthy Minds for Life', doi='10.18112/openneuro.ds007522'),
    'ds005752': dict(nome='NIMH Healthy Research Volunteer', doi='10.18112/openneuro.ds005752'),
    'ds003592': dict(nome='Neurocognitive aging (Setton et al.)', doi='10.18112/openneuro.ds003592',
                     fabricante='Siemens', modelo='3T (incerto)', campo=3),
    'ds000030': dict(nome='UCLA LA5c (controles)', doi='10.18112/openneuro.ds000030',
                     fabricante='Siemens', modelo='Trio', campo=3),
    'ds004173': dict(nome='MR-ART (aquisição padrão)', doi='10.18112/openneuro.ds004173'),
    'ds002785': dict(nome='AOMIC PIOP1', doi='10.18112/openneuro.ds002785',
                     fabricante='Philips', modelo='Achieva', campo=3),
    'ds002790': dict(nome='AOMIC PIOP2', doi='10.18112/openneuro.ds002790',
                     fabricante='Philips', modelo='Achieva', campo=3),
    'ds003097': dict(nome='AOMIC ID1000', doi='10.18112/openneuro.ds003097',
                     fabricante='Philips', modelo='Intera', campo=3),
    'ds004856': dict(nome='Dallas Lifespan Brain Study', doi='10.18112/openneuro.ds004856',
                     fabricante='Philips', modelo='Achieva', campo=3),
}
# cotas por sítio (exames novos); o DLBS já processado entra inteiro
COTAS = {
    'pan_atlanta': 50, 'pan_baltimore': 50, 'pan_miami': 50, 'pan_tucson': 50,
    'nimh_mprage': 40, 'nimh_fspgr': 20,
    'ds3592_s1': 35, 'ds3592_s2': 25,
    'la5c': 30, 'mrart': 40,
    'aomic_piop1': 15, 'aomic_piop2': 15, 'aomic_id1000': 20,
}


def get(url):
    return urllib.request.urlopen(url, context=CTX, timeout=60).read()


def cache(pasta, nome, url):
    p = os.path.join(pasta, nome)
    if not os.path.exists(p):
        open(p, 'wb').write(get(url))
    return p


def listar(pasta, ds):
    p = os.path.join(pasta, ds + '.keys.json')
    if os.path.exists(p):
        return [k for k, _ in json.load(open(p))]
    tok, out = None, []
    while True:
        q = {'list-type': '2', 'prefix': ds + '/', 'max-keys': '1000'}
        if tok:
            q['continuation-token'] = tok
        x = get(S3 + '?' + urllib.parse.urlencode(q)).decode()
        out += re.findall(r'<Key>([^<]*)</Key>.*?<Size>(\d+)</Size>', x)
        m = re.search(r'<NextContinuationToken>([^<]*)<', x)
        if not m:
            break
        tok = m.group(1)
    json.dump(out, open(p, 'w'))
    return [k for k, _ in out]


def sidecar(pasta, chave):
    nome = chave.replace('/', '__')
    try:
        return json.load(open(cache(pasta, nome, f'{S3}/{chave}')))
    except Exception:
        return {}


def participantes(pasta, ds):
    return pd.read_csv(cache(pasta, ds + '.participants.tsv', f'{S3}/{ds}/participants.tsv'),
                       sep='\t', dtype={'participant_id': str})


def sexo(v):
    v = str(v).strip().lower()
    return 'F' if v in ('f', 'female', 'woman') else 'M' if v in ('m', 'male', 'man') else None


def candidatos(pasta):
    """→ DataFrame: base, sujeito, sitio, idade, sexo, chave (T1 no S3)"""
    linhas = []

    def add(ds, sitio, sub, idade, sx, chave):
        sx = sexo(sx)
        try:
            idade = float(idade)
        except (TypeError, ValueError):
            return
        if sx and np.isfinite(idade) and idade >= 18 and chave:
            linhas.append(dict(base=ds, sujeito=sub, sitio=sitio, idade=idade, sexo=sx, chave=chave))

    # PAN: ses-01 (ou ses-02 quando a linha de base foi refeita), T1 desidentificado; sítio = cidade
    ds = 'ds007522'; ks = set(listar(pasta, ds)); p = participantes(pasta, ds)
    for _, r in p.iterrows():
        sub = r.participant_id
        for ses in ('ses-01', 'ses-02'):
            k = f'{ds}/{sub}/{ses}/anat/{sub}_{ses}_rec-defaced_T1w.nii.gz'
            if k in ks:
                add(ds, 'pan_' + str(r.site).lower(), sub, r.age, r.sex, k)
                break
    # NIMH: GE MR750; dois protocolos de T1 (ABCD MPRAGE e ADNI-3 IR-FSPGR) = dois sítios.
    # Usa a reconstrução SCIC (correção de intensidade do console), que existe nos dois
    ds = 'ds005752'; ks = set(listar(pasta, ds)); p = participantes(pasta, ds)
    for _, r in p.iterrows():
        sub = r.participant_id
        for acq, sitio in (('MPRAGE', 'nimh_mprage'), ('FSPGR', 'nimh_fspgr')):
            k = f'{ds}/{sub}/ses-01/anat/{sub}_ses-01_acq-{acq}_rec-SCIC_T1w.nii.gz'
            if k in ks:
                add(ds, sitio, sub, r.age, r.sex, k)
                break
    # Setton et al.: 2 sítios (Cornell e York), jovens e idosos saudáveis
    ds = 'ds003592'; ks = set(listar(pasta, ds)); p = participantes(pasta, ds)
    for _, r in p.iterrows():
        sub = r.participant_id
        k = f'{ds}/{sub}/ses-1/anat/{sub}_ses-1_T1w.nii.gz'
        if k in ks:
            add(ds, f'ds3592_s{int(r.site)}', sub, r.age, r.sex, k)
    # LA5c: só controles
    ds = 'ds000030'; ks = set(listar(pasta, ds)); p = participantes(pasta, ds)
    for _, r in p[p.diagnosis == 'CONTROL'].iterrows():
        sub = r.participant_id
        k = f'{ds}/{sub}/anat/{sub}_T1w.nii.gz'
        if k in ks:
            add(ds, 'la5c', sub, r.age, r.gender, k)
    # MR-ART: só a aquisição padrão (sem movimento induzido)
    ds = 'ds004173'; ks = set(listar(pasta, ds)); p = participantes(pasta, ds)
    for _, r in p.iterrows():
        sub = r.participant_id
        k = f'{ds}/{sub}/anat/{sub}_acq-standard_T1w.nii.gz'
        if k in ks:
            add(ds, 'mrart', sub, r.age, r.sex, k)
    # AOMIC: âncora dos jovens
    for ds, sitio, sufixo in (('ds002785', 'aomic_piop1', '_T1w'), ('ds002790', 'aomic_piop2', '_T1w'),
                              ('ds003097', 'aomic_id1000', '_run-1_T1w')):
        ks = set(listar(pasta, ds)); p = participantes(pasta, ds)
        for _, r in p.iterrows():
            sub = r.participant_id
            k = f'{ds}/{sub}/anat/{sub}{sufixo}.nii.gz'
            if k in ks:
                add(ds, sitio, sub, r.age, r.sex, k)
    return pd.DataFrame(linhas)


def estratificar(d, cota, rng):
    """amostra até `cota` exames, igual por faixa de 5 anos (o que sobra vai às faixas cheias),
    sexo alternado; devolve em ordem intercalada por faixa (qualquer prefixo cobre as idades)"""
    d = d.copy(); d['faixa'] = (d.idade // 5).astype(int)
    faixas = sorted(d.faixa.unique())
    grupos = {f: [] for f in faixas}
    for f in faixas:
        g = d[d.faixa == f]
        por_sexo = [g[g.sexo == s].sample(frac=1, random_state=int(rng.integers(1e9))) for s in ('F', 'M')]
        alt = []
        for i in range(max(len(x) for x in por_sexo)):
            for x in por_sexo:
                if i < len(x):
                    alt.append(x.iloc[i])
        grupos[f] = alt
    escolhidos = {f: [] for f in faixas}
    n = 0
    while n < min(cota, len(d)):
        for f in faixas:
            if n >= cota:
                break
            if len(escolhidos[f]) < len(grupos[f]):
                escolhidos[f].append(grupos[f][len(escolhidos[f])]); n += 1
    ordem = []
    for i in range(max(len(v) for v in escolhidos.values())):
        for f in faixas:
            if i < len(escolhidos[f]):
                ordem.append(escolhidos[f][i])
    return pd.DataFrame(ordem)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cache', required=True); ap.add_argument('--saida', default='manifesto.json')
    ap.add_argument('--dlbs', default=None, help='selecao.json do tools/dlbs_selecao.py (entra inteiro)')
    ap.add_argument('--semente', type=int, default=20261003)
    ap.add_argument('--sem-sidecar', action='store_true', help='não baixa os sidecars (scanner)')
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    rng = np.random.default_rng(a.semente)
    c = candidatos(a.cache)
    por_sitio = {}
    for s, cota in COTAS.items():
        d = c[c.sitio == s]
        if len(d):
            por_sitio[s] = estratificar(d, cota, rng)
    # intercalação ponderada (round-robin suave) entre sítios
    fila, peso, pos, ordem = list(por_sitio), {s: len(v) for s, v in por_sitio.items()}, {s: 0 for s in por_sitio}, []
    credito = {s: 0.0 for s in fila}; total = sum(peso.values())
    while len(ordem) < total:
        for s in fila:
            credito[s] += peso[s] / total
        s = max((s for s in fila if pos[s] < peso[s]), key=lambda s: credito[s])
        credito[s] -= 1; ordem.append(por_sitio[s].iloc[pos[s]]); pos[s] += 1
    out = []
    if a.dlbs:
        meta = BASES['ds004856']
        for o in json.load(open(a.dlbs)):
            n = o['num']
            out.append(dict(id=f"ds004856_{o['id']}", base='ds004856', sujeito=f'sub-{n}', sitio='dlbs',
                            idade=o['idade'], sexo=o['sexo'], fabricante=meta['fabricante'],
                            modelo=meta['modelo'], campo=meta['campo'], licenca='CC0',
                            url=f'{S3}/ds004856/sub-{n}/ses-wave1/anat/sub-{n}_ses-wave1_acq-MPRAGE_run-1_T1w.nii.gz'))
    for r in ordem:
        meta = BASES[r.base]
        sc = {} if a.sem_sidecar else sidecar(a.cache, r.chave.replace('.nii.gz', '.json'))
        fab = sc.get('Manufacturer') or meta.get('fabricante')
        mod = sc.get('ManufacturersModelName') or meta.get('modelo')
        campo = sc.get('MagneticFieldStrength') or meta.get('campo')
        out.append(dict(id=f'{r.base}_{r.sujeito}', base=r.base, sujeito=r.sujeito, sitio=r.sitio,
                        idade=round(float(r.idade), 2), sexo=r.sexo, fabricante=fab, modelo=mod,
                        campo=campo, serie=sc.get('DeviceSerialNumber'), licenca='CC0',
                        url=f'{S3}/{r.chave}'))
    json.dump(out, open(a.saida, 'w'), indent=0, ensure_ascii=False)
    df = pd.DataFrame(out)
    print(len(out), 'exames')
    print(df.groupby('sitio').agg(n=('id', 'size'), idade_min=('idade', 'min'), idade_max=('idade', 'max'),
                                  F=('sexo', lambda x: (x == 'F').sum()), modelo=('modelo', 'first')).to_string())


if __name__ == '__main__':
    main()
