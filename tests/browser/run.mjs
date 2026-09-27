#!/usr/bin/env node
// Testes de navegador (Playwright + Chromium, inferência simulada): node tests/browser/run.mjs [estado|layout]
import { testeEstado } from './estado.mjs'
import { testeLayout } from './layout.mjs'

const quais = process.argv.slice(2)
let falhas = 0
if (!quais.length || quais.includes('estado')) falhas += await testeEstado()
if (!quais.length || quais.includes('layout')) falhas += await testeLayout()
console.log(falhas ? `NAVEGADOR: ${falhas} falha(s)` : 'NAVEGADOR: tudo passou')
process.exit(falhas ? 1 : 0)
