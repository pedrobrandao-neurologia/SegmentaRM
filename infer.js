// infer.js — carrega o ONNX Runtime Web e roda modelos 3D em blocos (tiles).

const ORT_CANDIDATES = [
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.bundle.min.mjs',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.bundle.min.mjs',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.webgpu.min.mjs',
  'https://unpkg.com/onnxruntime-web@1.22.0/dist/ort.webgpu.bundle.min.mjs',
];

let ortPromise = null;

export function loadOrt(customUrl) {
  if (ortPromise) return ortPromise;
  const list = customUrl ? [customUrl, ...ORT_CANDIDATES] : ORT_CANDIDATES;
  ortPromise = (async () => {
    let lastErr;
    for (const url of list) {
      try {
        const mod = await import(/* @vite-ignore */ url);
        const ort = mod.default ?? mod;
        if (!ort.InferenceSession) throw new Error('módulo sem InferenceSession');
        ort.env.wasm.wasmPaths = url.slice(0, url.lastIndexOf('/') + 1);
        ort.env.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 8);
        ort.__sourceUrl = url;
        return ort;
      } catch (e) { lastErr = e; }
    }
    ortPromise = null;
    throw new Error(
      `Não foi possível carregar o ONNX Runtime Web. Verifique a conexão na primeira execução, ou informe uma URL própria em Ajustes. (${lastErr?.message || lastErr})`
    );
  })();
  return ortPromise;
}

export async function hasWebGPU() {
  if (!('gpu' in navigator)) return false;
  try {
    const a = await navigator.gpu.requestAdapter();
    return !!a;
  } catch { return false; }
}

export async function gpuLimits() {
  if (!('gpu' in navigator)) return null;
  try {
    const a = await navigator.gpu.requestAdapter();
    if (!a) return null;
    return {
      maxBufferSize: a.limits.maxBufferSize,
      maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize,
      vendor: a.info?.vendor || '',
      architecture: a.info?.architecture || '',
    };
  } catch { return null; }
}

export class Model {
  /**
   * @param {object} spec  Entrada do registry: {id,name,task,layout,inputSize,tile,overlap,labels,inputName,outputName}
   */
  constructor(spec, session, ort) {
    this.spec = spec;
    this.session = session;
    this.ort = ort;
  }

