# Extrai normas subcorticais regionais (por sexo e hemisfério) dos modelos oficiais do
# CentileBrain / ENIGMA Lifespan Working Group (Ge et al., Lancet Digit Health 2024;
# repositório github.com/CentileBrain/centilebrain) para models/normative/subcortical.json.
#
# Uso (R ≥ 4.1 com gamlss, gamlss.dist, mfp e jsonlite instalados):
#   git clone --depth 1 https://github.com/CentileBrain/centilebrain /tmp/centilebrain
#   LC_ALL=C.UTF-8 Rscript tools/extract_centilebrain_subcortical.R /tmp/centilebrain models/normative/subcortical.json
#
# O que sai:
#  - curvas de centis do modelo LMS/GAMLSS (famílias Box-Cox BCCGo/BCPEo/BCTo, mu/sigma/nu/tau
#    suavizados em pb(idade)) avaliadas numa grade de idades inteiras 3–90 anos em 13
#    probabilidades (as mesmas de brainchart.json), + média e DP da distribuição (integração
#    numérica nos quantis);
#  - média prevista e RMSE do modelo MFPR só com idade (models_without_globalMeasures), que é a
#    definição do escore de desvio publicada pelo CentileBrain: z = (y − ŷ)/RMSE.
# O modelo MFPR com ICV (models/MFPmodels_subcorticalvolume_*.rds) NÃO é usado: com ICV em mm³
# (como no template do próprio CentileBrain) ele prevê ~45–60% dos volumes típicos — a escala
# do ICV de treino não está documentada (ver relatório em lib/normative.js).

# textos com acentos: força UTF-8 (em locale "C" o jsonlite grava bytes escapados como <e2><80><94>)
invisible(Sys.setlocale("LC_CTYPE", "C.UTF-8"))
args <- commandArgs(trailingOnly = TRUE)
cbDir <- if (length(args) >= 1) args[1] else "centilebrain"
outFile <- if (length(args) >= 2) args[2] else "models/normative/subcortical.json"

suppressMessages({ library(gamlss); library(gamlss.dist); library(mfp); library(jsonlite) })

# ordem das colunas do template do CentileBrain (o script oficial aplica o modelo [[i]] à
# coluna i + 2 de SITE, age, Lthal, Rthal, ...): é essa ordem que liga modelo ↔ estrutura
REGIONS <- list(
  c("Thalamus", "L"), c("Thalamus", "R"), c("Caudate", "L"), c("Caudate", "R"),
  c("Putamen", "L"), c("Putamen", "R"), c("Pallidum", "L"), c("Pallidum", "R"),
  c("Hippocampus", "L"), c("Hippocampus", "R"), c("Amygdala", "L"), c("Amygdala", "R"),
  c("Accumbens-area", "L"), c("Accumbens-area", "R")
)
AGES <- 3:90
PROBS <- c(0.001, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.975, 0.99, 0.999)
PFINE <- (seq_len(19999) - 0.5) / 19999  # para média/DP por integração nos quantis

fixEnv <- function(L) lapply(L, function(a) {
  attr(a$terms, ".Environment") <- globalenv(); attr(a$fit$terms, ".Environment") <- globalenv(); a
})

qdist <- function(a, p, age) {
  qf <- get(paste0("q", a$family[1]), mode = "function")
  pars <- list(p = p, mu = a$muFun(age), sigma = a$sigmaFun(age))
  if (!is.null(a$nuFun)) pars$nu <- a$nuFun(age)
  if (!is.null(a$tauFun)) pars$tau <- a$tauFun(age)
  do.call(qf, pars)
}

out <- list(
  fonte = paste(
    "CentileBrain / ENIGMA Lifespan Working Group — Ge R, Yu Y, Qi YX, et al. Normative modelling of",
    "brain morphometry across the lifespan with CentileBrain: algorithm benchmarking and model",
    "optimisation. Lancet Digit Health 2024;6(3):e211–e221. doi:10.1016/S2589-7500(23)00250-9"),
  versao = NA, licenca = paste(
    "Modelos distribuídos em github.com/CentileBrain/centilebrain 'for research purpose' (sem arquivo",
    "de licença no repositório); artigo em acesso aberto. Uso em pesquisa, não clínico."),
  atlas = "FreeSurfer aseg (FreeSurfer ≥ 5.0), volumes brutos em mm³ harmonizados por ComBat-GAM no treino",
  unidade = "mm3", ajusteICV = FALSE,
  gerado = paste(
    "LMS/GAMLSS (models/GAMLSSmodels_subcorticalvolume_{female,male}.rds): quantis nas idades inteiras 3–90;",
    "MFPR só com idade (models_without_globalMeasures): média prevista e RMSE = sqrt(deviance/n)"),
  idades = AGES, probs = PROBS, faixaTreino = list(), estruturas = list()
)
if (dir.exists(file.path(cbDir, ".git"))) {
  sha <- tryCatch(system(sprintf("git -C '%s' log -1 --format='%%h %%ad' --date=short", cbDir), intern = TRUE), error = function(e) NA)
  out$versao <- paste("github.com/CentileBrain/centilebrain commit", sha)
}

for (sx in c("female", "male")) {
  S <- if (sx == "female") "F" else "M"
  G <- readRDS(file.path(cbDir, "models", sprintf("GAMLSSmodels_subcorticalvolume_%s.rds", sx)))
  M <- fixEnv(readRDS(file.path(cbDir, "models_without_globalMeasures", "models", sprintf("MFPmodels_subcorticalvolume_%s.rds", sx))))
  rngs <- sapply(G, function(a) range(a$xvar))
  out$faixaTreino[[S]] <- round(c(min(rngs[1, ]), max(rngs[2, ])), 2)
  for (i in seq_along(REGIONS)) {
    st <- REGIONS[[i]][1]; hm <- REGIONS[[i]][2]
    a <- G[[i]]; m <- M[[i]]
    q <- t(sapply(AGES, function(ag) qdist(a, PROBS, ag)))
    ms <- t(sapply(AGES, function(ag) { v <- qdist(a, PFINE, ag); c(mean(v), sd(v)) }))
    nM <- m$fit$df.residual + length(m$fit$coefficients)
    ent <- list(
      familia = a$family[1], n = a$noObs, faixa = round(range(a$xvar), 2),
      q = round(q, 1), mean = round(ms[, 1], 1), sd = round(ms[, 2], 1),
      mfpMean = round(as.numeric(predict(m, newdata = data.frame(age = AGES))), 1),
      mfpRmse = round(sqrt(m$fit$deviance / nM), 2), mfpN = nM
    )
    if (is.null(out$estruturas[[st]])) out$estruturas[[st]] <- list()
    if (is.null(out$estruturas[[st]][[hm]])) out$estruturas[[st]][[hm]] <- list()
    out$estruturas[[st]][[hm]][[S]] <- ent
  }
}

con <- file(outFile, open = "w", encoding = "UTF-8")
writeLines(enc2utf8(as.character(toJSON(out, auto_unbox = TRUE, digits = NA))), con)
close(con)
cat("gravado", outFile, "\n")
