// viewer.js — três planos ortogonais com sobreposição de rótulos.

import { labelInfo } from './lut.js';

export class Ortho {
  constructor(root) {
    this.root = root;
    this.dims = [1, 1, 1];
    this.opacity = 0.45;
    this.crosshair = [0, 0, 0];
    this.planes = [];
    root.innerHTML = '';
    for (const name of ['sagital', 'coronal', 'axial']) {
      const fig = document.createElement('figure');
      fig.className = 'plane';
      const cv = document.createElement('canvas');
      const cap = document.createElement('figcaption');
      cap.textContent = name;
      fig.append(cv, cap);
      root.append(fig);
      cv.addEventListener('click', (e) => this._onClick(name, cv, e));
      this.planes.push({ name, cv, cap });
    }
    this._offscreen = document.createElement('canvas');
  }

  setVolume(data, dims) {
    this.data = data;
    this.dims = dims;
    this.crosshair = dims.map((d) => Math.floor(d / 2));
    const s = [];
    const step = Math.max(1, Math.floor(data.length / 100000));
    for (let i = 0; i < data.length; i += step) s.push(data[i]);
    s.sort((a, b) => a - b);
    this.lo = s[Math.floor(s.length * 0.02)];
    this.hi = s[Math.floor(s.length * 0.99)];
    if (this.hi <= this.lo) this.hi = this.lo + 1;
    this.render();
  }

  setLabels(labels) { this.labels = labels; this._colorCache = new Map(); this.render(); }
  setOpacity(o) { this.opacity = o; this.render(); }

  _color(id) {
    if (!this._colorCache) this._colorCache = new Map();
    let c = this._colorCache.get(id);
    if (!c) { c = labelInfo(id).color; this._colorCache.set(id, c); }
    return c;
  }

  _onClick(name, cv, e) {
    const r = cv.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    const [nx, ny, nz] = this.dims;
    const c = this.crosshair;
    if (name === 'sagital') { c[1] = Math.round(u * (ny - 1)); c[2] = Math.round((1 - v) * (nz - 1)); }
    if (name === 'coronal') { c[0] = Math.round(u * (nx - 1)); c[2] = Math.round((1 - v) * (nz - 1)); }
    if (name === 'axial') { c[0] = Math.round(u * (nx - 1)); c[1] = Math.round((1 - v) * (ny - 1)); }
    this.render();
    this.root.dispatchEvent(new CustomEvent('crosshair', { detail: [...c] }));
  }

  render() {
    if (!this.data) return;
    const [nx, ny, nz] = this.dims;
    const [cx, cy, cz] = this.crosshair;
    for (const p of this.planes) {
      let w, h, sample;
      if (p.name === 'sagital') {
        w = ny; h = nz;
        sample = (a, b) => cx + a * nx + b * nx * ny;
      } else if (p.name === 'coronal') {
        w = nx; h = nz;
        sample = (a, b) => a + cy * nx + b * nx * ny;
      } else {
        w = nx; h = ny;
        sample = (a, b) => a + b * nx + cz * nx * ny;
      }
      const off = this._offscreen;
      off.width = w; off.height = h;
      const ctx = off.getContext('2d');
      const img = ctx.createImageData(w, h);
      const rng = this.hi - this.lo;
      for (let b = 0; b < h; b++) {
        for (let a = 0; a < w; a++) {
          const src = sample(a, h - 1 - b);
          let g = ((this.data[src] - this.lo) / rng) * 255;
          g = g < 0 ? 0 : g > 255 ? 255 : g;
          const o = (b * w + a) * 4;
          let r = g, gg = g, bb = g;
          if (this.labels) {
            const id = this.labels[src];
            if (id) {
              const c = this._color(id);
              const k = this.opacity;
              r = g * (1 - k) + c[0] * k;
              gg = g * (1 - k) + c[1] * k;
              bb = g * (1 - k) + c[2] * k;
            }
          }
          img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = bb; img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);

      const cv = p.cv;
      const size = Math.max(160, Math.min(this.root.clientWidth / 3 - 14, 320));
      cv.width = Math.round(size); cv.height = Math.round((size * h) / w);
      const c2 = cv.getContext('2d');
      c2.imageSmoothingEnabled = true;
      c2.drawImage(off, 0, 0, cv.width, cv.height);
      c2.strokeStyle = 'rgba(120,215,225,.55)';
      c2.lineWidth = 1;
      let ux, uy;
      if (p.name === 'sagital') { ux = cy / (ny - 1); uy = 1 - cz / (nz - 1); }
      else if (p.name === 'coronal') { ux = cx / (nx - 1); uy = 1 - cz / (nz - 1); }
      else { ux = cx / (nx - 1); uy = 1 - cy / (ny - 1); }
      c2.beginPath();
      c2.moveTo(ux * cv.width, 0); c2.lineTo(ux * cv.width, cv.height);
      c2.moveTo(0, uy * cv.height); c2.lineTo(cv.width, uy * cv.height);
      c2.stroke();
    }
  }

  labelAtCrosshair() {
    if (!this.labels) return null;
    const [nx, ny] = this.dims;
    const [cx, cy, cz] = this.crosshair;
    const id = this.labels[cx + cy * nx + cz * nx * ny];
    return id ? labelInfo(id) : null;
  }
}
