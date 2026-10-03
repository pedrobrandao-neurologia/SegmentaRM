#!/usr/bin/env python3
"""
Manifesto de exames LOCAIS para as normas próprias (docs/normas-proprias.md): bases de acesso
condicionado que o próprio usuário obteve depois de aceitar os termos (nível B, como o OASIS-3)
ou controles saudáveis do próprio serviço. Nada é baixado aqui: os T1 já estão no disco do
usuário, o lote (tools/normas_lote.mjs) os lê no lugar e guarda só os volumes. Nenhum exame,
caminho de arquivo ou identificador vai para o repositório: o manifesto e os resultados ficam
na pasta de trabalho do usuário, e o JSON das normas leva só coeficientes agregados.

Modo genérico (controles do serviço ou qualquer base já organizada):
  python3 tools/normas_local.py --csv controles.csv --base servico --saida manifesto_local.json
  colunas do CSV: arquivo, idade, sexo (F/M), sitio [, sujeito, fabricante, modelo, campo]

Modo OASIS-3 (exige o Data Use Agreement do OASIS aceito pelo próprio usuário em oasis-brains.org):
  python3 tools/normas_local.py --oasis3 <pasta dos NIfTI> --demografia OASIS3_demographics.csv \
      --cdr OASIS3_UDSb4_cdr.csv --saida manifesto_oasis3.json [--estavel] [--janela 365]
  - T1: arquivos *_T1w.nii(.gz) com sujeito OAS3xxxx e sessão d#### no nome (sub-OAS30001_ses-d0129_…
    ou OAS30001_MR_d0129/…); o sidecar .json ao lado dá o scanner (sítio = modelo × campo);
  - cognitivamente normal: CDR global 0 na visita clínica mais próxima do exame, a até --janela
    dias; com --estavel, CDR 0 também em TODAS as visitas posteriores (exclui quem progrediu —
    reduz o Alzheimer pré-clínico entre os idosos, à custa de n);
  - idade no exame = idade na entrada + dias desde a entrada / 365,25; um exame por pessoa (o
    primeiro que cumpre o critério; a primeira aquisição T1 da sessão).
  Os nomes das colunas das planilhas mudaram entre versões do OASIS-3: o script procura vários
  nomes conhecidos e, se não achar, para e lista as colunas disponíveis (use --col-* para indicar).
  CONFIRA a codificação do sexo (--sexo-masculino, padrão 1) contra a documentação da sua cópia.

Depois:  node tools/normas_lote.mjs manifesto_oasis3.json <resultados>
         node tools/normas_preparar.mjs <resultados (todos)> tabela.csv
         Rscript tools/normas_ajuste.R tabela.csv models/normative/normas_segmentarm.json <validação>
"""
import argparse, glob, json, os, re
import pandas as pd

OASIS3_AGRADECIMENTO = ('Data were provided in part by OASIS-3: Longitudinal Multimodal Neuroimaging. Principal '
                        'Investigators: T. Benzinger, D. Marcus, J. Morris; NIH P30 AG066444, P50 AG00561, '
                        'P30 NS09857781, P01 AG026276, P01 AG003991, R01 AG043434, UL1 TR000448, R01 EB009352.')


def coluna(df, opcoes, nome, forcada=None):
    if forcada:
        if forcada not in df.columns:
            raise SystemExit(f'coluna "{forcada}" não existe; disponíveis: {list(df.columns)}')
        return forcada
    low = {c.lower(): c for c in df.columns}
    for o in opcoes:
        if o.lower() in low:
            return low[o.lower()]
    raise SystemExit(f'não achei a coluna de {nome} (tentei {opcoes}); disponíveis: {list(df.columns)} — use --col-{nome}')


def scanner(arq):
    js = re.sub(r'\.nii(\.gz)?$', '.json', arq)
    try:
        d = json.load(open(js))
    except Exception:
        return None, None, None
    return d.get('Manufacturer'), d.get('ManufacturersModelName'), d.get('MagneticFieldStrength')


def sitio_de(fab, mod, campo):
    t = '_'.join(str(x) for x in (fab, mod, f'{campo}T' if campo else None) if x)
    return re.sub(r'[^a-z0-9]+', '_', t.lower()).strip('_') or 'desconhecido'


def modo_csv(a):
    d = pd.read_csv(a.csv)
    out = []
    for i, r in d.iterrows():
        sx = str(r['sexo']).strip().upper()[:1]
        if sx not in ('F', 'M') or not (float(r['idade']) >= 18) or not os.path.exists(r['arquivo']):
            print('ignorado (sexo, idade ou arquivo):', i); continue
        fab, mod, campo = scanner(r['arquivo'])
        out.append(dict(id=f"{a.base}_{r.get('sujeito', i)}", base=a.base, sujeito=str(r.get('sujeito', i)),
                        sitio=f"{a.base}_{r['sitio']}", idade=float(r['idade']), sexo=sx,
                        fabricante=r.get('fabricante', fab), modelo=r.get('modelo', mod), campo=r.get('campo', campo),
                        licenca=a.licenca, arquivo=os.path.abspath(r['arquivo'])))
    return out


