// CARS agent — per-car designs: body loft tables + detail dressing.
// All designs are original procedural geometry evoking the silhouettes of real cars (fan-made
// likeness, no logos, no badges, no copyrighted assets).
//
// Body table cheat-sheet (all [[z, value], ...] in metres, z forward):
//   top     centreline top silhouette (hood / windshield / roof / deck)
//   halfW   plan-view half width at the widest point;  sideY  height of that widest point
//   shY/shX shoulder (fender peak / beltline) height and x as fraction of halfW
//   upDrop/upX  hood-valley / roof-edge point: (top - upDrop) and x fraction of halfW
//   sillY/sillIn bottom of side skin + inset; floorY underbody (diffuser rises at the tail)
// Ring parameter s: 2 sill, 3 low side, 4 widest, 5 shoulder, 6 roof edge, 7 centre top (8..12 mirror)
import * as THREE from 'three';
import { roundRect, ellipse, plateZY, plateXZ, plateXY, sweep, roundSection, revolve, wingGeometry } from './parts.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------- shared detail helpers
function glassCanopy(c, { z0, z1, edge = 6.07, taper0 = 0, taper1 = 0.4, slot = 'glass' }) {
  const e = edge;
  c.patch(slot, { proj: 's', z: [z1, z0], a0: [[z1, e + taper1], [z1 + 0.25, e], [z0, e + taper0]], a1: [[z1, 14 - e - taper1], [z1 + 0.25, 14 - e], [z0, 14 - e - taper0]], na: 18, nz: Math.ceil((z0 - z1) / 0.04), off: 0.004, mirror: false });
}
function sideWindow(c, { z0, z1, lo, hi, frame = 0.012, slot = 'glass', frameSlot = 'gloss', nz }) {
  c.patch(frameSlot, { proj: 's', z: [z1 - frame, z0 + frame], a0: lo.map(([z, s]) => [z, s - 0.05]), a1: hi.map(([z, s]) => [z, s + 0.04]), na: 6, nz: nz ?? Math.ceil((z0 - z1) / 0.04), off: 0.002 });
  c.patch(slot, { proj: 's', z: [z1, z0], a0: lo, a1: hi, na: 8, nz: nz ?? Math.ceil((z0 - z1) / 0.04), off: 0.004 });
}
/** Thin vertical-ish panel line on the side from y0 to y1 at z(y) (a-major). */
function panelLine(c, zAt, y0, y1, w = 0.005, slot = 'black') {
  const zf = (y) => (typeof zAt === 'function' ? zAt(y) : zAt);
  const pts0 = [], pts1 = [];
  for (let i = 0; i <= 6; i++) { const y = y0 + (y1 - y0) * i / 6; pts0.push([y, zf(y) - w / 2]); pts1.push([y, zf(y) + w / 2]); }
  c.patch(slot, { proj: 'side', a: [y0, y1], z: [pts0, pts1], nz: 6, na: 1, off: 0.0015, range: [2, 5.2] });
}
/** Front splitter blade following the plan-view outline of the nose (offset outward by ext). */
function splitter(c, { y, ext = 0.04, thick = 0.014, depth = 0.4, slot = 'carbon' }) {
  const B = c.B, zF = B.zF, zb = zF - depth, N = 10;
  const hw = (z) => B.f.halfW(z) - B.f.sillIn(z) + 0.01;
  const left = [];
  for (let i = 0; i <= N; i++) { const z = zb + (zF - zb) * Math.sin((i / N) * Math.PI / 2); left.push([hw(z) + ext * (i / N), z]); }
  const pts = [...left, [hw(zF) * 0.92, zF + ext], [-hw(zF) * 0.92, zF + ext], ...left.reverse().map(([x, z]) => [-x, z])];
  c.add(slot, plateXZ(pts, thick, y - thick, 0.002));
}
function diffuserFins(c, xs, { zEnd, zStart, yLow, yHigh, thick = 0.008, slot = 'black' }) {
  for (const x of xs) c.add(slot, plateZY([[zStart, yLow], [zEnd + 0.01, yLow], [zEnd + 0.01, yHigh], [zStart + 0.1, yLow + 0.01]], thick, x, 0));
}

// ======================================================================================
// Tesla Roadster (2nd gen) — SpaceX package
// ======================================================================================
const roadster = {
  accent: 0xc8102e,
  headColor: 0xf4f8ff,
  wheel: { type: 'turbine', spokes: 10, twist: 0.32, rimColor: 0x2e3135, rimMetal: 0.85, rimRough: 0.32, caliper: 0xc8102e, dish: 0.04, spokeW: 0.032, sidewall: 0.08 },
  body: {
    zF: 2.10, zR: -2.19, bevelF: 0.05, bevelR: 0.12, noseBulge: 0.08, noseBulgeLen: 0.8, tailBulge: 0.03,
    top: [[2.175, 0.40], [2.13, 0.49], [2.03, 0.565], [1.80, 0.645], [1.45, 0.705], [1.15, 0.735], [0.92, 0.765], [0.62, 0.92], [0.32, 1.065], [0.05, 1.145], [-0.30, 1.15], [-0.65, 1.10], [-1.0, 1.02], [-1.35, 0.95], [-1.70, 0.895], [-2.0, 0.875], [-2.12, 0.878], [-2.19, 0.84]],
    halfW: [[2.175, 0.74], [2.11, 0.85], [1.98, 0.925], [1.70, 0.97], [1.35, 0.985], [1.0, 0.975], [0.65, 0.945], [0.2, 0.935], [-0.35, 0.965], [-0.85, 0.995], [-1.30, 1.0], [-1.75, 0.99], [-2.0, 0.95], [-2.19, 0.84]],
    sideY: [[2.175, 0.30], [1.95, 0.44], [1.4, 0.50], [0.6, 0.52], [-0.4, 0.56], [-1.3, 0.60], [-2.0, 0.60], [-2.225, 0.56]],
    shY: [[2.175, 0.385], [2.03, 0.56], [1.75, 0.70], [1.35, 0.785], [1.0, 0.79], [0.7, 0.785], [0.1, 0.795], [-0.55, 0.83], [-1.1, 0.88], [-1.6, 0.875], [-2.05, 0.865], [-2.225, 0.82]],
    shX: [[2.1, 0.80], [1.6, 0.86], [0.8, 0.885], [-0.5, 0.86], [-1.4, 0.84], [-2.1, 0.8]],
    upDrop: [[2.1, 0.008], [1.0, 0.01], [0.75, 0.03], [0.5, 0.055], [-0.4, 0.06], [-0.95, 0.04], [-1.4, 0.015]],
    upX: [[2.1, 0.45], [1.2, 0.48], [0.9, 0.62], [0.5, 0.6], [0.0, 0.57], [-0.6, 0.55], [-1.1, 0.55], [-1.6, 0.5], [-2.1, 0.45]],
    lowY: 0.42, lowIn: [[2.0, 0.04], [1.2, 0.03], [0.2, 0.05], [-1.3, 0.025], [-2.1, 0.035]],
    sillY: [[2.175, 0.20], [1.9, 0.18], [0.5, 0.175], [-1.9, 0.20], [-2.225, 0.29]],
    sillIn: [[2.0, 0.05], [1.0, 0.04], [0.3, 0.065], [-1.0, 0.04], [-2.1, 0.05]],
    floorY: [[2.175, 0.17], [1.85, 0.12], [-1.45, 0.11], [-1.95, 0.19], [-2.225, 0.27]],
    dents: [
      // sculpted side scoop behind the front wheel, rising toward the rear haunch
      { plane: 'side', z: 0.35, y: 0.42, hz: 0.55, hy: 0.10, r: 0.09, depth: 0.035, soft: 0.12, slope: 0.12 },
    ],
  },
  details(c) {
    const B = c.B;
    // glass canopy (windshield + removable glass roof + rear glass) and side glass
    glassCanopy(c, { z0: 0.90, z1: -1.3, edge: 6.07, taper1: 0.5 });
    sideWindow(c, {
      z0: 0.86, z1: -0.86,
      lo: [[0.86, 5.55], [0.74, 5.12], [0.3, 5.07], [-0.5, 5.08], [-0.78, 5.3], [-0.86, 5.6]],
      hi: [[0.86, 5.62], [0.74, 5.93], [0.3, 5.94], [-0.5, 5.93], [-0.78, 5.8], [-0.86, 5.62]],
    });
    // headlights: slim almond units on the front corners + LED brow
    c.patch('lensInner', { proj: 's', z: [1.83, 2.135], a0: [[1.83, 5.3], [1.98, 4.82], [2.135, 4.5]], a1: [[1.83, 5.42], [1.98, 5.45], [2.135, 5.1]], na: 6, nz: 10, off: 0.003 });
    c.patch('head', { proj: 's', z: [1.87, 2.12], a0: [[1.87, 5.15], [1.99, 4.9], [2.12, 4.62]], a1: [[1.87, 5.3], [1.99, 5.3], [2.12, 4.95]], na: 4, nz: 10, off: 0.0045 });
    c.patch('drl', { proj: 's', z: [1.84, 2.13], a0: [[1.84, 5.34], [1.98, 5.36], [2.13, 5.02]], a1: [[1.84, 5.38], [1.98, 5.42], [2.13, 5.07]], na: 1, nz: 12, off: 0.005 });
    // front fascia: wide lower intake + corner intakes, carbon splitter
    shape(c, 'meshHex', 'front', [[-0.6, 0.19], [0.6, 0.19], [0.7, 0.24], [0.66, 0.31], [-0.66, 0.31], [-0.7, 0.24]], { off: 0.004, mirror: false, depth: 0.5, n: 20 });
    shape(c, 'gloss', 'front', quad([0.72, 0.2], [0.82, 0.24], [0.8, 0.36], [0.74, 0.33]), { off: 0.004, depth: 0.5 });
    splitter(c, { z0: 2.12, y: 0.17, w: 0.78, ext: 0.03, depth: 0.4 });
    // mirrors
    const mb = B.sidePoint(0.66, 0.80, new THREE.Vector3());
    c.mirrors(mb, { out: 0.12, up: 0.07, w: 0.16, h: 0.075, depth: 0.1 });
    // door shut lines
    panelLine(c, (y) => 0.80 - (y - 0.2) * 0.12, 0.22, 0.77);
    panelLine(c, (y) => -0.72 + (y - 0.2) * 0.25, 0.25, 0.84);
    // tail: slim light bars wrapping the rear corners
    const zR = B.zR;
    c.patch('tailDark', { proj: 'rear', z: [0.12, 0.86], a0: [[0.12, 0.655], [0.86, 0.655]], a1: [[0.12, 0.69], [0.7, 0.705], [0.86, 0.69]], na: 3, nz: 22, off: 0.002 });
    c.patch('tail', { proj: 'rear', z: [0.16, 0.85], a0: [[0.16, 0.668], [0.85, 0.665]], a1: [[0.16, 0.682], [0.7, 0.69], [0.85, 0.68]], na: 2, nz: 22, off: 0.004 });
    c.patch('tailDark', { proj: 'rear', z: [-0.12, 0.12], a0: 0.668, a1: 0.678, na: 1, nz: 6, off: 0.003, mirror: false });
    // license plate recess + flap (opens with boost to reveal the cold-gas thrusters)
    c.plateRear('black', roundRect(0, 0.47, 0.38, 0.17, 0.02), 0.008, 0.001);
    const flapG = plateXY(roundRect(0, 0.47, 0.34, 0.15, 0.012), 0.012, zR - 0.012);
    c.extra('flap', 'paint', flapG, [0, 0.545, zR - 0.012]);
    for (const [x, y] of [[0.075, 0.43], [-0.075, 0.43], [0.075, 0.505], [-0.075, 0.505]]) c.nozzle(x, y, zR + 0.002, 'back', 'boost', 0.03, false);
    // lower rear: black diffuser surround + fins
    c.plateRear('black', roundRect(0, 0.335, 1.5, 0.07, 0.03), 0.01, 0.001);
    diffuserFins(c, [-0.55, -0.3, 0.3, 0.55], { zEnd: zR, zStart: -1.6, yLow: 0.112, yHigh: 0.265 });
    c.plateRear('redGlow', roundRect(0, 0.335, 0.08, 0.025, 0.008), 0.006, 0.006); // fog/rain light
    // side cold-gas nozzles in the rear haunches + hover nozzles in the floor
    c.nozzle(0.985, 0.55, -1.86, 'left', 'side', 0.022, true);
    for (const z of [1.85, -1.85]) c.nozzle(0.42, z > 0 ? 0.125 : 0.155, z, 'down', 'hover', 0.04, true);
    // reverse lights (small, in diffuser surround)
    for (const sx of [1, -1]) c.plateRear('reverse', roundRect(sx * 0.62, 0.335, 0.1, 0.022, 0.01), 0.006, 0.006);
  },
};


