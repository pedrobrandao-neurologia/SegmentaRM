# Normas próprias a partir de bases públicas

> **Estado (out/2026):** o nível A está implementado e embarcado no app
> (`models/normative/normas_segmentarm.json`, ligado por padrão para o SynthSeg com volume
> suave). Resultado e validação na [§6](#6-implementação-e-validação-out2026) e em
> [`validacao/normas.md`](validacao/normas.md). As seções 1–5 são o plano original.

**Objetivo.** Substituir o par "norma FreeSurfer + recentragem" por curvas ajustadas
diretamente em volumes medidos com o **mesmo método** do app: SynthSeg 1.0 do SegmentaRM,
volume suave, bloco 128³ e espelhamento E/D. O **sítio** entra modelado.

**Restrição mantida.** Todo o processamento é offline, em `tools/`. No app entram só
coeficientes, e nenhum exame sai do dispositivo.

Levantamento feito em out/2026. Os números do OpenNeuro foram lidos do S3 público
(`participants.tsv`, `dataset_description.json` e listagem de T1). Itens marcados
*incerto* não puderam ser conferidos na fonte primária.

## 1. Bases utilizáveis

### Nível A — CC0, download anônimo (`https://s3.amazonaws.com/openneuro.org/<ds>/`)

| Base | N com T1 / idade | Scanner | Observação |
|---|---|---|---|
| DLBS ds004856 | 464 (onda 1); 21–89 | Philips 3T | Saudáveis, MMSE ≥ 26; ondas 2–3 para estabilidade; já usado na recentragem |
| PAN / Healthy Minds for Life ds007522 | 968; 50–79 | 4 sítios 3T (Philips Ingenia Elition X; Siemens Skyra, Prisma Fit e Vida) | Sem demência; cognição só por pedido; `excluded_scans` |
| NIMH Healthy Research Volunteer ds005752 | 249; 18–72 | **GE** MR750 3T | Clinicamente saudáveis |
| Neurocognitive aging ds003592 | 300; 18–83 | 2 sítios, 3T (modelo *incerto*) | Jovens e 60–83 |
| LEMON ds000221 | 318; faixas de 5 anos | Siemens Verio 3T | Idade só em faixas (±2,5 anos) |
| LA5c ds000030 | 130 controles; 21–50 | Siemens 3T | — |
| MR-ART ds004173 | 148; 18–75 | Siemens 3T | Usar só a aquisição padrão; as com movimento servem para testar o QC |
| AOMIC ds002785, ds002790, ds003097 | 1.370; 18–26 | Philips 3T | Âncora dos jovens (subamostrar) |
| ON-Harmony ds004712 | 20 pessoas, 6 scanners | Philips, GE, Siemens 3T | **Só validação** do efeito de scanner |

**O que dá para montar no nível A** (computado):
- Total: **3.926 exames saudáveis**, 1.669 com 40 anos ou mais.
- Por década, com 40 anos ou mais (F/M): 40s 73/46 · 50s 294/122 · 60s 416/229 · 70s 267/159 · **80s 35/28**.
- **Lacunas:** nenhum exame de 1,5 T e só 60 de GE com 40 anos ou mais.

### Nível A′ — download anônimo, com condições de licença

- **IXI** (~581; 20–86): CC BY-SA 3.0. É a única fonte anônima com **1,5 T e GE 1,5 T**; a distribuição por sítio é *incerta*.
- **SALD** (494; 19–80; Siemens 3T, China): CC BY-NC.
- **NKI-Rockland:** imagens anônimas, mas inclui diagnósticos psiquiátricos. Separar os saudáveis exige o fenótipo completo, sob DUA institucional, o que na prática o coloca no nível C.

### Nível B — termos aceitos pelo próprio usuário

| Base | Conteúdo | Termos |
|---|---|---|
| **OASIS-3** | 755 cognitivamente normais, 42–95 anos, 1,5 e 3T | Melhor fonte para 75–95 anos |
| **OASIS-1** | 316 não dementes, 18–96 anos, 1,5T | — |
| **Calgary-Campinas CC-359** | 359 saudáveis, ~60 por combinação GE/Philips/Siemens × 1,5/3T | CC BY-ND; adquirido em Calgary, não é população brasileira |
| **BrainLat** | 250 controles latino-americanos, 21–89 anos | Synapse; condições *incertas*; sem o Brasil |
| **Cam-CAN** | 656, 18–87 anos | O DUA exige os dados no servidor da instituição, não em disco externo |

### Nível C — controlados

ADNI/AIBL, HCP-Aging, UK Biobank e ELSA-Brasil. Os dados agregados costumam poder ser publicados, os individuais não.

**Brasil:** não foi encontrada nenhuma base aberta de T1 de adultos saudáveis brasileiros (*incerto*). A calibração local continua essencial.

## 2. Modelagem

### Modelo principal

GAMLSS por fenótipo e sexo, no estilo do BrainChart, com o **sítio** (scanner × protocolo) como efeito aleatório:
- **μ:** spline penalizada ou polinômio fracionário da idade + sexo + sítio;
- **σ:** idade + sexo + sítio;
- **ν e τ:** constantes ou lineares.

Família: **SHASHo sobre o log do volume**. O z sai em forma fechada, `z = sinh(τ·asinh((ln V − μ)/σ) − ν)`, sem tabelas e sem extrapolação de caudas.

Alternativa: regressão bayesiana hierárquica (PCNtoolkit), que adapta um sítio novo usando a posterior como prior. É mais cara (MCMC).

### Harmonização

**Não usar ComBat-GAM como pré-processamento.** Aqui idade e sítio estão confundidos (AOMIC só tem jovens, PAN só 50–79), e um sítio novo exigiria reestimar a harmonização.

### Sítio não visto, em três regimes

1. **Sem controles locais:** curva populacional com a **variância inflada pela variância entre sítios estimada**, que passa a entrar no IC do z. É o que hoje falta.
2. **Com controles locais:** estimar o efeito do sítio, como na calibração que o app já faz. A literatura pede **≥ 50–100 controles** para estabilidade, contra os 10/30 de hoje.
3. **Validar os limiares:** deixar um sítio de fora e adaptá-lo com k = 5, 10, 20, 30, 50 e 100 controles.

### Caudas

O erro-padrão do z num quantil z_p é ≈ √((1 + z_p²/2)/n). No P2,5 (z = −1,96) isso dá:

| n efetivo | erro-padrão do z | P2,5 estimado entre |
|---|---|---|
| 63 | 0,22 | P1,5 e P4,1 |
| 300 | 0,10 | P2,0 e P3,1 |
| 1.000 | 0,05 | P2,2 e P2,8 |

Os 80+ do nível A (63 exames) não bastam: é preciso o nível B (OASIS).

### Validação

- Deixar um sítio de fora, com e sem adaptação.
- Métricas: média do z ≈ 0 e DP ≈ 1, cobertura de P2,5/P97,5 e P5/P95 e *wormplots* por década, sexo e fabricante.
- Comparar com o pipeline atual (BrainChart + recentragem) nos mesmos sítios deixados de fora.

### QC

- Régua A–D do app, exclusões que vêm com cada base e regras de QC em Node.
- Excluir só falhas técnicas (por exemplo, |z| > 5 numa medida global com sobreposição conferida). Não aparar as caudas biológicas.

## 3. Fenótipos e volume intracraniano (VIC)

**Fenótipos:**
- globais (córtex, SB, cinzenta subcortical, TCV);
- ventrículos (total, laterais, corno temporal E/D);
- subcorticais E/D;
- cerebelo e tronco;
- HOC e índice de assimetria.

Pálido e accumbens recebem marca de baixa confiabilidade (dependem do contraste; ver `validacao/dlbs.md`).

**VIC:**
- Modelo principal com volumes brutos.
- Modelo secundário com log(eTIV) como covariável em μ, o que equivale ao método dos resíduos. Não usar a razão volume/VIC.
- O eTIV afim (`lib/icv.js`) precisa ser levado para o lote Node, que hoje não o calcula.

## 4. Pipeline offline

1. **`tools/normas_selecao.py`** (generaliza `dlbs_selecao.py`): manifesto com base, sujeito, sessão, idade, sexo, sítio, fabricante, campo, licença e regra de inclusão, e a lista de URLs do S3. São ~55–60 GB de T1, apagáveis depois.
2. **`tools/lote_synthseg_node.mjs`:** bloco 128³ explícito (o volume muda até 7% com 96³), vários processos em paralelo, eTIV e SHA-256 dos pesos. O tempo é de ~2 min por exame em 4 núcleos: ~130 h de CPU para 3.926 exames, ou ~16–40 h numa máquina de 32 núcleos.
3. **QC** (`tools/normas_qc.mjs`).
4. **Ajuste** (`tools/normas_ajuste.R`, com gamlss): seleção por BIC, validação deixando um sítio de fora e bootstrap por sujeito e por sítio. Leva horas a ~1 dia.
5. **Exportação** para `models/normative/normas_segmentarm.json`:
   - μ, σ, ν e τ por fenótipo e sexo numa grade de 18–90 anos;
   - a variância entre sítios;
   - o erro-padrão do z por idade;
   - n por década;
   - as bases, com DOI e licença.

   Fica com ~1 MB.
6. **No app:**
   - z SHASHo em forma fechada;
   - sem calibração local, a variância entre sítios entra no IC do z;
   - com calibração, ela estima o efeito do sítio;
   - a recentragem deixa de ser necessária para essas normas, mas continua para BrainChart e CentileBrain;
   - selo "normas SegmentaRM, n = …, sítios …".
7. **Validação gerada por script** (`docs/validacao/normas.md`), o SHA-256 no manifesto e testes contra z calculados no R.

## 5. Riscos

**Licenças.** CC0 e OASIS são tranquilos. Para as demais:
- IXI (BY-SA) e CC-359 (BY-ND): não está claro se coeficientes contam como "adaptação". O conservador é publicar os coeficientes sob BY-SA se o IXI entrar, ou usar essas bases só para validação.
- Bases NC (SALD, NKI): ficam num arquivo separado ou fora.

**Representatividade.** As amostras são de EUA, Europa e China, sem brasileiros. Calibrar localmente com 50–100 controles continua sendo o passo decisivo.

**Domínio.** Faltam 1,5 T e GE no nível A; as normas valem só para o mesmo peso, o mesmo bloco e o volume suave.

**"Saudável" varia entre bases.** Há Alzheimer pré-clínico nos idosos, e o PAN tem 69% de mulheres.

## 6. Implementação e validação (out/2026)

### O que foi feito

| Etapa | Ferramenta | Resultado |
|---|---|---|
| Seleção | `tools/normas_selecao.py` | 641 exames de 14 sítios, todos 3 T: 201 do DLBS (os da recentragem) + 440 novos, com cotas por sítio, estratificação por faixa de 5 anos e sexo, e ordem intercalada |
| Medida | `tools/normas_lote.mjs` | SynthSeg do app em Node (bloco 128³, volume suave) e VIC do app (conformação do NiiVue + `lib/icv.js`); cada T1 é baixado do S3, medido e **apagado** |
| Tabela | `tools/normas_preparar.mjs` | fenótipos com as mesmas definições do app e, nos mesmos exames, o z do pipeline atual (com e sem recentragem) |
| Ajuste | `tools/normas_ajuste.R` | GAMLSS por fenótipo (SHASHo ou normal sobre ln V, pelo BIC); μ = P-spline da idade + sexo + sítio aleatório; σ = P-spline da idade + sexo; σ_sítio por REML; erro da curva por bootstrap de sítios (B = 40); validação deixando cada sítio de fora |
| Relatório | `tools/normas_relatorio.py` | [`validacao/normas.md`](validacao/normas.md) |
| Locais (nível B) | `tools/normas_local.py` | manifesto de exames do disco do usuário (OASIS-3 ou controles do serviço) |

Amostra (F/M): 10s 15/11 · 20s 58/44 · 30s 26/24 · 40s 23/20 · 50s 64/49 · 60s 64/60 ·
70s 62/60 · 80+ 34/27. Fabricantes: Philips 301, Siemens 280, GE 60.

Processamento: ~170 s por exame num contêiner de 4 núcleos (dois processos em paralelo),
~14 h no total; o ajuste com bootstrap leva ~1 h.

### Validação: sítio não visto

Comparação nos mesmos exames, com cada sítio deixado de fora do ajuste das normas próprias. A
recentragem atual foi ajustada no DLBS, então a comparação justa é **sem o DLBS** (440 exames,
13 sítios). Média sobre as 19 medidas comuns (globais e subcorticais E/D):

| | Normas próprias | Atual (BrainChart/CentileBrain + recentragem) | Sem recentragem |
|---|---|---|---|
| \|média do z\| | **0,07** | 0,43 | 0,62 |
| Viés típico de um sítio (RMS das médias) | **0,32** | 0,56 | 0,73 |
| DP do z | 1,03 | 0,96 | 0,96 |
| \|z\| > 1,96 (nominal 5%) | **5,8%** | 8,2% | 10,9% |

- **Globais** (córtex, SB, TCV, ventrículos): empate. O viés por sítio é de 0,19–0,34 nas
  próprias e de 0,25–0,26 no pipeline atual; na cinzenta subcortical, 0,27 contra 0,49.
- **Subcorticais:** vantagem clara das próprias. O CentileBrain recentrado ainda fica +0,3 a
  +0,7 nos núcleos da base e na amígdala, e +1,1 a +1,6 no pálido (fica em +0,1 a +0,2 nas
  próprias).
- **Com controles locais** (k = 10–30, a calibração do app): as duas convergem, com viés por
  sítio de 0,3–0,4 e |z| > 1,96 de 4,4–6,6%.
- **Variação entre sítios estimada** (em z): 0,2–0,3 nas medidas globais, no hipocampo, no
  tálamo e no cerebelo; 0,3–0,4 na amígdala e no accumbens; 0,65–1,0 no pálido. O efeito de estudo do
  BrainChart é de ≈ 1 z nas medidas globais, porque o pipeline (FreeSurfer × outros) entra
  nele; aqui o método é fixo.

**Decisão:** as normas próprias ficam **ligadas por padrão** (`ativoPorPadrao`) quando a
segmentação é SynthSeg com volume suave. Elas eliminam o viés sistemático das subcorticais e
levam o IC 90% com a variância do sítio, coisa que o pipeline atual não faz. BrainChart e
CentileBrain continuam como alternativa no painel; as parcelas corticais seguem no BrainChart.

### Limitações que continuam

1. **80+ anos:** 61 exames, quase todos do DLBS. Deixando o DLBS de fora, o hipocampo aos 80+
   sai em −0,6 (E) e −0,9 (D): a curva desses anos é, na prática, a do DLBS. O app marca o z em
   cinza quando a década tem < 30 controles **ou** < 3 sítios, e o erro da curva aos 85 anos
   (0,2–0,3 z; 1,1 no corno temporal E) entra no IC. **O OASIS-3 (nível B) é o próximo passo:**
   `tools/normas_local.py --oasis3` já monta o manifesto a partir dos arquivos que o usuário
   baixar depois de aceitar os termos.
2. **Só 3 T e só EUA/Europa** (Philips, Siemens, GE). Nada de 1,5 T nem de brasileiros: a
   calibração local continua recomendada.
3. **Pálido:** depende do contraste. A variação entre sítios estimada é de 0,65–1,0 z, e o IC
   fica largo de acordo.
4. **VIC:** a norma usa só os 573 exames sem aviso no registro. No sítio 1 do ds003592 (imagens
   com 43% dos voxels zerados, provavelmente desidentificação agressiva), o registro falhou em
   34 de 35 exames. O app avisa nesses casos, e o VIC deles não entra na comparação.
5. **σ_sítio = 0 nos ventrículos** (REML na borda): a variação biológica (DP de ~0,35 em ln V)
   domina a de sítio. O IC desses itens fica só com o erro de medida e o da curva.
6. **"Saudável" difere entre bases** (por exemplo, Alzheimer pré-clínico nos idosos; o PAN
   exclui só demência e doença psicótica).
