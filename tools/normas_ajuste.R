# Normas próprias do SegmentaRM, etapa 3 (OFFLINE): ajuste GAMLSS por fenótipo em volumes medidos
# com o MESMO método do app (SynthSeg 1.0, volume suave, bloco 128³), com o SÍTIO como efeito
# aleatório, e validação deixando um sítio de fora. Ver docs/normas-proprias.md.
#
#   Rscript tools/normas_ajuste.R tabela.csv normas_segmentarm.json validacao_dir [B] [padrao]
#     tabela.csv  ← tools/normas_preparar.mjs
#     B           réplicas do bootstrap por sítio para o erro-padrão da curva (padrão 40; 0 = sem)
#     padrao      1 = o app usa estas normas por padrão (decidido pela validação); 0 = opcional
#
# Modelo, por fenótipo (sexos juntos):
#   log V ~ SHASHo(μ, σ, ν, τ)
#   μ = pb(idade) + sexo + random(sítio)      σ = pb(idade) + sexo      ν, τ constantes
# e a alternativa normal (ν = 0, τ = 1); escolhe pelo BIC. pb() = P-spline com λ por ML local.
# Curva populacional = efeitos fixos com o efeito de sítio = 0; σ_sítio = DP do efeito aleatório
# (escala log V). z = sinh(τ·asinh((ln V − μ)/σ) − ν) — forma fechada, sem tabela de quantis.
# Exclusão só de falha técnica: |z| > 5 no primeiro ajuste (não apara as caudas biológicas).
#
# Validação (validacao_dir/loso_z.csv): para cada sítio com n ≥ 10, ajusta sem ele e calcula o z
# dos seus exames pela curva populacional (sítio não visto). A adaptação com k controles do sítio e
# a comparação com o pipeline atual ficam em tools/normas_relatorio.py.
suppressMessages({ library(gamlss); library(jsonlite); library(nlme) })
args <- commandArgs(TRUE)
if (length(args) < 3) stop("uso: Rscript tools/normas_ajuste.R tabela.csv saida.json validacao_dir [B]")
TAB <- args[1]; SAIDA <- args[2]; VDIR <- args[3]; B <- if (length(args) >= 4) as.integer(args[4]) else 40L
PADRAO <- length(args) >= 5 && args[5] == "1"
# bases conhecidas → nome, DOI e licença (as de acesso condicionado levam o agradecimento exigido)
BASES <- list(
  ds004856 = list(nome = "Dallas Lifespan Brain Study", doi = "10.18112/openneuro.ds004856", licenca = "CC0"),
  ds007522 = list(nome = "PAN / Healthy Minds for Life", doi = "10.18112/openneuro.ds007522", licenca = "CC0"),
  ds005752 = list(nome = "NIMH Healthy Research Volunteer", doi = "10.18112/openneuro.ds005752", licenca = "CC0"),
  ds003592 = list(nome = "Neurocognitive aging (Setton et al.)", doi = "10.18112/openneuro.ds003592", licenca = "CC0"),
  ds000030 = list(nome = "UCLA LA5c (controles)", doi = "10.18112/openneuro.ds000030", licenca = "CC0"),
  ds004173 = list(nome = "MR-ART (aquisição padrão)", doi = "10.18112/openneuro.ds004173", licenca = "CC0"),
  ds002785 = list(nome = "AOMIC PIOP1", doi = "10.18112/openneuro.ds002785", licenca = "CC0"),
  ds002790 = list(nome = "AOMIC PIOP2", doi = "10.18112/openneuro.ds002790", licenca = "CC0"),
  ds003097 = list(nome = "AOMIC ID1000", doi = "10.18112/openneuro.ds003097", licenca = "CC0"),
  oasis3 = list(nome = "OASIS-3", doi = "10.1101/2019.12.13.19014902", licenca = "OASIS-3 Data Use Agreement",
                agradecimento = "Data were provided in part by OASIS-3: Longitudinal Multimodal Neuroimaging. Principal Investigators: T. Benzinger, D. Marcus, J. Morris; NIH P30 AG066444, P50 AG00561, P30 NS09857781, P01 AG026276, P01 AG003991, R01 AG043434, UL1 TR000448, R01 EB009352."))
