// CARS agent — parametric lofted car body.
//
// The body is a loft of cross-sections along local Z (forward). Each section is a ring of 15
// control points (left half mirrored to the right):
//   0 C1 floor edge / inner well wall bottom     4 C5 widest point (character line)
//   1 C2 well ceiling inner                       5 C6 shoulder / fender peak / beltline
//   2 C3 sill (lip of the wheel arch)             6 C7 hood valley / roof edge
//   3 C4 lower side                               7 C8 top centre (hood / roof / deck)
//   8..14 mirror of 6..0 (x -> -x)
// Ring parameter s is continuous in [0,14]. Wheel arches are cut by sliding the lip up the
// "uncut" side curve so the side surface keeps its shape and the arch outline is exact.
// Ends get a round bevel then a flat cap (nose / tail fascia).
// Conforming "patches" (glass, lights, vents, stripes) are sampled on the same surface via
// side (z,y), top (z,x) or raw (z,s) projections and offset along the normal.
import * as THREE from 'three';
import { curve, clamp, lerp, smoothstep } from './util.js';

const NR = 15;
const SEG_HIGH = [1, 1, 3, 4, 6, 8, 7];

export class Body {
  constructor(def, dims, { quality = 'high' } = {}) {
    this.def = def; this.dims = dims; this.quality = quality;
    const D = def;
    this.zF = D.zF; this.zR = D.zR;
    this.bevelF = D.bevelF ?? 0.07; this.bevelR = D.bevelR ?? 0.06;
    const c = (v, dflt) => curve(v ?? dflt);
    this.f = {
      top: c(D.top), halfW: c(D.halfW), sideY: c(D.sideY), shY: c(D.shY), shX: c(D.shX, 0.9),
      upY: D.upY ? c(D.upY) : null, upDrop: c(D.upDrop, 0.02), upX: c(D.upX, 0.5),
      lowY: c(D.lowY, 0.45), lowIn: c(D.lowIn, 0.025), sillY: c(D.sillY, dims.rideHeight + 0.06),
      sillIn: c(D.sillIn, 0.05), floorY: c(D.floorY, dims.rideHeight),
    };
    const ag = D.archGap ?? 0.035;
    const tw = dims.tireWidth ?? 0.27;
    this.wheels = [
      { z: dims.wheelBase / 2, r: dims.wheelRadius, Ra: dims.wheelRadius + ag, hubY: dims.wheelRadius, wellX: dims.track / 2 - tw / 2 - 0.06 },
      { z: -dims.wheelBase / 2, r: dims.rearWheelRadius ?? dims.wheelRadius, Ra: (dims.rearWheelRadius ?? dims.wheelRadius) + ag, hubY: dims.wheelRadius, wellX: (dims.rearTrack ?? dims.track) / 2 - (dims.rearTireWidth ?? tw) / 2 - 0.06 },
    ];
    this.sharp = new Uint8Array(NR);
    for (const i of [0, 1, 2, ...(D.sharp || [])]) { this.sharp[i] = 1; this.sharp[14 - i] = 1; }
    const q = quality === 'high' ? 1 : quality === 'medium' ? 0.6 : 0.4;
    this.segCounts = [];
    const segL = (D.seg || SEG_HIGH).map((n, i) => (i < 2 ? n : Math.max(1, Math.round(n * q))));
    for (let i = 0; i < 7; i++) this.segCounts.push(segL[i]);
    for (let i = 6; i >= 0; i--) this.segCounts.push(segL[i]);
    this.stationStep = (D.stationStep ?? 0.026) / q;
    this.dents = D.dents || [];
    this.dentFn = D.dentFn || null;
    this._secCache = new Map();
  }

  // ------------------------------------------------------------------ section
  section(z) {
    const key = Math.round(z * 1e5);
    let sec = this._secCache.get(key);
    if (sec) return sec;
    if (this._secCache.size > 4000) this._secCache.clear();
    sec = this._computeSection(z);
    this._secCache.set(key, sec);
    return sec;
  }

