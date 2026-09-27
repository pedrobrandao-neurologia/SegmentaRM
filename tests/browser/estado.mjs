// Estado da interface entre etapas: habilitação de botões, invalidação ao refazer, cancelamento
// (workers terminados), falha simulada, pipeline completo cancelado no DKT, novo exame.
import fs from 'node:fs'
import path from 'node:path'
import { RAIZ, servidor, navegador, niftiSintetico, relator } from './comum.mjs'

export async function testeEstado () {
  const R = relator('ESTADO')
  const { srv, url } = await servidor()
  const browser = await navegador()
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  const errs = []
  page.setDefaultTimeout(300000)
  page.on('pageerror', e => errs.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()) })
  page.on('response', r => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url()}`) })
  await page.addInitScript({ path: path.join(RAIZ, 'tests/browser/workers-simulados.js') })
  const outro = niftiSintetico('outro_exame.nii.gz', [96, 112, 90])
  try {
    await page.goto(url + '/index.html?mockbet')
    await page.waitForFunction(() => /pronto/.test(document.getElementById('console').textContent))
    const st = () => page.evaluate(() => {
      const S = window.__segrm; const $ = id => document.getElementById(id)
      return {
        running: S.running, seg: !!S.seg, segKind: S.segKind, stats: !!S.stats, surf: !!S.surf,
        meshes: S.nv.meshes.length, run: $('run').disabled, dkt: $('run-dkt').disabled, surfBtn: $('run-surf').disabled, clin: $('run-clinical').disabled,
        cancelHidden: $('cancel').hidden, exportHidden: $('step-export').hidden, resultsHidden: $('results').hidden,
        dlgErr: $('dlg-error').open, confBtn: document.querySelector('[data-export="nii-conf"]').disabled,
        confmapBtn: document.querySelector('[data-export="nii-confmap"]').disabled, pickFile: $('pick-file').disabled
      }
    })
    const idle = () => page.waitForFunction(() => !window.__segrm.running, null, { timeout: 1800000, polling: 300 })
    const dl = async (k) => {
      const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }).catch(() => null), page.click(`[data-export="${k}"]`)])
      if (!d) return null
      const p = await d.path()
      return { name: d.suggestedFilename(), size: fs.statSync(p).size, path: p }
    }

    await page.click('#load-example')
    await page.waitForFunction(() => /Exemplo T1/.test(document.getElementById('stage-lede').textContent), null, { timeout: 60000 })
    let s = await st()
    R.ok(!s.run && s.dkt && s.surfBtn && s.exportHidden, 'após carregar: só Segmentar habilitado')
    await page.click('#run'); await page.waitForTimeout(100)
    s = await st(); R.ok(s.running && !s.cancelHidden && s.pickFile, 'durante a segmentação: cancelar visível, abrir desabilitado')
    await idle()
    s = await st()
    R.ok(s.seg && s.segKind === 'synthseg' && !s.dkt && s.surfBtn && !s.exportHidden && !s.confBtn && !s.confmapBtn && s.cancelHidden, 'após a segmentação')
    let f = await dl('nii-conf'); R.ok(f && /conformado/.test(f.name) && f.size > 100000, 'exporta o conformado')
    f = await dl('nii-confmap'); R.ok(f && /confianca/.test(f.name), 'exporta o mapa de confiança')
    const csv = await dl('csv'); R.ok(csv && fs.readFileSync(csv.path, 'utf8').charCodeAt(0) === 0xFEFF, 'CSV com BOM')
    // volume suave como principal (a rede simulada devolve volumes suaves)
    const vs = await page.evaluate(() => ({ soft: window.__segrm.stats.volumeSoft, met: window.__segrm.stats.rows.filter(r => r.volMm3 > 0).map(r => r.metodoVolume) }))
    R.ok(vs.soft && vs.met.every(m => m === 'suave'), 'volume suave é o principal no SynthSeg')

    await page.click('#run-dkt'); await idle()
    s = await st(); R.ok(s.segKind === 'synthseg-dkt' && s.dkt && !s.surfBtn, 'após o DKT')
    const vd = await page.evaluate(() => window.__segrm.stats.rows.filter(r => /^ctx-/.test(r.name) && r.volMm3 > 0).map(r => r.metodoVolume))
    R.ok(vd.length > 0 && vd.every(m => m === 'suave-redistribuido'), 'parcelas DKT com córtex suave redistribuído')

    await page.click('#run'); await page.waitForTimeout(50)
    s = await st(); R.ok(!s.surf && s.meshes === 0 && s.exportHidden && s.dkt && s.surfBtn, 'refazer a segmentação invalida o que derivava dela')
    await idle()
    s = await st(); R.ok(s.segKind === 'synthseg' && !s.dkt && s.surfBtn, 'após refazer a segmentação')

    await page.evaluate(() => { window.__fakeDelay = 8000 })
    await page.click('#run')
    await page.waitForFunction(() => /fake|Segmentando/.test(document.getElementById('console').textContent) && window.__segrm.running)
    await page.waitForTimeout(3000)
    await page.evaluate(() => document.getElementById('load-example').click())
    await page.setInputFiles('#file-nifti', outro)
    await page.waitForTimeout(500)
    s = await st(); R.ok(s.running && s.segKind === null, 'entrada nova recusada durante a execução')
    await page.click('#cancel'); await idle()
    s = await st(); R.ok(!s.running && !s.dlgErr && !s.seg && !s.run && s.dkt && s.cancelHidden && !s.pickFile, 'após cancelar')
    const term = await page.evaluate(() => [window.__fakeCount, window.__fakeTerminated])
    R.ok(term[0] === term[1], `workers terminados (${term})`)

    await page.evaluate(() => { window.__fakeDelay = 200; window.__fakeFail = /synthseg/ })
    await page.click('#run'); await idle()
    s = await st(); R.ok(s.dlgErr && !s.seg && s.exportHidden && s.dkt, 'falha simulada na segmentação')
    await page.click('#err-close')
    await page.evaluate(() => { window.__fakeFail = null })

    await page.evaluate(() => { window.__fakeDelay = 200 })
    await page.selectOption('#model', 'synthseg')
    await page.click('#run-clinical'); await page.waitForTimeout(100)
    s = await st(); R.ok(s.clin && s.running, 'pipeline completo rodando')
    await page.waitForFunction(() => window.__segrm.segKind === 'synthseg' && window.__segrm.running, null, { timeout: 120000, polling: 50 }).catch(() => {})
    await page.evaluate(() => { window.__fakeDelay = 5000 })
    await page.waitForTimeout(1500)
    await page.click('#cancel')
    await page.waitForFunction(() => !window.__segrm.running && !document.getElementById('run-clinical').disabled, null, { timeout: 120000 })
    s = await st(); R.ok(s.segKind === 'synthseg' && !s.surf && !s.dlgErr, 'pipeline cancelado no DKT mantém o SynthSeg')

    await page.setInputFiles('#file-nifti', outro)
    await page.waitForFunction(() => /96×112×90/.test(document.getElementById('stage-lede').textContent), null, { timeout: 60000 })
    s = await st(); R.ok(!s.seg && !s.stats && s.exportHidden && s.resultsHidden && s.meshes === 0 && s.dkt, 'novo exame limpa o estado')
    await page.evaluate(() => { document.getElementById('stage-lede').textContent = 'x' })
    await page.setInputFiles('#file-nifti', outro)
    const reab = await page.waitForFunction(() => /96×112×90/.test(document.getElementById('stage-lede').textContent), null, { timeout: 60000 }).then(() => true).catch(() => false)
    R.ok(reab, 'reabrir o mesmo arquivo')
    R.ok(errs.length === 0, 'sem erros de página ' + errs.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    srv.close()
  }
  return R.fim()
}
