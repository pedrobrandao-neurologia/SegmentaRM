# Plano de modificações metodológicas — avaliação crítica e o que foi feito

Este documento responde, item por item, ao "Plano de modificações metodológicas" do
SegmentaRM, na ordem das seções dele. Para cada item há um status e o porquê. Os números
dos ajustes feitos com dados públicos estão em [`validacao/dlbs.md`](validacao/dlbs.md),
gerado pelos próprios scripts de ajuste.

| Status | Significado |
|---|---|
| **feito** | implementado e coberto por teste |
| **adaptado** | implementado de outro jeito, com a justificativa |
| **não viável agora** | fora do alcance desta versão: falta de pesos, de dados ou de validação |
| **offline** | depende de coleta ou processamento fora do app (roteiro descrito) |

A restrição central foi mantida: **nenhuma imagem sai do dispositivo**. Tudo o que é
pesado (lote do SynthSeg em controles públicos, ajuste da recentragem e das referências) roda
offline, em `tools/`, e só coeficientes entram em `models/normative/`.

---

## §0. Instruções

**Fases** — adaptado. A Fase 1 inteira foi feita. Das Fases 2–3 entrou o que não depende de
trocar as redes: o QC por regras, os volumes suaves, a recentragem pelo método (nível A), a calibração do
sítio (nível C) e as referências do mesmo método para assimetria e HOC. Ficaram de fora a
troca de pipeline (§2.1), o módulo hipocampal em *ensemble* (§4) e as normas próprias (nível B).

**Exames *golden*** — adaptado. São quatro exames **públicos** em `tests/golden/`: o exemplo
do app, uma adulta jovem do ds000001 e dois controles de **88 e 89 anos** do DLBS, na faixa
etária do exame-índice. O exame-índice em si não pode entrar num repositório público: mesmo
anonimizado, é dado de paciente, e não está disponível para mim. Para ele, e para qualquer
exame local, há o `--exame caminho.nii.gz`: a referência fica em `tests/golden/.local/`,
fora do git. O *runner* mostra a diferença por estrutura (%), tanto no volume rígido quanto
no principal, e falha acima da tolerância. Há dois motores:

- o **navegador**, com o app completo; é lento sem GPU;
- o **Node**, com o mesmo `lib/synthseg-core.js` e TensorFlow nativo, em ~2–5 min por exame.

A equivalência entre os dois foi medida num bloco real do exemplo (`tests/golden/motores.mjs`):

- com WebGL de 32 bits e com o backend CPU do navegador, o rótulo coincide com o do Node em
  100% dos voxels, e o volume suave difere em menos de 0,0001%;
- com texturas de 16 bits, a diferença fica abaixo de 0,2% por estrutura.

O que muda o volume é o **tamanho do bloco**. Com 96³ — memória baixa, ou GPU com texturas de
até 8192² —, o córtex cerebelar cai 7% e o pálido sobe até 2,8% em relação a 128³, o tamanho
com que o DLBS foi medido. Blocos de 160³ e 192³ ficam a menos de 1% de 128³. O laudo registra
o bloco e avisa quando ele é menor (regra `bloco_reduzido`).

Veja [`tests/golden/README.md`](../tests/golden/README.md).

*Diferença antes → depois desta versão.* Os rótulos não mudaram: `lib/synthseg-core.js`, os
*workers* e a fusão DKT estão idênticos ao `main` anterior. Mudou o **valor principal**, que
passou do rígido para o suave. A diferença suave − rígido por estrutura aparece nas
referências *golden* e em cada exportação (`dif_suave_rigido_pct`).

**Proveniência de todo número** — feito. Cada tabela normativa (painel, PDF, JSON) leva um
selo com:

- norma e ferramenta com que ela foi medida;
- ferramenta e tipo de volume do paciente;
- se o z foi recentrado por controles do mesmo método (nível A);
- se o sítio está calibrado;
- faixa etária da norma, com aviso de borda.

Cada linha tem uma dica com o z sem recentragem, o deslocamento descontado e os componentes do intervalo.

**"Verificar"** — feito para tudo o que foi usado:

- licença do SynthSeg (Apache 2.0) e do DLBS (CC0);
- ausência de licença explícita no CentileBrain (já documentada no README);
- ausência de licença nas curvas de Piot et al. 2025 (por isso não foram embarcadas);
- números do ENIGMA (Guadalupe et al. 2017, Tabela 2);
- Kong et al. 2018, que traz assimetria de espessura e de área, não de volume (não usado);
- os valores de teste-reteste usados no intervalo (§3.4).