  static async create(spec, bytes, { device = 'auto', ortUrl } = {}) {
    const ort = await loadOrt(ortUrl);
    const eps = device === 'wasm' ? ['wasm']
      : device === 'webgpu' ? ['webgpu']
        : (await hasWebGPU()) ? ['webgpu', 'wasm'] : ['wasm'];
    let session, used;
    for (const ep of eps) {
      try {
        session = await ort.InferenceSession.create(
          bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
          executionProviders: [ep],
          graphOptimizationLevel: 'all',
        });
        used = ep;
        break;
      } catch (e) {
        if (ep === eps[eps.length - 1]) throw new Error(`Falha ao iniciar o modelo (${ep}): ${e.message}`);
      }
    }
    const m = new Model(spec, session, ort);
    m.device = used;
    return m;
  }

  get inputName() { return this.spec.inputName || this.session.inputNames[0]; }
  get outputName() { return this.spec.outputName || this.session.outputNames[0]; }

  /**
   * Segmentação: devolve rótulos inteiros por voxel.
   * @param {Float32Array} data  volume normalizado
   * @param {number[]} dims      [nx,ny,nz]
   */
  async segment(data, dims, onProgress = () => {}) {
    const spec = this.spec;
    const tile = spec.tile && spec.tile > 0 ? spec.tile : Math.max(...dims);
    const ov = spec.overlap ?? 16;
    const [nx, ny, nz] = dims;
    const nvox = nx * ny * nz;
    const bestProb = new Float32Array(nvox);
    const bestIdx = new Uint16Array(nvox);

    const starts = (n) => {
      if (tile >= n) return [0];
      const step = tile - ov;
      const out = [];
      for (let s = 0; s + tile <= n; s += step) out.push(s);
      if (out[out.length - 1] + tile < n) out.push(n - tile);
      return out;
    };
    const sxs = starts(nx), sys = starts(ny), szs = starts(nz);
    const total = sxs.length * sys.length * szs.length;
    let done = 0;

    const td = Math.min(tile, nx), th = Math.min(tile, ny), tt = Math.min(tile, nz);
    const patch = new Float32Array(td * th * tt);

    for (const z0 of szs) for (const y0 of sys) for (const x0 of sxs) {
      // recorta o bloco
      let p = 0;
      for (let k = 0; k < tt; k++) {
        for (let j = 0; j < th; j++) {
          const base = x0 + (y0 + j) * nx + (z0 + k) * nx * ny;
          for (let i = 0; i < td; i++) patch[p++] = data[base + i];
        }
      }
      const shape = spec.layout === 'NCDHW' ? [1, 1, tt, th, td] : [1, tt, th, td, 1];
      const t = new this.ort.Tensor('float32', patch, shape);
      const res = await this.session.run({ [this.inputName]: t });
      const out = res[this.outputName];
      const od = out.dims;
      const nCh = spec.layout === 'NCDHW' ? od[1] : od[od.length - 1];
      const od0 = out.data;

      // margem descartada nas bordas internas para reduzir artefato de emenda
      const mg = (s, tsz, n) => [s === 0 ? 0 : Math.floor(ov / 2), s + tsz >= n ? tsz : tsz - Math.floor(ov / 2)];
      const [ix0, ix1] = mg(x0, td, nx), [iy0, iy1] = mg(y0, th, ny), [iz0, iz1] = mg(z0, tt, nz);

      for (let k = iz0; k < iz1; k++) {
        for (let j = iy0; j < iy1; j++) {
          for (let i = ix0; i < ix1; i++) {
            const local = i + j * td + k * td * th;
            let bi = 0, bp = -Infinity;
            if (spec.layout === 'NCDHW') {
              const plane = tt * th * td;
              for (let c = 0; c < nCh; c++) {
                const v = od0[c * plane + local];
                if (v > bp) { bp = v; bi = c; }
              }
            } else {
              const off = local * nCh;
              for (let c = 0; c < nCh; c++) {
                const v = od0[off + c];
                if (v > bp) { bp = v; bi = c; }
              }
            }
            const gi = (x0 + i) + (y0 + j) * nx + (z0 + k) * nx * ny;
            if (bp > bestProb[gi]) { bestProb[gi] = bp; bestIdx[gi] = bi; }
          }
        }
      }
      done++;
      onProgress(`Inferência ${done}/${total} blocos`, done / total);
      await new Promise((r) => setTimeout(r, 0));
    }

    // canal -> id de rótulo
    const map = spec.labels;
    const labels = new Uint16Array(nvox);
    if (Array.isArray(map) && map.length) {
      for (let i = 0; i < nvox; i++) labels[i] = map[bestIdx[i]] ?? 0;
    } else {
      labels.set(bestIdx);
    }
    return { labels, confidence: bestProb };
  }

  /** Regressão voxel-a-voxel (ex.: SynthSR). Devolve um volume contínuo. */
  async regress(data, dims, onProgress = () => {}) {
    const spec = this.spec;
    const tile = spec.tile && spec.tile > 0 ? spec.tile : Math.max(...dims);
    const ov = spec.overlap ?? 16;
    const [nx, ny, nz] = dims;
    const acc = new Float32Array(nx * ny * nz);
    const wsum = new Float32Array(nx * ny * nz);
    const starts = (n) => {
      if (tile >= n) return [0];
      const step = tile - ov, out = [];
      for (let s = 0; s + tile <= n; s += step) out.push(s);
      if (out[out.length - 1] + tile < n) out.push(n - tile);
      return out;
    };
    const sxs = starts(nx), sys = starts(ny), szs = starts(nz);
    const total = sxs.length * sys.length * szs.length;
    let done = 0;
    const td = Math.min(tile, nx), th = Math.min(tile, ny), tt = Math.min(tile, nz);
    const patch = new Float32Array(td * th * tt);

    for (const z0 of szs) for (const y0 of sys) for (const x0 of sxs) {
      let p = 0;
      for (let k = 0; k < tt; k++) for (let j = 0; j < th; j++) {
        const base = x0 + (y0 + j) * nx + (z0 + k) * nx * ny;
        for (let i = 0; i < td; i++) patch[p++] = data[base + i];
      }
      const shape = spec.layout === 'NCDHW' ? [1, 1, tt, th, td] : [1, tt, th, td, 1];
      const res = await this.session.run({ [this.inputName]: new this.ort.Tensor('float32', patch, shape) });
      const od0 = res[this.outputName].data;
      for (let k = 0; k < tt; k++) for (let j = 0; j < th; j++) for (let i = 0; i < td; i++) {
        const local = i + j * td + k * td * th;
        const gi = (x0 + i) + (y0 + j) * nx + (z0 + k) * nx * ny;
        acc[gi] += od0[local];
        wsum[gi] += 1;
      }
      done++;
      onProgress(`Síntese ${done}/${total} blocos`, done / total);
      await new Promise((r) => setTimeout(r, 0));
    }
    for (let i = 0; i < acc.length; i++) if (wsum[i]) acc[i] /= wsum[i];
    return acc;
  }
}
