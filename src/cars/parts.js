// CARS agent — reusable procedural parts: revolve, wheels (tyre/rim/spokes/disc/caliper), wings,
// mirrors, exhausts, thruster nozzles + jets, swept tubes. All geometry is built in the car local
// frame (forward +Z, left +X, up +Y). Wheels are built for the LEFT side (outer face +X).
import * as THREE from 'three';
import { lerp, clamp } from './util.js';
import { mergeSimple } from './body.js';

const TAU = Math.PI * 2;

/**
 * Revolve a profile of [r, x] points around the X axis. Normals = perpendicular (dx, -dr) of the
 * profile tangent, so order the profile so that this points outward. Repeat a point for a crease.
 */
export function revolve(profile, segs, { a0 = 0, a1 = TAU, uScale = 1, flip = false, vByLength = true } = {}) {
  const n = profile.length;
  // per-point normals in (r,x) space
  const nr = new Float64Array(n), nx = new Float64Array(n);
  const segN = [];
  for (let i = 0; i < n - 1; i++) {
    const dr = profile[i + 1][0] - profile[i][0], dx = profile[i + 1][1] - profile[i][1];
    const l = Math.hypot(dr, dx);
    segN.push(l < 1e-9 ? null : [dx / l, -dr / l]);
  }
  for (let i = 0; i < n; i++) {
    const A = i > 0 ? segN[i - 1] : null, B = i < n - 1 ? segN[i] : null;
    // crease: if previous point equals this one, only use following segment and vice versa
    const dupPrev = i > 0 && segN[i - 1] === null, dupNext = i < n - 1 && segN[i] === null;
    let a = 0, b = 0;
    if (dupPrev && B) { a = B[0]; b = B[1]; }
    else if (dupNext && A) { a = A[0]; b = A[1]; }
    else { if (A) { a += A[0]; b += A[1]; } if (B) { a += B[0]; b += B[1]; } }
    const l = Math.hypot(a, b) || 1; nr[i] = (flip ? -a : a) / l; nx[i] = (flip ? -b : b) / l;
  }
  const vv = new Float64Array(n);
  for (let i = 1; i < n; i++) vv[i] = vv[i - 1] + (vByLength ? Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]) : 1);
  const vMax = vv[n - 1] || 1;
  const pos = [], nor = [], uv = [], idx = [];
  const full = Math.abs(a1 - a0 - TAU) < 1e-6;
  for (let k = 0; k <= segs; k++) {
    const a = lerp(a0, a1, k / segs), c = Math.cos(a), s = Math.sin(a);
    for (let i = 0; i < n; i++) {
      const [r, x] = profile[i];
      pos.push(x, r * c, r * s);
      nor.push(nx[i], nr[i] * c, nr[i] * s);
      uv.push((k / segs) * uScale, vv[i] / vMax);
    }
  }
  for (let k = 0; k < segs; k++) for (let i = 0; i < n - 1; i++) {
    if (segN[i] === null) continue;
    const a = k * n + i, b = a + 1, c2 = a + n, d = c2 + 1;
    idx.push(a, c2, b, b, c2, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  fixWinding(g);
  void full;
  return g;
}

/** Make triangle winding agree with the stored vertex normals (majority vote, then flip all). */
export function fixWinding(g) {
  const p = g.attributes.position.array, nn = g.attributes.normal.array, idx = g.index.array;
  let score = 0;
  const step = Math.max(3, Math.floor(idx.length / 60 / 3) * 3);
  for (let t = 0; t < idx.length; t += step) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    score += cx * (nn[a] + nn[b] + nn[c]) + cy * (nn[a + 1] + nn[b + 1] + nn[c + 1]) + cz * (nn[a + 2] + nn[b + 2] + nn[c + 2]) > 0 ? 1 : -1;
  }
  if (score < 0) { for (let t = 0; t < idx.length; t += 3) { const x = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = x; } g.index.needsUpdate = true; }
  return g;
}