  _computeSection(z) {
    const f = this.f;
    const hw = f.halfW(z), top = f.top(z), floor = f.floorY(z);
    const sillY = Math.max(f.sillY(z), floor), sillX = hw - f.sillIn(z);
    let sideY = f.sideY(z);
    const shY = f.shY(z), shX = hw * f.shX(z);
    const upY = f.upY ? f.upY(z) : top - f.upDrop(z);
    const upX = hw * f.upX(z);
    const lowY = sillY + (sideY - sillY) * f.lowY(z), lowX = hw - f.lowIn(z);
    let xIn = sillX, yArch = sillY, inArch = 0;
    for (let w = 0; w < this.wheels.length; w++) {
      const W = this.wheels[w], dz = z - W.z;
      if (Math.abs(dz) < W.Ra) {
        const ya = W.hubY + Math.sqrt(W.Ra * W.Ra - dz * dz);
        if (ya > sillY) { yArch = ya; xIn = Math.min(W.wellX, sillX - 0.02); inArch = w + 1; }
      }
    }
    const px = new Float64Array(NR), py = new Float64Array(NR);
    px[0] = xIn; py[0] = floor;
    px[1] = xIn; py[1] = yArch;
    px[2] = sillX; py[2] = sillY;
    px[3] = lowX; py[3] = lowY;
    px[4] = hw; py[4] = sideY;
    px[5] = shX; py[5] = shY;
    px[6] = upX; py[6] = upY;
    px[7] = 0; py[7] = top;
    for (let i = 0; i < 7; i++) { px[14 - i] = -px[i]; py[14 - i] = py[i]; }
    const sec = { z, px, py, inArch, yArch, tc: 2, floor, sx: 1, sy: 1, cy: 0,
      dox: new Float64Array(NR), doy: new Float64Array(NR), dix: new Float64Array(NR), diy: new Float64Array(NR) };
    for (let i = 2; i <= 12; i++) {
      const ax = px[i] - px[i - 1], ay = py[i] - py[i - 1];
      const bx = px[i + 1] - px[i], by = py[i + 1] - py[i];
      if (this.sharp[i]) {
        let l = Math.hypot(ax, ay) || 1; sec.dix[i] = ax / l; sec.diy[i] = ay / l;
        l = Math.hypot(bx, by) || 1; sec.dox[i] = bx / l; sec.doy[i] = by / l;
      } else {
        const cx = px[i + 1] - px[i - 1], cy2 = py[i + 1] - py[i - 1];
        const l = Math.hypot(cx, cy2) || 1;
        sec.dix[i] = sec.dox[i] = cx / l; sec.diy[i] = sec.doy[i] = cy2 / l;
      }
    }
    if (inArch) {
      // find s in [2,5] on the uncut side curve where y == yArch
      let lo = 2, hi = 5; const o = [0, 0];
      this._raw(sec, 5, o);
      if (o[1] <= yArch) sec.tc = 4.95;
      else {
        for (let k = 0; k < 28; k++) { const m = (lo + hi) / 2; this._raw(sec, m, o); if (o[1] < yArch) lo = m; else hi = m; }
        sec.tc = (lo + hi) / 2;
      }
    }
    // end bevel (round), shrink toward section centre
    let d = 0;
    const bF = this.bevelF, bR = this.bevelR;
    if (z > this.zF - bF) { const t = clamp((z - (this.zF - bF)) / bF, 0, 1); d = bF * (1 - Math.sqrt(Math.max(0, 1 - t * t))); }
    if (z < this.zR + bR) { const t = clamp(((this.zR + bR) - z) / bR, 0, 1); d = Math.max(d, bR * (1 - Math.sqrt(Math.max(0, 1 - t * t)))); }
    if (d > 0) {
      const hh = Math.max(0.05, (top - floor) / 2);
      sec.cy = (top + floor) / 2;
      sec.sx = 1 - d / Math.max(0.1, hw);
      sec.sy = 1 - d / hh;
    }
    return sec;
  }

