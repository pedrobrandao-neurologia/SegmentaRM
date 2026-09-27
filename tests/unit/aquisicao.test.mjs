// Aquisição: idade na data do exame, correção de distorção, identidade do protocolo (sem
// identificadores) e lateralidade da reorientação RAS.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { idadeNoExame, correcaoDistorcao } from '../../lib/dicom-scan.js'
import { descritorProtocolo, protocoloDe } from '../../lib/protocolo.js'
import { reorientToRAS } from '../../lib/fsl-prep.js'

test('idade calculada pela data do exame, não pela data do processamento', () => {
  assert.deepEqual(idadeNoExame({ '00080020': '20240315', '00100030': '19350101' }), { IdadeNoExame: 89.2, IdadeFonte: 'DICOM: data do exame − data de nascimento' })
  // sem data do estudo, a data da aquisição serve
  assert.equal(idadeNoExame({ '00080022': '20100101', '00100030': '19900101' }).IdadeNoExame, 20)
  // sem datas: PatientAge (anos completos, meses, semanas)
  assert.equal(idadeNoExame({ '00101010': '089Y' }).IdadeNoExame, 89)
  assert.equal(idadeNoExame({ '00101010': '018M' }).IdadeNoExame, 1.5)
  assert.deepEqual(idadeNoExame({}), {})
  // data de nascimento depois do exame (anonimização malfeita): ignora
  assert.deepEqual(idadeNoExame({ '00080020': '19800101', '00100030': '19900101' }), {})
})

test('correção de distorção: só a Siemens declara em tag padrão; o resto é "não verificado"', () => {
  assert.match(correcaoDistorcao({ Manufacturer: 'SIEMENS', ImageType: ['ORIGINAL', 'PRIMARY', 'M', 'DIS3D'] }), /aplicada \(3D/)
  assert.match(correcaoDistorcao({ Manufacturer: 'Siemens Healthineers', ImageType: 'ORIGINAL\\PRIMARY\\M\\ND' }), /NÃO aplicada/)
  assert.equal(correcaoDistorcao({ Manufacturer: 'GE MEDICAL SYSTEMS', ImageType: ['ORIGINAL', 'PRIMARY'] }), 'não verificado')
  assert.equal(correcaoDistorcao(null), 'não verificado')
})

test('protocolo: família estável entre pacientes, sem identificadores', async () => {
  const sc = { Manufacturer: 'GE MEDICAL SYSTEMS', ManufacturersModelName: 'SIGNA Premier', MagneticFieldStrength: 3, MRAcquisitionType: '3D', SeriesDescription: 'Sag 3D T1 BRAVO', RepetitionTime: 0.0076, EchoTime: 0.0031, InversionTime: 0.45, FlipAngle: 12, PatientSex: 'M', IdadeNoExame: 89.2 }
  const a = await protocoloDe(sc, [1.02, 0.7, 1.02])
  const b = await protocoloDe({ ...sc, PatientSex: 'F', IdadeNoExame: 55 }, [1.02, 0.7, 1.02])
  assert.equal(a.familia, b.familia)
  assert.equal(a.id, b.id)
  assert.match(a.familia, /^[0-9a-f]{12}$/)
  const d = descritorProtocolo(sc, [1.02, 0.7, 1.02])
  assert.ok(!/89|PatientSex|Idade/.test(d.chaveExata))
  // voxel diferente muda o protocolo exato, não a família
  const c = await protocoloDe(sc, [1, 1, 1])
  assert.equal(c.familia, a.familia)
  assert.notEqual(c.id, a.id)
  assert.equal((await protocoloDe(null, [1, 1, 1])).semDicom, true)
})

test('lateralidade: um marcador no hemisfério esquerdo continua à esquerda após a reorientação', () => {
  // 11³, voxel 1 mm, codificação LPS-like: eixo i aponta para a DIREITA→ESQUERDA (x RAS decresce)
  const n = 11
  const img = new Float32Array(n ** 3)
  const A = [-1, 0, 0, 5, 0, -1, 0, 5, 0, 0, 1, -5, 0, 0, 0, 1] // x = 5 − i: i = 10 → x = −5 (esquerda)
  img[10 + n * (5 + n * 5)] = 1 // i = 10 → esquerda
  const r = reorientToRAS(img, [n, n, n], [1, 1, 1], A)
  assert.equal(r.applied, true)
  const k = r.img.indexOf(1)
  const i = k % n; const j = Math.floor(k / n) % n; const kk = Math.floor(k / (n * n))
  const Ar = r.affine
  const x = Ar[0] * i + Ar[1] * j + Ar[2] * kk + Ar[3]
  assert.ok(x < 0, `marcador em x RAS = ${x} (esperado negativo = esquerda)`)
})
