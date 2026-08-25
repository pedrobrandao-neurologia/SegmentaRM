# SegmentaRM

PWA de **segmentação e morfometria cerebral 100% no navegador** — nenhuma imagem sai do
dispositivo, nenhum servidor, nenhuma instalação. Converte **DICOM**, sintetiza um
**MP-RAGE T1 1 mm com a rede SynthSR original** (estilo `recon-all-clinical`), segmenta com
a rede **SynthSeg original** ou com os modelos MeshNet do brainchop, aplica a **parcelação
DKT da FastSurferCNN**, reconstrói **superfícies corticais** com espessura (Fischl–Dale) e
área por região, compara os volumes com as **curvas normativas dos brain charts** por idade
e sexo, e exporta tudo em **CSV, JSON, SPSS (.sav), PDF, NIfTI, malhas .mz3 e pacote .zip**.

> **Uso em pesquisa e ensino.** Não é dispositivo médico, não tem registro ANVISA e não
> substitui leitura radiológica. Confira a segmentação sobre a imagem antes de usar qualquer número.

---

## O fluxo

```
Pasta DICOM ──▶ triagem por série (cabeçalhos) ──▶ leitura direta ou dcm2niix (WASM) ──┐
Arquivo .nii/.nii.gz ──────────────────────────────────────────────────────────────────┤
                                        ▼
                 01 · Exame  (identificação, idade e sexo p/ o normativo)
                                        ▼
                 02 · Qualidade — régua A–D + pré-processamento estilo FSL
                     reorientação RAS · recorte de pescoço · correção de viés ·
                     extração cerebral (BET-like, f ajustável) · normalização
                     (nível C/D aciona também o ramo robusto: reamostragem cúbica)
                                        ▼
                     [opcional] SynthSR — MP-RAGE T1 1 mm sintético (rede original,
                     estilo recon-all-clinical; qualquer contraste/resolução)
                                        ▼
                     Conformação 256³ · 1 mm (estilo FreeSurfer, via NiiVue)
                                        ▼
                 03 · Segmentação — SynthSeg 1.0 (rede original) ou MeshNet (brainchop)
                                        ▼
                 04 · Parcelação DKT — FastSurferCNN (3 vistas) sobre a fita cortical
                                        ▼
                 05 · Superfícies — white/pial por hemisfério + espessura/área por região
                                        ▼
     Estatísticas: volumes, % do encéfalo, hemisférios, lobos, assimetria,
     comparação normativa (percentil/z por idade e sexo) e tabela estilo aparc.stats
                                        ▼
         CSV · JSON · SPSS .sav · PDF · NIfTI (.nii.gz) · malhas .mz3 · .zip · coorte
```

Cada passo é independente: um erro na parcelação ou nas superfícies **nunca** descarta o
resultado anterior.

## Estudos DICOM grandes: triagem por série

