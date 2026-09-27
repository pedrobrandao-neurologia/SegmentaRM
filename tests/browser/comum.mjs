// Infraestrutura dos testes de navegador: servidor estático da raiz do repositório numa
// porta livre, Chromium via playwright-core (CHROMIUM_PATH sobrepõe o navegador padrão) e
// um NIfTI sintético para os fluxos que precisam de "outro exame".
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { writeNifti } from '../../lib/nifti-writer.js'

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const TMP = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'segmentarm-testes-'))

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ttf': 'font/ttf' }

export function servidor () {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      const p = path.join(RAIZ, url === '/' ? 'index.html' : url)
      if (!p.startsWith(RAIZ) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' })
      fs.createReadStream(p).pipe(res)
    })
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }))
  })
}

export async function navegador () {
  const { chromium } = await import('playwright-core')
  const opts = { args: ['--no-sandbox', '--use-gl=angle', '--enable-unsafe-swiftshader'] }
  if (process.env.CHROMIUM_PATH) return chromium.launch({ ...opts, executablePath: process.env.CHROMIUM_PATH })
  try {
    return await chromium.launch(opts)
  } catch (e) {
    // navegador da versão do playwright-core ausente: procura um Chromium já instalado
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join((await import('node:os')).homedir(), '.cache/ms-playwright')
    const cands = fs.existsSync(base) ? fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse() : []
    for (const d of cands) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const exe = path.join(base, d, rel)
        if (fs.existsSync(exe)) return chromium.launch({ ...opts, executablePath: exe })
      }
    }
    throw e
  }
}

// volume sintético com "crânio" e "encéfalo" (os workers de inferência são simulados nos testes)
export function niftiSintetico (nome = 'sintetico.nii.gz', dims = [96, 112, 90]) {
  const [nx, ny, nz] = dims
  const img = new Uint8Array(nx * ny * nz)
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const d = Math.hypot((x - nx / 2) / (nx / 2.3), (y - ny / 2) / (ny / 2.3), (z - nz / 2) / (nz / 2.3))
    img[x + nx * (y + ny * z)] = d < 0.7 ? 120 : d < 0.85 ? 80 : d < 1 ? 40 : 0
  }
  const A = [[-1, 0, 0, nx / 2], [0, 1, 0, -ny / 2], [0, 0, 1, -nz / 2], [0, 0, 0, 1]]
  const buf = writeNifti({ dims, pixDims: [1, 1, 1], affine: A, datatype: 'uint8', description: 'teste' }, img)
  const p = path.join(TMP, nome)
  fs.writeFileSync(p, zlib.gzipSync(Buffer.from(buf)))
  return p
}

export function relator (nome) {
  let n = 0; let falhas = 0
  return {
    ok (cond, msg) { n++; if (!cond) { falhas++; console.log(`  FALHOU ${msg}`) } else console.log(`  ok ${msg}`) },
    fim () { console.log(falhas ? `${nome}: ${falhas} falha(s) de ${n}` : `${nome}: todos os ${n} testes passaram`); return falhas }
  }
}
