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

### O modo robusto não é o SynthSR

Quando a régua marca C/D (FLAIR axial de 5 mm, poucos cortes, baixo campo), o ramo robusto
aplica métodos **clássicos** — reamostragem cúbica, correção homomórfica de viés — inspirados
no *papel* do SynthSR dentro do `recon-all-clinical`, mas sem a rede: reamostrar não cria
informação. O relatório e o JSON registram o nível de qualidade e o pipeline usado; para
inferência individual em exame anisotrópico, seja conservador.

---

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

## Créditos

- **brainchop** — Masoud, Hu & Plis (MIT); **brain2print** — grupo de Chris Rorden (MIT): worker de inferência e modelos.
- **NiiVue** e **dcm2niix** — Rorden e colaboradores.
- Linhagem conceitual: **SynthSeg / SynthSR / recon-all-clinical** — Billot, Gopinath, Iglesias
  e colaboradores, Martinos Center (MGH/Harvard). Cite os artigos originais em trabalhos que
  usem as segmentações.