/** Sweep a closed 2D cross-section (array of [u,v]) along a polyline path with up-vector. */
export function sweep(path, section, { closed = true, scaleFn = null, upRef = new THREE.Vector3(0, 1, 0), caps = true, smooth = true } = {}) {
  const n = path.length, m = section.length;
  const pos = [], idx = [];
  const T = new THREE.Vector3(), Nn = new THREE.Vector3(), B = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
    T.subVectors(b, a).normalize();
    B.crossVectors(T, upRef); if (B.lengthSq() < 1e-8) B.set(1, 0, 0); B.normalize();
    Nn.crossVectors(B, T).normalize();
    const sc = scaleFn ? scaleFn(i / (n - 1)) : [1, 1];
    for (let j = 0; j < m; j++) {
      const [u, v] = section[j];
      const P = path[i];
      pos.push(P.x + B.x * u * sc[0] + Nn.x * v * sc[1], P.y + B.y * u * sc[0] + Nn.y * v * sc[1], P.z + B.z * u * sc[0] + Nn.z * v * sc[1]);
    }
  }
  const mm = closed ? m : m - 1;
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < mm; j++) {
    const a = i * m + j, b = i * m + ((j + 1) % m), c = a + m, d = b + m;
    idx.push(a, b, c, b, d, c);
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  if (caps && closed) {
    // fan caps
    const base = pos.length / 3;
    const c0 = new THREE.Vector3(), c1 = new THREE.Vector3();
    for (let j = 0; j < m; j++) { c0.x += pos[j * 3] / m; c0.y += pos[j * 3 + 1] / m; c0.z += pos[j * 3 + 2] / m; const k = ((n - 1) * m + j) * 3; c1.x += pos[k] / m; c1.y += pos[k + 1] / m; c1.z += pos[k + 2] / m; }
    pos.push(c0.x, c0.y, c0.z, c1.x, c1.y, c1.z);
    for (let j = 0; j < m; j++) { idx.push(base, (j + 1) % m, j); idx.push(base + 1, (n - 1) * m + j, (n - 1) * m + ((j + 1) % m)); }
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
  }
  if (!smooth) { g = g.toNonIndexed(); }
  g.computeVertexNormals();
  return orientOutward(g);
}

/** Flip winding if most normals point toward the centroid (for closed convex-ish solids). */
export function orientOutward(g) {
  g.computeBoundingBox();
  const c = new THREE.Vector3(); g.boundingBox.getCenter(c);
  const p = g.attributes.position.array, nn = g.attributes.normal.array;
  let score = 0;
  for (let i = 0; i < p.length; i += 3) score += (p[i] - c.x) * nn[i] + (p[i + 1] - c.y) * nn[i + 1] + (p[i + 2] - c.z) * nn[i + 2];
  if (score < 0) {
    if (g.index) { const idx = g.index.array; for (let t = 0; t < idx.length; t += 3) { const x = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = x; } }
    else { const pa = g.attributes.position.array; for (let t = 0; t < pa.length; t += 9) for (let k = 0; k < 3; k++) { const x = pa[t + 3 + k]; pa[t + 3 + k] = pa[t + 6 + k]; pa[t + 6 + k] = x; } }
    g.computeVertexNormals();
  }
  return g;
}

/** Rounded-rect / superellipse section points. */
export function roundSection(w, h, n = 12, p = 4) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU, c = Math.cos(a), s = Math.sin(a);
    pts.push([w / 2 * Math.sign(c) * Math.pow(Math.abs(c), 2 / p), h / 2 * Math.sign(s) * Math.pow(Math.abs(s), 2 / p)]);
  }
  return pts;
}

// ------------------------------------------------------------------------------- wheels
const wheelGeoCache = new Map();

/**
 * Wheel geometry set for a LEFT wheel centred at origin, axle along X, outer face +X.
 * style: { spokes: n, type: 'split'|'y'|'straight'|'turbine'|'aero'|'mesh', centerLock, dish, spokeW, lip }
 * returns { tire, rim, rimDark, disc, caliper, hub, cover }
 */