## §1. Diagnóstico do exame-índice

A leitura do plano se confirma com dados. Pusemos o SynthSeg do app lado a lado com o
FreeSurfer em dois conjuntos públicos:

- OpenNeuro ds000001/ds000005: FreeSurfer 6.0, 17 adultos jovens (`validacao/dlbs.md`, conjunto externo);
- DLBS: FreeSurfer 5.3 com edição manual, controles de 21 a 89 anos.

Os vieses são grandes e por estrutura:

- **córtex**: o SynthSeg mede cerca de 12–23% a mais, e o viés cresce com a idade no DLBS;
- **substância branca**: mede de 4% a 12% a menos;
- **ventrículos e corno temporal**: medem a mais.

Isso basta para produzir o padrão do exame-índice: córtex e lobos com z positivo, SB com z
negativo e corno temporal "dilatado". Ou seja, ao menos parte daqueles desvios é **viés de
método**, não biologia.

As **medianas lobares idênticas** entre E e D tinham causa: as curvas regionais do
BrainChart são as mesmas para os dois hemisférios, e o "z lobar" somava médias e DP de
parcelas. Esse z foi **removido** (§3.4).

A recentragem pelo método (§3.2, nível A) corrige a maior parte do desvio médio. O
exame-índice é GE BRAVO, e a recentragem foi ajustada em Philips MPRAGE; por isso o laudo
avisa (regra `recentragem_fora_do_dominio`) e recomenda a calibração do sítio (nível C).

## §2. Precisão da segmentação

**§2.1 Pipelines S e F** — não viável agora.

