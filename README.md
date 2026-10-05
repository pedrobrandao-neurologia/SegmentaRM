# SegmentaRM

PWA de **segmentação e morfometria cerebral 100% no navegador** — nenhuma imagem sai do
dispositivo, nenhum servidor, nenhuma instalação. Converte **DICOM**, sintetiza um
**MP-RAGE T1 1 mm com a rede SynthSR original** (estilo `recon-all-clinical`), segmenta com
a rede **SynthSeg original** ou com os modelos MeshNet do brainchop, aplica a **parcelação
DKT da FastSurferCNN**, reconstrói **superfícies corticais** com espessura (Fischl–Dale) e
área por região, compara os volumes com as **curvas normativas dos brain charts** por idade
e sexo — com proveniência em cada número, intervalo de 90% do z, recentragem por controles
medidos com o mesmo método e calibração do sítio — e exporta tudo em **CSV, JSON, SPSS (.sav),
PDF, NIfTI, malhas .mz3 e pacote .zip**. As escolhas de método estão justificadas, item a
item, em [`docs/plano-metodologico.md`](docs/plano-metodologico.md).

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
                 05 · Superfícies (recon-all-clinical) — SDFs white/pial → colocação
                     Eq. 5 → espessura Fischl–Dale · χ de Euler · norm · talairach.xfm
                                        ▼
     Estatísticas: volumes suaves (rígidos como auditoria), % do encéfalo e do VIC,
     hemisférios, lobos, assimetria (z contra controles do mesmo método), comparação
     normativa (z com IC 90%, recentragem pelo método, calibração do sítio), alertas de QC
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
| Correção de viés | `N4BiasFieldCorrection` | porte do N4 do ITK (Tustison et al., 2010) com os padrões do ANTs: shrink ~4 mm, B-spline cúbica com malha inicial ~200 mm, 4 níveis × 50 iterações, limiar 0,001, afinamento do histograma por Wiener; campo reproduz o SimpleITK com r ≥ 0,998 num T1 real, 1–3 s em 256³; **antes** da extração cerebral e **não** aplicado antes do SynthSeg (como no oficial); a homomórfica antiga fica só como alternativa se o N4 falhar |
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
`tools/convert_synthseg1_tfjs.py` (float16, 27 MB; argmax concorda em 99,99% com o
Keras). O pipeline reproduz o `predict_synthseg.py` oficial passo a passo
(`lib/synthseg-core.js › runSynthSeg`, o mesmo código do worker e dos testes):

- **entrada = o arquivo original**, como no oficial: reamostragem a 1 mm com o
  `edit_volumes.resample_volume` (gaussiano anti-serrilhado σ = 0,25/fator, mesma grade
  de amostragem), alinhamento RAS do `align_volume_to_ref`, percentis 0,5/99,5 do volume
  reamostrado, padding centrado; correção de viés e reamostragem clássicas **não** são
  aplicadas antes do SynthSeg (a rede foi treinada com viés e resolução sintéticos);
- **média com o volume espelhado E/D** (test-time flipping com troca de rótulos),
  suavização σ = 0,5 dos posteriores e **pós-processamento topológico** (maior componente
  global e por classe);
- **volumes "soft"** (soma dos posteriores, a convenção do `--vol`) exportados em
  `volume_soft_mm3`, além da contagem de voxels;
- a única diferença que resta é a inferência em **blocos com sobreposição de 64** sobre a
  caixa do tecido (o volume inteiro não cabe na GPU de um navegador comum), com os blocos
  na mesma fase dos max-poolings do volume inteiro. O tamanho do bloco é escolhido pelo
  **limite de textura da GPU**: 128³ quando ela aceita texturas de 16384² (a maioria das
  placas dedicadas e das integradas recentes) e 96³ quando o limite é 8192² — com 128³ a
  maior ativação da rede não cabe nessas GPUs. Com 96³ a paridade medida no T1 cai de
  0,998 para 0,992 de Dice médio e o número de blocos sobe (~45 contra ~12). No volume, o
  efeito é sistemático: no exame de exemplo, contra 128³, o córtex cerebelar cai 7%, o
  pálido sobe até 2,8% e o tálamo e os ventrículos caem cerca de 1%. Blocos de 160³ e 192³
  ficam a menos de 1% de 128³ ([`tests/golden/README.md`](tests/golden/README.md)). Como a
  recentragem foi medida com 128³, o laudo registra o bloco usado e avisa quando ele é
  menor (regra `bloco_reduzido`);
- robustez na GPU: o espelhamento é feito em JavaScript (a WebGL não tem `reverse` de
  tensor 5D), os 3 maiores posteriores são calculados na GPU (só 6 números por voxel descem
  da placa), a perda do contexto WebGL vira erro claro em vez de espera infinita, e o
  aplicativo encerra a etapa se a GPU ficar 8 min sem responder.

**Paridade medida contra o SynthSeg 1.0 oficial** (Python/Keras, `--v1`, mesma rede),
com a entrada exata que o aplicativo envia ao worker, comparada na grade da saída
oficial:

| Exame | Resolução | Dice médio | Dice mínimo | Voxels idênticos | Antes desta revisão |
|---|---|---|---|---|---|
| T1 MPRAGE (RAS) | 0,88 mm iso | **0,998** | 0,993 | 99,97% | 0,838 |
| FLAIR 2D clínico, oblíquo (LAS) | 0,34×0,34×3,6 mm | **0,996** | 0,988 | 99,96% | 0,843 |
| T1 (LAS) | 0,9×0,94×0,94 mm | **0,997** | 0,990 | 99,96% | 0,887 |

(A referência oficial foi gerada com `--crop` por limite de memória da máquina de teste;
o aplicativo implementa a mesma opção e a comparação usa o mesmo recorte. Os volumes
por estrutura ficaram a ±1,3% do oficial no T1.)

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

O item de **contraste** da régua é o **CJV** (coeficiente de variação conjunta,
(σ_SB + σ_SC)/|μ_SB − μ_SC|, a métrica do MRIQC; menor é melhor), estimado sem
segmentação por mistura de 3 gaussianas nas médias de vizinhança dentro do encéfalo:
≤ 0,90 bom, ≤ 1,20 moderado, > 1,20 pobre. É invariante a escala e deslocamento de
intensidade; os limiares valem para este estimador (fica 0,1–0,4 acima do CJV com máscaras).