dir.create(VDIR, showWarnings = FALSE, recursive = TRUE)
set.seed(20261003)

d0 <- read.csv(TAB, check.names = FALSE, stringsAsFactors = FALSE)
d0$sexoM <- as.numeric(d0$sexo == "M")
d0$sitio <- factor(d0$sitio)
FEN <- c("CortexVol", "CerebralWhiteMatterVol", "SubCortGrayVol", "VentricleVol", "TCV",
         as.vector(outer(c("Left-", "Right-"), c("Thalamus", "Caudate", "Putamen", "Pallidum", "Hippocampus",
                                                  "Amygdala", "Accumbens-area", "Inf-Lat-Vent", "Lateral-Ventricle"), paste0)),
         "CerebellumVol", "BrainStemVol", "vic")
FEN <- FEN[FEN %in% names(d0)]
IDADES <- 18:90
CTRL <- gamlss.control(n.cyc = 200, trace = FALSE)

zSHASHo <- function(y, mu, sigma, nu, tau) sinh(tau * asinh((y - mu) / sigma) - nu)
`%||%` <- function(a, b) if (is.null(a)) b else a

ajustar <- function(dd, familia) {
  if (familia == "SHASHo") {
    gamlss(ly ~ pb(idade) + sexoM + random(sitio), sigma.formula = ~ pb(idade) + sexoM,
           nu.formula = ~ 1, tau.formula = ~ 1, family = SHASHo, data = dd, control = CTRL)
  } else {
    gamlss(ly ~ pb(idade) + sexoM + random(sitio), sigma.formula = ~ pb(idade) + sexoM,
           family = NO, data = dd, control = CTRL)
  }
}

# parâmetros populacionais (efeito de sítio = 0) para idades/sexos quaisquer
popParams <- function(m, dd, idade, sexoM) {
  ref <- levels(dd$sitio)[1]
  nd <- data.frame(idade = idade, sexoM = sexoM, sitio = factor(rep(ref, length(idade)), levels = levels(dd$sitio)))
  p <- suppressWarnings(predictAll(m, newdata = nd, data = dd, type = "response", output = "list"))
  s <- getSmo(m, "mu", which = 2)
  b <- as.numeric(s$coef)[match(ref, levels(dd$sitio))]
  nu <- if (is.null(p$nu)) rep(0, length(idade)) else p$nu
  tau <- if (is.null(p$tau)) rep(1, length(idade)) else p$tau
  list(mu = p$mu - b, sigma = p$sigma, nu = nu, tau = tau)
}

ajusteFenotipo <- function(dd) {
  m1 <- tryCatch(ajustar(dd, "SHASHo"), error = function(e) NULL)
  m0 <- tryCatch(ajustar(dd, "NO"), error = function(e) NULL)
  bic <- function(m) if (is.null(m)) Inf else m$G.deviance + log(nrow(dd)) * m$df.fit
  if (bic(m1) < bic(m0)) list(m = m1, familia = "SHASHo", bic = c(SHASHo = bic(m1), NO = bic(m0)))
  else list(m = m0, familia = "NO", bic = c(SHASHo = bic(m1), NO = bic(m0)))
}

zDe <- function(m, dd, novos) {
  p <- popParams(m, dd, novos$idade, novos$sexoM)
  zSHASHo(log(novos$y), p$mu, p$sigma, p$nu, p$tau)
}

