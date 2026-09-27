# Exames *golden*

Quatro exames de referência, todos **públicos** — nenhum dado de paciente do serviço entra no
repositório. Cada mudança de método deve ser rodada contra eles: o *runner* mostra a diferença
de volume por estrutura (%) contra a referência gravada e falha se alguma passar da tolerância.

| id | fonte | idade/sexo | por quê |
|---|---|---|---|
| `exemplo` | exemplo do app (brain2print, MIT) | — | o mesmo exame dos testes de interface |
| `ds000001-sub-01` | OpenNeuro ds000001 (CC0) | 26 F | adulta jovem, Siemens |
| `dlbs-sub-1225` | Dallas Lifespan Brain Study, ds004856 (CC0) | 89 F | faixa etária do exame-índice (89 anos) |
| `dlbs-sub-2054` | Dallas Lifespan Brain Study, ds004856 (CC0) | 88 M | idem, sexo masculino |

Os arquivos são baixados na primeira execução para `tests/golden/.cache/` (fora do git) e
conferidos pelo SHA-256 registrado em `exames.json` — se a fonte mudar, o teste para.

## Rodar

```bash
npm install                                   # playwright-core (Chromium já instalado)
node tests/golden/run.mjs                     # navegador: o app inteiro, como o usuário
node tests/golden/run.mjs --so exemplo        # um exame
node tests/golden/run.mjs --atualizar         # grava a referência após mudança INTENCIONAL

npm i --no-save @tensorflow/tfjs-node@4.22.0
node tests/golden/run.mjs --motor node        # o mesmo núcleo do SynthSeg em Node
node tests/golden/motores.mjs --f16 --cpu     # equivalência navegador × Node num bloco real
node tests/golden/motores.mjs --tamanho 96    # efeito do tamanho do bloco (exame inteiro, Node)
```

**Dois motores, duas referências.** O motor do navegador roda o app completo (conformação,
SynthSeg, estatísticas): minutos com GPU. Sem GPU, o WebGL do Chromium é o SwiftShader
(software), que o tfjs recusa (`failIfMajorPerformanceCaveat`), e o app cai no backend CPU
em JavaScript. São cerca de 24 min por bloco de 128³ com o espelhado, e o exemplo tem 27
blocos: cerca de 11 h. O motor Node roda o **mesmo** `lib/synthseg-core.js` com TensorFlow
nativo, em ~2–5 min por exame em CPU. Os rígidos do motor Node são contados na grade da rede
(no app, na grade conformada); por isso cada motor tem a sua referência. As do repositório
são as do Node (`<id>.node.json`); a do navegador (`<id>.json`) é gravada na primeira
execução, de preferência numa máquina com GPU. A equivalência entre os dois está medida
abaixo.

**O que é comparado.** O volume **rígido** (a segmentação em si) e o **principal** (suave
quando a rede dá posteriores). Mudança só no principal = mudança de convenção de volume, não
da segmentação. A tolerância padrão é 0,5% (`--tol`).

## Equivalência entre os motores e tamanho do bloco (medidos)

O lote do DLBS foi medido com o motor Node e blocos de 128³, e com ele os coeficientes da
recentragem. `tests/golden/motores.mjs` verifica se o app no navegador dá os mesmos números:

- um bloco real do exame, com o pré-processamento oficial do núcleo, vai idêntico aos motores;
- cada motor roda a rede, a suavização e o top-3 do app;
- a comparação é feita voxel a voxel e por estrutura, depois do pós-processamento do app.

O recorte do exemplo sai igual nos dois motores: 209×256×208, o mesmo do log do app.

**Motores.** Exame `exemplo`, bloco central de 96³, 28 estruturas com ≥ 500 voxels no bloco.
É o bloco que o app usa quando a GPU aceita texturas de até 8192², como o SwiftShader.

| Navegador × Node | rótulo igual | \|Δ posterior\| máx. | maior \|Δ\| do volume suave | Dice mínimo | tempo |
|---|---:|---:|---:|---:|---:|
| WebGL, 32 bits | 100% dos voxels | 1,5·10⁻⁵ (1 passo da quantização) | 0,00002% | 1,0000 | 288 s |
| WebGL, 16 bits | 99,975% | 1,3·10⁻² | 0,14% (pálido E) | 0,9991 | 646 s |
| CPU do tfjs (o app sem WebGL) | 100% | 1,5·10⁻⁵ | 0,00002% | 1,0000 | 307 s |

O Node leva 1,6 s nesse bloco; os tempos do navegador são no SwiftShader, sem GPU. A linha
de 16 bits usa `WEBGL_FORCE_F16_TEXTURES`, que imita GPUs sem float32 renderizável.

- **Com float32**, que desktops e a maioria dos notebooks têm, o app e o motor Node dão o
  mesmo volume.
- **Com texturas de 16 bits**, a diferença fica abaixo de 0,2% por estrutura. Isso é bem
  menos que o erro teste-reteste do SynthSeg no mesmo scanner: 0,45–1% nos volumes globais
  e no tálamo (`models/normative/erro_medida.json`).

**Tamanho do bloco.** Exame `exemplo` inteiro em Node (`--tamanho`): diferença do volume
suave contra 128³, com E / D.

