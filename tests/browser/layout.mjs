// Layout ajustável, passo 05 (espessura + malhas só na tela), painel normativo com
// proveniência e multiplicidade, alertas de QC, calibração do sítio e conteúdo das exportações.
import fs from 'node:fs'
import path from 'node:path'
import { RAIZ, servidor, navegador, relator } from './comum.mjs'
import { textoDoPdf } from '../pdftexto.mjs'

export async function testeLayout () {
  const R = relator('LAYOUT')
  const { srv, url } = await servidor()
  const b = await navegador()
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 950 } })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()) })
  p.on('response', r => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url()}`) })
  await p.addInitScript({ path: path.join(RAIZ, 'tests/browser/workers-simulados.js') })
  try {
    await p.goto(url + '/index.html?mockbet')
    await p.waitForFunction(() => /pronto/.test(document.getElementById('console').textContent))
    const w = (sel) => p.$eval(sel, e => Math.round(e.getBoundingClientRect().width))
    const insp0 = await w('.inspector'); const view0 = await w('.view'); const rail0 = await w('.rail')
    const sb = await (await p.$('#split-insp')).boundingBox()
    await p.mouse.move(sb.x + 3, sb.y + sb.height / 2); await p.mouse.down(); await p.mouse.move(sb.x - 300, sb.y + sb.height / 2, { steps: 8 }); await p.mouse.up()
    await p.waitForTimeout(400)
    const insp1 = await w('.inspector'); const view1 = await w('.view'); const canvas1 = await w('#gl')
    R.ok(Math.abs(insp1 - insp0 - 300) <= 4, `inspetor ${insp0} → ${insp1} px`)
    R.ok(Math.abs(view0 - view1 - 300) <= 4 && Math.abs(canvas1 - view1) <= 4, 'visualizador e canvas acompanham o divisor')
    const sr = await (await p.$('#split-rail')).boundingBox()
    await p.mouse.move(sr.x + 3, sr.y + 200); await p.mouse.down(); await p.mouse.move(sr.x + 120, sr.y + 200, { steps: 6 }); await p.mouse.up()
    R.ok(Math.abs(await w('.rail') - rail0 - 120) <= 4, 'painel de etapas alargado 120 px')
    await p.reload(); await p.waitForFunction(() => /pronto/.test(document.getElementById('console').textContent))
    R.ok(Math.abs(await w('.inspector') - insp1) <= 4, 'largura do inspetor lembrada após recarregar')
    await p.dblclick('#split-insp'); await p.waitForTimeout(200)
    R.ok(Math.abs(await w('.inspector') - insp0) <= 4, 'duplo clique restaura a largura padrão')

    await p.click('#load-example')
    await p.waitForSelector('#run:not([disabled])', { timeout: 120000 })
    await p.click('#run'); await p.waitForFunction(() => window.__segrm.stats && !window.__segrm.running, null, { timeout: 600000 })
    await p.click('#run-dkt'); await p.waitForFunction(() => /-dkt$/.test(window.__segrm.segKind || '') && !window.__segrm.running, null, { timeout: 900000 })
    // idade e sexo → comparação normativa, alertas e calibração
    await p.fill('#age', '89'); await p.selectOption('#sex', 'M')
    await p.$eval('#age', e => e.dispatchEvent(new Event('change')))
    await p.waitForFunction(() => window.__segrm.norms && window.__segrm.norms.available, null, { timeout: 60000 })
    const nm = await p.evaluate(() => ({
      lobos: window.__segrm.norms.lobes.length,
      mult: window.__segrm.norms.multiplicidade,
      borda: window.__segrm.norms.proveniencia.centilebrain && window.__segrm.norms.proveniencia.centilebrain.borda,
      nota: document.getElementById('norm-sub-note').textContent,
      selo: [...document.querySelectorAll('#norm-table td[title]')].map(t => t.title).join(' | '),
      alertas: document.getElementById('alertas-panel').hidden === false,
      ic90: window.__segrm.norms.globals.some(g => Array.isArray(g.ic90)) && /IC 90%/.test(document.querySelector('#norm-table thead').textContent),
      recentrado: window.__segrm.norms.globals.some(g => g.recentrado && isFinite(g.recentrado.desloc)) && !document.getElementById('recentragem-wrap').hidden,
      ic90diag: JSON.stringify({ n: window.__segrm.norms.globals.length, g0: window.__segrm.norms.globals[0] && Object.keys(window.__segrm.norms.globals[0]), th: document.querySelector('#norm-table thead').textContent }),
      calib: document.getElementById('calib-status').textContent
    }))
    R.ok(nm.lobos === 0, 'sem z por lobo no normativo')
    R.ok(nm.mult && nm.mult.m > 0 && /espera-se/.test(nm.nota), 'multiplicidade explicada no painel')
    R.ok(nm.borda === true && /NÃO calibrado/.test(nm.selo), 'selo de proveniência com borda etária e sítio não calibrado' + (nm.borda === true && /NÃO calibrado/.test(nm.selo) ? '' : ` (borda ${nm.borda}; selo "${nm.selo.slice(0, 200)}")`))
    R.ok(nm.alertas, 'painel de alertas de QC visível')
    R.ok(nm.ic90, 'z com intervalo de 90% na tabela normativa' + (nm.ic90 ? '' : ` (${nm.ic90diag})`))
    R.ok(nm.recentrado && /recentrado por controles do mesmo método/.test(nm.selo), 'z recentrado pelo método (nível A), com selo e opção visível')
    R.ok(/Protocolo deste exame/.test(nm.calib), 'painel de calibração mostra o protocolo')
    // bloco do SynthSeg: registrado; aviso quando menor que o da recentragem (128³)
    const bl0 = await p.evaluate(() => ({ seg: window.__segrm.segBloco, alerta: (window.__segrm.alertasQC || []).some(a => a.id === 'bloco_reduzido') }))
    R.ok(bl0.seg && bl0.seg.usado === 128 && !bl0.alerta, 'bloco do SynthSeg registrado (128³, sem aviso)' + (bl0.seg ? '' : ' (sem registro)'))
    await p.evaluate(() => { window.__segrm.segBloco = { usado: 96, pedido: 128 } })
    await p.$eval('#age', e => e.dispatchEvent(new Event('change')))
    await p.waitForFunction(() => (window.__segrm.alertasQC || []).some(a => a.id === 'bloco_reduzido'), null, { timeout: 30000 }).catch(() => {})
    const bl1 = await p.evaluate(() => { const a = (window.__segrm.alertasQC || []).find(x => x.id === 'bloco_reduzido'); return a ? a.mensagem : '' })
    R.ok(/96³/.test(bl1) && /textura/.test(bl1), 'aviso de bloco reduzido (96³) quando a GPU limita a textura')
    await p.evaluate(() => { window.__segrm.segBloco = { usado: 128, pedido: 128 } })
    await p.$eval('#age', e => e.dispatchEvent(new Event('change')))
    await p.waitForFunction(() => !(window.__segrm.alertasQC || []).some(a => a.id === 'bloco_reduzido'), null, { timeout: 30000 }).catch(() => {})

    await p.selectOption('#surf-engine', 'edt')
    await p.click('#run-surf'); await p.waitForFunction(() => !window.__segrm.running, null, { timeout: 1800000 })
    const th = await p.evaluate(() => ({ ok: !!window.__segrm.thick, n: window.__segrm.thick ? window.__segrm.thick.regioes.length : 0, rows: document.querySelectorAll('#surf-table tbody tr').length }))
    R.ok(th.ok && th.rows === th.n && th.n > 0, 'espessura volumétrica calculada e tabelada por região')
    await p.selectOption('#surf-show-kind', 'both')
    let kinds = 0
    for (let i = 0; i < 20 && kinds < 4; i++) { await p.waitForTimeout(500); kinds = await p.evaluate(() => window.__segrm.nv.meshes.length) }
    R.ok(kinds === 4, `seletor "ambas" mostra white e pial dos dois hemisférios (${kinds} malhas)`)
    await p.click('#insp-max'); await p.waitForTimeout(300)
    const maxW = await w('.inspector')
    R.ok(maxW > view1, `painel ampliado cobre o visualizador (${maxW} px)`)
    const cols = await p.$$eval('.insp-body .panel:not([hidden])', ps => new Set(ps.filter(x => x.offsetParent).map(x => Math.round(x.getBoundingClientRect().left / 20))).size)
    R.ok(cols >= 2, `seções lado a lado no painel ampliado (${cols} colunas)`)
    await p.keyboard.press('Escape'); await p.waitForTimeout(200)
    R.ok(!(await p.$eval('.app', e => e.classList.contains('insp-max'))), 'Esc volta ao visualizador')
    const h = await p.$('#qc-panel > h3')
    if (h) { await h.click(); R.ok(await p.$eval('#qc-panel', e => e.classList.contains('collapsed')), 'seção recolhida pelo título') }

    const dl = async (k) => { const [d] = await Promise.all([p.waitForEvent('download', { timeout: 120000 }), p.click(`[data-export="${k}"]`)]); return fs.readFileSync(await d.path()) }
    const csv = (await dl('csv')).toString('utf8')
    R.ok(!/,superficie,/.test(csv) && /,espessura_volumetrica,/.test(csv) && /,nota_metodologica,/.test(csv), 'CSV com espessura + nota metodológica, sem malha')
    R.ok(/volume_rigido_mm3,metodo_volume/.test(csv.split('\r\n')[0]), 'CSV com volume rígido de auditoria e método')
    R.ok(/,z_assimetria$/.test(csv.split('\r\n')[0]), 'CSV com coluna de z da assimetria')
    const json = JSON.parse((await dl('json')).toString('utf8'))
    R.ok(json.superficie == null && json.espessura_volumetrica && /VOLUMÉTRICO/.test(json.espessura_volumetrica.aviso_metodologico), 'JSON sem malha; espessura com aviso')
    R.ok(json.normativo && json.normativo.proveniencia && json.normativo.multiplicidade, 'JSON com proveniência e multiplicidade')
    R.ok(json.normativo.globais.some(g => Array.isArray(g.ic90) && g.incerteza) && /ic90/.test(json.normativo.nota_intervalo), 'JSON com intervalo de 90% e componentes da incerteza')
    R.ok(json.reprodutibilidade && json.reprodutibilidade.componentes.some(c => c.nome === 'synthseg1' && /^[0-9a-f]{64}$/.test(c.sha256)), 'JSON com SHA-256 dos pesos usados')
    R.ok(json.aquisicao && json.aquisicao.correcaoDistorcao, 'JSON com parâmetros de aquisição')
    R.ok(json.reprodutibilidade.synthsegBloco === 128, 'JSON registra o bloco do SynthSeg')
    const zip = await dl('zip')
    const zm = /\.mz3|talairach\.xfm|norm_sintetico/.exec(zip.toString('latin1'))
    R.ok(!zm, 'ZIP sem malhas, talairach.xfm nem norm sintético' + (zm ? ` (achou "${zip.toString('latin1').slice(Math.max(0, zm.index - 60), zm.index + 40).replace(/[^\x20-\x7e]/g, '.')}")` : ''))
    const pdf = await dl('pdf')
    if (process.env.SALVAR_PDF) fs.writeFileSync(process.env.SALVAR_PDF, pdf) // inspeção visual
    const txt = textoDoPdf(pdf)
    R.ok(/Espessura cortical/.test(txt) && /Sobre o método/.test(txt) && !/Superfície cortical/.test(txt), 'PDF: espessura com aviso, sem página de malha')
    R.ok(/Como ler esta página/.test(txt) && /NÃO calibrado/.test(txt) && /não validado/.test(txt) && /Reprodutibilidade/.test(txt), 'PDF: como ler, selo, índice não validado e reprodutibilidade')
    R.ok(/Volumes por região/.test(txt) && !/Lobos corticais/.test(txt), 'PDF: regiões por lobo, sem tabela de z lobar')
    R.ok(/IC 90%/.test(txt) && /z IA/.test(txt) && !/em laranja, \|IA\| > 10%/.test(txt), 'PDF: intervalo do z e z da assimetria (sem o corte fixo de 10%)')
    R.ok(/\/FontFile2/.test(pdf.toString('latin1')), 'PDF com a Inter embutida')
    R.ok(await p.$eval('[data-export="xfm"]', e => e.hidden) && await p.$eval('[data-export="nii-norm"]', e => e.hidden), 'botões de norm/talairach ocultos')
    R.ok(errs.length === 0, 'sem erros de página ' + errs.slice(0, 3).join(' | '))
  } finally {
    await b.close()
    srv.close()
  }
  return R.fim()
}