saida <- list(); loso <- list()
umFenotipo <- function(f) {
  t0 <- Sys.time()
  d <- d0[is.finite(d0[[f]]) & d0[[f]] > 0, c("id", "sitio", "idade", "sexoM", "fabricante", f)]
  if (f == "vic") d <- d[d0$vicAviso[match(d$id, d0$id)] == 0, ]
  names(d)[6] <- "y"; d$ly <- log(d$y); d$sitio <- droplevels(d$sitio)
  # 1º ajuste → exclui falha técnica (|z| > 5) → ajuste final
  a <- ajusteFenotipo(d)
  zz <- zSHASHo(d$ly, fitted(a$m, "mu"), fitted(a$m, "sigma"),
                if (a$familia == "SHASHo") fitted(a$m, "nu") else 0, if (a$familia == "SHASHo") fitted(a$m, "tau") else 1)
  excl <- d$id[abs(zz) > 5]
  if (length(excl)) { d <- d[!d$id %in% excl, ]; d$sitio <- droplevels(d$sitio); a <- ajusteFenotipo(d) }
  m <- a$m; dd <- d
  es <- getSmo(m, "mu", which = 2)
  # σ_sítio exportado (vai para o IC do z): REML de um modelo misto com a mesma média (spline
  # natural da idade + sexo) — o λ local do random() do gamlss encolhe para 0 com sítios pequenos
  sb <- tryCatch(as.numeric(VarCorr(lme(ly ~ splines::ns(idade, 4) + sexoM, random = ~ 1 | sitio, data = d,
                                         method = "REML"))[1, "StdDev"]), error = function(e) es$sigb)
  grade <- lapply(c(F = 0, M = 1), function(sx) {
    p <- popParams(m, dd, IDADES, rep(sx, length(IDADES)))
    list(mu = round(p$mu, 6), sigma = round(p$sigma, 6))
  })
  pfin <- popParams(m, dd, 60, 0)
  # bootstrap por sítio (reamostra sítios inteiros): erro-padrão de μ populacional por idade, em z
  epz <- NULL
  if (B > 0) {
    sitios <- levels(dd$sitio); bm <- list()
    for (b in seq_len(B)) {
      ss <- sample(sitios, replace = TRUE)
      db <- do.call(rbind, lapply(seq_along(ss), function(i) { x <- dd[dd$sitio == ss[i], ]; x$sitio <- paste0(ss[i], "_", i); x }))
      db$sitio <- factor(db$sitio)
      mb <- tryCatch(ajustar(db, a$familia), error = function(e) NULL)
      if (is.null(mb)) next
      pb_ <- tryCatch(popParams(mb, db, rep(IDADES, 2), rep(c(0, 1), each = length(IDADES))), error = function(e) NULL)
      if (!is.null(pb_)) bm[[length(bm) + 1]] <- pb_$mu
    }
    if (length(bm) >= 10) {
      M <- do.call(cbind, bm)
      sdmu <- apply(M, 1, sd)
      sg <- c(grade$F$sigma, grade$M$sigma)
      epz <- list(F = round(sdmu[seq_along(IDADES)] / grade$F$sigma, 4), M = round(sdmu[-seq_along(IDADES)] / grade$M$sigma, 4), B = length(bm))
    }
  }
  nDec <- table(cut(dd$idade, c(18, seq(30, 90, 10), 200), right = FALSE))
  saida[[f]] <<- list(
    familia = a$familia, nu = if (a$familia == "SHASHo") round(pfin$nu[1], 6) else 0,
    tau = if (a$familia == "SHASHo") round(pfin$tau[1], 6) else 1,
    sigmaSitio = round(sb, 6), sigmaSitioGamlss = round(es$sigb, 6), F = grade$F, M = grade$M, epMuZ = epz,
    n = nrow(dd), nSitios = nlevels(dd$sitio), excluidos = length(excl),
    nPorDecada = as.list(setNames(as.integer(nDec), names(nDec))),
    faixa = range(dd$idade), bic = round(a$bic, 1),
    blup = as.list(setNames(round(as.numeric(es$coef), 4), levels(dd$sitio))))

  # ---- validação deixando um sítio de fora
  for (s in levels(dd$sitio)) {
    te <- dd[dd$sitio == s, ]
    if (nrow(te) < 10) next
    tr <- dd[dd$sitio != s, ]; tr$sitio <- droplevels(tr$sitio)
    ms <- tryCatch(ajustar(tr, a$familia), error = function(e) NULL)
    if (is.null(ms)) next
    z <- tryCatch(zDe(ms, tr, te), error = function(e) { cat('  LOSO', s, conditionMessage(e), '\n'); rep(NA, nrow(te)) })
    loso[[length(loso) + 1]] <<- data.frame(fenotipo = f, id = te$id, sitio = s, z = z)
  }
  cat(sprintf("%-26s %-6s n=%d sítios=%d excl=%d σ_sítio=%.3f (%.2f z) %.0fs\n", f, a$familia, nrow(d), nlevels(d$sitio),
              length(excl), sb, sb / pfin$sigma, as.numeric(Sys.time() - t0, units = "secs")))
}
for (f in FEN) tryCatch(umFenotipo(f), error = function(e) cat(f, "FALHOU:", conditionMessage(e), "\n"))