| Estrutura | 96³ (150 blocos) | 160³ (8 blocos) | 192³ (8 blocos) |
|---|---:|---:|---:|
| Córtex cerebral | −0,3% / −0,3% | +0,2% / +0,1% | +0,2% / +0,1% |
| SB cerebral | +0,0% / −0,1% | −0,1% / −0,1% | −0,1% / −0,1% |
| Ventrículo lateral | −1,2% / −1,2% | +0,0% / +0,2% | +0,1% / +0,2% |
| Corno temporal | −0,6% / +0,5% | −0,8% / −1,0% | −0,3% / −0,7% |
| Córtex cerebelar | **−6,7% / −7,2%** | +0,3% / +0,2% | +0,3% / +0,2% |
| SB cerebelar | −1,5% / −2,0% | +0,1% / +0,2% | +0,2% / +0,2% |
| Tálamo | −1,3% / −0,8% | −0,5% / −0,3% | +0,1% / +0,2% |
| Caudado | −0,2% / +0,0% | +0,1% / +0,1% | +0,1% / −0,0% |
| Putâmen | +0,1% / +0,0% | +0,3% / −0,0% | +0,3% / +0,0% |
| Pálido | **+2,8% / +1,4%** | +0,7% / +0,1% | −0,1% / −0,2% |
| Hipocampo | +0,4% / +0,2% | +0,1% / +0,0% | −0,1% / −0,1% |
| Amígdala | +0,4% / +0,6% | −0,2% / −0,5% | −0,5% / −0,4% |
| Accumbens | +0,9% / +0,7% | +1,1% / +0,8% | +0,2% / +0,3% |
| Diencéfalo ventral | +0,9% / +1,3% | +0,4% / +0,6% | −0,2% / −0,3% |
| 3º ventrículo | −0,3% | −0,4% | −0,2% |
| 4º ventrículo | +0,4% | +0,3% | +0,0% |
| Tronco | +0,2% | +0,1% | −0,0% |
| mediana \|Δ\| (todas as estruturas) | 0,62% | 0,16% | 0,19% |

- **Com 160³ e 192³**, tudo fica a menos de ~1% de 128³. Com 128³, a rede já tem contexto
  suficiente.
- **Com 96³**, o córtex cerebelar perde 7%, o pálido ganha até 2,8%, e o tálamo e os
  ventrículos perdem cerca de 1%.

Blocos de 96³ são os do app na variante "memória baixa" e em GPUs com texturas de até 8192².
Como a recentragem foi medida com 128³, o laudo avisa quando o bloco é menor (regra
`bloco_reduzido` em `models/qc_rules.json`) e registra o bloco usado na reprodutibilidade.

O volume inteiro num bloco só (224×256×224, como o `predict` oficial sem `--crop`) não coube
em 15 GB de RAM no Node.

## O exame-índice (e qualquer exame local)

```bash
node tests/golden/run.mjs --exame /caminho/exame.nii.gz
```

A referência de um exame local fica em `tests/golden/.local/` (fora do git). Anonimize antes
(dcm2niix sem nome/datas) e nunca faça *commit* desses arquivos.

## Diferença desta versão (rígido → suave como valor principal)

Os rótulos não mudaram nesta versão (`lib/synthseg-core.js` e os *workers* estão idênticos
ao `main` anterior): o volume principal passou do rígido (contagem de voxels) para o suave
(soma das posteriores, convenção do `--vol` do SynthSeg oficial). A diferença suave − rígido
de cada estrutura, em cada exame, é a coluna `dif_suave_rigido_pct` do CSV e o campo
`difSuaveRigidoPct` do JSON; as referências gravadas aqui trazem os dois valores.

Volume principal antes (rígido) → depois (suave), nas referências do motor Node (rígido
contado na grade da rede):

| Estrutura (E + D) | exemplo | ds000001 26 F | DLBS 89 F | DLBS 88 M |
|---|---:|---:|---:|---:|
| Córtex cerebral | −6,2% | −6,8% | −5,3% | −5,3% |
| SB cerebral | +1,9% | +1,5% | +0,8% | +1,4% |
| Ventrículo lateral | +0,9% | +3,0% | −0,4% | −1,5% |
| Corno temporal | +10,3% | +6,1% | −2,5% | −7,4% |
| Tálamo | −2,0% | −1,9% | −3,0% | −2,6% |
| Caudado | −0,8% | −0,6% | −1,0% | −0,8% |
| Putâmen | −0,5% | −0,3% | −1,9% | −1,6% |
| Pálido | +0,2% | +0,0% | −1,3% | −2,5% |
| Hipocampo | −4,1% | −5,6% | −5,4% | −6,1% |
| Amígdala | −5,2% | −5,6% | −6,7% | −6,8% |
| Accumbens | −4,6% | −5,4% | −6,1% | −8,9% |
| Diencéfalo ventral | −4,0% | −4,5% | −5,0% | −5,3% |
| Córtex cerebelar | −8,2% | −9,0% | −6,8% | −8,0% |
| SB cerebelar | +13,2% | +12,4% | +9,4% | +11,5% |
| 3º ventrículo | −6,6% | −8,6% | −9,1% | −10,5% |
| 4º ventrículo | −5,4% | −3,5% | −5,7% | −6,8% |
| Tronco | −3,6% | −3,3% | −3,3% | −3,4% |

O suave encolhe estruturas finas cercadas de tecido de outra classe (córtex, hipocampo,
amígdala, accumbens: os voxels de fronteira contam só a fração da posterior) e aumenta a SB
cerebelar e cerebral, que recebem as frações das vizinhas. É a convenção oficial do
SynthSeg; o viés que sobra em relação às normas (medidas com o FreeSurfer) é o que a
recentragem pelo método corrige (`docs/validacao/dlbs.md`).