- *SynthSeg 2.0 robusto.* O README ("Por que o modo robusto e o regressor de QC do SynthSeg
  2.0 não rodam no navegador") mostra que duas das quatro redes estouram a memória do
  navegador por construção; os conversores existem (`tools/convert_synthseg2_tfjs.py`).
- *FastSurfer VINN.* A aseg completa e o modo submilimétrico exigem portar outra
  arquitetura e validá-la; o app tem só a FastSurferCNN v1 de parcelação.

O risco de "misturar famílias de rótulos" é menor do que o plano supõe. A fusão DKT
**preserva as fronteiras de tecido do SynthSeg** — o FastSurfer só decide *qual parcela*
dentro do córtex do SynthSeg —, então não há conflito de fronteira SC/SB entre as famílias.
O que resta são as fronteiras *entre parcelas*.

O critério de aceite do occipital não pôde ser cumprido: não existe referência de
assimetria **do mesmo método** para parcelas (§2.6). O IA delas agora é descritivo, sem cor.

**§2.2 Volumes suaves** — feito.

- `V_soft` (soma das posteriores na grade da rede, como o `--vol` oficial) é o valor
  principal de todas as estruturas do SynthSeg.
- O rígido fica como auditoria (`volume_rigido_mm3`), com `dif_suave_rigido_pct` por estrutura.
- Nas parcelas DKT, o córtex suave de cada hemisfério é redistribuído na proporção do
  volume rígido das parcelas.

Com o FreeSurfer 6.0 (16 adultos do ds000001), o suave ficou mais perto em várias estruturas: hipocampo
+1,6% contra +6,9% do rígido; córtex +12,2% contra +20,3%. Não em todas: amígdala e córtex
cerebelar ficaram mais longe. Não é "mais verdadeiro" em si, é a convenção oficial — e a
recentragem absorve o que sobra.

**§2.3 Resolução nativa e pré-processamento** — adaptado.

1. Modo submilimétrico: não viável (depende do VINN, §2.1).
2. N4: já existia no pré-processamento. O SynthSeg é invariante a viés por desenho.
3. Correção de distorção de gradiente:
   - lida quando o fabricante a declara em tag padrão (Siemens: `ImageType` `DIS2D`/`DIS3D`/`ND`);
   - para GE e Philips, o laudo escreve "**não verificado**", porque a informação fica em
     tags privadas que o app não tem como confirmar.

   O critério "hipocampo nativo × 1 mm lado a lado" depende do item 1.

**§2.4 Envelhecimento** — adaptado.

- *Hipointensidades da SB.* O volume delas não pode ser reportado: o SynthSeg 1.0 não tem
  rótulo de lesão, e a FastSurferCNN daqui só parcela. Duas mitigações:
  - a recentragem tem termos de idade, que absorvem o desvio **médio** de hipointensidade
    rotulada como cinzenta;
  - a regra `fronteira_sc_sb` avisa quando, aos 60 anos ou mais, o córtex está acima e a SB
    abaixo do esperado, e anexa cortes para conferir.
- *Não-cérebro no córtex e espessura aparente > P99.* Não viável. Faltam um rótulo de
  líquor/vasos (o SynthSeg 1.0 não tem) e uma distribuição normativa **do mesmo método**
  para a espessura volumétrica; um corte inventado só trocaria um viés por outro.

**§2.5 Volume intracraniano** — parcialmente, por limite técnico.

- (a) eTIV afim: existe.
- (b) VIC por segmentação: impossível com o SynthSeg 1.0. A rede tem 32 classes e **nenhuma
  de líquor extracerebral**, então a soma dos rótulos não é o VIC (é o que o app chama de
  "total segmentado").
- (c) eTIV do hippodeep: não viável (§4).

O **ajuste pelo método dos resíduos** também ficou de fora, por dois motivos:

- ele exige um modelo normativo de volumes ajustados pelo VIC, e as normas embarcadas são
  de volumes brutos (os objetos do CentileBrain com VIC têm escala não documentada);
- o eTIV afim é enviesado pelo volume encefálico: encolhe com a atrofia e superestima o VIC
  em 4,0 ± 3,1% (Klasson et al., 2018). Ajustar por ele distorceria justamente os casos de
  interesse.

O laudo continua dizendo que o z inclui o efeito do tamanho da cabeça.

**§2.6 Assimetria** — feito para o que tem referência do mesmo método.

- O corte fixo |IA| > 10% saiu.
- O z do IA vem de controles do DLBS medidos **com o SynthSeg do app**, com média e DP
  dependentes da idade (`models/normative/referencia_mesmo_metodo.json`). Cobre subcorticais,
  ventrículos, corno temporal e os hemisférios do córtex, da SB e do cerebelo.
- As médias do ENIGMA (FreeSurfer) ficam no JSON e na validação só como comparação.
- Parcelas DKT não têm referência do mesmo método: exigiria rodar a parcelação nos
  controles, e a assimetria DK do FreeSurfer 5.3 é de outro método e outro atlas. O IA
  delas é descritivo, sem z e sem cor.

**§2.7 QC** — adaptado.

- Regressor do SynthSeg 2.0: não viável (§2.1).
- Métricas de imagem: parciais. A régua A–D já tinha voxel, anisotropia e FOV, além de CJV
  e CNR cinzenta/branca. Não há EFC, índice de fantasmas nem detector de movimento.
- Concordância entre métodos: não viável, porque não há segundo segmentador de hipocampo
  nem aseg do FastSurfer.
- Plausibilidade e coerência: feito. `models/qc_rules.json` é declarativo e o motor fica em
  `lib/qcrules.js`. A regra hipocampo × corno temporal usa o **z da HOC para a idade**
  (referência do mesmo método), e não mais um corte fixo.
- Inspeção guiada: feito. Cortes com a sobreposição, escolhidos pelas regras disparadas,
  vão anexados ao PDF.
- O escore virou "**índice de confiança interno (não validado)**".

## §3. Comparação normativa

**§3.2 Nível A** — feito, com o método trocado por evidência.

*Dados.* Controles saudáveis do Dallas Lifespan Brain Study (OpenNeuro ds004856, CC0; Park et
al., *Sci Data* 2025) — 201 controles de 21 a 89 anos —, com T1 público e volumes
FreeSurfer 5.3 **editados à mão e revisados por outra equipe**:

- seleção estratificada por década, com idosos sobre-representados (`tools/dlbs_selecao.py`);
- SynthSeg do app em lote (`tools/lote_synthseg_node.mjs`), com blocos de 128³ — dá o mesmo
  volume que o app no navegador com o mesmo bloco (medido em `tests/golden/README.md`);
- preparação e comparação com o FreeSurfer em `tools/referencias_dlbs.py`;
- ajuste da recentragem, com o código e as tabelas do próprio app, em `tools/recentragem_dlbs.mjs`.

O conjunto externo tem 17 adultos jovens do OpenNeuro ds000001/ds000005: outro scanner, com
FreeSurfer 6.0.1 dos derivados públicos do OpenNeuro.

*O que o plano pedia e o que os dados mostraram.* O plano pedia um tradutor
SynthSeg → FreeSurfer (Deming/Passing–Bablok) antes de consultar as normas, com o erro
residual somado à variância. Três achados mudaram o desenho:

1. **A regressão preditiva E[FS | SS] encolhe o z** por ρ, por diluição de regressão. Um
   paciente com z −3 sairia com cerca de −2,7; com a inflação σ² = σ²_norma + σ²_tradutor, com
   cerca de −2,2.
2. **Uma reta simétrica copia a escala do FreeSurfer da amostra de ajuste.** No DLBS, o DP do
   FreeSurfer 5.3 nas subcorticais é inflado por ruído de segmentação: de 1,3 a 1,9 vezes o σ
   da própria norma. A correlação com o SynthSeg vai de 0,3 (pálido) a 0,9 (hipocampo), e as
   assimetrias E/D destoam das do ENIGMA (tálamo +18%, contra +4%; o SynthSeg dá +6%).
   Reescalar por esse DP inflaria o |z| na mesma proporção.
3. **Nem o próprio FreeSurfer está em z ≈ 0 nestas normas.**
   - Controles saudáveis medidos pelo FreeSurfer ficam abaixo da GMV do BrainChart: em média
     −1,5 DP no FreeSurfer 5.3 do DLBS e −1,85 no 6.0.1 do conjunto externo.
   - Com o FreeSurfer 5.3, também ficam longe no tálamo esquerdo (+1,8) e no pálido (−1,4 a −1,9).
   - Traduzir o SynthSeg para a escala do FreeSurfer 5.3 levaria os controles, por construção,
     a esses mesmos z. Acima dos 75 anos, isso significa córtex −1,7 e hipocampo −0,7/−0,8 em
     pessoas saudáveis.

*O que foi feito: recentragem do z contra a própria norma.* Os controles do DLBS medidos com
o **mesmo SynthSeg do app** mostram, para cada estrutura e hemisfério, quanto o z deles se
desloca da norma em função da idade e do sexo:

```
z' = z − (a + c·t + d·t² + e·[M])     (t = idade − 60)
```

- é o mesmo princípio do escore *out-of-sample* do BrainChart e da calibração de sítio: um
  deslocamento estimado em controles, com o modelo normativo fixo;
- a escala do z continua a da norma;
- a incerteza do deslocamento (bootstrap por sujeito) entra no IC 90%;
- falhas grosseiras de segmentação saem do ajuste (|resíduo| > 5 DP robustos);
- o arquivo registra o SHA-256 das normas usadas, e um teste falha se elas mudarem sem refazer o ajuste.

*Validação* (`validacao/dlbs.md`, em controles saudáveis, onde o esperado é z ≈ 0):

- no DLBS, em validação cruzada, o z médio de cada terço de idade fica a ±0,14 de 0 — no
  terço mais velho (> 75 anos), o |z| médio cai de 0,83 para 0,04;
- no conjunto externo, o |z| médio cai de 0,76 para 0,46.

O que sobra no conjunto externo é, sobretudo, efeito de sítio e protocolo, que só a
calibração local remove. O caso mais evidente é o pálido: a medida do SynthSeg nele depende
do contraste, e o desvio passa de −1,7 para +1,9 em adultos jovens de outro scanner. A
comparação SynthSeg × FreeSurfer por estrutura (viés, correlação, DP) está no mesmo
relatório; ela explica os z crus, mas não vira tradutor.

*Interações.*

- Idade: termos linear e quadrático.
- Sexo: termo próprio.
- **Campo e fabricante: não** — o DLBS é um só equipamento (Philips 3 T MPRAGE). Por isso a
  recentragem declara o próprio domínio e o laudo avisa quando o exame está fora dele.

*No app.* A recentragem liga por padrão quando o volume é o suave do SynthSeg e pode ser
desligada. O selo diz "z recentrado por controles do mesmo método (nível A; DLBS, n = …)". Cada
linha mostra também o z sem recentragem, e a coluna "Mediana" passa a ser a esperada para o
mesmo método.

**Nível B — normas próprias** — não viável agora. Exigiria processar milhares de exames de
coortes com contratos de uso de dados (UK Biobank, ADNI, HCP-Aging) e ajustar GAMLSS com
efeitos de sítio. O lote Node, o *golden* e o script de ajuste são o primeiro tijolo desse
caminho.

**Nível C — calibração do sítio** — feito.

- *Protocolo.* O app deriva uma família de protocolo, com hash SHA-256 dos campos técnicos
  do DICOM (sem identificadores).
- *Controles.* Exames marcados como controle na coorte entram na calibração.
- *Regra por tamanho da amostra:*
  - com **n ≥ 30**, desloca e reescala (escala limitada a 0,5–2);
  - com **10 ≤ n < 30**, só desloca;
  - com **n < 10**, não aplica.
- *Estabilidade.* Intervalo bootstrap (semente fixa) e correlação com a idade, para checar
  heterocedasticidade.
- *Armazenamento.* Em vez de `sites/*.json` no repositório, a calibração fica no navegador
  e é exportável/importável em JSON. Calibração é dado local do serviço, não do código.

É o equivalente, no espaço do z, à estimativa de *offset* de sítio em μ e σ com o modelo
normativo fixo.

**§3.3 Catálogo e regras de uso** — feito o que se aplica.

- Selo em toda linha e z em cinza a menos de 5 anos do limite da norma.
- "Mostrar as duas normas": nenhuma estrutura tem duas normas embarcadas (BrainChart =
  globais; CentileBrain = subcorticais), então não se aplica.
- As curvas de Piot et al. 2025 não foram embarcadas: o repositório não declara licença.

**§3.4 Correções no cálculo** — feito.

- *z lobar*: removido.
- *Multiplicidade*:
  - número esperado de |z| > 2 por acaso;
  - observados;
  - correção de Holm (α 5%, *);
  - estruturas pré-especificadas (•);
  - alerta de "desvios em bloco".
- *Intervalo de 90% do z*: adaptado. Combina, em quadratura:
  - (ii) o erro de medida teste-reteste **publicado para o SynthSeg** (`models/normative/erro_medida.json`):
    - van Nederpelt et al., *Neuroradiology* 2023, SynthSeg 1.0, EPM intra e entre scanners
      para cérebro, SB, cinzenta e tálamo;
    - ICC por estrutura, convertido em EPM_z = √(1 − ICC);
    - Kondrateva et al., arXiv 2025, entre scanners, conservador. Usa **entre scanners
      enquanto o sítio não está calibrado**;
  - (iii) a incerteza da recentragem (bootstrap);
  - (iii) a incerteza da calibração (erro-padrão do deslocamento).

  O item (i), a incerteza do próprio modelo normativo, não entra. O BrainChart publica as
  réplicas bootstrap (`BOOT_*.rds`) e o DP do efeito de estudo; esse efeito, omitido na curva
  populacional, vale ≈ 1 z nos volumes globais — a maior fonte de incerteza para um sítio sem
  calibração (ver `docs/auditoria-normativa.md`). O laudo diz isso, e o z em cinza marca a
  borda etária.
- *Percentis extremos*: "< 1", "< 0,1", "> 99", "> 99,9".

*Tarefa "CDF exata GG/BCT, tolerância 1e-6"* — adaptado. As normas estão embarcadas como
tabelas de quantis, com interpolação na escala probit. Medido contra o R/gamlss: erro de z
< 0,01 entre P5 e P95 e < 0,06 em P0,5/P99,5. Exigir 1e-6 obrigaria a reexportar μ, σ, ν e
τ e reimplementar as famílias, sem ganho prático diante de intervalos de ±0,3–0,5 z.

## §4. Hipocampo

- *Ensemble* (hippodeep/FastSurfer/SynthSeg 2.0) e recorte nativo — não viável agora. O
  hippodeep precisaria ser exportado para ONNX e validado, o que exige o ADNI-HarP (acesso
  controlado). As outras duas redes esbarram no §2.1.
- **HOC** — feito, com referência do mesmo método por idade (média quadrática, DP linear),
  no JSON e na regra de coerência.
- **Escore tipo HAVAs** — não implementado. O próprio plano (§4.5) exige validação clínica
  (ADNI CN × MCI × DA) antes de ir para o PDF.
- **Assimetria hipocampal com z** — feito (§2.6).

## §5. O que o PDF diz

Feito:

- "Como ler esta página";
- selo de proveniência em cada tabela;
- intervalo de 90% (coluna "IC 90%");
- percentis truncados;
- multiplicidade;
- limitações do exame como alertas de QC: borda etária, recentragem ajustada em outro equipamento, VIC com
  aviso, desvios em bloco;
- página de métodos e reprodutibilidade:
  - SHA-256 de pesos, normas, recentragem, referências, erro de medida e regras;
  - versão do app;
  - parâmetros de aquisição do DICOM;
  - família do protocolo;
- terminologia "índice de confiança interno (não validado)".

## §6. Validação

| Item | Status |
|---|---|
| Concordância com FreeSurfer | **feito** (FreeSurfer 5.3 editado, DLBS; FreeSurfer 6.0, ds000001/ds000005) — `validacao/dlbs.md` |
| Teste-reteste no BRAVO local | **offline** — voluntários locais; o intervalo usa valores publicados até lá |
| 1,5 T × 3 T, fabricantes | **offline** — IXI/ADNI; a recentragem atual é só Philips 3 T (externo: outro scanner, jovens) |
| z de controles locais ~ N(0,1) | **feito** — o painel de calibração mostra média e DP dos z dos controles |
| Validade clínica (AUC) | **offline** — ADNI |

## §7. Checagens de sanidade

Todas feitas e cobertas por teste (`tests/unit/`):

- volume do voxel = |det| da afim do espaço em que os rótulos são contados;
- lateralidade preservada na reorientação;
- DKT → lobos, com as 31 parcelas;
- idade pela data do exame (`StudyDate`/`AcquisitionDate` − `PatientBirthDate`, senão `PatientAge`; nenhuma data armazenada);
- medianas lobares iguais: removidas junto com o z lobar.

Reamostragem de rótulos: o volume **principal** (suave) é somado na grade da rede, antes de
qualquer reamostragem. Só os rótulos rígidos vão para a grade conformada, por vizinho mais
próximo — a opção aceitável do plano.

## §8. Riscos e decisões do responsável

- *Dados embarcados.* DLBS: CC0. BrainChart: CC BY-NC-ND 4.0 ("strictly for non-commercial
  use"). CentileBrain: sem licença explícita, "for research purpose" — confirme com os autores
  antes de uso comercial.
  Nenhuma coorte com contrato de uso restrito entrou.
- *Controles locais (nível C).* Exigem aprovação ética. O app guarda a calibração no
  navegador e a exporta sem identificadores.
- *Memória.* Nada novo roda no navegador além de tabelas: o custo desta versão é zero em GPU.

## §9. Roteiro — situação

| Fase | Situação |
|---|---|
| 1 — sanidade, suave, sem z lobar, selos, multiplicidade | **concluída** |
| 2 — pipelines coerentes, VIC, QC real | QC por regras e inspeção guiada feitos; pipelines e VIC por segmentação não viáveis sem o SynthSeg 2.0 no navegador |
| 3 — nível A e curvas de Piot | recentragem pelo método feita (DLBS); tradução para o FreeSurfer testada e rejeitada; curvas de Piot sem licença |
| 4 — hipocampo | HOC e assimetria com referência do mesmo método; *ensemble* não viável |
| 5 — normas próprias | não viável agora (dados com contrato de uso) |
| 6 — controles locais e validação | módulo de calibração pronto; coleta local pendente |

## Como regenerar os coeficientes

```bash
# 1. dados públicos (DLBS, CC0)
curl -O https://s3.amazonaws.com/openneuro.org/ds004856/participants.tsv
curl -O https://s3.amazonaws.com/openneuro.org/ds004856/derivatives/brainsummary/Template_Structural_MRI.xlsx
python3 tools/dlbs_selecao.py --participantes participants.tsv --fs Template_Structural_MRI.xlsx \
    --saida selecao.json --urls urls.txt
mkdir -p t1 && while read u f; do curl -s -o "t1/$f" "$u"; done < urls.txt
# 2. SynthSeg do app em lote (TensorFlow nativo; ~2 min por exame em 4 núcleos)
npm i --no-save @tensorflow/tfjs-node@4.22.0
node tools/lote_synthseg_node.mjs t1 res selecao.json
# 3. referências do mesmo método + dados por sujeito (numpy, pandas, openpyxl)
python3 tools/referencias_dlbs.py --res res --fs Template_Structural_MRI.xlsx --selecao selecao.json \
    --trabalho trab [--piloto <res de um conjunto externo> --piloto-fs <aseg.stats + participants>]
# 4. recentragem do z com as normas do app → models/normative/recentragem_synthseg.json e docs/validacao/dlbs.md
node tools/recentragem_dlbs.mjs --trabalho trab
node tools/manifesto_sha256.mjs
```