export function wheelGeometry(R, W, style = {}, quality = 'high') {
  const key = [R, W, JSON.stringify(style), quality].join('|');
  if (wheelGeoCache.has(key)) return wheelGeoCache.get(key);
  const hi = quality === 'high', lo = quality === 'low';
  const segs = hi ? 56 : lo ? 20 : 36;
  const Rr = R - (style.sidewall ?? 0.082);  // rim radius
  const h = W / 2;
  // tyre profile (inner bead -> inner sidewall -> tread -> outer sidewall -> outer bead)
  const tp = [
    [Rr + 0.004, -h + 0.024], [Rr + 0.02, -h + 0.006], [R - 0.045, -h - 0.002], [R - 0.016, -h + 0.006], [R - 0.003, -h + 0.024],
  ];
  if (hi) {
    const gx = [-0.26, 0.0, 0.26];
    tp.push([R, -h * 0.6]);
    for (const g of gx) { const x = g * W; tp.push([R, x - 0.007], [R, x - 0.007], [R - 0.008, x - 0.006], [R - 0.008, x + 0.006], [R, x + 0.007], [R, x + 0.007]); }
    tp.push([R, h * 0.6]);
  } else tp.push([R, 0]);
  tp.push([R - 0.003, h - 0.024], [R - 0.016, h - 0.006], [R - 0.045, h + 0.002], [Rr + 0.02, h - 0.006], [Rr + 0.004, h - 0.024]);
  const tire = revolve(tp, segs, { uScale: 1 });

  // rim lip (polished) + barrel (inner, darker): lip at outer face
  const xl = h - 0.012;
  const lipP = [[Rr - 0.03, xl - 0.03], [Rr - 0.006, xl], [Rr - 0.006, xl], [Rr + 0.012, xl + 0.002], [Rr + 0.014, xl - 0.008]];
  const rimParts = [revolve(lipP, segs)];
  const barrel = revolve([[Rr - 0.004, xl - 0.025], [Rr - 0.012, -h + 0.03], [Rr + 0.01, -h + 0.02]], segs, { flip: true });
  // spokes
  const dish = style.dish ?? 0.05;
  const xFace = xl - 0.012;              // spoke face at rim end
  const xHub = xFace - dish;              // hub face (concave)
  const rh = style.hubR ?? 0.075;
  const spokes = [];
  const n = style.spokes ?? 10;
  const type = style.type || 'split';
  const sw = style.spokeW ?? 0.034;
  const st = style.spokeT ?? 0.03;
  const addSpoke = (a0, a1, r0, r1, w0, w1, x0, x1, t = st, bend = 0) => {
    const NS = hi ? 6 : 3;
    const path = [], ws = [];
    for (let i = 0; i <= NS; i++) {
      const u = i / NS;
      const r = lerp(r0, r1, u), a = lerp(a0, a1, u) + bend * Math.sin(u * Math.PI);
      const x = lerp(x0, x1, Math.pow(u, 0.8));
      path.push(new THREE.Vector3(x, r * Math.cos(a), r * Math.sin(a)));
      ws.push(lerp(w0, w1, u));
    }
    // section: trapezoid (face wider than back) — u across (tangential), v along axle
    const sec = [[-0.5, 0.5], [0.5, 0.5], [0.42, -0.5], [-0.42, -0.5]];
    const pos = [], idx = [];
    const T = new THREE.Vector3(), Bv = new THREE.Vector3(), Ax = new THREE.Vector3(1, 0, 0);
    for (let i = 0; i <= NS; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(NS, i + 1)];
      T.subVectors(b, a).normalize();
      Bv.crossVectors(T, Ax).normalize(); // tangential
      for (const [u, v] of sec) {
        const P = path[i];
        pos.push(P.x + Ax.x * v * t + Bv.x * u * ws[i], P.y + Bv.y * u * ws[i], P.z + Bv.z * u * ws[i]);
      }
    }
    for (let i = 0; i < NS; i++) for (let j = 0; j < 4; j++) {
      const a = i * 4 + j, b = i * 4 + ((j + 1) % 4), c = a + 4, d = b + 4;
      idx.push(a, b, c, b, d, c);
    }
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    g = g.toNonIndexed(); g.computeVertexNormals();
    orientOutward(g);
    const ii = []; for (let i = 0; i < g.attributes.position.count; i++) ii.push(i); g.setIndex(ii);
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    spokes.push(g);
  };
  const rEnd = Rr - 0.01;
  if (type === 'aero') {
    // flat dished cover with slots handled by darker inserts
    const cov = revolve([[0.0, xHub + 0.02], [rh, xHub + 0.018], [rEnd * 0.6, xFace - 0.006], [rEnd + 0.004, xFace + 0.002]], segs);
    spokes.push(cov);
  } else {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      if (type === 'split') {
        const d = (style.split ?? 0.07);
        addSpoke(a, a - d, rh * 0.9, rEnd, sw * 0.8, sw * 0.62, xHub, xFace);
        addSpoke(a, a + d, rh * 0.9, rEnd, sw * 0.8, sw * 0.62, xHub, xFace);
      } else if (type === 'y') {
        const mid = lerp(rh, rEnd, 0.42), d = style.split ?? 0.12;
        addSpoke(a, a, rh * 0.9, mid + 0.01, sw * 1.2, sw * 1.0, xHub, lerp(xHub, xFace, 0.55));
        addSpoke(a, a - d, mid, rEnd, sw * 0.75, sw * 0.55, lerp(xHub, xFace, 0.5), xFace);
        addSpoke(a, a + d, mid, rEnd, sw * 0.75, sw * 0.55, lerp(xHub, xFace, 0.5), xFace);
      } else if (type === 'turbine') {
        addSpoke(a, a + (style.twist ?? 0.35), rh * 0.9, rEnd, sw * 0.9, sw * 1.2, xHub, xFace, st * 0.8, 0.05);
      } else {
        addSpoke(a, a, rh * 0.9, rEnd, sw * 1.1, sw * 0.8, xHub, xFace);
      }
    }
  }
  // hub disc
  const hubP = [[0.0, xHub + 0.006], [rh * 0.7, xHub + 0.006], [rh, xHub - 0.004], [rh, xHub - 0.03]];
  const hubParts = [revolve(hubP, Math.max(16, segs >> 1))];
  if (style.centerLock) {
    const nut = revolve([[0, xHub + 0.045], [0.032, xHub + 0.045], [0.04, xHub + 0.035], [0.04, xHub]], 6, {});
    hubParts.push(nut);
  } else if (!lo) {
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU + 0.3;
      const nut = revolve([[0, xHub + 0.018], [0.009, xHub + 0.018], [0.011, xHub + 0.008], [0.011, xHub]], 6);
      nut.translate(0, 0.05 * Math.cos(a), 0.05 * Math.sin(a));
      hubParts.push(nut);
    }
  }
  const rim = mergeSimple([...rimParts, ...spokes, ...hubParts]);
  // brake disc (double sided ring plane facing x) + hat
  const discR = Math.min(Rr - 0.045, style.discR ?? 0.2);
  const dg = new THREE.PlaneGeometry(discR * 2, discR * 2);
  dg.rotateY(Math.PI / 2); dg.translate(-0.01, 0, 0);
  const discEdge = revolve([[discR, 0.008], [discR, -0.03]], Math.max(16, segs >> 1));
  const disc = mergeSimple([dg, discEdge]);
  // caliper: block over ~55deg at the rear-top quadrant, outboard of the disc
  const ca0 = -1.4, ca1 = -0.45;   // revolve angle a: (y,z) = (r cos a, r sin a) -> rear-top quadrant
  const cr0 = discR - 0.055, cr1 = discR + 0.018;
  const cp = [[cr0, 0.03], [cr1, 0.03], [cr1, 0.03], [cr1 + 0.006, 0.0], [cr1, -0.04], [cr0, -0.04]];
  const caliper = revolve([...cp, cp[0]], hi ? 10 : 5, { a0: ca0, a1: ca1 });
  // close the ends of the caliper with simple fans
  const res = { tire, rim, barrel, disc, caliper, Rr, xFace, xHub };
  wheelGeoCache.set(key, res);
  return res;
}