// ---------------------------------------------------------------- more helpers
/** Convex outline -> lower/upper boundary keys over the first coordinate. */
function bounds(pts, n = 14) {
  let a0 = Infinity, a1 = -Infinity;
  for (const p of pts) { a0 = Math.min(a0, p[0]); a1 = Math.max(a1, p[0]); }
  const lo = [], hi = [];
  for (let i = 0; i <= n; i++) {
    const u = a0 + (a1 - a0) * (0.002 + 0.996 * i / n);
    let mn = Infinity, mx = -Infinity;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], q = pts[(k + 1) % pts.length];
      if ((p[0] - u) * (q[0] - u) <= 0 && p[0] !== q[0]) {
        const t = (u - p[0]) / (q[0] - p[0]); const v = p[1] + (q[1] - p[1]) * t;
        mn = Math.min(mn, v); mx = Math.max(mx, v);
      }
    }
    if (mn === Infinity) continue;
    lo.push([u, mn]); hi.push([u, mx]);
  }
  return { a0: a0 + (a1 - a0) * 0.002, a1: a1 - (a1 - a0) * 0.002, lo, hi };
}
/** Shape patch: proj 'front'|'rear' (x,y) | 'side' (z,y) | 'top' (z,x). */
function shape(c, slot, proj, pts, opt = {}) {
  const b = bounds(pts, opt.n ?? 14);
  return c.patch(slot, { proj, z: [b.a0, b.a1], a0: b.lo, a1: b.hi, nz: opt.nz ?? (opt.n ?? 14), na: opt.na ?? 4, off: opt.off ?? 0.004, mirror: opt.mirror ?? true, range: opt.range, depth: opt.depth, uvScale: opt.uvScale });
}
function ell(cx, cy, rx, ry, n = 20, rot = 0) {
  const p = []; for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, x = rx * Math.cos(a), y = ry * Math.sin(a); p.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]); } return p;
}
/** Quad from 4 corners [[a,b]..] — convenience alias. */
const quad = (...p) => p;
/** Ribbon following a side-view path [[z,y],...] projected onto the body side (both sides). */
function sideStrip(c, slot, path, w = 0.02, off = 0.004, range = [2, 6]) {
  const B = c.B;
  const P = new THREE.Vector3(), N = new THREE.Vector3(), Pn = new THREE.Vector3(), Nn = new THREE.Vector3();
  const pts = [];
  // resample path with Catmull-Rom
  const cr = new THREE.CatmullRomCurve3(path.map(([z, y]) => new THREE.Vector3(0, y, z)));
  const M = Math.max(8, Math.round(cr.getLength() / 0.02));
  for (let i = 0; i <= M; i++) { const q = cr.getPointAt(i / M); pts.push([q.z, q.y]); }
  const pos = [], idx = [];
  for (let i = 0; i < pts.length; i++) {
    const [z, y] = pts[i];
    B.sidePoint(z, y, P, N, false, range);
    const j = Math.min(pts.length - 1, i + 1), k = Math.max(0, i - 1);
    B.sidePoint(pts[j][0], pts[j][1], Pn, Nn, false, range);
    const Pk = new THREE.Vector3(); B.sidePoint(pts[k][0], pts[k][1], Pk, Nn, false, range);
    const T = Pn.clone().sub(Pk).normalize();
    const Bn = new THREE.Vector3().crossVectors(N, T).normalize();
    const base = P.clone().addScaledVector(N, off);
    pos.push(...base.clone().addScaledVector(Bn, -w / 2).toArray(), ...base.clone().addScaledVector(Bn, w / 2).toArray());
  }
  for (let i = 0; i < pts.length - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  // ensure outward (+x on the left side)
  const n = g.attributes.normal; let sx = 0; for (let i = 0; i < n.count; i++) sx += n.getX(i);
  if (sx < 0) { const ia = g.index.array; for (let i = 0; i < ia.length; i += 3) { const t = ia[i + 1]; ia[i + 1] = ia[i + 2]; ia[i + 2] = t; } g.computeVertexNormals(); }
  c.addBoth(slot, g);
}
/** Louvre slits on top of the front fenders (top projection, mirrored). */
function louvres(c, { z0, z1, n, x0, x1, len = 0.03, slot = 'black', skew = 0 }) {
  for (let i = 0; i < n; i++) {
    const z = z0 + (z1 - z0) * (i / Math.max(1, n - 1));
    c.patch(slot, { proj: 'top', z: [z - len / 2, z + len / 2], a0: x0 + skew * i, a1: x1 + skew * i, nz: 1, na: 4, off: 0.003, mirror: true });
  }
}
/** Center fin along the top (z0 -> z1), height profile h(t). */
function topFin(c, slot, z0, z1, h0, h1, thick = 0.012) {
  const B = c.B; const pts = [], N = 12;
  for (let i = 0; i <= N; i++) { const z = z0 + (z1 - z0) * i / N; pts.push([z, B.topY(z, 0) - 0.02]); }
  for (let i = N; i >= 0; i--) { const t = i / N, z = z0 + (z1 - z0) * t; pts.push([z, B.topY(z, 0) + h0 + (h1 - h0) * t]); }
  c.add(slot, plateZY(pts, thick, 0, 0.003));
}
/** Rear wing: main plane + optional flap + endplates; returns nothing. */
function rearWing(c, { span, chord, y, z, aoa = 6, thick = 0.13, flap = null, endplate = null, slot = 'carbon', active = false }) {
  const g = wingGeometry(span, chord, thick, aoa, -0.05); g.translate(0, y, z);
  if (active) c.extra('wing', slot, g, [0, y, z]); else c.add(slot, g);
  if (flap) c.wing(span - 0.02, flap.chord, { y: flap.y, z: flap.z, aoa: flap.aoa ?? 20, thick: 0.1, slot });
  if (endplate) {
    const e = endplate;
    for (const sx of [1, -1]) c.add(slot, plateZY(e.pts, e.t ?? 0.012, sx * (span / 2 + 0.006), 0.002));
  }
}
function swanNeck(c, x, pts, slot = 'carbon', w = 0.075, t = 0.022) {
  const path = pts.map(([z, y]) => V(x, y, z));
  const g = sweep(path, roundSection(t, w, 10), { upRef: V(1, 0, 0) });
  c.add(slot, g);
}

// ======================================================================================
// Porsche 911 GT3 RS (992) — fastback, round lamps, swan-neck wing, fender louvres
// ======================================================================================
const gt3rs = {
  accent: 0xf2c200,
  wheel: { type: 'split', spokes: 5, split: 0.13, rimColor: 0x1d1e20, rimMetal: 0.7, rimRough: 0.35, caliper: 0xf2c200, centerLock: true, dish: 0.05, spokeW: 0.04, sidewall: 0.075 },
  body: {
    zF: 2.15, zR: -2.36, bevelF: 0.06, bevelR: 0.08, noseBulge: 0.05, tailBulge: 0.02,
    top: [[2.15, 0.50], [2.10, 0.575], [1.95, 0.625], [1.6, 0.665], [1.1, 0.70], [0.66, 0.735], [0.36, 0.93], [0.10, 1.20], [-0.15, 1.28], [-0.5, 1.285], [-0.8, 1.245], [-1.2, 1.12], [-1.6, 0.99], [-1.95, 0.915], [-2.2, 0.88], [-2.36, 0.84]],
    halfW: [[2.15, 0.70], [2.05, 0.82], [1.8, 0.90], [1.4, 0.92], [1.0, 0.915], [0.5, 0.90], [0.0, 0.905], [-0.6, 0.935], [-1.1, 0.95], [-1.5, 0.95], [-1.9, 0.94], [-2.2, 0.9], [-2.36, 0.82]],
    sideY: [[2.15, 0.38], [1.8, 0.47], [1.2, 0.51], [0.3, 0.49], [-0.7, 0.55], [-1.3, 0.62], [-2.0, 0.64], [-2.36, 0.6]],
    shY: [[2.15, 0.53], [2.02, 0.665], [1.78, 0.755], [1.23, 0.80], [0.95, 0.80], [0.66, 0.84], [0.0, 0.88], [-0.6, 0.92], [-1.1, 0.945], [-1.6, 0.935], [-2.0, 0.915], [-2.36, 0.855]],
    shX: [[2.1, 0.74], [1.6, 0.80], [0.9, 0.84], [0.5, 0.89], [-0.6, 0.875], [-1.3, 0.84], [-2.2, 0.8]],
    upDrop: [[2.0, -0.005], [1.0, -0.005], [0.7, 0.02], [0.4, 0.05], [-0.6, 0.05], [-1.2, 0.03], [-1.8, 0.01]],
    upX: [[2.1, 0.5], [1.0, 0.56], [0.7, 0.66], [0.3, 0.62], [-0.5, 0.6], [-1.2, 0.56], [-1.9, 0.5], [-2.3, 0.45]],
    lowY: 0.42, lowIn: 0.03,
    sillY: [[2.15, 0.21], [1.9, 0.19], [0, 0.18], [-1.9, 0.22], [-2.36, 0.30]],
    sillIn: [[2.0, 0.05], [1.0, 0.04], [0.3, 0.055], [-1.0, 0.035], [-2.2, 0.05]],
    floorY: [[2.15, 0.16], [1.8, 0.10], [-1.5, 0.10], [-2.0, 0.17], [-2.36, 0.26]],
    dents: [{ plane: 'side', z: -0.86, y: 0.64, hz: 0.13, hy: 0.06, r: 0.05, depth: 0.03, soft: 0.06, slope: 0.15 }],
  },
  details(c) {
    const B = c.B;
    // glass: windshield, side windows (911 D-shape), fastback rear window
    c.patch('glass', { proj: 's', z: [0.12, 0.68], a0: [[0.12, 6.1], [0.68, 6.06]], a1: [[0.12, 7.9], [0.68, 7.94]], na: 16, nz: 10, off: 0.004, mirror: false });
    c.patch('glass', { proj: 's', z: [-1.42, -0.66], a0: [[-1.42, 6.45], [-1.2, 6.18], [-0.66, 6.12]], a1: [[-1.42, 7.55], [-1.2, 7.82], [-0.66, 7.88]], na: 12, nz: 10, off: 0.004, mirror: false });
    sideWindow(c, { z0: 0.64, z1: -1.0,
      lo: [[0.64, 5.55], [0.52, 5.1], [-0.4, 5.08], [-0.85, 5.22], [-1.0, 5.6]],
      hi: [[0.64, 5.6], [0.5, 5.93], [-0.3, 5.94], [-0.7, 5.9], [-1.0, 5.62]] });
    panelLine(c, (y) => -0.06 + 0.02 * (y - 0.5), 0.25, 0.86, 0.005, 'black'); // B-pillar / window divider line
    panelLine(c, (y) => 0.66 - 0.18 * (y - 0.25), 0.24, 0.82);
    // round headlights on the fender fronts + 4-point LED DRL
    for (const [slot, r, off] of [['lensInner', 0.105, 0.003], ['head', 0.082, 0.005]]) shape(c, slot, 'front', ell(0.62, 0.618, r, r * 0.92, 20), { off, depth: 0.5, n: 12 });
    for (const [dx, dy] of [[0.03, 0.03], [-0.03, 0.03], [0.03, -0.03], [-0.03, -0.03]]) shape(c, 'drl', 'front', ell(0.62 + dx, 0.618 + dy, 0.017, 0.013, 10), { off: 0.007, depth: 0.5, n: 4, na: 2 });
    // front: big centre intake + side intakes + lip
    shape(c, 'meshHex', 'front', quad([-0.38, 0.22], [0.38, 0.22], [0.42, 0.38], [-0.42, 0.38]), { off: 0.004, mirror: false, depth: 0.5 });
    shape(c, 'meshHex', 'front', quad([0.5, 0.22], [0.8, 0.24], [0.76, 0.37], [0.52, 0.36]), { off: 0.004, depth: 0.5 });
    splitter(c, { z0: 2.12, y: 0.16, w: 0.8, ext: 0.05, depth: 0.45 });
    // hood nostrils (radiator outlets)
    for (const sx of [1, -1]) shape(c, 'black', 'top', [[1.35, sx * 0.07], [1.35, sx * 0.3], [1.72, sx * 0.26], [1.72, sx * 0.09]], { mirror: false, off: 0.004 });
    // fender louvres
    louvres(c, { z0: 1.05, z1: 1.5, n: 9, x0: 0.58, x1: 0.80, len: 0.022 });
    // mirrors
    c.mirrors(B.sidePoint(0.55, 0.87, V()), { out: 0.13, up: 0.07, w: 0.17, h: 0.085, depth: 0.11 });
    // rear quarter intake
    shape(c, 'meshHex', 'side', quad([-0.96, 0.61], [-0.76, 0.64], [-0.77, 0.68], [-0.95, 0.66]), { off: 0.004, range: [2, 5.2] });
    // rear: full-width light bar, grille, plate, exhausts, diffuser
    c.patch('tail', { proj: 'rear', z: [-0.86, 0.86], a0: [[-0.86, 0.80], [0, 0.81], [0.86, 0.80]], a1: [[-0.86, 0.828], [0, 0.832], [0.86, 0.828]], na: 2, nz: 40, off: 0.004, mirror: false });
    shape(c, 'tail', 'rear', quad([0.62, 0.72], [0.86, 0.73], [0.85, 0.80], [0.62, 0.795]), { off: 0.004 });
    shape(c, 'meshHex', 'rear', quad([-0.5, 0.72], [0.5, 0.72], [0.5, 0.785], [-0.5, 0.785]), { off: 0.003, mirror: false });
    shape(c, 'black', 'rear', quad([-0.22, 0.5], [0.22, 0.5], [0.22, 0.62], [-0.22, 0.62]), { off: 0.003, mirror: false });
    shape(c, 'reverse', 'rear', quad([0.3, 0.52], [0.42, 0.52], [0.42, 0.545], [0.3, 0.545]), { off: 0.004 });
    shape(c, 'black', 'rear', quad([-0.85, 0.28], [0.85, 0.28], [0.8, 0.42], [-0.8, 0.42]), { off: 0.003, mirror: false });
    c.exhaust(0.09, 0.36, B.zR - 0.015, 0.052, 'round', 0.16, 1, true);
    diffuserFins(c, [-0.6, -0.36, 0.36, 0.6], { zEnd: B.zR, zStart: -1.75, yLow: 0.102, yHigh: 0.25 });
    // swan-neck rear wing with DRS flap and big endplates
    rearWing(c, { span: 1.72, chord: 0.36, y: 1.18, z: -1.96, aoa: 5, thick: 0.12, flap: { chord: 0.17, y: 1.235, z: -2.22, aoa: 22 },
      endplate: { pts: [[-1.9, 1.10], [-2.38, 1.12], [-2.38, 1.33], [-2.0, 1.29]] } });
    for (const x of [0.32, -0.32]) swanNeck(c, x, [[-1.70, 0.94], [-1.78, 1.12], [-1.86, 1.27], [-1.96, 1.315], [-2.06, 1.30], [-2.12, 1.23]]);
    // nozzles
    for (const x of [0.2, -0.2]) c.nozzle(x, 0.45, B.zR + 0.01, 'back', 'boost', 0.032, false);
    for (const z of [1.75, -1.85]) c.nozzle(0.4, 0.11, z, 'down', 'hover', 0.04, true);
  },
};

// ======================================================================================
// Mercedes-AMG ONE — F1 nose, bubble canopy, roof intake + shark fin, long tail, aero wheels
// ======================================================================================
const amgone = {
  accent: 0xc0c4c8, paint2: 0x111214,
  wheel: { type: 'aero', rimColor: 0x15161a, rimMetal: 0.6, rimRough: 0.35, caliper: 0xb0b4b8, coverSlot: 'carbon', dish: 0.03, sidewall: 0.085 },
  body: {
    zF: 2.36, zR: -2.32, bevelF: 0.05, bevelR: 0.07, noseBulge: 0.05, noseBulgeLen: 0.5, tailBulge: 0.02,
    top: [[2.36, 0.30], [2.30, 0.40], [2.10, 0.49], [1.80, 0.585], [1.45, 0.665], [1.15, 0.73], [0.98, 0.79], [0.68, 0.97], [0.38, 1.12], [0.08, 1.195], [-0.25, 1.185], [-0.6, 1.10], [-1.0, 0.99], [-1.5, 0.915], [-1.9, 0.875], [-2.15, 0.865], [-2.32, 0.83]],
    halfW: [[2.36, 0.60], [2.25, 0.80], [2.0, 0.95], [1.6, 1.0], [1.36, 1.005], [1.0, 0.975], [0.6, 0.93], [0.1, 0.915], [-0.5, 0.95], [-1.0, 0.99], [-1.4, 1.005], [-1.9, 0.99], [-2.2, 0.93], [-2.32, 0.86]],
    sideY: [[2.36, 0.30], [2.0, 0.42], [1.4, 0.50], [0.5, 0.47], [-0.5, 0.52], [-1.4, 0.60], [-2.32, 0.58]],
    shY: [[2.36, 0.32], [2.15, 0.57], [1.8, 0.72], [1.36, 0.80], [1.0, 0.79], [0.7, 0.77], [0.2, 0.775], [-0.5, 0.83], [-1.0, 0.87], [-1.4, 0.885], [-1.9, 0.87], [-2.32, 0.815]],
    shX: [[2.2, 0.80], [1.4, 0.82], [0.8, 0.86], [-0.5, 0.86], [-1.5, 0.84], [-2.2, 0.80]],
    upDrop: [[2.2, 0.03], [1.4, 0.06], [1.05, 0.05], [0.8, 0.04], [0.5, 0.06], [-0.4, 0.06], [-1.0, 0.03], [-1.6, 0.02]],
    upX: [[2.2, 0.38], [1.4, 0.42], [1.0, 0.55], [0.6, 0.6], [0.0, 0.58], [-0.6, 0.55], [-1.2, 0.5], [-2.2, 0.45]],
    lowY: 0.42, lowIn: 0.03,
    sillY: [[2.36, 0.20], [1.9, 0.17], [0.5, 0.17], [-1.9, 0.20], [-2.32, 0.30]],
    sillIn: [[2.0, 0.05], [1.0, 0.04], [0.3, 0.07], [-1.0, 0.04], [-2.2, 0.05]],
    floorY: [[2.36, 0.15], [1.9, 0.095], [-1.4, 0.095], [-1.95, 0.18], [-2.32, 0.28]],
    skirtSlot: 'carbon',
    dents: [
      { plane: 'side', z: 0.45, y: 0.44, hz: 0.5, hy: 0.11, r: 0.1, depth: 0.05, soft: 0.1, slope: 0.18 },
      { plane: 'top', z: 1.75, y: 0.62, hz: 0.45, hy: 0.09, r: 0.08, depth: 0.025, soft: 0.06 },
    ],
  },
  details(c) {
    const B = c.B;
    // bubble canopy: windshield + roof glass band + side glass
    glassCanopy(c, { z0: 1.0, z1: -0.62, edge: 6.08, taper1: 0.35 });
    sideWindow(c, { z0: 0.95, z1: -0.55,
      lo: [[0.95, 5.55], [0.82, 5.12], [0.0, 5.08], [-0.4, 5.2], [-0.55, 5.6]],
      hi: [[0.95, 5.62], [0.82, 5.93], [0.0, 5.94], [-0.4, 5.85], [-0.55, 5.62]] });
    // roof air intake (scoop) + shark fin
    const scoop = [];
    for (let i = 0; i <= 10; i++) { const t = i / 10, z = 0.12 - 0.75 * t; scoop.push(V(0, B.topY(z, 0) + (0.03 + 0.035 * Math.sin(Math.min(1, t * 2.2) * Math.PI / 2)) * (1 - 0.7 * t), z)); }
    const sc = sweep(scoop, roundSection(0.30, 0.12, 14, 3), { upRef: V(0, 1, 0), scaleFn: (t) => [1 - 0.55 * t, 1 - 0.3 * t] });
    c.add('paint2', sc);
    c.add('exhaustIn', plateXY(ell(0, scoop[0].y + 0.005, 0.125, 0.048, 18), 0.006, 0.124, 0));
    topFin(c, 'paint2', -0.55, -2.0, 0.11, 0.05, 0.014);
    // F1-style nose: dark intakes either side of the nose cone, slim angular headlights
    shape(c, 'meshHex', 'front', quad([0.14, 0.2], [0.55, 0.2], [0.62, 0.36], [0.2, 0.40]), { off: 0.004, depth: 0.6 });
    shape(c, 'meshHex', 'front', quad([-0.12, 0.18], [0.12, 0.18], [0.1, 0.27], [-0.1, 0.27]), { off: 0.004, depth: 0.6, mirror: false });
    shape(c, 'lensInner', 'front', quad([0.52, 0.47], [0.86, 0.50], [0.84, 0.56], [0.55, 0.53]), { off: 0.003, depth: 0.8 });
    shape(c, 'head', 'front', quad([0.6, 0.495], [0.82, 0.515], [0.81, 0.54], [0.61, 0.522]), { off: 0.005, depth: 0.8 });
    shape(c, 'drl', 'front', quad([0.54, 0.535], [0.84, 0.555], [0.84, 0.562], [0.54, 0.542]), { off: 0.006, depth: 0.8 });
    splitter(c, { z0: 2.33, y: 0.15, w: 0.86, ext: 0.06, depth: 0.5 });
    // louvres over the front wheels
    louvres(c, { z0: 1.05, z1: 1.55, n: 10, x0: 0.66, x1: 0.92, len: 0.02 });
    c.mirrors(B.sidePoint(0.88, 0.82, V()), { out: 0.15, up: 0.09, w: 0.15, h: 0.07, depth: 0.1 }, { housing: 'paint2', glass: 'darkChrome', stalk: 'paint2' });
    // sidepod intake in front of the rear wheel
    shape(c, 'meshHex', 'side', quad([-0.96, 0.5], [-0.72, 0.53], [-0.72, 0.6], [-0.95, 0.6]), { off: 0.003, range: [2, 5.2] });
    // rear: slim light strips, F1 rain light, central exhausts, big diffuser, active wing
    shape(c, 'tail', 'rear', quad([0.28, 0.775], [0.86, 0.765], [0.85, 0.79], [0.3, 0.795]), { off: 0.004 });
    shape(c, 'meshHex', 'rear', quad([-0.8, 0.5], [0.8, 0.5], [0.82, 0.74], [-0.82, 0.74]), { off: 0.003, mirror: false });
    shape(c, 'redGlow', 'rear', quad([-0.03, 0.66], [0.03, 0.66], [0.03, 0.72], [-0.03, 0.72]), { off: 0.006, mirror: false });
    c.exhaust(0, 0.57, B.zR - 0.015, 0.065, 'round', 0.18);
    c.exhaust(0.15, 0.62, B.zR - 0.015, 0.032, 'round', 0.14, 1, true);
    shape(c, 'black', 'rear', quad([-0.88, 0.29], [0.88, 0.29], [0.84, 0.48], [-0.84, 0.48]), { off: 0.003, mirror: false });
    diffuserFins(c, [-0.7, -0.45, -0.22, 0.22, 0.45, 0.7], { zEnd: B.zR, zStart: -1.6, yLow: 0.097, yHigh: 0.27 });
    rearWing(c, { span: 1.6, chord: 0.3, y: 0.99, z: -1.98, aoa: 4, thick: 0.1, active: true, slot: 'paint2' });
    c.wing(1.6, 0.13, { y: 1.04, z: -2.24, aoa: 24, thick: 0.1, slot: 'paint2' });
    for (const sx of [1, -1]) c.add('paint2', plateZY([[-1.92, 0.86], [-2.36, 0.84], [-2.36, 1.08], [-2.0, 1.04]], 0.014, sx * 0.81, 0.003));
    for (const x of [0.12, -0.12]) c.nozzle(x, 0.44, B.zR + 0.02, 'back', 'boost', 0.03, false);
    for (const z of [1.8, -1.85]) c.nozzle(0.42, 0.1, z, 'down', 'hover', 0.04, true);
  },
};

// ======================================================================================
// McLaren 720S — eye-socket lamps, teardrop canopy, flying buttresses, door channel intake
// ======================================================================================
const mcl720 = {
  accent: 0xf26b0f,
  wheel: { type: 'split', spokes: 5, split: 0.1, rimColor: 0xb8bbbe, rimMetal: 0.95, rimRough: 0.2, caliper: 0xf26b0f, dish: 0.045, spokeW: 0.032, sidewall: 0.08 },
  body: {
    zF: 2.25, zR: -2.245, bevelF: 0.05, bevelR: 0.06, noseBulge: 0.05, tailBulge: 0.02,
    top: [[2.25, 0.38], [2.2, 0.46], [2.05, 0.535], [1.8, 0.61], [1.5, 0.67], [1.2, 0.715], [0.98, 0.76], [0.7, 0.925], [0.4, 1.075], [0.1, 1.17], [-0.15, 1.195], [-0.45, 1.155], [-0.8, 1.03], [-1.2, 0.94], [-1.6, 0.9], [-1.95, 0.895], [-2.12, 0.9], [-2.245, 0.86]],
    halfW: [[2.25, 0.66], [2.15, 0.82], [1.9, 0.915], [1.5, 0.955], [1.0, 0.94], [0.5, 0.905], [0.0, 0.915], [-0.6, 0.95], [-1.1, 0.965], [-1.6, 0.96], [-2.0, 0.93], [-2.245, 0.84]],
    sideY: [[2.25, 0.3], [1.9, 0.42], [1.3, 0.5], [0.4, 0.49], [-0.5, 0.52], [-1.3, 0.6], [-2.245, 0.6]],
    shY: [[2.25, 0.40], [2.1, 0.56], [1.8, 0.67], [1.335, 0.77], [1.0, 0.765], [0.7, 0.745], [0.2, 0.745], [-0.4, 0.80], [-0.9, 0.86], [-1.4, 0.88], [-1.9, 0.88], [-2.245, 0.845]],
    shX: [[2.2, 0.80], [1.4, 0.84], [0.8, 0.87], [-0.5, 0.86], [-1.5, 0.85], [-2.2, 0.8]],
    upDrop: [[2.0, 0.01], [1.1, 0.015], [0.8, 0.04], [0.4, 0.06], [-0.3, 0.06], [-0.6, 0.0], [-0.95, -0.08], [-1.4, -0.06], [-1.8, -0.02], [-2.1, 0.0]],
    upX: [[2.1, 0.48], [1.1, 0.52], [0.85, 0.62], [0.4, 0.6], [-0.3, 0.6], [-0.8, 0.64], [-1.4, 0.66], [-2.0, 0.6]],
    lowY: 0.42, lowIn: 0.03,
    sillY: [[2.25, 0.20], [1.9, 0.18], [0.5, 0.175], [-1.9, 0.21], [-2.245, 0.30]],
    sillIn: [[2.0, 0.05], [1.0, 0.04], [0.3, 0.06], [-1.0, 0.04], [-2.2, 0.05]],
    floorY: [[2.25, 0.16], [1.9, 0.10], [-1.4, 0.10], [-1.9, 0.18], [-2.245, 0.28]],
    dents: [
      { plane: 'side', z: -0.25, y: 0.6, hz: 0.62, hy: 0.075, r: 0.07, depth: 0.06, soft: 0.07, slope: 0.12 },
      { plane: 'side', z: -0.84, y: 0.6, hz: 0.12, hy: 0.14, r: 0.08, depth: 0.05, soft: 0.07 },
    ],
  },
  details(c) {
    const B = c.B;
    // teardrop canopy: windshield + glass roof band, doors with glass, rear buttress glass
    glassCanopy(c, { z0: 1.0, z1: -0.7, edge: 6.12, taper1: 0.55 });
    sideWindow(c, { z0: 0.95, z1: -0.75,
      lo: [[0.95, 5.55], [0.85, 5.12], [0.0, 5.1], [-0.4, 5.22], [-0.75, 5.75]],
      hi: [[0.95, 5.62], [0.85, 5.92], [0.0, 5.93], [-0.45, 5.9], [-0.75, 5.78]] });
    c.patch('glass', { proj: 's', z: [-1.75, -0.78], a0: [[-1.75, 6.75], [-1.4, 6.5], [-0.78, 6.4]], a1: [[-1.75, 7.25], [-1.4, 7.5], [-0.78, 7.6]], na: 8, nz: 12, off: 0.004, mirror: false });
    // eye sockets: dark sculpted recess with LED blade + lamp
    const eye = [[0.42, 0.35], [0.58, 0.31], [0.78, 0.37], [0.88, 0.47], [0.86, 0.555], [0.7, 0.56], [0.52, 0.5]];
    shape(c, 'gloss', 'front', eye, { off: 0.003, depth: 0.6, n: 16 });
    shape(c, 'lensInner', 'front', quad([0.56, 0.49], [0.84, 0.52], [0.84, 0.545], [0.6, 0.525]), { off: 0.005, depth: 0.6 });
    shape(c, 'drl', 'front', [[0.5, 0.485], [0.7, 0.535], [0.85, 0.552], [0.85, 0.56], [0.7, 0.546], [0.5, 0.495]], { off: 0.007, depth: 0.6, n: 12, na: 1 });
    shape(c, 'head', 'front', ell(0.76, 0.515, 0.045, 0.018, 12), { off: 0.007, depth: 0.6, n: 8 });
    shape(c, 'meshHex', 'front', quad([0.5, 0.33], [0.72, 0.34], [0.8, 0.42], [0.58, 0.44]), { off: 0.006, depth: 0.6 });
    shape(c, 'meshHex', 'front', quad([-0.3, 0.2], [0.3, 0.2], [0.32, 0.27], [-0.32, 0.27]), { off: 0.004, depth: 0.6, mirror: false });
    splitter(c, { z0: 2.22, y: 0.16, w: 0.8, ext: 0.04, depth: 0.45 });
    // hood channels
    for (const sx of [1, -1]) shape(c, 'black', 'top', [[1.5, sx * 0.18], [1.5, sx * 0.34], [1.85, sx * 0.30], [1.85, sx * 0.2]], { mirror: false, off: 0.004 });
    // dihedral door shut lines + door channel intake mesh
    sideStrip(c, 'black', [[0.9, 0.82], [0.95, 0.6], [0.88, 0.32], [0.8, 0.22]], 0.006, 0.002, [2, 5.4]);
    shape(c, 'meshHex', 'side', [[-0.95, 0.47], [-0.72, 0.5], [-0.72, 0.72], [-0.92, 0.75]], { off: 0.003, range: [2, 5.3] });
    c.mirrors(B.sidePoint(0.82, 0.80, V()), { out: 0.14, up: 0.08, w: 0.16, h: 0.075, depth: 0.1 });
    // rear: C-shaped thin LED, open mesh, high centre exhausts, airbrake
    shape(c, 'meshHex', 'rear', quad([-0.82, 0.45], [0.82, 0.45], [0.84, 0.78], [-0.84, 0.78]), { off: 0.003, mirror: false });
    shape(c, 'tail', 'rear', [[0.48, 0.79], [0.86, 0.785], [0.86, 0.81], [0.48, 0.81]], { off: 0.005 });
    shape(c, 'tail', 'rear', [[0.83, 0.62], [0.86, 0.62], [0.86, 0.80], [0.83, 0.80]], { off: 0.005, n: 4 });
    c.exhaust(0.1, 0.66, B.zR - 0.015, 0.055, 'round', 0.18, 1, true);
    shape(c, 'black', 'rear', quad([-0.86, 0.29], [0.86, 0.29], [0.82, 0.44], [-0.82, 0.44]), { off: 0.003, mirror: false });
    diffuserFins(c, [-0.62, -0.38, -0.14, 0.14, 0.38, 0.62], { zEnd: B.zR, zStart: -1.65, yLow: 0.102, yHigh: 0.27 });
    const ab = plateXZ([[-0.82, -1.92], [0.82, -1.92], [0.84, -2.24], [-0.84, -2.24]], 0.02, 0.89, 0.004);
    c.extra('wing', 'paint', ab, [0, 0.9, -1.92]);
    for (const x of [0.22, -0.22]) c.nozzle(x, 0.55, B.zR + 0.02, 'back', 'boost', 0.03, false);
    for (const z of [1.8, -1.8]) c.nozzle(0.4, 0.105, z, 'down', 'hover', 0.04, true);
  },
};

// ======================================================================================
// Lamborghini Revuelto — sharp wedge, Y lamps, hexagons, huge side intakes
// ======================================================================================
const revuelto = {
  accent: 0x111111,
  wheel: { type: 'y', spokes: 5, split: 0.16, rimColor: 0x1a1b1d, rimMetal: 0.8, rimRough: 0.3, caliper: 0xf2b600, dish: 0.06, spokeW: 0.04, sidewall: 0.075 },
  body: {
    zF: 2.33, zR: -2.36, bevelF: 0.035, bevelR: 0.05, noseBulge: 0.03, tailBulge: 0.0,
    top: [[2.33, 0.36], [2.27, 0.44], [2.0, 0.53], [1.5, 0.645], [1.1, 0.735], [0.8, 0.875], [0.4, 1.055], [0.05, 1.155], [-0.25, 1.15], [-0.6, 1.07], [-1.0, 0.985], [-1.5, 0.925], [-2.0, 0.905], [-2.25, 0.895], [-2.36, 0.86]],
    halfW: [[2.33, 0.70], [2.2, 0.88], [1.9, 0.975], [1.4, 1.015], [1.0, 0.995], [0.5, 0.94], [0.0, 0.94], [-0.6, 0.98], [-1.1, 1.015], [-1.6, 1.015], [-2.0, 0.99], [-2.36, 0.93]],
    sideY: [[2.33, 0.32], [1.9, 0.44], [1.3, 0.50], [0.5, 0.46], [-0.4, 0.50], [-1.3, 0.6], [-2.36, 0.62]],
    shY: [[2.33, 0.385], [2.1, 0.57], [1.7, 0.70], [1.39, 0.785], [1.0, 0.765], [0.6, 0.74], [0.0, 0.755], [-0.6, 0.835], [-1.2, 0.88], [-1.8, 0.885], [-2.36, 0.865]],
    shX: [[2.2, 0.82], [1.4, 0.85], [0.6, 0.88], [-0.6, 0.87], [-1.6, 0.86], [-2.3, 0.84]],
    upDrop: [[2.2, 0.0], [1.2, 0.0], [0.9, 0.03], [0.5, 0.055], [-0.3, 0.055], [-0.7, 0.0], [-1.1, -0.04], [-1.6, -0.03], [-2.2, 0.0]],
    upX: [[2.2, 0.5], [1.2, 0.55], [0.9, 0.64], [0.4, 0.6], [-0.3, 0.6], [-0.9, 0.62], [-1.6, 0.6], [-2.3, 0.55]],
    lowY: 0.38, lowIn: 0.055,
    sillY: [[2.33, 0.20], [1.9, 0.18], [0.5, 0.175], [-1.9, 0.22], [-2.36, 0.32]],
    sillIn: [[2.0, 0.05], [1.0, 0.05], [0.3, 0.08], [-1.0, 0.05], [-2.2, 0.06]],
    floorY: [[2.33, 0.15], [1.9, 0.105], [-1.4, 0.105], [-1.95, 0.19], [-2.36, 0.30]],
    sharp: [3, 4, 5],
    seg: [1, 1, 2, 3, 5, 8, 7],
    skirtSlot: 'carbon',
    dents: [
      { plane: 'side', z: -0.8, y: 0.63, hz: 0.24, hy: 0.15, r: 0.07, depth: 0.06, soft: 0.07, slope: 0.3 },
      { plane: 'side', z: 0.35, y: 0.36, hz: 0.42, hy: 0.06, r: 0.05, depth: 0.025, soft: 0.06, slope: -0.1 },
    ],
  },
  details(c) {
    const B = c.B;
    glassCanopy(c, { z0: 1.12, z1: -0.6, edge: 6.1, taper1: 0.6 });
    sideWindow(c, { z0: 1.05, z1: -0.65,
      lo: [[1.05, 5.55], [0.95, 5.12], [0.0, 5.08], [-0.45, 5.25], [-0.65, 5.75]],
      hi: [[1.05, 5.6], [0.95, 5.92], [0.0, 5.93], [-0.45, 5.88], [-0.65, 5.77]] });
    // engine cover hex louvres
    c.patch('meshHex', { proj: 'top', z: [-1.95, -0.75], a0: -0.3, a1: 0.3, nz: 10, na: 6, off: 0.004, mirror: false, uvScale: 2.5 });
    // Y-shaped lamps: dark housing, Y DRL, lamp
    shape(c, 'gloss', 'front', quad([0.46, 0.47], [0.9, 0.5], [0.88, 0.585], [0.52, 0.55]), { off: 0.003, depth: 0.7 });
    shape(c, 'drl', 'front', quad([0.5, 0.505], [0.72, 0.53], [0.72, 0.542], [0.5, 0.517]), { off: 0.006, depth: 0.7, na: 1 });
    shape(c, 'drl', 'front', quad([0.71, 0.53], [0.88, 0.505], [0.885, 0.517], [0.72, 0.542]), { off: 0.006, depth: 0.7, na: 1 });
    shape(c, 'drl', 'front', quad([0.71, 0.536], [0.86, 0.572], [0.855, 0.582], [0.705, 0.546]), { off: 0.006, depth: 0.7, na: 1 });
    shape(c, 'head', 'front', quad([0.56, 0.535], [0.68, 0.548], [0.68, 0.565], [0.57, 0.552]), { off: 0.006, depth: 0.7 });
    // big angular intakes with hex mesh + central splitter blade
    shape(c, 'meshHex', 'front', [[0.12, 0.2], [0.62, 0.2], [0.8, 0.3], [0.72, 0.44], [0.3, 0.38]], { off: 0.004, depth: 0.7 });
    shape(c, 'meshHex', 'front', quad([-0.1, 0.19], [0.1, 0.19], [0.08, 0.25], [-0.08, 0.25]), { off: 0.004, depth: 0.7, mirror: false });
    splitter(c, { z0: 2.31, y: 0.15, w: 0.86, ext: 0.05, depth: 0.5 });
    // hood: sharp Y crease implied by dark vents
    for (const sx of [1, -1]) shape(c, 'black', 'top', [[1.7, sx * 0.15], [1.95, sx * 0.4], [1.9, sx * 0.47], [1.65, sx * 0.2]], { mirror: false, off: 0.004 });
    // side intake + door crease
    shape(c, 'meshHex', 'side', [[-1.0, 0.5], [-0.62, 0.52], [-0.52, 0.76], [-0.92, 0.78]], { off: 0.002, range: [2, 5.3] });
    sideStrip(c, 'black', [[1.0, 0.82], [0.98, 0.5], [0.9, 0.22]], 0.006, 0.002, [2, 5.4]);
    c.mirrors(B.sidePoint(0.92, 0.80, V()), { out: 0.15, up: 0.08, w: 0.17, h: 0.07, depth: 0.09 });
    // rear: Y tail lamps, hex exhausts high centre, open mesh, huge diffuser
    shape(c, 'meshHex', 'rear', quad([-0.85, 0.42], [0.85, 0.42], [0.88, 0.80], [-0.88, 0.80]), { off: 0.003, mirror: false });
    shape(c, 'tail', 'rear', quad([0.5, 0.74], [0.9, 0.76], [0.9, 0.775], [0.5, 0.755]), { off: 0.006, na: 1 });
    shape(c, 'tail', 'rear', quad([0.68, 0.75], [0.9, 0.64], [0.9, 0.655], [0.69, 0.765]), { off: 0.006, na: 1 });
    shape(c, 'tail', 'rear', quad([0.66, 0.76], [0.68, 0.76], [0.6, 0.86], [0.58, 0.86]), { off: 0.006, na: 1, depth: 0.8 });
    c.exhaust(0.13, 0.66, B.zR - 0.015, 0.07, 'hex', 0.2, 1, true);
    shape(c, 'black', 'rear', quad([-0.9, 0.31], [0.9, 0.31], [0.86, 0.42], [-0.86, 0.42]), { off: 0.003, mirror: false });
    diffuserFins(c, [-0.66, -0.42, -0.18, 0.18, 0.42, 0.66], { zEnd: B.zR, zStart: -1.55, yLow: 0.107, yHigh: 0.29 });
    rearWing(c, { span: 1.5, chord: 0.22, y: 0.97, z: -2.12, aoa: 6, thick: 0.08, active: true, slot: 'carbon' });
    for (const x of [0.36, -0.36]) c.nozzle(x, 0.6, B.zR + 0.02, 'back', 'boost', 0.03, false);
    for (const z of [1.85, -1.85]) c.nozzle(0.42, 0.11, z, 'down', 'hover', 0.04, true);
  },
};

// ======================================================================================
// Ferrari SF90 Stradale — curvy cab-forward, shut-off Gurney tail, twin round-ish lamps
// ======================================================================================
const sf90 = {
  accent: 0xf2c200,
  wheel: { type: 'split', spokes: 5, split: 0.09, rimColor: 0x2a2c30, rimMetal: 0.85, rimRough: 0.3, caliper: 0xf2c200, dish: 0.05, spokeW: 0.036, sidewall: 0.08 },
  body: {
    zF: 2.30, zR: -2.335, bevelF: 0.05, bevelR: 0.035, noseBulge: 0.05, tailBulge: 0.0,
    top: [[2.30, 0.36], [2.24, 0.46], [2.05, 0.545], [1.8, 0.615], [1.45, 0.675], [1.15, 0.725], [0.95, 0.77], [0.65, 0.93], [0.35, 1.08], [0.05, 1.18], [-0.25, 1.175], [-0.6, 1.09], [-1.0, 0.995], [-1.45, 0.93], [-1.9, 0.91], [-2.2, 0.925], [-2.3, 0.935], [-2.335, 0.92]],
    halfW: [[2.30, 0.62], [2.2, 0.82], [1.95, 0.935], [1.5, 0.975], [1.1, 0.965], [0.6, 0.93], [0.0, 0.93], [-0.6, 0.965], [-1.1, 0.985], [-1.6, 0.98], [-2.0, 0.96], [-2.335, 0.91]],
    sideY: [[2.30, 0.30], [1.9, 0.43], [1.3, 0.5], [0.5, 0.48], [-0.5, 0.52], [-1.4, 0.6], [-2.335, 0.6]],
    shY: [[2.30, 0.37], [2.15, 0.58], [1.8, 0.71], [1.325, 0.79], [1.0, 0.78], [0.6, 0.75], [0.0, 0.76], [-0.6, 0.82], [-1.2, 0.88], [-1.7, 0.885], [-2.1, 0.885], [-2.335, 0.89]],
    shX: [[2.2, 0.80], [1.4, 0.83], [0.7, 0.87], [-0.6, 0.86], [-1.6, 0.85], [-2.3, 0.84]],
    upDrop: [[2.1, 0.012], [1.1, 0.012], [0.85, 0.035], [0.4, 0.06], [-0.3, 0.06], [-0.7, 0.01], [-1.1, -0.04], [-1.6, -0.025], [-2.2, 0.0]],
    upX: [[2.1, 0.48], [1.1, 0.52], [0.85, 0.62], [0.4, 0.6], [-0.3, 0.6], [-0.9, 0.63], [-1.6, 0.6], [-2.3, 0.55]],
    lowY: 0.42, lowIn: 0.035,
    sillY: [[2.30, 0.20], [1.9, 0.18], [0.5, 0.175], [-1.9, 0.21], [-2.335, 0.30]],
    sillIn: [[2.0, 0.05], [1.0, 0.04], [0.3, 0.065], [-1.0, 0.04], [-2.2, 0.05]],
    floorY: [[2.30, 0.155], [1.9, 0.10], [-1.4, 0.10], [-1.95, 0.18], [-2.335, 0.28]],
    dents: [
      { plane: 'side', z: -0.8, y: 0.61, hz: 0.2, hy: 0.09, r: 0.08, depth: 0.045, soft: 0.09, slope: 0.2 },
      { plane: 'side', z: 0.1, y: 0.42, hz: 0.55, hy: 0.09, r: 0.08, depth: 0.03, soft: 0.1, slope: 0.15 },
    ],
  },
  details(c) {
    const B = c.B;
    glassCanopy(c, { z0: 0.97, z1: -0.6, edge: 6.1, taper1: 0.55 });
    sideWindow(c, { z0: 0.92, z1: -0.62,
      lo: [[0.92, 5.55], [0.82, 5.12], [0.0, 5.08], [-0.4, 5.22], [-0.62, 5.72]],
      hi: [[0.92, 5.62], [0.82, 5.93], [0.0, 5.94], [-0.4, 5.88], [-0.62, 5.74]] });
    c.patch('glass', { proj: 's', z: [-1.6, -0.7], a0: [[-1.6, 6.75], [-1.3, 6.48], [-0.7, 6.4]], a1: [[-1.6, 7.25], [-1.3, 7.52], [-0.7, 7.6]], na: 8, nz: 10, off: 0.004, mirror: false });
    // headlights: slim slit + DRL, boomerang intake below
    shape(c, 'gloss', 'front', quad([0.5, 0.5], [0.86, 0.53], [0.86, 0.585], [0.55, 0.555]), { off: 0.003, depth: 0.7 });
    shape(c, 'head', 'front', quad([0.6, 0.522], [0.83, 0.543], [0.83, 0.565], [0.62, 0.546]), { off: 0.005, depth: 0.7 });
    shape(c, 'drl', 'front', quad([0.52, 0.553], [0.86, 0.578], [0.86, 0.586], [0.52, 0.561]), { off: 0.006, depth: 0.7, na: 1 });
    shape(c, 'meshHex', 'front', [[0.2, 0.21], [0.66, 0.22], [0.82, 0.36], [0.76, 0.45], [0.62, 0.34], [0.26, 0.33]], { off: 0.004, depth: 0.7 });
    shape(c, 'meshHex', 'front', quad([-0.18, 0.2], [0.18, 0.2], [0.16, 0.3], [-0.16, 0.3]), { off: 0.004, depth: 0.7, mirror: false });
    splitter(c, { z0: 2.28, y: 0.155, w: 0.8, ext: 0.04, depth: 0.45 });
    shape(c, 'black', 'top', [[1.55, -0.3], [1.55, 0.3], [1.82, 0.26], [1.82, -0.26]], { mirror: false, off: 0.004 });
    // side intake
    shape(c, 'meshHex', 'side', [[-0.96, 0.53], [-0.62, 0.58], [-0.6, 0.66], [-0.94, 0.68]], { off: 0.002, range: [2, 5.3] });
    c.mirrors(B.sidePoint(0.82, 0.79, V()), { out: 0.14, up: 0.08, w: 0.17, h: 0.08, depth: 0.1 });
    // rear: shut-off Gurney face with twin squircle lamps each side, high twin exhausts
    shape(c, 'gloss', 'rear', quad([-0.9, 0.52], [0.9, 0.52], [0.9, 0.86], [-0.9, 0.86]), { off: 0.002, mirror: false });
    for (const [x, r] of [[0.52, 0.058], [0.77, 0.058]]) {
      shape(c, 'tailDark', 'rear', ell(x, 0.775, r + 0.012, r * 0.82 + 0.01, 18), { off: 0.004 });
      shape(c, 'tail', 'rear', ell(x, 0.775, r, r * 0.8, 18), { off: 0.006 });
    }
    shape(c, 'meshHex', 'rear', quad([-0.4, 0.55], [0.4, 0.55], [0.4, 0.72], [-0.4, 0.72]), { off: 0.004, mirror: false });
    c.exhaust(0.075, 0.64, B.zR - 0.015, 0.048, 'round', 0.16, 1.15, true);
    shape(c, 'black', 'rear', quad([-0.86, 0.29], [0.86, 0.29], [0.82, 0.46], [-0.82, 0.46]), { off: 0.003, mirror: false });
    diffuserFins(c, [-0.6, -0.36, -0.12, 0.12, 0.36, 0.6], { zEnd: B.zR, zStart: -1.6, yLow: 0.102, yHigh: 0.27 });
    // Gurney lip
    c.add('paint', plateXZ([[-0.74, B.zR + 0.1], [0.74, B.zR + 0.1], [0.72, B.zR - 0.03], [-0.72, B.zR - 0.03]], 0.018, 0.9, 0.005));
    for (const x of [0.25, -0.25]) c.nozzle(x, 0.48, B.zR + 0.02, 'back', 'boost', 0.03, false);
    for (const z of [1.8, -1.85]) c.nozzle(0.4, 0.105, z, 'down', 'hover', 0.04, true);
  },
};

// ======================================================================================
// Bugatti Chiron — horseshoe grille, C-line, two-tone, quad LED lamps, centre spine, light bar
// ======================================================================================
const cLineZ = (y) => {
  // rear edge of the "C" in side view: big curve from beltline (z -0.35, y 0.86) round to (z 0.25, y 0.3)
  const t = Math.min(1, Math.max(0, (0.86 - y) / 0.56));
  return -0.35 - 0.42 * Math.sin(t * Math.PI) + 0.6 * t * t;
};
const chiron = {
  accent: 0x1c4fa0, paint2: 0x0b0e16, paint2Metal: 0.5, paint2Rough: 0.3,
  wheel: { type: 'split', spokes: 5, split: 0.11, rimColor: 0xa9adb2, rimMetal: 1.0, rimRough: 0.18, caliper: 0x1c4fa0, dish: 0.035, spokeW: 0.036, sidewall: 0.085 },
  body: {
    zF: 2.235, zR: -2.267, bevelF: 0.07, bevelR: 0.07, noseBulge: 0.04, tailBulge: 0.0,
    top: [[2.235, 0.42], [2.18, 0.52], [2.0, 0.615], [1.7, 0.695], [1.3, 0.755], [1.0, 0.80], [0.76, 0.855], [0.5, 1.0], [0.25, 1.13], [0.0, 1.20], [-0.3, 1.21], [-0.6, 1.16], [-0.95, 1.06], [-1.3, 0.985], [-1.7, 0.945], [-2.05, 0.935], [-2.267, 0.885]],
    halfW: [[2.235, 0.62], [2.15, 0.82], [1.9, 0.955], [1.5, 1.005], [1.1, 0.995], [0.6, 0.955], [0.0, 0.965], [-0.6, 1.0], [-1.1, 1.019], [-1.6, 1.015], [-2.0, 0.99], [-2.267, 0.9]],
    sideY: [[2.235, 0.34], [1.9, 0.45], [1.3, 0.52], [0.4, 0.5], [-0.5, 0.55], [-1.3, 0.62], [-2.267, 0.6]],
    shY: [[2.235, 0.44], [2.05, 0.635], [1.7, 0.755], [1.355, 0.81], [1.0, 0.82], [0.6, 0.84], [0.0, 0.86], [-0.6, 0.90], [-1.1, 0.925], [-1.7, 0.92], [-2.267, 0.885]],
    shX: [[2.2, 0.80], [1.4, 0.84], [0.6, 0.88], [-0.6, 0.87], [-1.6, 0.86], [-2.2, 0.82]],
    upDrop: [[2.1, -0.01], [1.1, -0.01], [0.8, 0.03], [0.4, 0.06], [-0.4, 0.06], [-0.9, 0.04], [-1.5, 0.02]],
    upX: [[2.1, 0.5], [1.1, 0.54], [0.8, 0.62], [0.3, 0.6], [-0.4, 0.58], [-1.0, 0.56], [-1.7, 0.52], [-2.2, 0.48]],
    lowY: 0.42, lowIn: 0.03,
    sillY: [[2.235, 0.21], [1.9, 0.19], [0.5, 0.185], [-1.9, 0.22], [-2.267, 0.30]],
    sillIn: [[2.0, 0.05], [1.0, 0.04], [0.3, 0.05], [-1.0, 0.04], [-2.2, 0.05]],
    floorY: [[2.235, 0.17], [1.9, 0.11], [-1.4, 0.11], [-1.9, 0.18], [-2.267, 0.28]],
    paint2: (x, y, z) => (y < 0.875 ? z > cLineZ(y) : z > 0.72) || y < 0.2,
    capFrontSlot: 'paint2',
    dents: [{ plane: 'side', z: -0.62, y: 0.6, hz: 0.12, hy: 0.2, r: 0.1, depth: 0.06, soft: 0.06, slope: 0 }],
  },
  details(c) {
    const B = c.B;
    glassCanopy(c, { z0: 0.78, z1: -0.75, edge: 6.08, taper1: 0.5 });
    sideWindow(c, { z0: 0.74, z1: -0.7,
      lo: [[0.74, 5.55], [0.64, 5.12], [-0.2, 5.08], [-0.55, 5.25], [-0.7, 5.65]],
      hi: [[0.74, 5.62], [0.62, 5.93], [-0.2, 5.93], [-0.55, 5.85], [-0.7, 5.66]] });
    // C-line (polished aluminium)
    const cpath = [];
    for (let i = 0; i <= 24; i++) { const y = 0.865 - 0.56 * i / 24; cpath.push([cLineZ(y), y]); }
    cpath.unshift([0.55, 0.875], [0.1, 0.872]);
    cpath.push([0.45, 0.27]);
    sideStrip(c, 'alu', cpath, 0.045, 0.004, [2, 5.4]);
    shape(c, 'meshDiamond', 'side', [[-0.78, 0.45], [-0.6, 0.42], [-0.52, 0.6], [-0.6, 0.78], [-0.74, 0.8]], { off: 0.002, range: [2, 5.3] });
    // horseshoe grille
    const hs = (r, top) => { const p = []; for (let i = 0; i <= 16; i++) { const a = Math.PI * i / 16; p.push([r * Math.cos(a), top - r * 1.3 + r * 1.3 * Math.sin(a)]); } p.push([-r * 0.92, 0.24], [r * 0.92, 0.24]); return p; };
    shape(c, 'chrome', 'front', hs(0.2, 0.58), { off: 0.004, mirror: false, depth: 0.8, n: 18 });
    shape(c, 'meshDiamond', 'front', hs(0.17, 0.555), { off: 0.007, mirror: false, depth: 0.8, n: 18 });
    // quad LED lamps (4 per side) in a slim dark housing + intakes
    shape(c, 'gloss', 'front', quad([0.42, 0.52], [0.86, 0.555], [0.86, 0.62], [0.46, 0.585]), { off: 0.003, depth: 0.8 });
    for (let i = 0; i < 4; i++) { const x = 0.5 + i * 0.1, y = 0.553 + i * 0.008; shape(c, 'head', 'front', ell(x, y, 0.032, 0.022, 12), { off: 0.006, depth: 0.8, n: 8 }); }
    shape(c, 'drl', 'front', quad([0.44, 0.592], [0.86, 0.622], [0.86, 0.628], [0.44, 0.598]), { off: 0.007, depth: 0.8, na: 1 });
    shape(c, 'meshDiamond', 'front', [[0.3, 0.22], [0.78, 0.24], [0.82, 0.36], [0.68, 0.46], [0.32, 0.4]], { off: 0.004, depth: 0.8 });
    splitter(c, { z0: 2.2, y: 0.17, w: 0.82, ext: 0.03, depth: 0.45 });
    // centre spine (roof to tail)
    topFin(c, 'paint', 0.3, -2.05, 0.03, 0.035, 0.03);
    c.mirrors(B.sidePoint(0.6, 0.88, V()), { out: 0.14, up: 0.08, w: 0.17, h: 0.08, depth: 0.1 }, { housing: 'paint2', glass: 'darkChrome', stalk: 'paint2' });
    // rear: single LED light bar, mesh, big centre exhaust surround with 4 pipes, flush wing
    shape(c, 'meshDiamond', 'rear', quad([-0.86, 0.48], [0.86, 0.48], [0.88, 0.76], [-0.88, 0.76]), { off: 0.003, mirror: false });
    c.patch('tail', { proj: 'rear', z: [-0.88, 0.88], a0: 0.77, a1: 0.79, na: 1, nz: 40, off: 0.005, mirror: false });
    for (let i = -6; i <= 6; i++) shape(c, 'tail', 'rear', quad([i * 0.13 - 0.004, 0.70], [i * 0.13 + 0.004, 0.70], [i * 0.13 + 0.004, 0.77], [i * 0.13 - 0.004, 0.77]), { off: 0.004, mirror: false, n: 2, na: 1 });
    shape(c, 'black', 'rear', quad([-0.3, 0.3], [0.3, 0.3], [0.3, 0.46], [-0.3, 0.46]), { off: 0.004, mirror: false });
    for (const x of [-0.18, -0.06, 0.06, 0.18]) c.exhaust(x, 0.38, B.zR - 0.015, 0.042, 'round', 0.1);
    diffuserFins(c, [-0.7, -0.5, 0.5, 0.7], { zEnd: B.zR, zStart: -1.6, yLow: 0.112, yHigh: 0.27 });
    const wg = plateXZ([[-0.84, -1.70], [0.84, -1.70], [0.86, -2.2], [-0.86, -2.2]], 0.025, B.topY(-1.9, 0) - 0.005, 0.006);
    c.extra('wing', 'paint', wg, [0, B.topY(-1.7, 0), -1.70]);
    for (const x of [0.42, -0.42]) c.nozzle(x, 0.4, B.zR + 0.02, 'back', 'boost', 0.03, false);
    for (const z of [1.8, -1.8]) c.nozzle(0.42, 0.115, z, 'down', 'hover', 0.04, true);
  },
};

// ======================================================================================
// Rimac Nevera — smooth EV hypercar, hood bridge, scoop sides, active aero, no exhausts
// ======================================================================================
const nevera = {
  accent: 0x2f6f8f,
  wheel: { type: 'turbine', spokes: 14, twist: 0.22, rimColor: 0x9ea3a8, rimMetal: 1.0, rimRough: 0.22, caliper: 0x1b1d20, dish: 0.035, spokeW: 0.024, spokeT: 0.024, sidewall: 0.08 },
  body: {
    zF: 2.32, zR: -2.36, bevelF: 0.05, bevelR: 0.08, noseBulge: 0.05, tailBulge: 0.015,
    top: [[2.32, 0.36], [2.25, 0.46], [2.05, 0.555], [1.75, 0.635], [1.4, 0.695], [1.1, 0.74], [0.9, 0.78], [0.6, 0.95], [0.3, 1.10], [0.0, 1.20], [-0.3, 1.205], [-0.65, 1.13], [-1.0, 1.03], [-1.4, 0.95], [-1.8, 0.91], [-2.15, 0.905], [-2.36, 0.86]],
    halfW: [[2.32, 0.64], [2.2, 0.84], [1.95, 0.94], [1.5, 0.98], [1.1, 0.965], [0.6, 0.93], [0.0, 0.93], [-0.6, 0.96], [-1.1, 0.99], [-1.6, 0.99], [-2.0, 0.965], [-2.36, 0.88]],
    sideY: [[2.32, 0.3], [1.9, 0.43], [1.3, 0.5], [0.4, 0.48], [-0.5, 0.52], [-1.3, 0.6], [-2.36, 0.6]],
    shY: [[2.32, 0.38], [2.12, 0.58], [1.8, 0.70], [1.37, 0.78], [1.0, 0.77], [0.6, 0.75], [0.0, 0.76], [-0.6, 0.82], [-1.2, 0.87], [-1.8, 0.875], [-2.36, 0.85]],
    shX: [[2.2, 0.80], [1.4, 0.84], [0.7, 0.87], [-0.6, 0.86], [-1.6, 0.85], [-2.3, 0.82]],
    upDrop: [[2.1, 0.012], [1.1, 0.012], [0.8, 0.04], [0.4, 0.06], [-0.4, 0.06], [-0.9, 0.035], [-1.5, 0.015]],
    upX: [[2.1, 0.48], [1.1, 0.52], [0.8, 0.62], [0.3, 0.6], [-0.4, 0.58], [-1.0, 0.56], [-1.7, 0.52], [-2.3, 0.47]],
    lowY: 0.42, lowIn: 0.03,
    sillY: [[2.32, 0.20], [1.9, 0.18], [0.5, 0.175], [-1.9, 0.21], [-2.36, 0.30]],
    sillIn: [[2.0, 0.05], [1.0, 0.04], [0.3, 0.06], [-1.0, 0.04], [-2.2, 0.05]],
    floorY: [[2.32, 0.155], [1.9, 0.10], [-1.4, 0.10], [-1.95, 0.18], [-2.36, 0.28]],
    skirtSlot: 'carbon',
    dents: [
      { plane: 'side', z: -0.45, y: 0.5, hz: 0.5, hy: 0.1, r: 0.09, depth: 0.05, soft: 0.1, slope: 0.32 },
      { plane: 'top', z: 1.85, y: 0.0, hz: 0.2, hy: 0.36, r: 0.08, depth: 0.03, soft: 0.05 },
    ],
  },
  details(c) {
    const B = c.B;
    glassCanopy(c, { z0: 0.92, z1: -1.05, edge: 6.08, taper1: 0.55 });
    sideWindow(c, { z0: 0.88, z1: -0.82,
      lo: [[0.88, 5.55], [0.76, 5.12], [-0.1, 5.08], [-0.55, 5.22], [-0.82, 5.62]],
      hi: [[0.88, 5.62], [0.76, 5.93], [-0.1, 5.94], [-0.55, 5.88], [-0.82, 5.64]] });
    // hood bridge outlet
    shape(c, 'black', 'top', [[1.72, -0.34], [1.72, 0.34], [1.98, 0.3], [1.98, -0.3]], { mirror: false, off: 0.003 });
    shape(c, 'paint', 'top', [[1.8, -0.36], [1.8, 0.36], [1.86, 0.36], [1.86, -0.36]], { mirror: false, off: 0.012 });
    // slim LED headlights with vertical element
    shape(c, 'gloss', 'front', quad([0.5, 0.5], [0.87, 0.53], [0.86, 0.565], [0.52, 0.535]), { off: 0.003, depth: 0.7 });
    shape(c, 'drl', 'front', quad([0.52, 0.515], [0.86, 0.543], [0.86, 0.552], [0.52, 0.524]), { off: 0.006, depth: 0.7, na: 1 });
    shape(c, 'head', 'front', quad([0.62, 0.527], [0.8, 0.542], [0.8, 0.556], [0.62, 0.541]), { off: 0.005, depth: 0.7 });
    shape(c, 'drl', 'front', quad([0.84, 0.44], [0.85, 0.44], [0.86, 0.54], [0.85, 0.54]), { off: 0.006, depth: 0.7, na: 1, n: 4 });
    shape(c, 'meshHex', 'front', [[-0.62, 0.21], [0.62, 0.21], [0.7, 0.3], [0.5, 0.38], [-0.5, 0.38], [-0.7, 0.3]], { off: 0.004, depth: 0.7, mirror: false, n: 20 });
    splitter(c, { z0: 2.3, y: 0.155, w: 0.82, ext: 0.05, depth: 0.45 });
    // side scoop intake
    shape(c, 'meshHex', 'side', [[-0.98, 0.5], [-0.7, 0.55], [-0.7, 0.74], [-0.95, 0.76]], { off: 0.002, range: [2, 5.3] });
    c.mirrors(B.sidePoint(0.78, 0.79, V()), { out: 0.14, up: 0.07, w: 0.15, h: 0.07, depth: 0.1 });
    // rear: wraparound slim light bar, big diffuser, active wing flap
    c.patch('tail', { proj: 'rear', z: [-0.86, 0.86], a0: [[-0.86, 0.74], [0, 0.755], [0.86, 0.74]], a1: [[-0.86, 0.755], [0, 0.768], [0.86, 0.755]], na: 1, nz: 40, off: 0.005, mirror: false });
    shape(c, 'gloss', 'rear', quad([-0.7, 0.55], [0.7, 0.55], [0.72, 0.72], [-0.72, 0.72]), { off: 0.003, mirror: false });
    shape(c, 'reverse', 'rear', quad([0.5, 0.6], [0.62, 0.6], [0.62, 0.62], [0.5, 0.62]), { off: 0.005 });
    shape(c, 'black', 'rear', quad([-0.88, 0.29], [0.88, 0.29], [0.84, 0.52], [-0.84, 0.52]), { off: 0.003, mirror: false });
    diffuserFins(c, [-0.66, -0.44, -0.22, 0.0, 0.22, 0.44, 0.66], { zEnd: B.zR, zStart: -1.55, yLow: 0.102, yHigh: 0.27 });
    const flap = plateXZ([[-0.8, -2.0], [0.8, -2.0], [0.8, -2.3], [-0.8, -2.3]], 0.018, B.topY(-2.1, 0) + 0.0, 0.005);
    c.extra('wing', 'paint', flap, [0, B.topY(-2.0, 0), -2.0]);
    for (const x of [0.15, -0.15]) c.nozzle(x, 0.45, B.zR + 0.02, 'back', 'boost', 0.032, false);
    for (const z of [1.85, -1.85]) c.nozzle(0.42, 0.105, z, 'down', 'hover', 0.04, true);
  },
};

export const DESIGNS = { roadster, gt3rs, amgone, '720s': mcl720, revuelto, sf90, chiron, nevera };
void ellipse; void revolve;
