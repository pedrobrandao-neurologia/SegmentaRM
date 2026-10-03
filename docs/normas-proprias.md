# Normas próprias a partir de bases públicas — plano

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