def modo_oasis3(a):
    dem = pd.read_csv(a.demografia)
    cdr = pd.read_csv(a.cdr)
    cs = coluna(dem, ['OASISID', 'Subject', 'subject_id'], 'sujeito', a.col_sujeito)
    ci = coluna(dem, ['AgeatEntry', 'Age at Entry', 'age_at_entry'], 'idade', a.col_idade)
    cg = coluna(dem, ['GENDER', 'M/F', 'sex', 'Gender'], 'sexo', a.col_sexo)
    ks = coluna(cdr, ['OASISID', 'Subject', 'subject_id'], 'sujeito', a.col_sujeito)
    kd = coluna(cdr, ['days_to_visit', 'days_since_entry', 'visit_days'], 'dias', a.col_dias)
    kc = coluna(cdr, ['CDRTOT', 'CDRGLOB', 'cdr', 'CDR'], 'cdr', a.col_cdr)
    cdr = cdr[[ks, kd, kc]].dropna()
    cdr.columns = ['suj', 'dias', 'cdr']
    dem = dem.set_index(cs)

    def sexo(v):
        try:
            return 'M' if int(v) == a.sexo_masculino else 'F'
        except (TypeError, ValueError):
            v = str(v).strip().upper()[:1]
            return v if v in ('F', 'M') else None

    vistos, out, motivos = set(), [], {}
    arqs = sorted(glob.glob(os.path.join(a.oasis3, '**', '*_T1w.nii*'), recursive=True))
    for arq in arqs:
        m = re.search(r'(OAS3\d{4}).*?d(\d{4,5})', arq)
        if not m:
            motivos['nome sem sujeito/sessão'] = motivos.get('nome sem sujeito/sessão', 0) + 1; continue
        suj, dias = m.group(1), int(m.group(2))
        if suj in vistos:
            continue
        if suj not in dem.index:
            motivos['sem demografia'] = motivos.get('sem demografia', 0) + 1; continue
        v = cdr[cdr.suj == suj]
        if not len(v):
            motivos['sem CDR'] = motivos.get('sem CDR', 0) + 1; continue
        prox = v.iloc[(v.dias - dias).abs().argsort()[:1]]
        if abs(int(prox.dias.iloc[0]) - dias) > a.janela or float(prox.cdr.iloc[0]) != 0:
            motivos['CDR ≠ 0 ou visita distante'] = motivos.get('CDR ≠ 0 ou visita distante', 0) + 1; continue
        if a.estavel and (v[v.dias > dias].cdr > 0).any():
            motivos['progrediu depois (--estavel)'] = motivos.get('progrediu depois (--estavel)', 0) + 1; continue
        r = dem.loc[suj]
        if isinstance(r, pd.DataFrame):
            r = r.iloc[0]
        idade = float(r[ci]) + dias / 365.25
        sx = sexo(r[cg])
        if not sx or idade < 18:
            continue
        fab, mod, campo = scanner(arq)
        vistos.add(suj)
        out.append(dict(id=f'oasis3_{suj}_d{dias:04d}', base='oasis3', sujeito=suj, sitio='oasis3_' + sitio_de(fab, mod, campo),
                        idade=round(idade, 2), sexo=sx, fabricante=fab, modelo=mod, campo=campo,
                        licenca='OASIS-3 Data Use Agreement', agradecimento=OASIS3_AGRADECIMENTO,
                        arquivo=os.path.abspath(arq)))
    print(f'{len(arqs)} T1 encontrados; {len(out)} pessoas incluídas; exclusões: {motivos}')
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--saida', required=True)
    ap.add_argument('--csv'); ap.add_argument('--base', default='local'); ap.add_argument('--licenca', default='uso local (não redistribuir)')
    ap.add_argument('--oasis3'); ap.add_argument('--demografia'); ap.add_argument('--cdr')
    ap.add_argument('--estavel', action='store_true'); ap.add_argument('--janela', type=int, default=365)
    ap.add_argument('--sexo-masculino', type=int, default=1)
    for c in ('sujeito', 'idade', 'sexo', 'dias', 'cdr'):
        ap.add_argument(f'--col-{c}', default=None)
    a = ap.parse_args()
    if a.oasis3:
        if not (a.demografia and a.cdr):
            raise SystemExit('--oasis3 exige --demografia e --cdr')
        out = modo_oasis3(a)
    elif a.csv:
        out = modo_csv(a)
    else:
        raise SystemExit('use --csv ou --oasis3')
    json.dump(out, open(a.saida, 'w'), indent=0, ensure_ascii=False)
    if out:
        d = pd.DataFrame(out)
        d['decada'] = (d.idade // 10 * 10).astype(int)
        print(d.groupby(['sitio']).size().to_string())
        print(pd.crosstab(d.decada, d.sexo).to_string())
    print('→', a.saida)


if __name__ == '__main__':
    main()