Ao abrir uma pasta DICOM (ou arrastá-la), o aplicativo **não converte o estudo inteiro**:
lê apenas os cabeçalhos (~128 KB por arquivo, sem pixel data), agrupa por
`SeriesInstanceUID` e mostra um diálogo para **escolher quais séries abrir** — um estudo
de 4.000 arquivos vira a conversão de uma série de 200. Cada série selecionada é
processada **uma por vez** (o pico de memória é o de uma série, não o do estudo), e
séries não comprimidas (Little Endian) são montadas **corte a corte direto em NIfTI**,
sem passar pelo conversor WASM; as demais vão pelo dcm2niix só com os arquivos daquela
série. Isso elimina o `ArrayBuffer allocation failed` em máquinas com pouca memória.
Mecanismo portado do [LUME](https://github.com/pedrobrandao-neurologia/LUME), do mesmo
autor (`lib/dicom-scan.js`).

## Pré-processamento estilo FSL (portado do Morfo Studio)

A seção **02 · Qualidade** expõe os equivalentes navegador das etapas estruturais
clássicas do FSL (`lib/fsl-prep.js`, portado do
[MorfoStudio](https://github.com/pedrobrandao-neurologia/MorfoStudio)) — as etapas
nativas rodam em Web Worker antes da conformação, e a imagem corrigida alimenta todo o
resto:

| Etapa | Equivalente FSL | Como funciona aqui |
|---|---|---|
| Reorientação RAS | `fslreorient2std` | permutação/flip de eixos pela affine, **sem reamostrar**, no espaço nativo |
| Recorte de pescoço | `robustfov` | perfil de área de primeiro plano (Otsu) no eixo S-I detectado pela affine; mantém 170 mm do topo |
| Correção de viés | `N4`-like | correção homomórfica, garantida **antes** da extração cerebral |
| Extração cerebral | `BET` | modelo de máscara em modo probabilidade, limiar **f configurável**, fechamento + maior componente + cavidades; máscara sobreposta para inspeção; a rede recebe só o cérebro |
| Contraste SC/SB | efeito do `FAST -B` | normalização opcional [p2,p98]→[0,255] dentro da máscara |

Os intermediários (pré-processado nativo, máscara, cérebro extraído) saem em `.nii.gz` e
no `.zip`; o JSON registra a **proveniência** (`preprocessamento`). O
[niimath](https://github.com/rordenlab/niimath) WASM foi avaliado e não integrado (não tem
`fslreorient2std` nem BET; a morfologia já existia em JS) — segue como opção natural para
um `fslmaths` genérico. **Limitações declaradas**: recorte heurístico ≠ robustfov exato;
extração por rede ≠ superfície deformável do BET; mascarar/normalizar muda o domínio visto
pelos MeshNet — compare com e sem as opções.

## Segmentação (passo 03)

### SynthSeg de verdade, no navegador

A opção padrão **SynthSeg 1.0** roda a **rede original** de Billot, Iglesias e
colaboradores ([BBillot/SynthSeg](https://github.com/BBillot/SynthSeg), Apache 2.0): os
pesos oficiais `synthseg_1.0.h5` convertidos para TensorFlow.js com
`tools/convert_synthseg1_tfjs.py` (paridade numérica verificada — argmax concorda em
99,99% com o Keras; float16, 27 MB). O pré-processamento segue o `predict.py` oficial
(RAS, rescale robusto 0,5–99,5, 1 mm). **Diferenças declaradas**: inferência em blocos
com sobreposição (stitching por recorte central), sem test-time flipping nem suavização
de posteriors. Duas camadas ausentes no tfjs foram implementadas em
`lib/tfjs-upsampling3d.js`.

### Modelos MeshNet embarcados (brainchop, MIT)

| Opção na interface | Pasta | Classes |
|---|---|---|
| Aparc+Aseg 104 | `models/model21_104class` | DKT por hemisfério, subcortical E/D, cerebelo córtex/SB E/D, tronco, caloso em 5 segmentos |
| Aparc+Aseg 50 | `models/model30chan50cls` | parcelação sem separar hemisférios |
| Subcortical 18 | `models/model30chan18cls` | aseg compacta |
| Tecidos / Tecidos leve | `models/model20chan3cls` | cinzenta / branca |
| Máscara encefálica | `models/model5_gw_ae` / `model11_gw_ae` | skull stripping (também usado pelo BET) |

Todos com variantes de memória normal/baixa. A primeira execução baixa os pesos; o
service worker guarda tudo e o aplicativo funciona **offline** depois disso.

### SynthSR de verdade — MP-RAGE T1 1 mm sintético (estilo recon-all-clinical)

A caixa **"MP-RAGE sintético 1 mm (SynthSR)"** no passo 02 roda a rede **SynthSR v1.0
original** ([BBillot/SynthSR](https://github.com/BBillot/SynthSR), Apache 2.0; Iglesias
et al., *Science Advances* 2023): os pesos oficiais `SynthSR_v10_210712.h5` convertidos
para tfjs float16 (26 MB, `tools/convert_synthsr_tfjs.py`; paridade numérica com o Keras
máx |Δ| = 0,004 em 128). É a peça central do `recon-all-clinical` (Gopinath et al.,
*Medical Image Analysis* 2025): de **qualquer contraste e resolução** — FLAIR axial de
5 mm, T2, T1 clínico anisotrópico — a rede sintetiza um **MP-RAGE T1 1 mm isotrópico**
que alimenta a conformação, os modelos treinados em T1 (aseg, DKT, tecidos, superfícies)
e a visualização.

A inferência replica o `predict_command_line.py` oficial: reamostragem à grade **RAS
1 mm**, normalização min–max global, UNet de regressão em **blocos com sobreposição**
(o volume inteiro não cabe na GPU do navegador; recorte central no stitching), saída
×255 recortada a [0,128]; opcionalmente com **média do volume espelhado L/R**
(test-time flipping do oficial). Validação: núcleo de bloco real contra a referência da
rede em T1 real, e restauração visível de um T1 degradado a 5 mm (r = 0,95 entre a
síntese do degradado e a do original).

Como no artigo, dois avisos: o **SynthSeg dispensa o SynthSR** (é agnóstico a contraste
e resolução — no `recon-all-clinical` ele segmenta a imagem *original*; o aplicativo
avisa se você combinar os dois), e **morfometria sobre imagem sintética herda o viés da
síntese** — espessuras/volumes de um FLAIR-virado-MPRAGE são estimativas, não medidas;
reporte sempre a sequência de origem (a proveniência vai no JSON/PDF).

### O modo robusto continua clássico

Quando a régua marca C/D, o ramo robusto aplica métodos **clássicos** (reamostragem
cúbica, correção de viés), que não criam informação. Para exame anisotrópico ou de
contraste não-T1, o caminho com rede é a caixa SynthSR acima.

## Parcelação cortical DKT (passo 04) — com o FastSurfer de verdade

Passo separado sobre um resultado **SynthSeg** ou **aseg compacta** pronto — se falhar, a
segmentação permanece intacta. A fusão replica o `--parc` do SynthSeg 2.0
(`seg[máscara de córtex] = parcelação[máscara]`, com propagação modal por vizinhança —
`lib/dkt-fusion.js`).

A **fonte recomendada** é a **FastSurferCNN**
([Deep-MI/FastSurfer](https://github.com/Deep-MI/FastSurfer), Apache 2.0; Henschel et
al., *NeuroImage* 2020): os **checkpoints oficiais v1** (axial/coronal/sagital)
convertidos para tfjs float16 com BatchNorm dobrada (`tools/convert_fastsurfer_tfjs.py`,
3,6 MB por vista; paridade de argmax 99,98% com a referência em fatias reais). É a rede
volumétrica cujo `aparc.DKTatlas+aseg` o recon-surf refina — a inferência replica o
pipeline v1 (fatias espessas de 7 cortes, agregação 0,4·axial + 0,4·coronal +
0,2·sagital em logits), **restrita à fita cortical** (por isso cabe na memória do
navegador); as regiões que a v1 não lateraliza são atribuídas por componente conexo
contra a linha média. Há a opção **axial+coronal** (mais rápida) e a rede DKT do
brainchop como alternativa. Estruturas ausentes num sujeito são aceitas — contagem menor
de rótulos é aviso, não erro.

## Superfícies corticais (passo 05) — o análogo navegador do recon-surf

Sobre um resultado com parcelação DKT, reconstrói as malhas **white** e **pial** por
hemisfério e calcula a tabela estilo `aparc.stats` — **espessura média ± dp, área pial e
volume por região DKT** — no inspetor e em todas as exportações. A pial aparece **no
painel central**, colorida pelas parcelas (chave "Mostrar 3D"). O mapeamento honesto com
o `recon-surf` (que continua sendo binário FreeSurfer, horas de CPU, e **não roda em
navegador**):

| recon-surf | Aqui (`lib/surfaces.js`, Web Worker, segundos) |
|---|---|
| `mri_fill` | máscaras white/pial por hemisfério + fechamento, maior componente, cavidades |
| `mri_mc` / `mri_tessellate` | **surface nets** (malha fechada 2-variedade; esfera-teste: volume −0,6%) |
| `mris_smooth` | **Taubin** λ\|μ, que não encolhe (área da esfera a +0,2% do analítico) |
| `sample_parc` | parcela por vértice amostrando o volume — mesma filosofia do FastSurfer |
| `mris_place_surface` → thickness | **pareamento de superfícies Fischl–Dale** (*PNAS* 2000): T = ½·[d(white→pial) + d(pial→white)], vértice a vértice entre as malhas suavizadas (fantasma de 3 mm: 2,77) |
| `mris_anatomical_stats` | espessura/área/volume por região |
| `mris_sphere` + `mris_register` | **não existe** — análise vertex-wise entre sujeitos exige o FreeSurfer/FastSurfer reais |

A espessura usa a definição do FreeSurfer (média dos dois sentidos entre white e pial),
mas sobre malhas derivadas da segmentação — sem o posicionamento sub-voxel nem a correção
de topologia do `mris_place_surface`; aproximação de triagem, declarada no relatório.

## Comparação normativa (QC, não clínico)

Informando **idade e sexo**, os volumes são comparados com as curvas populacionais dos
**brain charts** (Bethlehem et al., *Nature* 2022 — modelos GAMLSS oficiais de
[brainchart/Lifespan](https://github.com/brainchart/Lifespan), avaliados offline e
vendorizados em `models/normative/brainchart.json`): **percentil e z-score do previsto**
para volumes globais, **volume cortical por lobo** (E/D e total, após o passo DKT) e
parcelas DKT individuais. |z| ≥ 3 marca achado atípico; **|z| ≥ 4 vira alerta de possível
erro de segmentação** no painel e no PDF. As normas foram ajustadas em volumes FreeSurfer;
os daqui vêm do SynthSeg/DKT — aproximação para triagem, não para uso clínico.

## Exportações

- **CSV** longo (estrutura/agregado/lobo/assimetria/superfície; decimal configurável)
- **JSON** completo (estruturas com centroide RAS, agregados, lobos, assimetria,
  qualidade, proveniência do pré-processamento, normativo, superfície, ressalvas)
- **SPSS `.sav`** — escritor próprio (nomes longos, rótulos em português UTF-8), incluindo
  `thick_*`/`surfarea_*`; abre no SPSS, `haven::read_sav()` e `pyreadstat`
- **PDF** — capa com captura e banner de QC, comparação normativa com réguas de percentil,
  lobos, estruturas, assimetria, superfície cortical e página de métodos
- **NIfTI** — segmentação, conformado e intermediários (pré-processado nativo, máscara,
  cérebro extraído) em `.nii.gz`
- **Malhas** — white/pial em `.mz3` dentro do `.zip`
- **Coorte** — uma linha larga por exame, persistida no navegador → CSV largo e `.sav`

### Usar no R

```r
library(dplyr); library(haven)
vol <- read_sav("coorte_volumes.sav")
vol |> mutate(across(-c(subject, BrainSegVol), ~ .x / BrainSegVol * 100, .names = "pct_{.col}"))
```

---

## Rodar

Precisa de HTTP (módulos ES + service worker não funcionam em `file://`):

```bash
python3 -m http.server 8080     # http://localhost:8080
```

**GitHub Pages:** o repositório é 100% estático — ative Pages na branch e pronto.
Tudo (NiiVue, dcm2niix WASM, TensorFlow.js, modelos, fontes) está vendorizado; não há CDN.

O botão **Exemplo** carrega um T1 real 256³ (do brain2print, MIT) para demonstrar o fluxo.
Após uma atualização do aplicativo, recarregue a página duas vezes (o service worker troca
o cache na segunda visita).

## Estrutura

```
index.html · styles.css · app.js       interface e orquestração
lib/quality.js                         régua de qualidade A–D
lib/dicom-scan.js                      triagem DICOM por série + leitura direta (do LUME)
lib/fsl-prep.js                        reorientação RAS, robustfov, morfologia, normalização
lib/synthseg-core.js                   pré/pós-processamento e tiles do SynthSeg
lib/tfjs-upsampling3d.js               camadas 3D ausentes no tfjs
lib/fastsurfer-core.js                 FastSurferCNN v1 (forward, vistas, LIA, agregação)
lib/synthsr-core.js                    SynthSR: reamostragem RAS 1 mm + blocos de inferência
lib/dkt-fusion.js                      fusão parcelação→córtex (esquema do predict_synthseg)
lib/surfaces.js                        EDT, surface nets, Taubin, áreas, MZ3
lib/normative.js                       percentil/z contra os brain charts
lib/stats.js · lib/labels.js           volumetria, lobos, assimetria, nomes em pt-BR
lib/sav.js · lib/pdf.js · lib/report.js  SPSS, PDF e relatório
lib/nifti-writer.js · lib/zip.js       NIfTI-1 e ZIP
workers/preprocess.worker.js           etapas nativas (FSL-like + ramo robusto)
workers/mask.worker.js                 limpeza da máscara cerebral (BET-like)
workers/synthseg.worker.js             inferência SynthSeg em blocos
workers/synthsr.worker.js              síntese SynthSR (MP-RAGE 1 mm)
workers/fastsurfer.worker.js           parcelação FastSurferCNN por vistas
workers/surface.worker.js              superfícies e espessura Fischl–Dale
brainchop/                             worker de inferência do brain2print (MIT)
models/synthseg1/                      SynthSeg 1.0 em tfjs f16 (27 MB) + rótulos
models/synthsr/                        SynthSR v1.0 em tfjs f16 (26 MB) + fixture de paridade
models/fastsurfer/                     FastSurferCNN v1 f16 (3×3,6 MB) + manifesto
models/normative/brainchart.json       curvas normativas vendorizadas
models/model*/                         MeshNet do brainchop (MIT)
tools/convert_synthseg1_tfjs.py        conversor SynthSeg (reprodutível)
tools/convert_synthsr_tfjs.py          conversor SynthSR (reprodutível)
tools/convert_fastsurfer_tfjs.py       conversor FastSurferCNN (reprodutível, sem torch)
licenses/                              licenças e proveniência dos pesos
vendor/                                NiiVue, dcm2niix WASM, TensorFlow.js, fontes
sw.js · manifest.webmanifest           PWA offline
```

## Interface

Layout de estação de trabalho (inspirado no
[Morfo Studio](https://github.com/pedrobrandao-neurologia/MorfoStudio)): barra superior,
rail esquerdo com os passos 01–05, **visualizador no centro** com HUD (janelamento
automático por percentis + botão **"janela"** para ajuste manual por arrasto — ↔
contraste, ↕ brilho, duplo clique volta ao automático), inspetor à direita e log no
rodapé. O visualizador **se recupera sozinho de perda de contexto WebGL** (comum após
inferência pesada na GPU — era a causa da tela branca). Tema escuro grafite/osso/
vermelho-córtex com princípios das HIG da Apple e equivalentes para
`prefers-reduced-motion`, `prefers-reduced-transparency` e `prefers-contrast: more`.

## Limites

- **Sem registro esférico** (`sphere.reg`): comparação vertex-wise entre sujeitos e QC por
  número de Euler da tesselagem original exigem FreeSurfer/FastSurfer reais. A espessura
  daqui usa a definição Fischl–Dale sobre malhas derivadas da segmentação, sem
  posicionamento sub-voxel — boa para triagem por região, não para efeitos sutis.
- **Morfometria sobre SynthSR é estimativa**: a rede restaura um MP-RAGE plausível, mas
  números medidos numa imagem sintetizada de FLAIR/T2/T1 espesso carregam o viés da
  síntese (Gopinath et al., 2025). Use para viabilizar a análise de exames clínicos,
  reportando a sequência de origem — não para comparar com números de T1 nativo.
- **Memória/GPU**: a inferência usa WebGL; em GPUs integradas use os modelos compactos ou
  memória baixa. CPU funciona, mas é lenta (SynthSeg/FastSurfer em CPU levam dezenas de
  minutos). Em estudos DICOM grandes, use a triagem para abrir só o necessário.
- **DICOM**: a leitura direta cobre séries Little Endian não comprimidas; JPEG etc. passam
  pelo dcm2niix WASM; séries muito exóticas podem exigir conversão prévia.
- Os modelos foram treinados em **T1** (o SynthSeg tolera outros contrastes por desenho);
  a régua de qualidade avisa quando a entrada foge do domínio.
- **Não misture pipelines na mesma coorte**: os volumes daqui têm vieses sistemáticos
  próprios (como qualquer pipeline) — reprocesse todos os sujeitos do mesmo jeito.

## Créditos

- **SynthSeg** — Billot, Greve, Puonti, Thielscher, Van Leemput, Fischl, Dalca, Iglesias
  ([BBillot/SynthSeg](https://github.com/BBillot/SynthSeg), Apache 2.0): pesos originais
  `synthseg_1.0.h5` convertidos para tfjs. Cite *SynthSeg: Segmentation of brain MRI scans
  of any contrast and resolution without retraining* (Medical Image Analysis, 2023).
- **SynthSR** — Iglesias, Billot, Balbastre, Magdamo, Arnold, Das, Edlow, Alexander,
  Golland, Fischl ([BBillot/SynthSR](https://github.com/BBillot/SynthSR), Apache 2.0):
  pesos originais `SynthSR_v10_210712.h5` convertidos para tfjs
  (`licenses/synthsr.txt`). Cite *SynthSR: A public AI tool to turn heterogeneous
  clinical brain scans into high-resolution T1-weighted images for 3D morphometry*
  (Science Advances, 2023) e, para o fluxo completo, *"Recon-all-clinical": Cortical
  surface reconstruction and analysis of heterogeneous clinical brain MRI* (Gopinath et
  al., Medical Image Analysis, 2025).
- **FastSurfer** — Henschel, Conjeti, Estrada, Diers, Fischl, Reuter
  ([Deep-MI/FastSurfer](https://github.com/Deep-MI/FastSurfer), Apache 2.0): checkpoints
  oficiais do FastSurferCNN v1 convertidos para tfjs (`licenses/fastsurfer.txt`). Cite
  *FastSurfer — A fast and accurate deep learning based neuroimaging pipeline*
  (NeuroImage, 2020).
- **Brain charts** — Bethlehem, Seidlitz, White et al.
  ([brainchart/Lifespan](https://github.com/brainchart/Lifespan)). Cite *Brain charts for
  the human lifespan* (Nature, 2022).
- **brainchop** — Masoud, Hu & Plis (MIT); **brain2print** — grupo de Chris Rorden (MIT):
  worker de inferência e modelos MeshNet.
- **NiiVue** e **dcm2niix** — Rorden e colaboradores.
- **LUME** e **Morfo Studio** — projetos do mesmo autor; triagem DICOM e pré-processamento
  FSL portados de lá.
- Linhagem conceitual: **SynthSeg / SynthSR / recon-all-clinical** — Billot, Gopinath,
  Iglesias e colaboradores, Martinos Center (MGH/Harvard). Cite os artigos originais em
  trabalhos que usem as segmentações.
