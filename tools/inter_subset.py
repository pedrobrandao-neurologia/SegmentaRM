#!/usr/bin/env python3
"""Gera as fontes do laudo PDF (fonts/inter/) a partir da Inter 4 estática (SIL OFL 1.1).

Entrada: inter-400.ttf, inter-600.ttf e inter-700.ttf (instâncias estáticas da Inter, por
exemplo as servidas pelo Google Fonts: https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700).
Saída em <destino>:
  Inter-400.ttf / Inter-600.ttf / Inter-700.ttf — subconjunto latino (pt-BR + símbolos do
    laudo) SEM tabelas de layout, com os algarismos tabulares (tnum) já no cmap: o gerador de
    PDF do app (lib/pdf.js) não aplica GSUB, e números em tabela precisam de largura fixa;
  kern.json — pares de kerning da feature 'kern' (GPOS), em milésimos de em.

Uso: python3 tools/inter_subset.py <pasta com inter-*.ttf> fonts/inter
Requer: fonttools.
"""
import json
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

PESOS = (400, 600, 700)
UNI = (list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)) +
       [0x2011, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2030, 0x2032,
        0x2033, 0x2039, 0x203A, 0x20AC, 0x2122, 0x0152, 0x0153, 0x2190, 0x2191, 0x2192, 0x2193,
        0x2194, 0x2212, 0x2248, 0x2260, 0x2264, 0x2265, 0x2009, 0x202F])
# caracteres cujos pares de kerning interessam ao laudo
KCH = [chr(c) for c in list(range(0x21, 0x7F)) + list(range(0xC0, 0x100)) +
       [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0xB7, 0xB3, 0xB2, 0xB0]]


def tnum_no_cmap(f):
    """Troca, no cmap, os algarismos pelos glifos tabulares da feature tnum."""
    gsub = f['GSUB'].table
    tn = {}
    for fr in gsub.FeatureList.FeatureRecord:
        if fr.FeatureTag != 'tnum':
            continue
        for li in fr.Feature.LookupListIndex:
            for st in gsub.LookupList.Lookup[li].SubTable:
                m = getattr(st, 'mapping', None)
                if m:
                    tn.update(m)
    for tb in f['cmap'].tables:
        if tb.isUnicode():
            for cp in range(0x30, 0x3A):
                g = tb.cmap.get(cp)
                if g in tn:
                    tb.cmap[cp] = tn[g]


def pares_kern(f):
    """Pares (caractere, caractere) → ajuste em milésimos de em, da feature kern (GPOS)."""
    cmap = f.getBestCmap()
    g2c = {}
    for ch in KCH:
        g = cmap.get(ord(ch))
        if g:
            g2c.setdefault(g, []).append(ch)
    pares = {}

    def add(g1, g2, v):
        if not v or g1 not in g2c or g2 not in g2c:
            return
        for a in g2c[g1]:
            for b in g2c[g2]:
                pares.setdefault(a + b, v)  # a primeira regra (ordem dos lookups) vence

    def xadv(vr):
        return getattr(vr, 'XAdvance', 0) if vr is not None else 0

    gpos = f['GPOS'].table
    for fr in gpos.FeatureList.FeatureRecord:
        if fr.FeatureTag != 'kern':
            continue
        for li in fr.Feature.LookupListIndex:
            lk = gpos.LookupList.Lookup[li]
            for st in lk.SubTable:
                if lk.LookupType == 9:
                    st = st.ExtSubTable
                if not hasattr(st, 'PairSet') and not hasattr(st, 'Class1Record'):
                    continue
                cov = st.Coverage.glyphs
                if st.Format == 1:
                    for i, g1 in enumerate(cov):
                        for pv in st.PairSet[i].PairValueRecord:
                            add(g1, pv.SecondGlyph, xadv(pv.Value1))
                else:
                    c1 = st.ClassDef1.classDefs
                    sec = {}
                    for g, c in st.ClassDef2.classDefs.items():
                        sec.setdefault(c, []).append(g)
                    for g1 in cov:
                        for ci, rec in enumerate(st.Class1Record[c1.get(g1, 0)].Class2Record):
                            v = xadv(rec.Value1)
                            if v:
                                for g2 in sec.get(ci, []):
                                    add(g1, g2, v)
    upm = f['head'].unitsPerEm
    return {k: round(v * 1000 / upm) for k, v in pares.items()}


def main(src, dst):
    os.makedirs(dst, exist_ok=True)
    kern = {}
    for w in PESOS:
        f = TTFont(os.path.join(src, f'inter-{w}.ttf'))
        kern[str(w)] = ' '.join(f'{k}{v:+d}' for k, v in sorted(pares_kern(f).items())
                                if abs(v) >= 6 and not any(c.isspace() for c in k))
        tnum_no_cmap(f)
        opts = subset.Options()
        opts.layout_features = []
        opts.name_IDs = ['*']
        opts.notdef_outline = True
        opts.hinting = False
        s = subset.Subsetter(opts)
        s.populate(unicodes=UNI)
        s.subset(f)
        f.save(os.path.join(dst, f'Inter-{w}.ttf'))
        print(w, 'glifos', f['maxp'].numGlyphs, 'pares de kerning', len(kern[str(w)].split()))
    with open(os.path.join(dst, 'kern.json'), 'w', encoding='utf-8') as fh:
        json.dump({'fonte': 'Inter 4 (GPOS kern), extraído por tools/inter_subset.py',
                   'unidade': 'milésimos de em (negativo aproxima)',
                   'formato': 'itens separados por espaço: 2 caracteres + valor com sinal',
                   'pares': kern}, fh, ensure_ascii=False)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