  _raw(sec, s, out) {
    let i = Math.floor(s); if (i >= 14) i = 13; if (i < 0) i = 0;
    const t = s - i;
    const px = sec.px, py = sec.py;
    if (i < 2 || i >= 12) { out[0] = lerp(px[i], px[i + 1], t); out[1] = lerp(py[i], py[i + 1], t); return out; }
    const x0 = px[i], y0 = py[i], x1 = px[i + 1], y1 = py[i + 1];
    const h = Math.hypot(x1 - x0, y1 - y0);
    const m0x = sec.dox[i] * h, m0y = sec.doy[i] * h, m1x = sec.dix[i + 1] * h, m1y = sec.diy[i + 1] * h;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    out[0] = h00 * x0 + h10 * m0x + h01 * x1 + h11 * m1x;
    out[1] = h00 * y0 + h10 * m0y + h01 * y1 + h11 * m1y;
    return out;
  }

  /** Point on the (unbevelled-then-bevelled, undented) ring: out = [x, y]. s in [0,14], s<0 or >14 => floor */
  evalS(sec, s, out) {
    const tc = sec.tc;
    if (s <= 1) { this._raw(sec, s, out); }
    else if (s < 2) { const o = this._tmp2 || (this._tmp2 = [0, 0]); this._raw(sec, tc, o); const t = s - 1; out[0] = lerp(sec.px[1], o[0], t); out[1] = lerp(sec.py[1], o[1], t); }
    else if (s <= 5) { this._raw(sec, tc + (s - 2) * (5 - tc) / 3, out); }
    else if (s < 9) { this._raw(sec, s, out); }
    else if (s <= 12) { this._raw(sec, 14 - (tc + ((14 - s) - 2) * (5 - tc) / 3), out); }
    else if (s < 13) { const o = this._tmp2 || (this._tmp2 = [0, 0]); this._raw(sec, 14 - tc, o); const t = s - 12; out[0] = lerp(o[0], sec.px[13], t); out[1] = lerp(o[1], sec.py[13], t); }
    else { this._raw(sec, s, out); }
    out[0] *= sec.sx; out[1] = sec.cy + (out[1] - sec.cy) * sec.sy;
    return out;
  }

  /** Floor point, t in [0,1] from right (-x) to left (+x). */
  evalFloor(sec, t, out) {
    out[0] = lerp(-sec.px[0], sec.px[0], t) * sec.sx; out[1] = sec.cy + (sec.floor - sec.cy) * sec.sy; return out;
  }

  dentAt(x, y, z, s) {
    let d = 0;
    const side = (s > 1.9 && s < 6.6) || (s > 7.4 && s < 12.1);
    const topS = s > 4.4 && s < 9.6;
    const ax = Math.abs(x);
    for (const D of this.dents) {
      if (D.plane === 'top' ? !topS : !side) continue;
      const u = z - D.z, vRaw = (D.plane === 'top' ? ax : y) - D.y - (D.slope || 0) * u;
      const qx = Math.abs(u) - (D.hz - D.r), qy = Math.abs(vRaw) - (D.hy - D.r);
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - D.r;
      if (sd < 0) d += D.depth * smoothstep(0, D.soft ?? 0.03, -sd);
    }
    if (this.dentFn) d += this.dentFn(x, y, z, s);
    return d;
  }

  // ------------------------------------------------------------------ surface queries
  /** Undented point at (z,s) into Vector3. */
  pointRaw(z, s, v) { const o = this._o || (this._o = [0, 0]); this.evalS(this.section(z), s, o); return v.set(o[0], o[1], z); }