// ------------------------------------------------------------------------------- aero / bits
/** Airfoil shape (chord along +x from 0..c, thickness up). Returns THREE.Shape. */
export function airfoilShape(c, t, camber = 0.04, n = 14) {
  const sh = new THREE.Shape();
  const up = [], lo = [];
  for (let i = 0; i <= n; i++) {
    const x = (1 - Math.cos((i / n) * Math.PI)) / 2;
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x ** 4);
    const yc = camber * 4 * x * (1 - x);
    up.push([x * c, (yc + yt) * c]); lo.push([x * c, (yc - yt) * c]);
  }
  sh.moveTo(up[0][0], up[0][1]);
  for (let i = 1; i <= n; i++) sh.lineTo(up[i][0], up[i][1]);
  for (let i = n; i >= 0; i--) sh.lineTo(lo[i][0], lo[i][1]);
  return sh;
}

/** Wing: airfoil spanning x in [-span/2, span/2], leading edge at z=0 pointing +Z, trailing toward -Z. */
export function wingGeometry(span, chord, thick = 0.12, aoaDeg = 8, camber = -0.05, curveDown = 0) {
  const shape = airfoilShape(chord, thick, camber);
  const nSpan = curveDown ? 8 : 1;
  const g = new THREE.ExtrudeGeometry(shape, { depth: span, bevelEnabled: false, curveSegments: 1, steps: nSpan });
  // shape x (chord) -> -z, shape y -> y, depth -> x
  g.rotateY(Math.PI / 2);         // x' = z(depth), z' = -x(chord)
  g.translate(-span / 2, 0, 0);
  g.rotateX(-aoaDeg * Math.PI / 180 * -1);
  if (curveDown) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i) / (span / 2); p.setY(i, p.getY(i) - curveDown * x * x); }
    g.computeVertexNormals();
  }
  return g;
}

