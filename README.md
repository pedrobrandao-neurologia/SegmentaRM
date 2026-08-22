# Morfometria local

PWA que segmenta RM encefálica e calcula volumes por estrutura **inteiramente no navegador**.
Nenhuma imagem é enviada para servidor algum. Feito no espírito do `brain2print` e do `brainchop`,
mas orientado a relatório volumétrico: aseg + parcelação cortical, cerebelo, tronco encefálico,
entrada por pasta DICOM e exportação em CSV, JSON, SPSS (`.sav`) e NIfTI.

> **Uso em pesquisa e ensino.** Não é dispositivo médico, não tem registro ANVISA e não substitui
> leitura radiológica. Confira a segmentação sobre a imagem antes de usar qualquer número.

---

## O que já está pronto e o que falta

| Peça | Situação |
|---|---|
| Leitura de pasta DICOM (VR explícito/implícito, little endian), agrupamento por série, ordenação por posição, montagem do affine LPS→RAS | pronto |
| Leitura e escrita de NIfTI-1, incluindo `.nii.gz` | pronto |
| Reamostragem para grade isotrópica de 1 mm alinhada a RAS, normalização robusta por percentis | pronto |
| Inferência ONNX em blocos com sobreposição, argmax progressivo, WebGPU com queda para CPU | pronto |
| Fusão de segmentações (cerebelo e tronco sobrescrevendo a aseg) | pronto |
| Volumetria, índice de assimetria, agregados derivados | pronto |
| Visualizador ortogonal com sobreposição e leitura do rótulo sob o cursor | pronto |
| Exportação CSV / JSON / `.sav` / NIfTI e acúmulo de coorte | pronto |
| Armazenamento dos modelos no dispositivo (OPFS) e funcionamento offline | pronto |
| **Os pesos dos modelos em ONNX** | **você precisa converter** |

O aplicativo não embarca nenhum modelo. Os pesos do SynthSeg são distribuídos pelos autores
sob os termos deles, e a conversão precisa rodar na sua máquina.

---

## Converter o SynthSeg

```bash
git clone https://github.com/BBillot/SynthSeg
# baixe os pesos conforme o README do repositório (vão para SynthSeg/models/)
pip install tensorflow tf2onnx onnx onnxruntime numpy

python tools/convert_synthseg.py \
  --model  SynthSeg/models/synthseg_2.0.h5 \
  --labels SynthSeg/data/labels_classes_priors/synthseg_segmentation_labels_2.0.npy \
  --out    build/synthseg_aseg \
  --name   "SynthSeg 2.0 aseg"
```

O script gera `synthseg_aseg.onnx` e `synthseg_aseg.json`. Arraste **os dois juntos** para o slot
"Segmentação principal". Para a versão com parcelação cortical, use `synthseg_parc_2.0.h5` com o
`.npy` de rótulos correspondente.

O `.json` é o contrato entre o modelo e o aplicativo:

```jsonc
{
  "name": "SynthSeg 2.0 aseg",
  "task": "segment",         // ou "regress" para o SynthSR
  "layout": "NDHWC",         // "NCDHW" para modelos exportados do PyTorch
  "inputName": "input",
  "outputName": "unet_prediction",
  "tile": 0,                 // 0 = volume inteiro; 96 ou 128 se faltar memória
  "overlap": 16,
  "labels": [0, 2, 3, ...]   // labels[i] = rótulo FreeSurfer do canal i
}
```

Se a lista `labels` estiver na ordem errada, a segmentação sai plausível e completamente trocada —
é o erro mais fácil de cometer e o mais difícil de perceber. Por isso o script lê o `.npy` oficial
e confere o número de canais.

### Cerebelo e tronco encefálico

O SynthSeg entrega o cerebelo como cortical/branca por hemisfério e o tronco como rótulo único (16).
Para subdividir:

- **Cerebelo:** o CerebNet, módulo do FastSurfer (`Deep-MI/FastSurfer`), é PyTorch e exporta com
  `torch.onnx.export`. Use `"layout": "NCDHW"` e a LUT do próprio CerebNet.
