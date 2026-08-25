# SegmentaRM

PWA que converte **DICOM**, segmenta o encéfalo e calcula **volumetria por estrutura**
inteiramente no navegador — nenhuma imagem sai do dispositivo. Construído no espírito do
[brainchop](https://github.com/neuroneural/brainchop) e do
[brain2print](https://github.com/niivue/brain2print), mas orientado a relatório volumétrico:
**aparc+aseg com hemisférios, cerebelo (córtex/substância branca E/D), tronco encefálico e
corpo caloso**, com exportação em **CSV, JSON, SPSS (.sav), PDF e NIfTI**.

> **Uso em pesquisa e ensino.** Não é dispositivo médico, não tem registro ANVISA e não
> substitui leitura radiológica. Confira a segmentação sobre a imagem antes de usar qualquer número.

---

## Estudos DICOM grandes: triagem por série

Ao abrir uma pasta DICOM (ou arrastá-la), o aplicativo **não converte o estudo inteiro**:
lê apenas os cabeçalhos (~128 KB por arquivo, sem pixel data), agrupa por
`SeriesInstanceUID` e mostra um diálogo para **escolher quais séries abrir** — um estudo
de 4.000 arquivos vira a conversão de uma série de 200. Cada série selecionada é
processada **uma por vez** (o pico de memória é o de uma série, não o do estudo), e
séries não comprimidas (Little Endian) são montadas **corte a corte direto em NIfTI**,
sem passar pelo conversor WASM — mais rápido e com alocação mínima; as demais vão pelo
dcm2niix só com os arquivos daquela série. Isso elimina o `ArrayBuffer allocation failed`
em máquinas com pouca memória. Mecanismo portado do
[LUME](https://github.com/pedrobrandao-neurologia/LUME), do mesmo autor
(`lib/dicom-scan.js`).

## O fluxo

```
Pasta DICOM ──dcm2niix (WASM)──▶ NIfTI ──┐
Arquivo .nii/.nii.gz ────────────────────┤
                                         ▼
                       Régua de qualidade (A–D)
                       voxel · anisotropia · nº de cortes · FOV · contraste · campo
                                         ▼
              ┌── nível A/B ── pipeline padrão (conformação direta)
              └── nível C/D ── pipeline robusto:
                    reamostragem cúbica Catmull-Rom → isotrópico 1 mm
                    correção homomórfica de campo de viés
                    suavização leve (opcional)
                                         ▼
                    Conformação 256³ · 1 mm (estilo FreeSurfer, via NiiVue)
                                         ▼
                    Segmentação — worker brainchop (MeshNet, TensorFlow.js)
                                         ▼
        Estatísticas: volumes, % do encéfalo, hemisférios, lobos, índice de assimetria
                                         ▼
            CSV · JSON · SPSS .sav · PDF · NIfTI (.nii.gz) · pacote .zip · coorte
```

### SynthSeg de verdade, no navegador

A opção **SynthSeg 1.0** roda a **rede original** de Billot, Iglesias e colaboradores
([BBillot/SynthSeg](https://github.com/BBillot/SynthSeg), Apache 2.0): os pesos oficiais
`synthseg_1.0.h5` foram convertidos para TensorFlow.js com
`tools/convert_synthseg1_tfjs.py` (arquitetura reconstruída camada a camada a partir de
`ext/neuron/models.py`; paridade numérica verificada — argmax concorda em 99,99% com o
Keras, Δ máximo de posterior 0,004 com quantização float16, 27 MB).

O pré-processamento segue o `predict.py` deles: alinhamento a RAS, rescale robusto por
percentis 0,5–99,5 e grade de 1 mm (a conformação 256³ do app). **Diferenças declaradas**
desta versão web: a inferência roda em **blocos com sobreposição** (o volume inteiro não
cabe na memória de GPU do navegador; stitching por recorte central), e ainda não há
test-time flipping nem suavização de posteriors. É isso que dá o caráter
contraste/resolução-agnóstico do método — a rede é a mesma do `mri_synthseg`.

Duas camadas ausentes no tfjs foram implementadas em `lib/tfjs-upsampling3d.js`
(UpSampling3D por repetição e BatchNorm congelado para rank 5).

### Parcelação cortical DKT — agora com o FastSurfer de verdade

A parcelação DKT é um **passo separado** (04 · Parcelação DKT), aplicado sobre um resultado
**SynthSeg** ou **Subcortical 18 (aseg compacta)** já pronto — se algo falhar, a segmentação
feita permanece intacta e não é preciso reprocessar. A fusão replica o `--parc` do
SynthSeg 2.0 (`predict_synthseg.py`: `seg[mask de córtex] = parcelação[mask]`), com
propagação modal por vizinhança para voxels sem parcela (`lib/dkt-fusion.js`).

A **fonte recomendada** da parcelação é a **FastSurferCNN**
([Deep-MI/FastSurfer](https://github.com/Deep-MI/FastSurfer), Apache 2.0; Henschel et al.,
*NeuroImage* 2020) — os **checkpoints oficiais v1** (axial/coronal/sagital,
`Epoch_30_training_state.pkl`) convertidos para tfjs float16 com as BatchNorm dobradas
(`tools/convert_fastsurfer_tfjs.py`, 3,6 MB por vista; paridade numérica verificada:
argmax concorda em 99,98% com a referência, em fatias reais). É exatamente a rede
volumétrica cujo `aparc.DKTatlas+aseg` o **recon-surf** depois refina em superfícies —
o recon-surf em si (malhas, registro esférico, binários C++ do FreeSurfer, horas de CPU)
**não é executável no navegador**; o que se embarca é a parcelação volumétrica que o
alimenta. A inferência replica o `fastsurfer_inference` v1: fatias espessas de 7 cortes,
**agregação de vistas** (0,4·axial + 0,4·coronal + 0,2·sagital, em logits), restrita à
fita cortical da segmentação-fonte (por isso cabe na memória do navegador); as 19 regiões
que a v1 não lateraliza são atribuídas por componente conexo contra a linha média
(adaptação do fix por centroide de substância branca do pipeline oficial). Há uma opção
**axial+coronal** (mais rápida, pesos renormalizados) e a rede DKT do brainchop continua
disponível como alternativa.

No SynthSeg, o hemisfério do córtex vem da própria segmentação (E=2/D=19, a autoridade,
como no mascaramento oficial); na aseg compacta o córtex é bilateral e o hemisfério vem
da parcelação. Estruturas ausentes num sujeito são aceitas — contagem menor de rótulos é
aviso, não erro.

### Superfícies corticais (passo 05) — o análogo navegador do recon-surf

Sobre um resultado com parcelação DKT, o passo **05 · Superfícies** reconstrói as malhas
**white** e **pial** por hemisfério e calcula a tabela estilo `aparc.stats` — **espessura
média ± dp, área pial e volume por região DKT** — no inspetor, no PDF, no CSV, no JSON,
no `.sav` (colunas `thick_*`/`surfarea_*`) e no `.zip` (malhas `.mz3`). A pial aparece
**no painel central**, colorida pelas parcelas (chave "Mostrar 3D").

O mapeamento honesto com o `recon-surf` do FastSurfer (que continua sendo binário
FreeSurfer, horas de CPU, e **não roda em navegador**):

| recon-surf | Aqui (`lib/surfaces.js`, Web Worker) |
|---|---|
| `mri_fill` (separar hemisférios, fechar SB) | máscaras white/pial por hemisfério a partir dos rótulos + fechamento morfológico, maior componente e cavidades |
| `mri_mc` / `mri_tessellate` | **surface nets** sobre a máscara (malha fechada, 2-variedade; validada em esfera: volume −0,6%) |
| `mris_smooth` | **suavização de Taubin** λ\|μ, que não encolhe (área da esfera a +0,2% do analítico) |
| `sample_parc` (rótulos DKT volume→superfície) | parcela por vértice amostrando o volume — mesma filosofia |
| `mris_place_surface` → `?h.thickness` | **aproximação por transformada de distância**: espessura = d(córtex→SB) + d(córtex→fora da pial), EDT exata de Felzenszwalb (fantasma de casca de 3 mm: 2,78 ± 0,24) |
| `mris_anatomical_stats` → `?h.aparc.stats` | espessura/área/volume por região na tabela e nas exportações |
| `mris_sphere` + `mris_register` (`?h.sphere.reg`) | **não existe** — análise vertex-wise entre sujeitos continua exigindo o FreeSurfer/FastSurfer de verdade |

As diferenças são declaradas no relatório: a espessura por EDT é uma aproximação de
triagem (sem posicionamento sub-voxel de superfícies nem correção de topologia); o número
de Euler das malhas aqui é o da máscara limpa, não um QC da tesselagem original.

### Modelos embarcados (brainchop, licença MIT)

| Opção na interface | Pasta | Classes |
|---|---|---|
| **Aparc+Aseg 104** (padrão) | `models/model21_104class` | Córtex Desikan-Killiany **por hemisfério**, subcortical E/D, **cerebelo córtex/SB E/D**, **tronco encefálico**, ventrículos, **corpo caloso em 5 segmentos** |
| Aparc+Aseg 50 | `models/model30chan50cls` | Parcelação cortical + subcortical sem separar hemisférios |
| Subcortical 18 | `models/model30chan18cls` | aseg compacta: tálamo, gânglios da base, hipocampo, amígdala, cerebelo, tronco |
| Tecidos | `models/model20chan3cls` | Cinzenta / branca |
| Máscara encefálica | `models/model5_gw_ae` / `model11_gw_ae` | Skull stripping |

Cada modelo tem variantes de memória normal/baixa (convolução sequencial na última camada).
A primeira execução baixa <1 MB de pesos; o service worker guarda tudo e o aplicativo
funciona **offline** depois disso.

### Pré-processamento estilo FSL (portado do Morfo Studio)

A seção **02 · Qualidade** expõe os equivalentes navegador das etapas estruturais clássicas
do FSL (`lib/fsl-prep.js`, portado de
[MorfoStudio](https://github.com/pedrobrandao-neurologia/MorfoStudio)), nesta ordem — as
etapas nativas rodam em Web Worker antes da conformação, e a imagem corrigida alimenta
todo o resto:

| Etapa | Equivalente FSL | Como funciona aqui |
|---|---|---|
| Reorientação RAS | `fslreorient2std` | permutação/flip de eixos pela affine, **sem reamostrar**, no espaço nativo (a conformação já reorientava implicitamente; agora é explícito e testável) |
| Recorte de pescoço | `robustfov` | heurística no perfil de área de primeiro plano (Otsu) do eixo S-I detectado pela affine; mantém 170 mm do topo da cabeça |
| Correção de viés | `N4`-like | correção homomórfica existente, garantida **antes** da extração cerebral |
| Extração cerebral | `BET` | modelo MeshNet de máscara com **probabilidade** (softmax via `isScalar`), limiar **f configurável** (0,1–0,9; maior = máscara menor), fechamento morfológico, maior componente 26-conexo e preenchimento de cavidades — a máscara é **sobreposta no visualizador** para inspeção e a rede recebe só o cérebro |
| Contraste SC/SB | efeito do `FAST -B` | normalização opcional [p2,p98]→[0,255] dentro da máscara; a segmentação de tecidos (modelo Tecidos) dá SC/SB/líquor no painel |

Os intermediários saem nos botões de exportação (**pré-processado nativo, máscara e cérebro
extraído** em `.nii.gz`, também no pacote `.zip`) e o JSON registra a **proveniência**
(`preprocessamento`: etapas aplicadas e parâmetros).

**Sobre o niimath** (avaliado antes de reimplementar): o
[niimath](https://github.com/rordenlab/niimath) WASM (~723 KB, BSD-2) tem `-robustfov`
exato, mas **não** tem `fslreorient2std` (o `-conform` dele reamostra) nem BET — como a
reorientação teria de ser JS de qualquer forma e a morfologia já existia, ficou tudo em
JS puro (~150 linhas), sem custo de download. O niimath continua sendo a opção natural
se um dia for preciso um `fslmaths` genérico.

**Limitações declaradas**: o recorte é heurístico (≠ robustfov exato); a extração usa a
rede de máscara do brainchop (≠ superfície deformável do BET); mascarar/normalizar muda o
domínio visto pelos MeshNet, que foram treinados em cabeça inteira conformada — use a
sobreposição de QC e compare com e sem as opções. O SynthSeg tolera entrada com ou sem
crânio por natureza.

### O modo robusto não é o SynthSR

Quando a régua marca C/D (FLAIR axial de 5 mm, poucos cortes, baixo campo), o ramo robusto
aplica métodos **clássicos** — reamostragem cúbica, correção homomórfica de viés — inspirados
no *papel* do SynthSR dentro do `recon-all-clinical`, mas sem a rede: reamostrar não cria
informação. O relatório e o JSON registram o nível de qualidade e o pipeline usado; para
inferência individual em exame anisotrópico, seja conservador.

---

### Comparação normativa (QC, não clínico)

Informando **idade e sexo**, o aplicativo compara os volumes com as curvas populacionais dos
**brain charts** (Bethlehem et al., *Nature* 2022 — modelos GAMLSS oficiais de
[brainchart/Lifespan](https://github.com/brainchart/Lifespan), avaliados offline e vendorizados
em `models/normative/brainchart.json`): **percentil e z-score do valor previsto** para volumes
globais (GMV, WMV, cinzenta subcortical, ventrículos, cérebro total), **volume cortical por
lobo** (frontal, parietal, temporal, occipital, ínsula, cíngulo — E/D e total, após o passo DKT)
e parcelas DKT individuais. |z| ≥ 3 marca achado atípico; **|z| ≥ 4 é sinalizado como possível
erro de segmentação** no painel e no PDF (banner "verificar segmentação"). As normas foram
ajustadas em volumes FreeSurfer harmonizados; os volumes daqui vêm do SynthSeg/DKT — a
comparação é uma aproximação para triagem/QC, não para uso clínico.

## Exportações

- **CSV** longo (uma linha por estrutura/agregado/assimetria; separador decimal configurável para Excel pt-BR ou R/Python)
- **JSON** completo (estruturas com centroide RAS, agregados, lobos, assimetria, qualidade, ressalvas)
- **SPSS `.sav`** — escritor próprio de system file com nomes longos (registro 7/13), rótulos de variável em português com acentos (UTF-8) e missing como sysmis; abre no SPSS, `haven::read_sav()` e `pyreadstat`
- **PDF** — relatório com captura do visualizador, régua de qualidade, agregados, tabela por estrutura, escada de assimetria e página de métodos
- **NIfTI** — segmentação e volume conformado em `.nii.gz`
- **Pacote `.zip`** com tudo
- **Coorte** — uma linha larga por exame, persistida no navegador → CSV largo e `.sav` para SPSS/R

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

O botão **Exemplo** carrega um T1 real 256³ (do brain2print, MIT) para demonstrar o fluxo completo.

## Estrutura

```
index.html · styles.css · app.js     interface e orquestração
lib/quality.js                       régua de qualidade A–D
lib/stats.js · lib/labels.js         volumetria, hemisférios, lobos, assimetria, nomes em pt-BR
lib/sav.js                           escritor SPSS .sav
lib/pdf.js · lib/report.js           gerador de PDF e relatório
lib/nifti-writer.js · lib/zip.js     NIfTI-1 e ZIP
workers/preprocess.worker.js         modo robusto (reamostragem cúbica + correção de viés)
brainchop/                           worker de inferência do brain2print (MIT), tfjs vendorizado
models/                              pesos MeshNet do brainchop (MIT)
vendor/                              NiiVue, dcm2niix WASM, TensorFlow.js, fontes
tools/convert_synthseg.py            conversor Keras→ONNX da iteração anterior (opcional)
sw.js · manifest.webmanifest         PWA offline
```

## Limites

- **Espessura cortical e superfícies** não estão aqui: dependem de geometria/topologia
  (`recon-all-clinical`). Isto é volumetria.
- **Memória/GPU**: a inferência usa WebGL; em GPUs integradas use os modelos compactos ou a
  variante de memória baixa. CPU funciona, mas é lenta.
- **DICOM**: o dcm2niix WASM embarcado decodifica também séries JPEG; séries muito exóticas
  podem exigir conversão prévia no desktop.
- Os modelos foram treinados em **T1**; T2/FLAIR degradam o resultado (a régua avisa).

## Interface

Layout de estação de trabalho (inspirado no [Morfo Studio](https://github.com/pedrobrandao-neurologia/MorfoStudio)):
barra superior com as ações de abertura, rail esquerdo com as etapas do pipeline,
**visualizador ocupando o centro** com HUD sobreposto, inspetor à direita (exame,
agregados, regiões, assimetria, exportação/coorte) e log de uma linha no rodapé.
Tema escuro grafite/osso/vermelho-córtex com princípios das HIG da Apple: resposta no
`pointer-down`, transições críticas curtas, materiais com hierarquia, e equivalentes para
`prefers-reduced-motion`, `prefers-reduced-transparency` e `prefers-contrast: more`.

## Créditos

- **SynthSeg** — Billot, Greve, Puonti, Thielscher, Van Leemput, Fischl, Dalca, Iglesias
  ([BBillot/SynthSeg](https://github.com/BBillot/SynthSeg), Apache 2.0): pesos originais
  `synthseg_1.0.h5` convertidos para tfjs. Cite *SynthSeg: Segmentation of brain MRI scans
  of any contrast and resolution without retraining* (Medical Image Analysis, 2023).
- **FastSurfer** — Henschel, Conjeti, Estrada, Diers, Fischl, Reuter
  ([Deep-MI/FastSurfer](https://github.com/Deep-MI/FastSurfer), Apache 2.0): checkpoints
  oficiais do FastSurferCNN v1 convertidos para tfjs (`licenses/fastsurfer.txt`). Cite
  *FastSurfer — A fast and accurate deep learning based neuroimaging pipeline*
  (NeuroImage, 2020).
- **brainchop** — Masoud, Hu & Plis (MIT); **brain2print** — grupo de Chris Rorden (MIT): worker de inferência e modelos MeshNet.
- **NiiVue** e **dcm2niix** — Rorden e colaboradores.
- Linhagem conceitual: **SynthSeg / SynthSR / recon-all-clinical** — Billot, Gopinath, Iglesias
  e colaboradores, Martinos Center (MGH/Harvard). Cite os artigos originais em trabalhos que
  usem as segmentações.