/** Thin plate from a 2D outline in the (z,y) plane, thickness along x, centred at x. */
export function plateZY(points, thickness, x = 0, bevel = 0.003) {
  const sh = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: thickness, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 4 });
  // shape x -> z, shape y -> y, depth -> x
  g.rotateY(-Math.PI / 2);       // x' = -z(depth) , z' = x(shape)
  g.translate(x + thickness / 2, 0, 0);
  return g;
}

/** Thin plate from a 2D outline in the (x,z) plane (top view), thickness along y. */
export function plateXZ(points, thickness, y = 0, bevel = 0.003) {
  const sh = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: thickness, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 4 });
  g.rotateX(-Math.PI / 2); // shape y(-z) -> -z..., depth -> y
  g.translate(0, y, 0);
  return g;
}

/** Thin plate from a 2D outline in the (x,y) plane (front view), thickness along z. */
export function plateXY(points, thickness, z = 0, bevel = 0.002) {
  const sh = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: thickness, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 6 });
  g.translate(0, 0, z - thickness / 2);
  return g;
}

/** Rounded rectangle / stadium outline as [[a,b],...] centred at (ca, cb). */
export function roundRect(ca, cb, w, h, r, n = 4) {
  const pts = [];
  r = Math.min(r, w / 2, h / 2);
  const cs = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 1], [-w / 2 + r, -h / 2 + r, 2], [w / 2 - r, -h / 2 + r, 3]];
  for (const [x, y, q] of cs) for (let i = 0; i <= n; i++) {
    const a = (q + i / n) * Math.PI / 2;
    pts.push([ca + x + r * Math.cos(a), cb + y + r * Math.sin(a)]);
  }
  return pts;
}

/** Ellipse outline */
export function ellipse(ca, cb, rx, ry, n = 20) {
  const pts = []; for (let i = 0; i < n; i++) { const a = (i / n) * TAU; pts.push([ca + rx * Math.cos(a), cb + ry * Math.sin(a)]); } return pts;
}

/** Side mirror (left side). base = attachment point on the door, returns {housing, glass, stalk}. */
export function mirrorGeometry(base, { len = 0.2, w = 0.2, h = 0.09, depth = 0.11, out = 0.16, up = 0.08, stalkW = 0.03 } = {}) {
  // housing: superellipsoid-ish lathe (teardrop) along z, then scaled
  const prof = [];
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const t = i / N; // 0 front (nose) -> 1 rear face
    const r = Math.pow(Math.sin(Math.min(1, t * 1.15) * Math.PI / 2), 0.7) * (t > 0.96 ? 0.92 : 1);
    prof.push([Math.max(0.001, r), t]);
  }
  prof.push([0.0, 1.0]);
  const hg = revolve(prof, 16);                  // around X axis, x in [0,1]
  hg.rotateY(Math.PI / 2);                      // x -> -z ; nose at z=0 pointing +z?  (x' = z, z' = -x)
  // now housing extends from z=0 (nose) to z=-1 (rear face)
  hg.scale(w / 2, h / 2, depth);
  hg.translate(base.x + out, base.y + up, base.z + depth * 0.4);
  const glass = new THREE.CircleGeometry(1, 16);
  glass.rotateY(Math.PI);                       // face -z
  glass.scale(w / 2 * 0.86, h / 2 * 0.8, 1);
  glass.translate(base.x + out, base.y + up, base.z + depth * 0.4 - depth * 0.985);
  // stalk: swept blade from door to housing
  const path = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    path.push(new THREE.Vector3(base.x + out * t, base.y + up * Math.pow(t, 0.6), base.z - 0.02 * t));
  }
  const stalk = sweep(path, roundSection(stalkW * 2.2, stalkW, 8), { upRef: new THREE.Vector3(0, 0, 1) });
  return { housing: hg, glass, stalk };
}