- **Tronco:** o `segmentBS` do FreeSurfer é bayesiano, não é rede — não há conversão direta.
  As alternativas realistas hoje são treinar/obter uma rede própria ou o NextBrain, que é pesado
  demais para o navegador. O slot existe e funciona com qualquer ONNX que produza os rótulos
  173/174/175/178; até lá, deixe vazio.

O aplicativo aceita qualquer inteiro como rótulo. Para nomes e cores corretos de um modelo novo,
carregue o `FreeSurferColorLUT.txt` (ou a LUT do modelo) em **Ajustes**.

---

## Rodar

Precisa ser servido por HTTP — módulos ES e service worker não funcionam em `file://`.

```bash
python3 -m http.server 8080     # http://localhost:8080
```

Para publicar no GitHub Pages, basta commitar a pasta: é tudo estático. O ONNX Runtime vem de CDN
na primeira execução e fica em cache pelo service worker; os modelos ficam no OPFS. Depois disso o
aplicativo funciona sem rede.

---

## Limites que você vai encontrar

**Memória.** Uma U-Net a 192³ com 24 canais na resolução plena usa ~680 MB por tensor de ativação,
e a saída com 98 rótulos passa de 2,8 GB. O WASM tem teto de 4 GB; no WebGPU o
`maxStorageBufferBindingSize` costuma ficar bem abaixo disso. Se der erro de alocação, reduza a
grade para 160³ e coloque `"tile": 96` no descritor.

**Convolução 3D.** É cidadã de segunda classe nos runtimes web. Espere de 1 a 4 minutos com WebGPU
numa máquina boa e de 15 a 45 minutos em CPU. O badge no topo da barra lateral mostra o que o seu
navegador oferece.

**DICOM comprimido.** JPEG, JPEG-LS, JPEG 2000 e RLE não são decodificados. O aplicativo avisa e
pede conversão prévia com `dcm2niix`. A maior parte da RM de rotina sai em VR explícito não
comprimido e passa direto.

**Espessura cortical e superfícies.** Não estão aqui e não vão estar: dependem de geometria e
topologia (`recon-all-clinical`), que é C++ pesado. Isto é volumetria.

**Exame anisotrópico.** Reamostrar um FLAIR de 5 mm para 1 mm não cria informação. Os volumes
servem para estudo de grupo com N grande; para leitura individual, seja conservador e sempre
reporte a sequência e a resolução de origem.

---

## Usar os resultados no R

```r
library(dplyr); library(tidyr); library(readr)

vol <- read_csv("coorte_volumes.csv")           # formato largo, uma linha por exame

# normalizar pelo volume cerebral segmentado
vol_norm <- vol |>
  mutate(across(-c(subject, BrainSegVol), ~ .x / BrainSegVol * 100, .names = "pct_{.col}"))

# assimetria de estruturas pareadas
assim <- vol |>
  transmute(subject,
            AI_hipocampo = 200 * (`Left-Hippocampus` - `Right-Hippocampus`) /
                                 (`Left-Hippocampus` + `Right-Hippocampus`))
```

O `.sav` sai com nomes longos no registro 7/13, então abre no SPSS, no `haven::read_sav()` e no
`pyreadstat` com os nomes das estruturas preservados.

---

## Estrutura

```
index.html            interface e estilos
app.js                orquestração
lib/dicom.js          leitor de séries DICOM não comprimidas
lib/nifti.js          leitura e escrita NIfTI-1
lib/resample.js       reamostragem afim, conform, normalização
lib/infer.js          ONNX Runtime, inferência em blocos
lib/stats.js          volumetria, fusão, assimetria, CSV/JSON
lib/sav.js            escritor SPSS .sav
lib/lut.js            rótulos, cores, pares contralaterais
lib/viewer.js         visualizador ortogonal
tools/convert_synthseg.py   conversão Keras → ONNX + descritor
sw.js                 cache offline
```

## Créditos

SynthSeg e SynthSR: Billot, Iglesias e colaboradores, Martinos Center (MGH/Harvard).
Cite os artigos originais em qualquer trabalho que use as segmentações.
A ideia de rodar segmentação 3D no navegador vem do `brainchop` (Masoud, Hu & Plis) e do
`brain2print` (grupo do Chris Rorden).
