# Gera models/normative/brainchart.json a partir dos modelos GAMLSS oficiais dos brain charts
# (Bethlehem et al., Nature 2022; github.com/brainchart/Lifespan, release do artigo em
# Share/OriginalModels — NÃO os RefittedModels de 2025).
#
# Uso (R ≥ 4.1 com gamlss ≥ 5.4 e jsonlite):
#   git clone https://github.com/brainchart/Lifespan bc
#   cd bc && Rscript ../tools/gerar_brainchart_json.R ../models/normative/brainchart.json
#
# O que sai, por fenótipo × sexo × idade: quantis da distribuição gama generalizada (GGalt) em
# 23 probabilidades (P0,1–P99,9 e caudas até ±6 DP — fora da tabela o app extrapola a reta probit
# do último intervalo, que superestimava muito o |z| dos ventrículos, cuja GG é assimétrica),
# mais média e DP. Volumes em mm³ (o modelo usa Y/10 000).
#
# Curva populacional: efeitos fixos sem efeito aleatório de estudo (sítio) e SEM nível de
# fs_version — com o contraste contr.sum do modelo, isso é a MÉDIA NÃO PONDERADA dos 6 níveis de
# pipeline (Custom, Custom_T1T2, FS53, FS6_T1, FS6_T1T2, FSInfant), e não "a versão-base do
# FreeSurfer". O efeito de estudo omitido tem DP de ≈ 1 z nos volumes globais (≈ 0,6 no TCV):
# é por isso que um sítio novo precisa de calibração local (ver docs/auditoria-normativa.md).
#
# Idade: anos → dias pós-concepção (365,25·idade + 280), como no modelo. Grade de 0,25 ano até os
# 6 anos (o modelo é em log da idade e a interpolação linear entre idades inteiras errava até
# 0,35 z aos 1,5 ano) e de 1 ano depois disso.
suppressMessages({
  source("100.common-variables.r"); source("101.common-functions.r")
  source("300.variables.r"); source("301.functions.r"); library(jsonlite)
})
args <- commandArgs(TRUE)
saida <- if (length(args) >= 1) args[1] else "brainchart.json"

PROBS <- sort(c(pnorm(c(-6, -5, -4.5, -4, -3.5, 3.5, 4, 4.5, 5, 6)),
                0.001, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.975, 0.99, 0.999))
ps <- setNames(PROBS, sprintf("p%02d", seq_along(PROBS)))
IDADES <- c(seq(1, 6, by = 0.25), 7:100)
DIR <- "Share/OriginalModels"
reg <- sub("FIT_(.*)\\.rds", "\\1", list.files(DIR, "^FIT_[a-z].*rds$"))
phen <- c("GMV", "WMV", "sGMV", "Ventricles", "TCV", reg)
fen <- list()
for (ph in phen) {
  F <- readRDS(file.path(DIR, sprintf("FIT_%s.rds", ph)))
  ND <- expand.grid(age = IDADES, sex = c("Female", "Male"))
  ND$sex <- factor(ND$sex, levels = c("Female", "Male"))
  ND$AgeTransformed <- log(ND$age * 365.25 + 280)
  C <- suppressWarnings(Apply.Param(NEWData = ND, FITParam = F$param, Pred.Set = ps))
  cols <- sprintf("PRED.%s.pop", names(ps)); o <- list()
  for (s in c("Female", "Male")) {
    k <- C$sex == s
    o[[substr(s, 1, 1)]] <- list(q = round(unname(as.matrix(C[k, cols])) * 1e4, 1),
                                 mean = round(C$PRED.mean.pop[k] * 1e4, 1),
                                 sd = round(sqrt(C$PRED.variance.pop[k]) * 1e4, 1))
  }
  fen[[ph]] <- o
}
out <- list(
  fonte = "Bethlehem et al., Brain charts for the human lifespan, Nature 2022 (modelos GAMLSS-GG oficiais, github.com/brainchart/Lifespan, Share/OriginalModels; licença CC BY-NC-ND 4.0)",
  gerado = "curva populacional: efeitos fixos sem efeito de estudo (sítio) e sem nível de fs_version (média não ponderada dos 6 níveis de pipeline, contr.sum); idade pós-concepção (offset 280 d); gerador tools/gerar_brainchart_json.R",
  unidade = "mm3", idades = IDADES, probs = PROBS, fenotipos = fen)
writeLines(toJSON(out, auto_unbox = TRUE, digits = NA), saida)