  /** Dented point + normal at (z,s). */
  surf(z, s, P, N) {
    const e = 0.0025, es = 0.01;
    const a = this._va || (this._va = new THREE.Vector3()), b = this._vb || (this._vb = new THREE.Vector3());
    const c2 = this._vc || (this._vc = new THREE.Vector3()), d2 = this._vd || (this._vd = new THREE.Vector3());
    const zz = clamp(z, this.zR + 1e-4, this.zF - 1e-4);
    this.pointRaw(Math.min(zz + e, this.zF), s, a); this.pointRaw(Math.max(zz - e, this.zR), s, b);
    this.pointRaw(zz, Math.min(s + es, 14), c2); this.pointRaw(zz, Math.max(s - es, 0), d2);
    const tu = a.sub(b), ts = c2.sub(d2);
    N.crossVectors(ts, tu);
    if (N.lengthSq() < 1e-14) N.set(0, 1, 0); else N.normalize();
    this.pointRaw(z, s, P);
    const dd = this.dentAt(P.x, P.y, P.z, s);
    if (dd) P.addScaledVector(N, -dd);
    return P;
  }

  /** s on the side (left, x>0) where y == target, searching [lo,hi] (y increasing). */
  sideToS(z, y, lo = 2, hi = 6) {
    const sec = this.section(z), o = [0, 0];
    this.evalS(sec, lo, o); if (y <= o[1]) return lo;
    this.evalS(sec, hi, o); if (y >= o[1]) return hi;
    for (let k = 0; k < 26; k++) { const m = (lo + hi) / 2; this.evalS(sec, m, o); if (o[1] < y) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  /** s on the top where x == target, searching [lo,hi] (x decreasing). */
  topToS(z, x, lo = 4, hi = 10) {
    const sec = this.section(z), o = [0, 0];
    this.evalS(sec, lo, o); if (x >= o[0]) return lo;
    this.evalS(sec, hi, o); if (x <= o[0]) return hi;
    for (let k = 0; k < 26; k++) { const m = (lo + hi) / 2; this.evalS(sec, m, o); if (o[0] > x) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  /** Convenience: dented surface point on the side at (z,y) [left side unless x<0 requested]. */
  sidePoint(z, y, P, N, right = false, range) {
    let s = this.sideToS(z, y, range?.[0], range?.[1]); if (right) s = 14 - s;
    return this.surf(z, s, P, N || (this._nTmp || (this._nTmp = new THREE.Vector3())));
  }
  topPoint(z, x, P, N, range) {
    const s = this.topToS(z, x, range?.[0], range?.[1]);
    return this.surf(z, s, P, N || (this._nTmp || (this._nTmp = new THREE.Vector3())));
  }
  topY(z, x = 0) { const v = new THREE.Vector3(); this.topPoint(z, x, v); return v.y; }

  // ------------------------------------------------------------------ main geometry
  stations() {
    const zs = [];
    const step = this.stationStep;
    const n = Math.max(12, Math.ceil((this.zF - this.zR) / step));
    for (let i = 0; i <= n; i++) zs.push(lerp(this.zR, this.zF, i / n));
    const nb = this.def.cheap ? 2 : this.quality === 'low' ? 3 : 7;
    for (let i = 1; i < nb; i++) {
      const t = 1 - Math.cos((i / nb) * Math.PI / 2);
      zs.push(this.zF - this.bevelF * t); zs.push(this.zR + this.bevelR * t);
    }
    for (const W of this.wheels) {
      for (const sg of [-1, 1]) {
        const e = W.z + sg * W.Ra;
        if (this.def.cheap) zs.push(e - sg * 0.0006, e + sg * 0.0006, e - sg * 0.03);
        else zs.push(e - sg * 0.0006, e + sg * 0.0006, e - sg * 0.012, e - sg * 0.035);
      }
    }
    for (const z of this.def.extraStations || []) zs.push(z);
    zs.sort((a, b) => a - b);
    const out = [];
    for (const z of zs) if (z >= this.zR - 1e-9 && z <= this.zF + 1e-9 && (!out.length || z - out[out.length - 1] > 0.0004)) out.push(z);
    out[0] = this.zR; out[out.length - 1] = this.zF;
    return out;
  }

  /** Builds the body shell. Returns Map(slot -> BufferGeometry). */
  build() {
    const zs = this.stations();
    const NZ = zs.length;
    // ring sample parameters
    const sList = [];
    for (let seg = 0; seg < 14; seg++) { const n = this.segCounts[seg]; for (let k = 0; k < n; k++) sList.push(seg + k / n); }
    sList.push(14);
    // bands: split at sharp points (and segment 0-2 / 12-14 always separate)
    const sharpIdx = [];
    for (let i = 2; i <= 12; i++) if (this.sharp[i]) sharpIdx.push(i);
    const bands = [[0, 2, this.def.skirtSlot || 'black']];
    for (let k = 0; k < sharpIdx.length - 1; k++) bands.push([sharpIdx[k], sharpIdx[k + 1], 'paint']);
    bands.push([12, 14, this.def.skirtSlot || 'black']);
    // stations break where arch state changes (u-crease for normals)
    const secs = zs.map((z) => this.section(z));
    const runId = new Int32Array(NZ); let rid = 0;
    for (let i = 1; i < NZ; i++) { if (!!secs[i].inArch !== !!secs[i - 1].inArch) rid++; runId[i] = rid; }

    const slots = new Map();
    const push = (slot, pos, nor, uv, idx) => {
      let s = slots.get(slot); if (!s) { s = { pos: [], nor: [], uv: [], idx: [] }; slots.set(slot, s); }
      const base = s.pos.length / 3;
      for (let i = 0; i < pos.length; i++) s.pos.push(pos[i]);
      for (let i = 0; i < nor.length; i++) s.nor.push(nor[i]);
      for (let i = 0; i < uv.length; i++) s.uv.push(uv[i]);
      for (let i = 0; i < idx.length; i++) s.idx.push(idx[i] + base);
    };
    const o = [0, 0];
    const paint2 = this.def.paint2 || null;
    const slotFn = this.def.slotFn || null;

    const makeGrid = (cols, evalFn, slot, isFloor) => {
      const NC = cols.length;
      const P = new Float64Array(NZ * NC * 3);
      for (let i = 0; i < NZ; i++) for (let j = 0; j < NC; j++) {
        evalFn(secs[i], cols[j], o);
        const k = (i * NC + j) * 3; P[k] = o[0]; P[k + 1] = o[1]; P[k + 2] = zs[i];
      }
      const normals = (Pa) => {
        const Nn = new Float64Array(NZ * NC * 3);
        const g = (i, j, c) => Pa[(i * NC + j) * 3 + c];
        for (let i = 0; i < NZ; i++) {
          let ia = i - 1, ib = i + 1;
          if (ia < 0 || runId[ia] !== runId[i]) ia = i;
          if (ib >= NZ || runId[ib] !== runId[i]) ib = i;
          for (let j = 0; j < NC; j++) {
            let ja = Math.max(0, j - 1), jb = Math.min(NC - 1, j + 1);
            let sx = g(i, jb, 0) - g(i, ja, 0), sy = g(i, jb, 1) - g(i, ja, 1), sz = g(i, jb, 2) - g(i, ja, 2);
            let tries = 0;
            while (sx * sx + sy * sy + sz * sz < 1e-12 && tries++ < 4) {
              ja = Math.max(0, ja - 1); jb = Math.min(NC - 1, jb + 1);
              sx = g(i, jb, 0) - g(i, ja, 0); sy = g(i, jb, 1) - g(i, ja, 1); sz = g(i, jb, 2) - g(i, ja, 2);
            }
            let ux = g(ib, j, 0) - g(ia, j, 0), uy = g(ib, j, 1) - g(ia, j, 1), uz = g(ib, j, 2) - g(ia, j, 2);
            if (ux * ux + uy * uy + uz * uz < 1e-12) { ux = 0; uy = 0; uz = 1; }
            let nx = sy * uz - sz * uy, ny = sz * ux - sx * uz, nz = sx * uy - sy * ux;
            const l = Math.hypot(nx, ny, nz);
            if (l < 1e-12) { nx = 0; ny = isFloor ? -1 : 1; nz = 0; } else { nx /= l; ny /= l; nz /= l; }
            const k = (i * NC + j) * 3; Nn[k] = nx; Nn[k + 1] = ny; Nn[k + 2] = nz;
          }
        }
        return Nn;
      };
      let Nn = normals(P);
      if (!isFloor && (this.dents.length || this.dentFn)) {
        let any = false;
        for (let i = 0; i < NZ; i++) for (let j = 0; j < NC; j++) {
          const k = (i * NC + j) * 3;
          const dd = this.dentAt(P[k], P[k + 1], P[k + 2], cols[j]);
          if (dd) { any = true; P[k] -= Nn[k] * dd; P[k + 1] -= Nn[k + 1] * dd; P[k + 2] -= Nn[k + 2] * dd; }
        }
        if (any) Nn = normals(P);
      }
      // emit triangles per slot
      const perSlot = new Map();
      const tri = (sl, a, b, c) => { let arr = perSlot.get(sl); if (!arr) { arr = []; perSlot.set(sl, arr); } arr.push(a, b, c); };
      for (let i = 0; i < NZ - 1; i++) for (let j = 0; j < NC - 1; j++) {
        const a = i * NC + j, b = a + 1, c = a + NC, d = c + 1;
        let sl = slot;
        if (slot === 'paint' && (paint2 || slotFn)) {
          const k1 = a * 3, k2 = d * 3;
          const cx = (P[k1] + P[k2]) / 2, cy = (P[k1 + 1] + P[k2 + 1]) / 2, cz = (P[k1 + 2] + P[k2 + 2]) / 2;
          if (slotFn) sl = slotFn(cx, cy, cz, (cols[j] + cols[j + 1]) / 2) || slot;
          if (sl === 'paint' && paint2 && paint2(cx, cy, cz)) sl = 'paint2';
        }
        tri(sl, a, b, c); tri(sl, b, d, c);
      }
      const pos = Array.from(P), nor = Array.from(Nn), uv = [];
      for (let i = 0; i < NZ; i++) for (let j = 0; j < NC; j++) { const k = (i * NC + j) * 3; uv.push(zs[i] * 0.5, (P[k + 1] + Math.abs(P[k])) * 0.5); }
      for (const [sl, idx] of perSlot) push(sl, pos, nor, uv, idx);
    };

    for (const [s0, s1, slot] of bands) {
      const cols = sList.filter((s) => s >= s0 - 1e-9 && s <= s1 + 1e-9);
      makeGrid(cols, (sec, s, out) => this.evalS(sec, s, out), slot, false);
    }
    // floor (right -> left)
    makeGrid([0, 0.5, 1], (sec, t, out) => this.evalFloor(sec, t, out), 'under', true);

    // caps
    const ring = (sec) => {
      const pts = [];
      for (const s of sList) { this.evalS(sec, s, o); pts.push(new THREE.Vector2(o[0], o[1])); }
      this.evalFloor(sec, 0.5, o); pts.push(new THREE.Vector2(o[0], o[1]));
      const clean = [];
      for (const p of pts) if (!clean.length || clean[clean.length - 1].distanceToSquared(p) > 1e-8) clean.push(p);
      if (clean.length > 2 && clean[0].distanceToSquared(clean[clean.length - 1]) < 1e-8) clean.pop();
      return clean;
    };
    this.capOutline = {};
    for (const [z, nz, name] of [[this.zF, 1, 'front'], [this.zR, -1, 'rear']]) {
      const pts = ring(this.section(z));
      this.capOutline[name] = pts;
      let tris;
      try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch (e) { tris = []; }
      const pos = [], nor = [], uv = [], idx = [];
      for (const p of pts) { pos.push(p.x, p.y, z); nor.push(0, 0, nz); uv.push(p.x, p.y); }
      for (const t of tris) {
        const [a, b, c] = t;
        const cr = (pts[b].x - pts[a].x) * (pts[c].y - pts[a].y) - (pts[b].y - pts[a].y) * (pts[c].x - pts[a].x);
        if ((cr > 0) === (nz > 0)) idx.push(a, b, c); else idx.push(a, c, b);
      }
      push(name === 'front' ? (this.def.capFrontSlot || 'paint') : (this.def.capRearSlot || 'paint'), pos, nor, uv, idx);
    }

    const out = new Map();
    for (const [slot, s] of slots) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(s.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(s.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(s.uv, 2));
      g.setIndex(s.idx);
      out.set(slot, compact(g));
    }
    return out;
  }

  // ------------------------------------------------------------------ end faces (front / rear projection)
  ringPoly(sec) {
    if (sec.poly) return sec.poly;
    const o = [0, 0], poly = [];
    for (let s = 0; s <= 14.0001; s += 0.25) { this.evalS(sec, s, o); poly.push(o[0], o[1]); }
    this.evalFloor(sec, 0.5, o); poly.push(o[0], o[1]);
    sec.poly = poly; return poly;
  }
  inside(sec, x, y) {
    const p = this.ringPoly(sec), n = p.length / 2;
    let c = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi) c = !c;
    }
    return c;
  }
  /** z on the front/rear face at (x,y) (ray along z). Returns null if (x,y) misses within depth. */
  endZ(x, y, end, depth = 0.7) {
    const zE = end === 'front' ? this.zF : this.zR, dir = end === 'front' ? -1 : 1;
    if (this.inside(this.section(zE), x, y)) return zE;
    if (!this.inside(this.section(zE + dir * depth), x, y)) return null;
    let lo = 0, hi = depth;
    for (let k = 0; k < 22; k++) { const m = (lo + hi) / 2; if (this.inside(this.section(zE + dir * m), x, y)) hi = m; else lo = m; }
    return zE + dir * hi;
  }
  endPoint(x, y, end, P, N, depth) {
    const z = this.endZ(x, y, end, depth); if (z === null) return null;
    const e = 0.006;
    const zx1 = this.endZ(x + e, y, end, depth) ?? z, zx0 = this.endZ(x - e, y, end, depth) ?? z;
    const zy1 = this.endZ(x, y + e, end, depth) ?? z, zy0 = this.endZ(x, y - e, end, depth) ?? z;
    const gx = (zx1 - zx0) / (2 * e), gy = (zy1 - zy0) / (2 * e);
    const sg = end === 'front' ? 1 : -1;
    N.set(-gx * sg, -gy * sg, sg).normalize();
    P.set(x, y, z);
    return P;
  }

  // ------------------------------------------------------------------ patches
  /**
   * Conforming patch. spec:
   *  proj: 'side' (z,y) | 'top' (z,x) | 's' (z,s)
   *  z: [z0, z1]; a0(z), a1(z): lower/upper bounds of the 2nd coordinate (fn | number | keys)
   *  nz, na: grid resolution; off: offset along normal; mirror: also emit x-mirrored copy (side/s)
   *  range: s search range for projections; uv: 'box' -> (0..1, 0..1) over the patch
   */
  patch(spec) {
    const z0 = Array.isArray(spec.a) ? 0 : spec.z[0], z1 = Array.isArray(spec.a) ? 0 : spec.z[1];
    const A0 = curve(spec.a0 ?? 0), A1 = curve(spec.a1 ?? 0);
    const q = this.quality === 'high' ? 1 : this.quality === 'medium' ? 0.6 : 0.4;
    const nz = Math.max(1, Math.round((spec.nz ?? Math.max(4, Math.abs(z1 - z0) / 0.03)) * q));
    const na = Math.max(1, Math.round((spec.na ?? 6) * (q < 1 ? 0.7 : 1)));
    const off = spec.off ?? 0.003;
    const proj = spec.proj || 'side';
    const mirror = spec.mirror ?? (proj !== 'top');
    if ((proj === 'front' || proj === 'rear') && spec.nz === undefined) spec = { ...spec, nz: Math.max(3, Math.abs(z1 - z0) / 0.03) };
    const P = new THREE.Vector3(), N = new THREE.Vector3();
    const zMap = spec.zMap ? curve(spec.zMap) : null;
    // a-major mode: spec.a = [a0, a1] (numbers), spec.z = [fnZ0(a), fnZ1(a)] (rows over a, columns over z)
    const aMajor = Array.isArray(spec.a);
    const Z0 = aMajor ? curve(spec.z[0]) : null, Z1 = aMajor ? curve(spec.z[1]) : null;
    const build = (right) => {
      const pos = [], nor = [], uv = [], idx = [];
      for (let i = 0; i <= nz; i++) {
        const t = i / nz;
        let z = zMap ? zMap(t) : lerp(z0, z1, t);
        const lo = aMajor ? 0 : A0(z), hi = aMajor ? 0 : A1(z);
        for (let j = 0; j <= na; j++) {
          const b = j / na;
          let a = lerp(lo, hi, b);
          if (aMajor) { a = lerp(spec.a[0], spec.a[1], t); z = lerp(Z0(a), Z1(a), b); }
          let s;
          if (proj === 'front' || proj === 'rear') {
            // here "z" is x across the face and a is y
            const xx = right ? -z : z;
            if (!this.endPoint(xx, a, proj, P, N, spec.depth)) { P.set(xx, a, proj === 'front' ? this.zF : this.zR); N.set(0, 0, proj === 'front' ? 1 : -1); }
          } else {
            if (proj === 'side') s = this.sideToS(z, a, spec.range?.[0] ?? 2, spec.range?.[1] ?? 6);
            else if (proj === 'top') s = this.topToS(z, right ? -a : a, spec.range?.[0] ?? 4, spec.range?.[1] ?? 10);
            else s = a;
            if (right && proj !== 'top') s = 14 - s;
            this.surf(z, s, P, N);
          }
          P.addScaledVector(N, off);
          pos.push(P.x, P.y, P.z); nor.push(N.x, N.y, N.z);
          uv.push(spec.uvScale ? z * spec.uvScale : t, spec.uvScale ? a * spec.uvScale : (right ? 1 - b : b));
        }
      }
      const W = na + 1;
      for (let i = 0; i < nz; i++) for (let j = 0; j < na; j++) {
        const a = i * W + j, b = a + 1, c = a + W, d = c + 1;
        // orientation: s increasing x z increasing gives outward normal (left side). For the right
        // side s is reversed, for top x decreasing along s => a increasing means s decreasing.
        let flip = (proj === 'top') ? !right : (proj === 'front') ? !right : (proj === 'rear') ? right : right;
        if (aMajor) flip = !flip;
        if (!flip) { idx.push(a, b, c, b, d, c); } else { idx.push(a, c, b, b, c, d); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      if (spec.smoothNormals !== false) g.computeVertexNormals();
      return g;
    };
    const gs = [build(false)];
    if (mirror) gs.push(build(true));
    if (gs.length === 1) return gs[0];
    return mergeSimple(gs);
  }
}

/** Remove unused vertices is unnecessary here; just return. */
function compact(g) { return g; }

export function mergeSimple(gs) {
  let nv = 0, ni = 0;
  for (const g of gs) { nv += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const g of gs) {
    pos.set(g.attributes.position.array, ov * 3); nor.set(g.attributes.normal.array, ov * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, ov * 2);
    const ia = g.index.array; for (let i = 0; i < ia.length; i++) idx[oi + i] = ia[i] + ov;
    ov += g.attributes.position.count; oi += ia.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
