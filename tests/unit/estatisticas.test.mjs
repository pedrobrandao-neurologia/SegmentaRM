// Estatísticas: volume do voxel pela afim do espaço de contagem, volume suave como principal
// (com redistribuição do córtex nas parcelas DKT), agregados FreeSurfer e mapa de lobos.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeStats, aplicarVolumesSuaves, statsToCSV, statsToJSON, statsToWideRow } from '../../lib/stats.js'
import { lobeOf } from '../../lib/labels.js'

const I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
const labels = { 0: 'BG', 1: 'Left-Cerebral-White-Matter', 2: 'Left-Cerebral-Cortex', 14: 'Left-Hippocampus', 4: 'Left-Inf-Lat-Vent', 32: 'ctx-lh-insula', 33: 'ctx-lh-lingual', 18: 'Right-Cerebral-White-Matter', 28: 'Right-Hippocampus' }
function volume () {
  const n = 20 ** 3; const seg = new Uint8Array(n)
  const ciclo = [1, 2, 14, 4, 32, 33, 18, 28]
  for (let i = 0; i < n; i++) seg[i] = ciclo[i % 8]
  return seg
}

test('volume do voxel = |det| da afim do espaço onde os rótulos foram contados', () => {
  const seg = volume()
  const A = [[-0.9, 0, 0, 10], [0, 1.2, 0, 0], [0, 0, 1.1, 0], [0, 0, 0, 1]]
  const st = computeStats(seg, new Uint8Array(seg.length), [20, 20, 20], labels, A, 1)
  assert.ok(Math.abs(st.voxVol - 0.9 * 1.2 * 1.1) < 1e-9)
  assert.equal(st.voxVolSource, 'determinante da affine')
  const hip = st.rows.find(r => r.name === 'Left-Hippocampus')
  assert.ok(Math.abs(hip.volMm3 - 1000 * st.voxVol) < 1e-6)
})

test('volume suave vira o principal; rígido fica como auditoria; córtex redistribuído nas parcelas', () => {
  const seg = volume()
  const st = computeStats(seg, new Uint8Array(seg.length), [20, 20, 20], labels, I, 1)
  assert.equal(st.volumeSoft, false)
  const suave = { 'Left-Cerebral-White-Matter': 900, 'Left-Cerebral-Cortex': 1500, 'Left-Hippocampus': 950, 'Left-Inf-Lat-Vent': 800, 'Right-Cerebral-White-Matter': 1010, 'Right-Hippocampus': 980 }
  const s2 = aplicarVolumesSuaves(st, suave)
  const r = (n) => s2.rows.find(x => x.name === n)
  assert.equal(s2.volumeSoft, true)
  assert.equal(r('Left-Hippocampus').volMm3, 950)
  assert.equal(r('Left-Hippocampus').volHardMm3, 1000)
  assert.equal(r('Left-Hippocampus').metodoVolume, 'suave')
  assert.ok(Math.abs(r('Left-Hippocampus').difSuaveRigidoPct + 5) < 1e-9)
  // 1500 mm³ de córtex suave repartidos por insula + lingual + resíduo (1000 rígidos cada)
  assert.equal(r('ctx-lh-insula').metodoVolume, 'suave-redistribuido')
  assert.ok(Math.abs(r('ctx-lh-insula').volMm3 - 500) < 1e-9)
  assert.ok(Math.abs(s2.composites.find(c => c.id === 'CortexVol').volMm3 - 1500) < 1e-6)
  // assimetria recalculada sobre o valor principal
  const par = s2.pairs.find(p => p.base === 'Hippocampus')
  assert.ok(Math.abs(par.ai - 200 * (950 - 980) / (950 + 980)) < 1e-9)
  // exportações: principal, rígido e método
  const csv = statsToCSV(s2, { subject: 't' })
  assert.match(csv.split('\r\n')[0], /volume_rigido_mm3,metodo_volume,dif_suave_rigido_pct/)
  const j = JSON.parse(statsToJSON(s2, { subject: 't' }))
  assert.match(j.metodo_volume, /PRINCIPAL = volume suave/)
})

test('rede sem posteriores: tudo continua rígido', () => {
  const seg = volume()
  const st = computeStats(seg, new Uint8Array(seg.length), [20, 20, 20], labels, I, 1)
  assert.ok(st.rows.every(r => r.metodoVolume === 'rigido' && r.volHardMm3 === r.volMm3))
})

test('lobos: as 31 parcelas DKT caem em frontal, temporal, parietal, occipital ou ínsula', () => {
  const dkt = ['caudalanteriorcingulate', 'caudalmiddlefrontal', 'cuneus', 'entorhinal', 'fusiform', 'inferiorparietal', 'inferiortemporal', 'isthmuscingulate', 'lateraloccipital', 'lateralorbitofrontal', 'lingual', 'medialorbitofrontal', 'middletemporal', 'parahippocampal', 'paracentral', 'parsopercularis', 'parsorbitalis', 'parstriangularis', 'pericalcarine', 'postcentral', 'posteriorcingulate', 'precentral', 'precuneus', 'rostralanteriorcingulate', 'rostralmiddlefrontal', 'superiorfrontal', 'superiorparietal', 'superiortemporal', 'supramarginal', 'transversetemporal', 'insula']
  assert.equal(dkt.length, 31)
  const lobos = new Set(['frontal', 'temporal', 'parietal', 'occipital', 'ínsula'])
  for (const p of dkt) for (const h of ['lh', 'rh']) assert.ok(lobos.has(lobeOf(`ctx-${h}-${p}`)), `${p} → ${lobeOf(`ctx-${h}-${p}`)}`)
  // convenção dos lobos "estritos": cíngulo anterior no frontal, posterior e istmo no parietal
  assert.equal(lobeOf('ctx-lh-rostralanteriorcingulate'), 'frontal')
  assert.equal(lobeOf('ctx-rh-isthmuscingulate'), 'parietal')
})

test('linha da coorte leva idade, sexo, protocolo e a marca de controle', () => {
  const seg = volume()
  const st = computeStats(seg, new Uint8Array(seg.length), [20, 20, 20], labels, I, 1)
  const { row } = statsToWideRow(st, { subject: 's', age: 70, sex: 'F', controle: true, protocolo: { familia: 'abc123', familiaTxt: 'GE · 3T' } })
  assert.equal(row.idade, 70)
  assert.equal(row.sexo, 'F')
  assert.equal(row.controle, 1)
  assert.equal(row.protocolo_familia, 'abc123')
  assert.ok(row.Left_Hippocampus > 0)
})