Quando a régua marca C/D, o ramo robusto aplica métodos **clássicos** (reamostragem
cúbica, correção de viés), que não criam informação. Para exame anisotrópico ou de
contraste não-T1, o caminho com rede é a caixa SynthSR acima.

## Parcelação cortical DKT (passo 04) — com o FastSurfer de verdade

Passo separado sobre um resultado **SynthSeg** ou **aseg compacta** pronto — se falhar, a
segmentação permanece intacta. A fusão replica o mecanismo do `--parc` do SynthSeg 2.0
(`seg[máscara de córtex] = parcelação[máscara]`, com propagação modal por vizinhança —
`lib/dkt-fusion.js`), mas o atlas é outro: o `--parc` oficial é **DK** (Desikan-Killiany,
68 regiões) e aqui é **DKT** (62 regiões).

A **fonte recomendada** é a **FastSurferCNN**
([Deep-MI/FastSurfer](https://github.com/Deep-MI/FastSurfer), Apache 2.0; Henschel et
al., *NeuroImage* 2020): os **checkpoints oficiais v1** (axial/coronal/sagital —
`Epoch_30_training_state.pkl` do commit `e215b839`, os mesmos das tags v1.0.0–v1.1.2)
convertidos para tfjs **float32** (`tools/convert_fastsurfer_tfjs.py`, 7,2 MB por vista).
As BatchNorm que seguem uma convolução são dobradas nela (exato); a **bn0 da entrada fica
explícita**, aplicada antes do zero-padding da primeira convolução como no PyTorch —
dobrá-la não é exato na borda e o erro se propaga pela U-Net. É a rede volumétrica cujo
`aparc.DKTatlas+aseg` o recon-surf refina — a inferência replica o pipeline v1 (fatias
espessas de 7 cortes com borda replicada, entrada/255, agregação 0,4·axial + 0,4·coronal +
0,2·sagital em logits, mapeamento sagital 51→79 classes), **restrita à fita cortical**:
o acumulador guarda só os voxels da máscara (Int16, ~0,1 GB), nunca o volume
256³ × 79 × float32 (5,3 GB) do pipeline oficial. Dentro da máscara o argmax é tomado
entre as classes corticais (o "argmax sem fundo" do `--parc`).

**Paridade medida** (logits da rede portada × referência numpy do FastSurferCNN com as BN
não dobradas, lidas dos `.pkl`; argmax nos voxels de tecido de fatias 256² reais):
contra a referência em **float32** (a precisão em que o PyTorch roda) — coronal
**99,99%**, axial **100%**, sagital **99,99%**, o mesmo ruído que separa duas
implementações float32; contra float64 — 99,90% / 100% / 99,995% (a vista coronal é a
mais sensível ao arredondamento float32). WebGL (Chromium) e CPU dão o mesmo argmax. Para
registro, o formato anterior (float16 com a bn0 dobrada) ficava em 99,50% / 97,98% /
99,39%, e o unpool por `scatterND` não terminava na WebGL.

**Lateralização.** A rede v1 usa uma única classe para os dois lados em várias regiões
corticais. Com a fonte **SynthSeg**, o hemisfério é o do SynthSeg (a rede só nomeia a
parcela). Com a **aseg compacta** (córtex bilateral), segue-se o `eval.py` v1: as 19
classes da lista oficial (inclui precuneus e superiorfrontal) são trocadas para o lado
direito por componente 26-conexo mais próximo do hemisfério direito, e as 4 que cruzam a
fissura (lateraloccipital, parsorbitalis, rostralanteriorcingulate, superiorparietal)
voxel a voxel. **Adaptação declarada:** o oficial mede a proximidade contra a substância
branca E/D (maior componente; divisão voxel a voxel pela SB suavizada, σ = 3 mm); aqui só a
fita cortical é inferida, então os centroides dos hemisférios vêm das parcelas que a rede
já lateraliza e a divisão voxel a voxel usa o plano bissetor entre eles. Há a opção
**axial+coronal** (mais rápida) e a rede DKT do brainchop como alternativa. Estruturas
ausentes num sujeito são aceitas — contagem menor de rótulos é aviso, não erro.

## O pipeline recon-all-clinical no navegador — mapa de fidelidade

O passo 05 (e o botão **"Pipeline completo (recon-all-clinical)"** no passo 03, que
encadeia 03→04→05) reproduz o fluxo do `recon-all-clinical.sh` (Gopinath et al.,
*Medical Image Analysis* 2025). A tabela abaixo mapeia **cada etapa do script oficial**
(lido do código-fonte, branch dev do `freesurfer/freesurfer`) ao que roda aqui — para
uso em pesquisa, cite o que é reprodução e o que é aproximação:

| recon-all-clinical.sh | Aqui | Fidelidade |
|---|---|---|
| `mri_synthseg --robust` (cadeia S1→denoiser→S2) | SynthSeg 1.0 (rede original) | **análogo declarado** — ver *Por que o modo robusto não roda no navegador* abaixo |
| `mri_synthseg --parc` | parcelação DKT da FastSurferCNN | **análogo declarado** — mesmo mecanismo de fusão, mas **atlas diferente**: o `--parc` oficial dá o **Desikan-Killiany (DK, 68 regiões, com `bankssts`, `frontalpole` e `temporalpole`)**; aqui sai o **DKT** (62 regiões, Klein & Tourville 2012), de outra rede. O conversor já emite a `unet_parc` do SynthSeg 2.0 para quem quiser trocar |
| `mri_synthseg --qc` (regressor CNN → `synthseg.qc.csv`) | **QC próprio por grupo tecidual** (confiança × coesão × simetria), nos mesmos 9 grupos e nomes do oficial | **método diferente, declarado** — ver *QC automático* abaixo |
| `mri_synthsr` (visualização) | SynthSR v1.0 original (paridade r=0,997) | **exato** (em blocos) |
| SynthDist (`mri_synth_surf.py`, SDFs ±5 mm) | **rede SynthDist original, com os pesos incluídos** (`models/synthsurf/`, 26,5 MB; paridade tfjs×Keras máx \|Δ\| = 7e-5) — opção padrão; SDF por EDT das máscaras segue como alternativa | **exato** (o fallback por EDT é aproximação declarada) |
| `wm.seg.mgz` / `filled.mgz` (regras de rótulos; partição E/D por EDT) | mesmas regras, mesma partição por EDT | **exato** |
| `norm.mgz` sintético (70·tanh(2(W+0,3)) + 40·tanh(2P), máscara dilatada 3) | fórmula idêntica; exportável (`Norm sintético`) | **exato** |
| `talairach.xfm` (COGs medianos vs. tabela do ICBM152, `getM`) | porte exato, mesma tabela de COGs; exportável | **exato** |
| `mri_pretess` + `mri_tessellate` + `mris_extract_main_component` | fechamento + maior componente + cavidades + **surface nets** | **análogo** (tesselação diferente, mesma função) |
| `mris_sphere -q` + `mris_fix_topology` + `mris_remesh` | **não portado** — a característica de Euler (χ) é calculada e relatada como QC; χ≠2 vira aviso | **ausente, declarado** |
| `mris_place_surface --white --nsmooth 5` / `--pial --repulse-surf` | descida de gradiente na **energia da Eq. 5 do artigo** (tanh(D)² + molas λ₁=6·10⁻⁴/λ₂=2·10⁻⁴ de Dale 1999), nsmooth 5 na white, pial parte da white com repulsão | **reprodução do método do artigo** (o script oficial equivalente cola as SDFs na imagem sintética e roda o `mris_place_surface` clássico) |
| `mris_register` (sphere.reg, atlas acfb40) + `mris_ca_label` | **não portado** — parcelas por amostragem volumétrica DKT nos vértices da white (≈ `sample_parc`); **sem correspondência vertex-wise com o fsaverage** | **ausente, declarado** |
| `--thickness ... 20 5` (Fischl & Dale 2000, teto 5 mm) | pareamento branca↔pial nos dois sentidos, teto 5 mm | **mesma definição** (busca por grade, não por nhops) |
| `mris_anatomical_stats` | espessura ± dp, **área na white** (como o aparc.stats), volume por parcela | **análogo** (volume por contagem de voxels, não ribbon) |
| `mri_cc` (corpo caloso), BA_exvivo/vpnl | não portados | **ausentes** (o próprio script anota que o mri_cc "doesn't work very well") |

Validação do motor: fantoma de esferas — descida ao nível zero com desvio máximo
0,36 mm, espessura esférica 2,98/3,00 mm, χ=2 preservado, repulsão impede a pial de
invadir a white, norm 110/40/0 exatos, Talairach recupera escala/translação sintéticas.

### QC automático da segmentação (por grupo tecidual)

Toda segmentação sai com um **QC por grupo tecidual**, no painel do inspetor, no PDF, no
JSON e num **`*_qc.csv`** de uma linha por exame — feito para triagem de lote, que é
onde o `synthseg.qc.csv` entra num projeto de pesquisa. Os **9 grupos e seus nomes são os
do regressor oficial** do SynthSeg 2.0 (extraídos de `synthseg_qc_labels_2.0.npy` /
`..._names_2.0.npy`), então a tabela tem a mesma forma; o **escore, porém, é próprio**:

| componente | o que mede | de onde vem |
|---|---|---|
| **confiança** | incerteza do próprio modelo | média da posterior máxima (softmax) nos voxels do grupo — sai de graça da rede, antes descartada no argmax |
| **coesão** | fragmentação / ilhas espúrias | fração dos voxels de cada estrutura no seu maior componente conexo (6-vizinhança), agregada ao grupo por volume |
| **simetria** | perda unilateral | 1 − excesso de assimetria E/D (\|IA\| até 10% não penaliza, 40% zera); grupos medianos ficam de fora |

`índice = confiança × coesão × simetria` — multiplicativo, para que uma única falha
derrube o grupo. No laudo ele se chama **índice de confiança interno (não validado)**: não é
o Dice predito pelo regressor oficial, é outra grandeza, em outra escala, e o 0,65 do artigo
(Billot et al., *PNAS* 2023) entra só como referência de partida até um corte próprio ser
calibrado em teste-reteste. Os três componentes vão **separados** no CSV/JSON justamente
para você recalibrar o corte na sua coorte.

Validação (fantomas + uma segmentação SynthSeg **real** progressivamente degradada):

| ruído de rótulo | coesão da SB | escore mínimo global | grupos em alerta |
|---|---|---|---|
| 0% (íntegra) | 0,998 | 0,971 | 0 |
| 0,5% | 0,993 | 0,932 | 0 |
| 2% | 0,983 | 0,830 | 0 |
| 5% | 0,958 | 0,653 | 0 |
| 12% | 0,914 | 0,464 | 3 |

Perda unilateral de metade de um hemisfério derruba a pior simetria de 1,000 para 0,099.

**Alertas de QC por regras.** Além do índice, `models/qc_rules.json` declara regras de
plausibilidade e coerência (motor em `lib/qcrules.js`), cada uma com severidade, fonte e
status (provisória/validada):

- |z| ≥ 4 (provável erro de segmentação);
- desvios em bloco no mesmo sentido (viés de ferramenta ou de sítio);
- córtex acima e SB abaixo do esperado em idosos (fronteira cinzenta/branca);
- hipocampo grande com ocupação hipocampal baixa para a idade (HOC contra controles do mesmo método);
- idade na borda da norma;
- recentragem ajustada em outro equipamento (fabricante ou campo diferente do DLBS);
- índice de confiança baixo;
- VIC com aviso;
- assimetria extrema (z do IA).

Quando uma regra dispara, o PDF ganha uma página de **alertas** com cortes da sobreposição
escolhidos pela regra (hipocampo, polo occipital, cérebro inteiro).
O mapa de confiança também é exportável (`.nii.gz`, 0–255) e visualizável a um clique na
linha do tempo. Só o **SynthSeg** devolve posteriores; com os modelos MeshNet o
componente de confiança fica neutro e a proveniência declara isso.

### Por que o modo robusto e o regressor de QC do SynthSeg 2.0 não rodam no navegador

`tools/convert_synthseg2_tfjs.py` converte as **quatro** redes do SynthSeg 2.0 (S1,
denoiser `l2l`, S2, `unet_parc` e o regressor `qc`) no padrão traga-seus-pesos — o
construtor foi verificado camada a camada contra o `synthseg_1.0.h5` real (28/28
casadas, com controles negativos). Mas duas delas esbarram na memória do navegador, por
construção:

- o **denoiser** é um prior de forma sobre o encéfalo **inteiro** — dividir em blocos
  quebraria exatamente o que ele faz, então não há a saída de tiles que usamos nas
  outras redes;
- o **regressor de QC** recebe a segmentação recortada/preenchida a **exatamente 224³**
  (`MakeShape(224)`, sem reduzir resolução) em **one-hot de 9 canais**: são **405 MB só
  no tensor de entrada** e **1,08 GB na primeira ativação** (224³ × 24 filtros × 4 B),
  com várias dessas vivas ao mesmo tempo no forward.

Tentei medir o limite real aqui, mas este ambiente só tem WebGL por software
(SwiftShader) — a medição não terminou e não representaria uma GPU de verdade, então
fica a aritmética acima, que é exata. Numa workstation com GPU grande pode caber; em
GPU integrada, não. Por isso o QC do navegador é o próprio, descrito acima. A
`unet_parc` **não** tem esse problema (é uma UNet igual às que já rodamos em blocos com
sobreposição) e é o próximo passo natural quando você converter os pesos.

**A rede SynthDist acompanha o projeto.** O checkpoint oficial tem 159 MB porque
carrega o estado do otimizador Adam; `models/shrink_checkpoint.py` o reduz a
**24,4 MB** (pesos-só, convoluções em float16 e **BatchNorm preservada em float32** —
as estatísticas alimentam 1/√(var+ε) e a perda de precisão ali se propaga pela rede), e
`tools/convert_synthsurf_tfjs.py` gera `models/synthsurf/` (26,5 MB) com a mesma regra.
Conferência: 28/28 camadas casadas, 13,24 M parâmetros, `unet_likelihood` com kernel
(1,1,1,24,**9**) — os 9 canais de SDF —, **paridade tfjs × Keras de máx |Δ| = 7·10⁻⁵**
numa saída que varia de −65 a +22, e sinal anatomicamente correto validado contra uma
segmentação SynthSeg do mesmo exame.

**A ordem dos canais é o inverso do que o código-fonte sugere.** O `mri_synth_surf.py`
nomeia `W = pred[...,0]` e `P = pred[...,1]`, mas a medição nos pesos v10 mostra que
**0 = lh-pial, 1 = lh-white, 2 = rh-pial, 3 = rh-white**. A prova está no córtex — a
faixa *entre* as duas superfícies, onde a white é positiva (está-se fora dela) e a pial
negativa (está-se dentro): no córtex esquerdo o canal 0 dá −1,12 mm (3,9% positivo) e o
canal 1 dá +1,18 mm (94,9% positivo); no córtex direito o 2 dá −2,10 mm e o 3, −1,77 mm.
Fechando o argumento, a fórmula do norm sintético só reproduz o alvo com a atribuição
medida: **córtex 39,8** contra os 40 pretendidos (a leitura literal dá 63,9). Em vez de
fixar isso às cegas, `escolheCanaisSdf` **decide pelo próprio exame** — dentro de cada
par, o canal de maior média no córtex daquele hemisfério é a white — e escreve na linha
do tempo as médias medidas; um checkpoint futuro com outra ordem é seguido e
**relatado**, não ignorado. O passo 05 já vem com **"Rede SynthDist" selecionada**; o
caminho traga-seus-pesos continua valendo para quem preferir converter de uma
instalação local. **Antes de redistribuir**, leia `licenses/synthsurf.txt`: a rede
vem do FreeSurfer, cuja licença — diferente do Apache 2.0 do SynthSeg/SynthSR —
restringe redistribuição.

## Superfícies corticais (passo 05) — saídas

Sobre um resultado com parcelação DKT, o passo 05 entrega: malhas **white/pial** por
hemisfério (pial colorida pelas parcelas, visível no painel central pela chave
"Mostrar 3D"), tabela estilo `aparc.stats` — **espessura média ± dp (Fischl–Dale, teto
5 mm), área na white e volume por região DKT** —, **χ de Euler por hemisfério** como QC
de topologia, o **norm sintético** (córtex super-resolvido derivado das SDFs) e o
**`talairach.xfm`** (MNI por centros de massa) — tudo no inspetor, na linha do tempo e
em todas as exportações. O mapa de fidelidade da seção anterior diz exatamente o que é
reprodução do recon-all-clinical e o que é aproximação; o JSON/PDF registram o motor de
SDF usado (rede SynthDist ou EDT) e o χ de Euler de cada execução.

## Volume intracraniano (VIC ≈ eTIV)

O SynthSeg 1.0 não rotula o líquor extracerebral, então a soma dos rótulos **não** é o
volume intracraniano. Após a segmentação, o T1 conformado (cabeça inteira, antes de
qualquer extração cerebral) é registrado por um **afim de 12 parâmetros** (correlação
normalizada, Levenberg–Marquardt, 8 → 4 → 2 mm, 90 inícios, pesos de Tukey) ao template
**MNI152 2009c** embutido em `lib/icv.js` (licença MNI/McGill, `licenses/mni152.txt`); o
VIC é `K × det(A)` com K = 2 172 000 mm³, calibrado para a **escala do eTIV do FreeSurfer**
(Buckner et al., *NeuroImage* 2004), o mesmo princípio do `mri_segstats --etiv`.

Validação (31 adultos do OpenNeuro com recon-all): r = 0,92 com o eTIV do FreeSurfer, viés
±1% e DP 2,5–4% com K calibrado num conjunto e testado no outro (o afim do ANTs com
informação mútua deu r = 0,79 nos mesmos sujeitos); reescalas ×0,9/×1,1 recuperadas com
erro < 0,2%; rotação de 15° e recorte de pescoço mudam o VIC ≤ 0,1%. ~4–5 s no navegador.

O VIC aparece como cartão nos resultados, como coluna **% VIC** na tabela e sai no CSV
(linha `vic` e coluna `pct_vic`), no JSON (`volume_intracraniano`), na planilha larga
(`eTIV`, pronta como covariável) e na capa do PDF. Avisos automáticos: registro de baixa
qualidade, imagem já sem crânio (o VIC fica extrapolado), FOV cortado, escala fora da
faixa, fração cerebral implausível. Não é estimado com o SynthSR ativo (T1 sintético sem
crânio). Erro individual típico de 3–4%: para grupos, prefira-o como covariável.

## Comparação normativa (QC, não clínico)

Informando **idade e sexo** (lidos do DICOM quando há: a idade é calculada pela **data do
exame**, não pela do processamento), os volumes são comparados com normas por idade e sexo.

**Normas SegmentaRM (padrão com o SynthSeg, volume suave).** São curvas próprias, ajustadas em
volumes medidos com o **mesmo SynthSeg do app**. A amostra é de 641 adultos saudáveis de bases
abertas CC0 do OpenNeuro (14 sítios Philips, Siemens e GE, todos 3 T; 18–89 anos), com o
**sítio modelado**. Detalhes em [`docs/normas-proprias.md`](docs/normas-proprias.md) e
[`docs/validacao/normas.md`](docs/validacao/normas.md).

- Modelo: GAMLSS por estrutura, SHASHo (ou normal) sobre o log do volume, com P-spline da idade,
  sexo e sítio como efeito aleatório. O z sai em forma fechada:
  `z = sinh(τ·asinh((ln V − μ)/σ) − ν)`.
- Cobre os volumes globais, as subcorticais E/D, cornos temporais, ventrículos laterais,
  cerebelo, tronco e o **VIC (eTIV)**. As parcelas corticais continuam no BrainChart.
- Sem calibração local, o IC 90% inclui a **variância entre sítios** e o erro da curva; com
  calibração, o deslocamento do sítio é estimado.
- Década com < 30 controles ou < 3 sítios (hoje, os 80+): z em cinza.
- Validação deixando cada sítio de fora, sem o DLBS: |média do z| 0,07 contra 0,43 do pipeline
  anterior (BrainChart/CentileBrain + recentragem), e |z| > 1,96 em 5,8% contra 8,2%. A
  vantagem está nas subcorticais; nas medidas globais, as duas empatam.
- Faltam 1,5 T, brasileiros e uma boa amostra de 80+. O OASIS-3 entra com os termos aceitos
  pelo usuário (`tools/normas_local.py`). A calibração local continua recomendada.

Uma caixa no painel normativo volta às normas de literatura, que também valem para as outras
redes e para o volume rígido:

- **volumes globais** (córtex, SB, cinzenta subcortical, ventrículos e cérebro total = GMV +
  WMV, como no BrainChart), com as curvas dos **brain charts** (Bethlehem et al., *Nature* 2022 —
  modelos GAMLSS oficiais de [brainchart/Lifespan](https://github.com/brainchart/Lifespan),
  licença CC BY-NC-ND 4.0, avaliados offline por `tools/gerar_brainchart_json.R` e vendorizados
  em `models/normative/brainchart.json`);
- **estruturas subcorticais por hemisfério e sexo** (tálamo, caudado, putâmen, pálido,
  hipocampo, amígdala, accumbens), com os modelos do **CentileBrain** (Ge et al., *Lancet
  Digit Health* 2024; ENIGMA Lifespan; ~37 mil controles, 3–90 anos, FreeSurfer aseg
  harmonizado por ComBat-GAM). Os centis vêm de `tools/extract_centilebrain_subcortical.R`
  (→ `models/normative/subcortical.json`); o JS reproduz o R com erro de z < 0,01 entre P5 e
  P95. O repositório CentileBrain não traz licença explícita (apenas "for research
  purpose"): os centis são redistribuídos para pesquisa, com citação — confirme com os
  autores antes de uso comercial.

Cada tabela leva um **selo de proveniência**:

- a norma e a ferramenta com que ela foi medida;
- a ferramenta e o tipo de volume do paciente;
- se o z foi recentrado por controles do mesmo método;
- se o sítio está calibrado;
- a faixa etária da norma.

A menos de 5 anos do limite da norma, z e percentil ficam **em cinza** (estimativa instável).
Percentis extremos aparecem como "< 1", "< 0,1", "> 99" e "> 99,9". **Não há z por lobo**:
não existe norma lobar própria, e somar médias e DP de parcelas não é um modelo. O z por
parcela DK fica só no JSON, como exploratório.

**Multiplicidade.** O painel e o PDF dizem quantos |z| > 2 se esperam por acaso (m·4,55%) e
quantos foram observados. Os achados que sobrevivem à correção de Holm (α 5%, p bicaudal)
levam *; as estruturas pré-especificadas levam • (hipocampo, amígdala, tálamo, putâmen,
ventrículos). Muitos desvios no mesmo sentido disparam o alerta de **desvios em bloco**:
é o padrão de viés entre ferramentas ou de sítio não calibrado, não de biologia.

**Intervalo de 90% do z (normas de literatura).** Cada z vem com um IC 90% que soma, em
quadratura, três fontes:

- o **erro de medida** publicado para o SynthSeg (`models/normative/erro_medida.json`):
  - van Nederpelt et al., *Neuroradiology* 2023 — EPM intra e entre scanners do SynthSeg 1.0 e ICC por estrutura;
  - Kondrateva et al., arXiv 2025 — variação entre scanners, conservadora;
  - vale o erro **entre scanners enquanto o sítio não estiver calibrado**;
- a incerteza da **recentragem pelo método**;
- a incerteza da **calibração**.

Não inclui a incerteza do próprio modelo normativo nem a **variação entre sítios**. O
BrainChart publica as réplicas bootstrap e o DP do efeito de estudo, e esse efeito, omitido na
curva populacional, vale ≈ 1 z nos volumes globais (≈ 0,6 no TCV, ≈ 0,5 nas regiões): para um
sítio sem calibração local o intervalo real é bem maior que o mostrado. Detalhes em
[`docs/auditoria-normativa.md`](docs/auditoria-normativa.md).

**Recentragem pelo método (nível A).** As normas são de volumes FreeSurfer, e o SynthSeg
difere dele por estrutura, e de forma grande: o córtex fica ~14–23% acima (mais nos idosos) e a
SB ~7–12% abaixo.
Sem correção, isso desloca os z de estruturas inteiras.

A correção óbvia — traduzir o volume para a escala do FreeSurfer — **não funciona** com essas
normas. Controles saudáveis medidos pelo próprio FreeSurfer ficam, em média, 1,5 DP (FreeSurfer
5.3 do DLBS) e 1,9 DP (FreeSurfer 6.0.1 de outro conjunto) abaixo da GMV do BrainChart.
Traduzir para essa escala criaria atrofia cortical em quem não tem.

Por isso o app recentra o z contra a **própria norma**. Controles saudáveis do **Dallas
Lifespan Brain Study** (OpenNeuro ds004856, CC0; 21–89 anos), medidos com o **mesmo SynthSeg
do app**, definem, por estrutura, o desvio médio do z em função da idade e do sexo:

```
z' = z − (a + c·t + d·t² + e·[M]),   t = idade − 60
```

- os coeficientes ficam em `models/normative/recentragem_synthseg.json`;
- a escala do z continua a da norma;
- a incerteza do deslocamento vai para o IC 90%;
- a coluna "Mediana" passa a ser a esperada para o mesmo método.

A recentragem liga por padrão com o SynthSeg (volume suave) e pode ser desligada no painel;
cada linha mostra também o z sem recentragem.

Validação completa em [`docs/validacao/dlbs.md`](docs/validacao/dlbs.md), em controles
saudáveis:

- no DLBS, em validação cruzada, o z médio fica perto de 0 em todos os terços de idade — no
  terço mais velho (> 75 anos), o |z| médio cai de 0,83 para 0,04;
- num conjunto externo de outro scanner, o |z| médio cai de 0,76 para 0,46.

O que sobra é efeito de sítio. Por isso, quando o equipamento difere do DLBS (Philips 3 T
MPRAGE), o laudo recomenda a calibração local.

**Calibração do sítio (nível C).** Exames marcados como **controle** na coorte, do mesmo
protocolo, calibram os z daquele protocolo. A família de protocolo é um SHA-256 dos campos
técnicos do DICOM, sem identificadores. A regra depende do número de controles:

- com ≥ 30, desloca e reescala (escala limitada a 0,5–2);
- com 10–29, só desloca;
- com menos de 10, não aplica.

O painel mostra, **antes do ajuste**, a média e o DP dos z dos controles e a correlação com
a idade. A calibração fica no navegador e pode ser exportada e importada em JSON. Sem ela,
todas as tabelas dizem "**não calibrado para este sítio**".

**Assimetria e ocupação hipocampal do mesmo método.** O z do índice de assimetria e o da
ocupação hipocampal (HOC = V_hip / (V_hip + V_corno temporal)) são calculados contra
controles do DLBS medidos **com o mesmo SynthSeg do app**, com média e DP por idade
(`models/normative/referencia_mesmo_metodo.json`). Parcelas corticais DKT não têm essa
referência: o IA delas é descritivo, sem z e sem cor. O antigo corte fixo |IA| > 10% saiu.

**DKT × normas DK.** As normas regionais dos brain charts são do atlas **DK**; o protocolo
**DKT** (Klein & Tourville, *Front Neurosci* 2012) eliminou bankssts, frontalpole e
temporalpole, cujo tecido foi absorvido pelas regiões adjacentes sem partilha definida. Com
parcelação DKT, as parcelas DK vizinhas saem **sem z** ("sem norma comparável"), em vez de
um z inflado.

### Convenções dos números exportados

- **Volume principal:** com o SynthSeg, o **volume suave** (soma das posteriores na grade da
  rede, a convenção do `--vol` oficial); a contagem de voxels (volume rígido) fica como
  auditoria (`volume_rigido_mm3`, `metodo_volume`, `dif_suave_rigido_pct` — a diferença
  suave − rígido é um indicador de incerteza de fronteira). Parcelas DKT: o córtex suave de
  cada hemisfério é redistribuído na proporção do volume rígido das parcelas. Redes sem
  posteriores (MeshNet) continuam com o rígido.
- **Índice de assimetria:** `IA = 200·(E − D)/(E + D)`, em %. **Positivo = esquerda maior**,
  negativo = direita maior, 0 = simetria (faixa −200 a +200). Calculado para cada par E/D com
  o mesmo nome-base (`Left-`/`Right-`, `ctx-lh-`/`ctx-rh-`), sobre o volume principal; o
  `z_assimetria` vem da referência do mesmo método, quando há. A convenção vai também no JSON
  (`convencao_assimetria`), nos rótulos do SPSS e no PDF.
- **Parcelas ausentes no DKT:** o protocolo DKT (Klein & Tourville 2012) eliminou `bankssts`,
  `frontalpole` e `temporalpole` (absorvidos pelas regiões vizinhas). Com a parcelação DKT elas
  não aparecem nas tabelas nem nas exportações (em vez de linhas com volume zero); o JSON
  registra a omissão em `rotulos_omitidos`. Com o modelo DK de 104 classes (brainchop), que as
  tem, elas continuam presentes.

## Exportações

- **CSV** longo (estrutura/agregado/lobo/assimetria/VIC/espessura volumétrica; decimal
  configurável; colunas `pct_vic`, `volume_rigido_mm3`, `metodo_volume`,
  `dif_suave_rigido_pct` e `z_assimetria`)
- **JSON** completo. Traz:
  - estruturas com centroide RAS, agregados, lobos, assimetria com z, VIC, qualidade e proveniência do pré-processamento;
  - normativo com `proveniencia`, `multiplicidade`, `ic90` e `incerteza` por z;
  - `alertas_qc` e `ocupacao_hipocampal`;
  - `aquisicao`: fabricante, campo, sequência, TR/TE/TI, correção de distorção;
  - `protocolo` (família) e `idade_fonte`;
  - `reprodutibilidade`: SHA-256 dos pesos, normas, recentragem e referências usados, e versão do app;
  - espessura e ressalvas
- **SPSS `.sav`** — escritor próprio (nomes longos, rótulos em português UTF-8), incluindo
  `eTIV` e `thick_*`; abre no SPSS, `haven::read_sav()` e `pyreadstat`
- **PDF** — laudo diagramado no estilo Apple (hierarquia por peso e tamanho, cartões
  arredondados, cor só com função: azul informa, laranja marca o atípico, vermelho o
  possível erro): capa com ficha do exame, captura e mostradores; QC por grupo tecidual;
  comparação normativa com medidores P5–P50–P95; **volumes por região** agrupados por lobo
  (frontal, temporal, parietal, occipital, ínsula) e depois por grupo tecidual, com
  **esquerdo e direito lado a lado**, total, % do VIC e o **índice de assimetria como
  coluna** (sem página própria); espessura por região, também por lobo, com régua E/D; métodos.
  Tipografia **Inter** (SIL OFL 1.1, `fonts/inter/`), embutida com kerning, algarismos
  tabulares e espaçamento pelas métricas dinâmicas da Inter — a alternativa aberta mais
  próxima da SF Pro (a San Francisco e a Myriad não podem ser redistribuídas: a licença da
  SF limita o uso às plataformas da Apple, e a Myriad é comercial da Adobe). O texto do PDF
  continua pesquisável e copiável (ToUnicode); sem as fontes, o laudo cai na Helvetica.
  `tools/inter_subset.py` regenera o subconjunto e o kerning.

**Lobos.** As parcelas DKT são agrupadas em cinco lobos — frontal, temporal, parietal,
occipital e ínsula —, com o cíngulo distribuído como nos lobos "estritos" do FreeSurfer:
cíngulo anterior (rostral e caudal) no frontal, cíngulo posterior e istmo no parietal. A
mesma convenção vale para os volumes por lobo do CSV/JSON (sem z por lobo: não há norma lobar).

**Espessura cortical volumétrica nas exportações.** A espessura por região DKT (passo 05)
sai no CSV (linhas `espessura_volumetrica`), no JSON, no `.sav`/coorte (`thick_*`) e no PDF,
**sempre com o aviso metodológico**: é um método volumétrico (Laplace + reconstrução de
sulcos fechados), validado em fantomas, mas sem comparação sujeito a sujeito com o
FreeSurfer — os valores absolutos podem diferir dos do recon-all/FastSurfer, então não os
misture com espessuras de outro método. O aviso vai numa linha `nota_metodologica` do CSV,
em `espessura_volumetrica.aviso_metodologico` do JSON, nos rótulos das variáveis do `.sav`,
nas ressalvas e num cartão no topo da página de espessura do PDF. A malha 3D continua fora
das exportações.
- **NIfTI** — segmentação, conformado e intermediários (pré-processado nativo, MP-RAGE
  sintético, máscara, cérebro extraído, **norm sintético**) em `.nii.gz`
- **QC `.csv`** — índice de confiança interno (não validado), confiança, coesão e simetria
  por grupo tecidual (uma linha por exame, na forma do `synthseg.qc.csv`) + mapa de
  confiança da rede em `.nii.gz`
- **`talairach.xfm`** — transformada linear para o MNI (formato MNI Transform File)
- **Malhas** — white/pial em `.mz3` dentro do `.zip` (com o xfm e o norm)
- **Coorte** — uma linha larga por exame, persistida no navegador → CSV largo e `.sav`
  (com idade, sexo, família do protocolo e a marca de **controle** usada na calibração do sítio)

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

**Testes** (Node ≥ 20):

```bash
npm install                  # playwright-core (usa o Chromium instalado)
npm test                     # unidade: normas × R, Holm, IC 90%, recentragem, calibração, DICOM, PDF
npm run test:navegador       # interface no Chromium, com inferência simulada
npm run test:golden          # exames de referência com o pipeline real (tests/golden/README.md)
```
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
lib/sdf-surface.js                     recon-clinical: SDFs, partição E/D, Eq. 5, Euler, Talairach
lib/segqc.js                           QC por grupo tecidual (confiança, coesão, simetria)
lib/dkt-fusion.js                      fusão parcelação→córtex (esquema do predict_synthseg)
lib/surfaces.js                        EDT, surface nets, Taubin, áreas, MZ3
lib/normative.js                       percentil/z, proveniência, IC 90%, recentragem, multiplicidade
lib/calibracao.js · lib/protocolo.js   calibração do sítio (nível C) e família do protocolo (DICOM)
lib/qcrules.js · models/qc_rules.json  alertas de QC declarativos e alvos de captura
lib/assimetria.js                      z da assimetria e da HOC contra controles do mesmo método
lib/stats.js · lib/labels.js           volumetria, lobos, assimetria, nomes em pt-BR
lib/sav.js · lib/pdf.js · lib/report.js  SPSS, PDF e relatório
lib/nifti-writer.js · lib/zip.js       NIfTI-1 e ZIP
workers/preprocess.worker.js           etapas nativas (FSL-like + ramo robusto)
workers/mask.worker.js                 limpeza da máscara cerebral (BET-like)
workers/synthseg.worker.js             inferência SynthSeg em blocos
workers/synthsr.worker.js              síntese SynthSR (MP-RAGE 1 mm)
workers/fastsurfer.worker.js           parcelação FastSurferCNN por vistas
workers/reconsurf.worker.js            superfícies recon-all-clinical (SDF + Eq. 5)
workers/surface.worker.js              motor anterior (surface nets puro; substituído)
brainchop/                             worker de inferência do brain2print (MIT)
models/synthseg1/                      SynthSeg 1.0 em tfjs f16 (27 MB) + rótulos
models/synthsr/                        SynthSR v1.0 em tfjs f16 (26 MB) + fixture de paridade
models/synthsurf/                      SynthDist em tfjs f16 (26,5 MB) + fixture de paridade
models/synthsurf_v10_fp16.h5           checkpoint enxugado (24,4 MB) + scripts de redução
models/fastsurfer/                     FastSurferCNN v1 f32 (3×7,2 MB) + manifesto
models/normative/brainchart.json       curvas normativas vendorizadas
models/normative/subcortical.json      centis subcorticais (CentileBrain)
models/normative/normas_segmentarm.json       normas próprias (mesmo SynthSeg, 641 controles, 14 sítios)
models/normative/recentragem_synthseg.json    recentragem do z pelo método (controles do DLBS)
models/normative/referencia_mesmo_metodo.json assimetria e HOC por idade (DLBS, SynthSeg do app)
models/normative/erro_medida.json      teste-reteste por estrutura (IC 90% do z)
models/manifest-sha256.json            SHA-256 dos pesos/normas (reprodutibilidade)
lib/icv.js · workers/icv.worker.js    volume intracraniano (eTIV) por registro afim ao MNI152
models/model*/                         MeshNet do brainchop (MIT)
tools/convert_synthseg1_tfjs.py        conversor SynthSeg (reprodutível)
tools/convert_synthsr_tfjs.py          conversor SynthSR (reprodutível)
tools/convert_synthsurf_tfjs.py        conversor SynthDist (traga-seus-pesos do FreeSurfer)
tools/convert_synthseg2_tfjs.py        conversor SynthSeg 2.0: S1/denoiser/S2, parc e QC (traga-seus-pesos)
tools/convert_fastsurfer_tfjs.py       conversor FastSurferCNN (reprodutível, sem torch)
tools/synthseg_node.mjs · tools/lote_synthseg_node.mjs  o SynthSeg do app em Node (lote offline)
tools/dlbs_selecao.py · tools/referencias_dlbs.py      seleção do DLBS, referências do mesmo método, comparação com o FreeSurfer
tools/recentragem_dlbs.mjs             recentragem do z (nível A) com as normas do app + relatório
tools/normas_selecao.py                normas próprias: manifesto das bases CC0 (OpenNeuro, S3)
tools/normas_lote.mjs                  normas próprias: baixa → SynthSeg + VIC → apaga a imagem
tools/normas_local.py                  normas próprias: exames locais (OASIS-3, controles do serviço)
tools/normas_preparar.mjs              normas próprias: tabela + z do pipeline anterior
tools/normas_ajuste.R                  normas próprias: GAMLSS com sítio aleatório + validação
tools/normas_relatorio.py              normas próprias: docs/validacao/normas.md
tools/manifesto_sha256.mjs             regenera models/manifest-sha256.json
tests/unit/ · tests/browser/ · tests/golden/  testes (Node, Chromium) e exames de referência
docs/                                  plano metodológico e validação
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
inferência pesada na GPU — era a causa da tela branca).

O inspetor traz a **linha do tempo do processamento**: cada etapa aparece em sequência
(rodando → concluída/aviso/erro) com as **decisões tomadas em função da imagem** (pipeline
robusto acionado pela régua, SynthSR ativo, rede recebendo só o cérebro extraído, máscara
pequena, hemisfério sem parcelas…) e **chips de um clique** que trocam o visualizador para
o entregável de cada etapa — exame original, pré-processado nativo, MP-RAGE sintético,
conformado, máscara (QC), cérebro extraído, segmentação/parcelação e malhas 3D. Uma etapa
com erro ganha os chips "o que fazer" (reabre o tutorial) e "baixar log de erro".

**Quando uma etapa falha**, um pop-up explica em português o que aconteceu e o que fazer
(ex.: superfícies sem parcelação DKT → re-rodar o passo 04, trocar a fonte ou usar
CPU/memória baixa), e cada erro vira um registro num **log exportável (.txt)** — com
entrada, seleções, diagnóstico do worker (voxels parcelados por hemisfério etc.) e as
últimas linhas do console — persistido no navegador (últimos 20) e acessível pelo botão
do pop-up ou por **Exportar → Log de erros**. O passo de superfícies também deixou de
bloquear com parcela em um único hemisfério: prossegue com o lado disponível e avisa.

Tema escuro grafite/osso/
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
- **recon-all-clinical / SynthDist** — Gopinath, Greve, Magdamo, Arnold, Das, Puonti,
  Iglesias ([freesurfer/freesurfer](https://github.com/freesurfer/freesurfer) →
  `recon_all_clinical/`): fluxo e fórmulas reimplementados do código-fonte; os pesos do
  SynthDist acompanham o projeto em forma reduzida e seguem a **licença do FreeSurfer**,
  que restringe redistribuição — leia `licenses/synthsurf.txt` antes de publicar um fork
  ou mirror. Cite *"Recon-all-clinical": Cortical surface
  reconstruction and analysis of heterogeneous clinical brain MRI* (Medical Image
  Analysis, 2025).
- **FastSurfer** — Henschel, Conjeti, Estrada, Diers, Fischl, Reuter
  ([Deep-MI/FastSurfer](https://github.com/Deep-MI/FastSurfer), Apache 2.0): checkpoints
  oficiais do FastSurferCNN v1 convertidos para tfjs (`licenses/fastsurfer.txt`). Cite
  *FastSurfer — A fast and accurate deep learning based neuroimaging pipeline*
  (NeuroImage, 2020).
- **Brain charts** — Bethlehem, Seidlitz, White et al.
  ([brainchart/Lifespan](https://github.com/brainchart/Lifespan)). Cite *Brain charts for
  the human lifespan* (Nature, 2022).
- **CentileBrain** — Ge, Yu, Qi et al.
  ([CentileBrain/centilebrain](https://github.com/CentileBrain/centilebrain), sem licença
  explícita; uso em pesquisa): normas subcorticais regionais. Cite *Normative modelling of
  brain morphometry across the lifespan with CentileBrain* (Lancet Digit Health, 2024) e
  Dima et al., *Subcortical volumes across the lifespan* (Hum Brain Mapp, 2022).
- **brainchop** — Masoud, Hu & Plis (MIT); **brain2print** — grupo de Chris Rorden (MIT):
  worker de inferência e modelos MeshNet.
- **NiiVue** e **dcm2niix** — Rorden e colaboradores.
- **LUME** e **Morfo Studio** — projetos do mesmo autor; triagem DICOM e pré-processamento
  FSL portados de lá.
- Linhagem conceitual: **SynthSeg / SynthSR / recon-all-clinical** — Billot, Gopinath,
  Iglesias e colaboradores, Martinos Center (MGH/Harvard). Cite os artigos originais em
  trabalhos que usem as segmentações.