L <- do.call(rbind, loso)
write.csv(L, file.path(VDIR, "loso_z.csv"), row.names = FALSE)

bs <- unique(d0$base)
out <- list(
  versao = "1.0", gerado = as.character(Sys.Date()), ativoPorPadrao = PADRAO,
  bases = lapply(setNames(bs, bs), function(b) c(BASES[[b]] %||% list(nome = b, licenca = "uso local"), list(n = sum(d0$base == b)))),
  faixa = range(d0$idade),
  fonte = "Normas SegmentaRM: GAMLSS por fenótipo em volumes do SynthSeg 1.0 do app (volume suave, bloco 128³, espelhamento E/D) de adultos saudáveis de bases abertas CC0 do OpenNeuro; sítio como efeito aleatório",
  gerador = "tools/normas_selecao.py → tools/normas_lote.mjs → tools/normas_preparar.mjs → tools/normas_ajuste.R",
  modelo = "log V ~ SHASHo (ou normal, pelo BIC); mu = pb(idade) + sexo + random(sitio); sigma = pb(idade) + sexo; nu, tau constantes. Curva populacional com efeito de sítio = 0.",
  z = "z = sinh(tau * asinh((ln V - mu) / sigma) - nu)",
  idades = IDADES, n = nrow(d0), nSitios = nlevels(d0$sitio),
  sitios = lapply(split(d0, d0$sitio), function(x) list(n = nrow(x), base = x$base[1], fabricante = x$fabricante[1], modelo = x$modelo[1], campo = x$campo[1], faixa = range(x$idade))),
  fenotipos = saida)
writeLines(toJSON(out, auto_unbox = TRUE, digits = NA, null = "null"), SAIDA)
cat("→", SAIDA, "\n")

# fixture dos testes (tests/fixtures/normas_segmentarm_exato_R.json): z pela CDF da SHASHo do
# gamlss.dist (qnorm(pSHASHo)) com os parâmetros EXPORTADOS, em idades da grade e entre elas
fx <- list()
for (f in names(saida)) {
  e <- saida[[f]]
  for (sx in c("F", "M")) for (idade in c(25, 47.5, 71, 88.25)) {
    i0 <- max(which(IDADES <= idade)); i1 <- min(i0 + 1, length(IDADES)); t <- idade - IDADES[i0]
    mu <- e[[sx]]$mu[i0] + t * (e[[sx]]$mu[i1] - e[[sx]]$mu[i0])
    sg <- e[[sx]]$sigma[i0] + t * (e[[sx]]$sigma[i1] - e[[sx]]$sigma[i0])
    for (q in c(-3.5, -2, -0.5, 1, 2.5)) {
      v <- exp(mu + sg * sinh((asinh(q) + e$nu) / e$tau)) * exp(0.013 * q)
      z <- qnorm(pSHASHo(log(v), mu = mu, sigma = sg, nu = e$nu, tau = e$tau))
      fx[[length(fx) + 1]] <- list(fen = f, sexo = sx, idade = idade, v = v, z = z)
    }
  }
}
writeLines(toJSON(fx, auto_unbox = TRUE, digits = NA), file.path(VDIR, "normas_segmentarm_exato_R.json"))
