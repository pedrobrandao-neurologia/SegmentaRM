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
```

**Dois motores, duas referências.** O motor do navegador roda o app completo (conformação,
SynthSeg no WebGL, estatísticas) e é a referência de verdade — minutos com GPU, horas numa
máquina sem GPU (o WebGL cai no SwiftShader). O motor Node roda o **mesmo**
`lib/synthseg-core.js` com TensorFlow nativo: ~2–4 min por exame em CPU. Os volumes suaves
(o valor principal) são somados na grade da rede e coincidem entre os motores a menos de
arredondamento; os rígidos do motor Node são contados na grade da rede (no app, na grade
conformada) — por isso cada motor tem a sua referência (`<id>.json` e `<id>.node.json`).

**O que é comparado.** O volume **rígido** (a segmentação em si) e o **principal** (suave
quando a rede dá posteriores). Mudança só no principal = mudança de convenção de volume, não
da segmentação. A tolerância padrão é 0,5% (`--tol`).

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