/** Exhaust tip along -Z at (x,y,z). shape 'round'|'hex'|'oval'|'square'. */
export function exhaustGeometry(x, y, z, r, len = 0.12, shape = 'round', sy = 1) {
  const segs = shape === 'hex' ? 6 : shape === 'square' ? 4 : 18;
  const outer = new THREE.CylinderGeometry(r, r * 0.96, len, segs, 1, true);
  outer.rotateX(Math.PI / 2);
  if (shape === 'hex') outer.rotateZ(Math.PI / 6);
  if (shape === 'square') outer.rotateZ(Math.PI / 4);
  outer.scale(1, sy, 1);
  outer.translate(x, y, z - len / 2);
  // lip ring
  const ring = new THREE.RingGeometry(r * 0.82, r * 1.0, segs);
  ring.rotateY(Math.PI); if (shape === 'hex') ring.rotateZ(Math.PI / 6); if (shape === 'square') ring.rotateZ(Math.PI / 4);
  ring.scale(1, sy, 1); ring.translate(x, y, z - len + 0.001);
  const inner = new THREE.CircleGeometry(r * 0.84, segs);
  inner.rotateY(Math.PI); if (shape === 'hex') inner.rotateZ(Math.PI / 6); if (shape === 'square') inner.rotateZ(Math.PI / 4);
  inner.scale(1, sy, 1); inner.translate(x, y, z - len + 0.03);
  const innerTube = new THREE.CylinderGeometry(r * 0.84, r * 0.84, 0.03, segs, 1, true);
  innerTube.rotateX(Math.PI / 2); if (shape === 'hex') innerTube.rotateZ(Math.PI / 6);
  innerTube.scale(1, sy, 1); innerTube.translate(x, y, z - len + 0.015);
  // flip inner tube to face inward
  const it = innerTube.index.array; for (let i = 0; i < it.length; i += 3) { const t = it[i + 1]; it[i + 1] = it[i + 2]; it[i + 2] = t; }
  const nn = innerTube.attributes.normal.array; for (let i = 0; i < nn.length; i++) nn[i] = -nn[i];
  return { metal: mergeSimple([outer, ring].map(nz)), dark: mergeSimple([inner, innerTube].map(nz)) };
}

function nz(g) { if (!g.index) { const ii = []; for (let i = 0; i < g.attributes.position.count; i++) ii.push(i); g.setIndex(ii); } return g; }

/** Thruster nozzle (bell) along +Z of a local frame; returns geometry for metal + dark inner ring. */
export function nozzleGeometry(r, len = 0.06) {
  const bell = revolve([[r * 0.55, -len], [r * 0.7, -len * 0.5], [r, 0], [r, 0], [r * 0.88, -0.004], [r * 0.5, -len * 0.7]], 16);
  // revolve is around X: rotate so axis -> Z
  bell.rotateY(-Math.PI / 2); // x -> z
  const inner = new THREE.CircleGeometry(r * 0.86, 16);
  inner.translate(0, 0, -len * 0.55);
  return { metal: bell, inner };
}

/** Jet: 3 crossed tapered planes along +Z from 0..1 (scaled at runtime; u across, v along). */
let jetGeo = null;
export function jetGeometry() {
  if (jetGeo) return jetGeo;
  const pos = [], uv = [], idx = [];
  const NZ = 6;
  for (let k = 0; k < 3; k++) {
    const ang = (k / 3) * Math.PI;
    const cx = Math.cos(ang), cy = Math.sin(ang);
    const base = pos.length / 3;
    for (let i = 0; i <= NZ; i++) {
      const v = i / NZ, w = 1 + 1.4 * v;
      for (const u of [0, 1]) { const x = (u * 2 - 1) * w; pos.push(x * cx, x * cy, v); uv.push(u, v); }
    }
    for (let i = 0; i < NZ; i++) { const a = base + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  jetGeo = g;
  return jetGeo;
}
