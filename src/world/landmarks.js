// Hand-built procedural landmark meshes at real positions (from the bake). Collision footprints live in
// landmarkdefs.js and share the same dimensions.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GG, DIMS, makeDeckProfile, landmarkById } from './landmarkdefs.js';

// ---------------------------------------------------------------- helpers
function canvasTex(w, h, draw, { repeat = [1, 1], srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** window grid texture: returns {map, lit} canvases textures. cols x rows windows per tile */
function windowTextures({ cols = 4, rows = 4, wall = '#e9e6df', glass = '#3d4b57', glassHi = '#7d8f9c', ww = 0.55, wh = 0.6, seed = 1, litFrac = 0.4 }) {
  const S = 256;
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const rects = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cw = S / cols, rh = S / rows;
    rects.push([c * cw + (cw * (1 - ww)) / 2, r * rh + (rh * (1 - wh)) / 2, cw * ww, rh * wh]);
  }
  const map = canvasTex(S, S, (g) => {
    g.fillStyle = wall; g.fillRect(0, 0, S, S);
    for (const [x, y, w, h] of rects) {
      const gr = g.createLinearGradient(x, y, x + w, y + h);
      gr.addColorStop(0, glassHi); gr.addColorStop(1, glass);
      g.fillStyle = gr; g.fillRect(x, y, w, h);
    }
  });
  const lit = canvasTex(S, S, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
    for (const [x, y, w, h] of rects) {
      if (rnd() > litFrac) continue;
      const v = 150 + rnd() * 105;
      g.fillStyle = `rgb(${v},${v * 0.82},${v * 0.55})`;
      g.fillRect(x, y, w, h);
    }
  });
  return { map, lit };
}

function box(w, h, d, x = 0, y = 0, z = 0) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z);
}
/** box whose top is scaled (taper) */
function taperBox(w0, d0, w1, d1, h, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i);
    p.setXYZ(i, p.getX(i) * (w0 + (w1 - w0) * t) + x, t * h + y, p.getZ(i) * (d0 + (d1 - d0) * t) + z);
  }
  g.computeVertexNormals();
  return g;
}
function cyl(rt, rb, h, seg, x = 0, y = 0, z = 0, open = false) {
  return new THREE.CylinderGeometry(rt, rb, h, seg, 1, open).translate(x, y + h / 2, z);
}
function mergeAll(list) {
  const clean = list.filter(Boolean).map((g) => {
    const ng = g.index ? g : g;
    if (!ng.attributes.uv) {
      ng.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(ng.attributes.position.count * 2), 2));
    }
    for (const k of Object.keys(ng.attributes)) if (!['position', 'normal', 'uv'].includes(k)) ng.deleteAttribute(k);
    return ng.index ? ng.toNonIndexed() : ng;
  });
  return mergeGeometries(clean, false);
}

function std(color, rough = 0.8, metal = 0, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}

// ---------------------------------------------------------------- builders
export function buildLandmarks(D, Q, { quality = 'high', uniforms } = {}) {
  const root = new THREE.Group();
  root.name = 'landmarks';
  const night = [];   // { mat, base } emissive driven by setNight
  const addMesh = (parent, geo, mat, { cast = true, receive = true } = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast; m.receiveShadow = receive;
    parent.add(m);
    return m;
  };
  const lmGroup = (lm, y = null) => {
    const g = new THREE.Group();
    g.position.set(lm.x, y == null ? Q.heightAt(lm.x, lm.z) : y, lm.z);
    g.rotation.y = -(lm.rot || 0);
    root.add(g);
    return g;
  };
  const glow = (color, base) => {
    const m = std(0x222222, 0.5, 0, { emissive: new THREE.Color(color), emissiveIntensity: base });
    night.push({ mat: m, base: 0.15 * base, add: base });
    return m;
  };
  const idx = D.index;
  let l;

  // ------------------------------------------------ Golden Gate Bridge
  const orange = std(0xb8402e, 0.55, 0.25);
  orange.emissive = new THREE.Color(0xff6a3a); orange.emissiveIntensity = 0;
  night.push({ mat: orange, base: 0, add: 0.12 });
  if (idx.ggbridge) {
    const P = makeDeckProfile(idx.ggbridge);
    const g = new THREE.Group();
    g.position.set(P.cx, 0, P.cz);
    g.rotation.y = Math.atan2(P.ax, P.az);   // local +Z = bridge axis (north); local X = -lateral
    root.add(g);
    const parts = [], concrete = [], deckTop = [], cableParts = [], red = [];
    const T = P.halfSpan;
    const lc = (GG.legInner + GG.legOuter) / 2;
    for (const tz of [-T, T]) {
      for (const sx of [-1, 1]) {
        // art-deco setbacks
        const segs = [[-6, 96, 8.0, 16], [96, 156, 7.4, 14], [156, 196, 6.8, 12.5], [196, 227, 6.2, 11]];
        for (const [y0, y1, w, d] of segs) parts.push(box(w, y1 - y0, d, sx * lc, y0, tz));
      }
      // portal struts above the deck + one below
      for (const [y, h] of [[100, 6], [160, 5], [199, 4], [221, 6]]) parts.push(box(2 * lc - 4, h, 8, 0, y, tz));
      parts.push(box(2 * lc, 4, 9, 0, 50, tz));
      concrete.push(box(2 * lc + 26, 12, 42, 0, -6, tz));   // pier fender
      for (const sx of [-1, 1]) red.push(new THREE.SphereGeometry(0.9, 8, 6).translate(sx * lc, 228.5, tz));
    }
    // deck (slab, stiffening trusses, railings) following slices + profile
    const segGeo = (xa0, xa1, xb0, xb1, yb0, yt0, yb1, yt1, t, t1) => {
      const v = [[xa0, yb0, t], [xa1, yb0, t], [xa1, yt0, t], [xa0, yt0, t], [xb0, yb1, t1], [xb1, yb1, t1], [xb1, yt1, t1], [xb0, yt1, t1]];
      const f = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
      const pos = [];
      for (const q of f) { const [a, b, c, d] = q.map((k) => v[k]); pos.push(...a, ...c, ...b, ...a, ...d, ...c); }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      return geo;
    };
    const sl = P.slices;
    for (let i = 0; i + 1 < sl.lmin.length; i++) {
      const t = sl.t0 + i * sl.step, t1 = t + sl.step;
      if (t1 < P.tmin || t > P.tmax) continue;
      const h0 = P.heightAtT(t), h1 = P.heightAtT(t1);
      // local x = -lateral
      const a0 = -sl.lmax[i], a1 = -sl.lmin[i], b0 = -sl.lmax[i + 1], b1 = -sl.lmin[i + 1];
      if (a1 - a0 < 1 || b1 - b0 < 1) continue;
      const truss = Math.abs(t) < T + 400 ? 7.6 : 3.0;
      for (const [ea, eb] of [[a0, b0], [a1, b1]]) {
        parts.push(segGeo(ea - 0.5, ea + 0.5, eb - 0.5, eb + 0.5, h0 - truss, h0 - 0.4, h1 - truss, h1 - 0.4, t, t1));
        parts.push(segGeo(ea - 0.15, ea + 0.15, eb - 0.15, eb + 0.15, h0 - 0.2, h0 + 1.1, h1 - 0.2, h1 + 1.1, t, t1));
      }
      parts.push(segGeo(a0, a1, b0, b1, h0 - truss - 0.2, h0 - truss + 0.6, h1 - truss - 0.2, h1 - truss + 0.6, t, t1));
      deckTop.push(segGeo(a0, a1, b0, b1, h0 - 1.2, h0 - 0.03, h1 - 1.2, h1 - 0.03, t, t1));
      // approach piers where the deck is well above ground
      if (Math.abs(t) > T + 30 && i % 6 === 0) {
        const lm = -(a0 + a1) / 2;
        const wx = P.cx + P.ax * t - P.az * lm, wz = P.cz + P.az * t + P.ax * lm;
        const gnd = Math.max(-2, Q.heightAt(wx, wz));
        const top = h0 - truss;
        if (top - gnd > 4) for (const e of [a0 + 3, a1 - 3]) concrete.push(box(3.5, top - gnd + 2, 5, e, gnd - 2, t));
      }
    }
    // anchorage housings
    for (const sgn of [-1, 1]) {
      const ta = sgn * (T + 343);
      const ha = P.heightAtT(ta);
      const gnd = Math.max(-3, Q.heightAt(P.cx + P.ax * ta, P.cz + P.az * ta));
      if (ha - gnd > 8) concrete.push(box(44, ha - gnd - 8, 34, 0, gnd - 2, ta));
    }
    // main cables (parabolic main span, sagging side spans) + suspenders
    const cx = lc, ctop = 225.5, cmid = P.heightAtT(0) + 3.0;
    const cableY = (t) => {
      const a = Math.abs(t);
      if (a <= T) return cmid + (ctop - cmid) * (t / T) ** 2;
      const u = (a - T) / 343;
      const ya = P.heightAtT(Math.sign(t) * (T + 343)) + 2;
      return ctop + (ya - ctop) * u - Math.sin(u * Math.PI) * 12;
    };
    const susp = [];
    for (const sx of [-1, 1]) {
      const pts = [];
      for (let t = -T - 343; t <= T + 343 + 0.1; t += 16) pts.push(new THREE.Vector3(sx * cx, cableY(t), t));
      cableParts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 180, 0.5, 6, false));
      for (let t = -T - 343 + 15; t < T + 343; t += 15) {
        if (Math.abs(Math.abs(t) - T) < 10) continue;
        const yc = cableY(t), yd = P.heightAtT(t) + 0.8;
        if (yc - yd < 1) continue;
        susp.push(box(0.16, yc - yd, 0.16, sx * cx, yd, t));
      }
    }
    addMesh(g, mergeAll(parts), orange);
    addMesh(g, mergeAll(cableParts.concat(susp)), orange, { cast: true });
    addMesh(g, mergeAll(concrete), std(0x9a968e, 0.9));
    addMesh(g, mergeAll(deckTop), std(0x6d6a66, 0.9), { cast: false });
    addMesh(g, mergeAll(red), glow(0xff2010, 2.5), { cast: false, receive: false });
  }

  // ------------------------------------------------ Bay Bridge west span (scenery)
  if ((l = landmarkById(idx, 'baybridge')) && l.span) {
    const steel = std(0x8c949c, 0.5, 0.6);
    let [a, b] = l.span;
    if (a[0] > b[0]) [a, b] = [b, a];   // a = SF end
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    const g = new THREE.Group();
    g.position.set(a[0], 0, a[1]);
    g.rotation.y = Math.atan2(dx, dz);
    root.add(g);
    const proj = (p) => (p[0] - a[0]) * (dx / L) + (p[1] - a[1]) * (dz / L);
    const towers = (l.towers || []).map(proj).sort((x, y) => x - y);
    const anch = l.anchorage ? proj(l.anchorage) : L / 2;
    const deckY = (t) => Math.min(58, 26 + Math.max(0, t) * 0.11);
    const parts = [], conc = [], cables = [], bayLights = [];
    for (let t = 0; t < L; t += 25) {
      const y0 = deckY(t), y1 = deckY(Math.min(L, t + 25));
      const ym = (y0 + y1) / 2;
      parts.push(box(21, 8.5, 25.5, 0, ym - 8.5, t + 12.5));
      const wx = a[0] + (dx / L) * (t + 12.5), wz = a[1] + (dz / L) * (t + 12.5);
      if (Math.round(t) % 75 === 0) {
        const gnd = Math.max(-5, Q.heightAt(wx, wz));
        if (ym - 8.5 - gnd > 3) for (const sx of [-1, 1]) conc.push(box(3.5, ym - 8.5 - gnd + 5, 5, sx * 7, gnd - 5, t + 12.5));
      }
    }
    const TH = 150;
    for (const tt of towers) {
      for (const sx of [-1, 1]) parts.push(taperBox(6, 7, 4.5, 5, TH + 5, sx * 13, -5, tt));
      for (const y of [70, 100, 125, 148]) parts.push(box(26, 3, 3, 0, y, tt));
      conc.push(box(40, 10, 22, 0, -6, tt));
    }
    conc.push(taperBox(46, 70, 38, 56, 96, 0, -8, anch));   // central anchorage
    // cables: SF anchor (t=towers[0]-350) -> W2 -> W3 -> anchorage -> W5 -> W6 -> YBI
    const tw = towers.length === 4 ? towers : [L * 0.15, L * 0.38, L * 0.62, L * 0.85];
    const knots = [[tw[0] - 330, 50], [tw[0], TH], [tw[1], TH], [anch, 88], [tw[2], TH], [tw[3], TH], [Math.min(L, tw[3] + 330), 60]];
    const cy = (t) => {
      for (let k = 0; k < knots.length - 1; k++) {
        const [t0, y0] = knots[k], [t1, y1] = knots[k + 1];
        if (t >= t0 && t <= t1) {
          const u = (t - t0) / (t1 - t0);
          const sag = k === 1 || k === 4 ? 82 : 22;
          return y0 + (y1 - y0) * u - Math.sin(u * Math.PI) * sag;
        }
      }
      return 60;
    };
    for (const sx of [-1, 1]) {
      const pts = [];
      for (let t = knots[0][0]; t <= knots[knots.length - 1][0]; t += 15) pts.push(new THREE.Vector3(sx * 12, cy(t), t));
      cables.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 200, 0.45, 5, false));
      for (let t = knots[0][0] + 10; t < knots[knots.length - 1][0]; t += 16) {
        const y = cy(t), d = deckY(t);
        if (y - d > 2) bayLights.push(box(0.2, y - d, 0.2, sx * 12, d, t));
      }
    }
    addMesh(g, mergeAll(parts), steel);
    addMesh(g, mergeAll(conc), std(0x9c978e, 0.9));
    addMesh(g, mergeAll(cables), steel);
    // "The Bay Lights": LED strands on the suspenders, glowing at night
    const bl = std(0x9aa0a6, 0.5, 0.5, { emissive: new THREE.Color(0xdfe8ff), emissiveIntensity: 0 });
    night.push({ mat: bl, base: 0, add: 1.6 });
    addMesh(g, mergeAll(bayLights), bl, { cast: false });
  }

  // ------------------------------------------------ Transamerica Pyramid
  if ((l = landmarkById(idx, 'transamerica'))) {
    const g = lmGroup(l);
    const d = DIMS.transamerica;
    const wt = windowTextures({ cols: 6, rows: 4, wall: '#f1eee7', glass: '#33404a', glassHi: '#6e8190', ww: 0.42, wh: 0.5, seed: 3, litFrac: 0.5 });
    wt.map.repeat.set(6, 12); wt.lit.repeat.set(6, 12);
    const m = std(0xffffff, 0.6, 0.05, { map: wt.map, emissiveMap: wt.lit, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0 });
    night.push({ mat: m, base: 0, add: 1.3 });
    const r0 = (d.base / 2) * Math.SQRT2, r1 = 7.5 * Math.SQRT2;
    const body = new THREE.CylinderGeometry(r1, r0, 212, 4, 1, true).rotateY(Math.PI / 4).translate(0, 106, 0);
    addMesh(g, body, m);
    const white = std(0xf2efe8, 0.55);
    const wings = [box(10, 85, 6, 0, 135, 13.2), box(10, 85, 6, 0, 135, -13.2)];
    wings.push(new THREE.CylinderGeometry(0, r1, 48, 4).rotateY(Math.PI / 4).translate(0, 212 + 24, 0));
    wings.push(box(d.base + 6, 3, d.base + 6, 0, 0, 0));
    addMesh(g, mergeAll(wings), white);
    addMesh(g, new THREE.SphereGeometry(0.8, 8, 6).translate(0, 260.5, 0), glow(0xff2a10, 2), { cast: false });
  }

  // ------------------------------------------------ Salesforce Tower
  if ((l = landmarkById(idx, 'salesforce'))) {
    const g = lmGroup(l);
    const d = DIMS.salesforce;
    const shape = roundedSquare(d.base / 2, 11, 6);
    const wt = windowTextures({ cols: 8, rows: 2, wall: '#dfe3e6', glass: '#5d7486', glassHi: '#a9bccb', ww: 0.92, wh: 0.72, seed: 5, litFrac: 0.45 });
    const m = std(0xffffff, 0.25, 0.5, { map: wt.map, emissiveMap: wt.lit, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0 });
    wt.map.repeat.set(3, 0.5); wt.lit.repeat.set(3, 0.5);
    night.push({ mat: m, base: 0, add: 1.1 });
    addMesh(g, taperedPrism(shape, 0, 296, 1.0, 0.86, 20), m);
    // crown: LED screen at night
    const crownTex = canvasTex(512, 64, (c, w, h) => {
      const gr = c.createLinearGradient(0, 0, w, 0);
      gr.addColorStop(0, '#2a6cff'); gr.addColorStop(0.3, '#9be7ff'); gr.addColorStop(0.55, '#ffffff'); gr.addColorStop(0.8, '#ff7ad9'); gr.addColorStop(1, '#2a6cff');
      c.fillStyle = gr; c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(0,0,0,0.35)';
      for (let x = 0; x < w; x += 8) c.fillRect(x, 0, 2, h);
    });
    const crown = std(0xd8dde2, 0.35, 0.4, { emissiveMap: crownTex, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0 });
    night.push({ mat: crown, base: 0, add: 1.8 });
    uniforms.animated.push((t) => { crownTex.offset.x = (t * 0.03) % 1; });
    addMesh(g, taperedPrism(roundedSquare(d.base / 2 * 0.86, 9.5, 6), 296, 326, 1.0, 0.82, 1, true), crown);
  }

  // ------------------------------------------------ Coit Tower
  if ((l = landmarkById(idx, 'coit'))) {
    const g = lmGroup(l);
    const d = DIMS.coit;
    const conc = std(0xe7e1d3, 0.85);
    const pts = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2, r = i % 2 ? d.r * 0.93 : d.r;
      pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
    }
    const col = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: d.height - 8, bevelEnabled: false }).rotateX(-Math.PI / 2);
    const top = [col, cyl(d.r * 1.04, d.r * 1.04, 1.5, 24, 0, d.height - 8, 0), cyl(d.r * 0.98, d.r * 0.98, 6, 24, 0, d.height - 6.5, 0),
      cyl(d.r * 1.06, d.r * 1.06, 1.2, 24, 0, d.height - 0.6, 0), box(24, 8, 24, 0, -2, 0), box(28, 1.2, 28, 0, 5.6, 0)];
    addMesh(g, mergeAll(top), conc);
    // arched lookout openings (dark) + floodlight glow at night
    const ring = cyl(d.r * 1.0, d.r * 1.0, 4.2, 24, 0, d.height - 5.6, 0, true);
    addMesh(g, ring, std(0x2a2a2a, 0.9), { cast: false });
    conc.emissive = new THREE.Color(1, 0.86, 0.66); conc.emissiveIntensity = 0;
    night.push({ mat: conc, base: 0, add: 0.25 });
  }

  // ------------------------------------------------ Ferry Building
  if ((l = landmarkById(idx, 'ferry'))) {
    const g = lmGroup(l);
    const d = DIMS.ferry;
    const L = Math.max(l.L || d.L, 120), W = Math.min(Math.max(l.W || d.W, 25), 45);
    const front = l.front || -1;       // city side = front * V
    const wt = windowTextures({ cols: 2, rows: 1, wall: '#e7dfcf', glass: '#3a3f44', glassHi: '#77808a', ww: 0.45, wh: 0.62, seed: 9, litFrac: 0.7 });
    wt.map.repeat.set(1, 1); wt.lit.repeat.set(1, 1);
    const stone = std(0xffffff, 0.8, 0, { map: wt.map, emissiveMap: wt.lit, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0 });
    night.push({ mat: stone, base: 0, add: 1.0 });
    const hall = box(L, d.height, W, 0, -2, 0);
    setBoxUV(hall, L, d.height, W, 6, 5);
    addMesh(g, hall, stone);
    const roofM = std(0x6f7a72, 0.7);
    addMesh(g, mergeAll([box(L + 1, 1.2, W + 1, 0, d.height - 2, 0), taperBox(L - 6, W - 8, L - 30, 4, 6, 0, d.height - 0.8, 0)]), roofM);
    // clock tower on the city side
    const tz = front * (W / 2 - 8);
    const plain = std(0xece5d6, 0.8);
    const tower = [box(d.towerW, 48, d.towerW, 0, 0, tz), box(d.towerW - 2, 10, d.towerW - 2, 0, 48, tz), box(d.towerW - 4, 7, d.towerW - 4, 0, 58, tz),
      box(d.towerW - 6, 4, d.towerW - 6, 0, 65, tz)];
    tower.push(new THREE.CylinderGeometry(0, 3.6, 7, 8).translate(0, 72.5, tz));
    addMesh(g, mergeAll(tower), plain);
    const clock = glow(0xfff2c8, 0.0);
    clock.color.set(0xf4f0e2);
    const faces = [];
    for (const [ox, oz, ry] of [[0, d.towerW / 2 - 0.9, 0], [0, -d.towerW / 2 + 0.9, Math.PI], [d.towerW / 2 - 0.9, 0, Math.PI / 2], [-d.towerW / 2 + 0.9, 0, -Math.PI / 2]]) {
      faces.push(new THREE.CircleGeometry(3.2, 20).rotateY(ry).translate(ox * 1.0 + Math.sin(ry) * 0.0, 52.5, tz + oz + Math.cos(ry) * 0.0).translate(Math.sin(ry) * 1.0, 0, Math.cos(ry) * 1.0));
    }
    addMesh(g, mergeAll(faces), clock, { cast: false });
  }

  // ------------------------------------------------ Palace of Fine Arts
  if ((l = landmarkById(idx, 'finearts'))) {
    const g = lmGroup(l);
    const ochre = std(0xc9a27e, 0.85), domeM = std(0xb06a48, 0.7);
    const parts = [];
    const R = 17;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      for (const da of [-0.09, 0.09]) parts.push(cyl(1.1, 1.3, 20, 8, Math.cos(a + da) * R, 0, Math.sin(a + da) * R));
      parts.push(box(4.5, 6, 4.5, Math.cos(a) * R, 20, Math.sin(a) * R));
    }
    parts.push(cyl(R + 2, R + 2, 4, 8, 0, 20, 0, true), cyl(R + 2, R + 2, 0.5, 8, 0, 24, 0));
    parts.push(cyl(R - 1, R, 7, 16, 0, 24, 0));
    // colonnade arcs (away from the lagoon)
    for (const side of [-1, 1]) {
      for (let k = 0; k < 14; k++) {
        const a = side * (0.55 + k * 0.075) + Math.PI;
        const x = Math.cos(a) * 62, z = Math.sin(a) * 62;
        parts.push(cyl(0.8, 0.9, 13, 8, x, 0, z));
      }
      const pts = [];
      for (let k = 0; k <= 14; k++) { const a = side * (0.55 + k * 0.075) + Math.PI; pts.push(new THREE.Vector3(Math.cos(a) * 62, 14, Math.sin(a) * 62)); }
      parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 1.2, 4, false));
    }
    addMesh(g, mergeAll(parts), ochre);
    addMesh(g, new THREE.SphereGeometry(R, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.05, 1).translate(0, 31, 0), domeM);
    ochre.emissive = new THREE.Color(1, 0.8, 0.6); ochre.emissiveIntensity = 0;
    night.push({ mat: ochre, base: 0, add: 0.3 });
  }

  // ------------------------------------------------ City Hall
  if ((l = landmarkById(idx, 'cityhall'))) {
    const g = lmGroup(l);
    const d = DIMS.cityhall;
    const L = Math.max(l.L || d.L, 90), W = Math.max(l.W || d.W, 60);
    const wt = windowTextures({ cols: 1, rows: 1, wall: '#e2ddd0', glass: '#384048', glassHi: '#6c7884', ww: 0.4, wh: 0.55, seed: 13, litFrac: 0.6 });
    const granite = std(0xffffff, 0.8, 0, { map: wt.map, emissiveMap: wt.lit, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0 });
    night.push({ mat: granite, base: 0, add: 0.9 });
    const base = box(L, d.height + 3, W, 0, -3, 0);
    setBoxUV(base, L, d.height + 3, W, 3.5, 4.5);
    addMesh(g, base, granite);
    const plain = std(0xe4dfd2, 0.8);
    const parts = [box(L + 1, 1.5, W + 1, 0, d.height, 0), box(40, 6, 40, 0, d.height, 0)];
    for (let i = 0; i < 20; i++) { const a = (i / 20) * Math.PI * 2; parts.push(cyl(0.9, 0.9, 14, 8, Math.cos(a) * 22, d.height + 6, Math.sin(a) * 22)); }
    parts.push(cyl(20.5, 20.5, 14, 24, 0, d.height + 6, 0), cyl(23.5, 23.5, 2, 24, 0, d.height + 20, 0));
    addMesh(g, mergeAll(parts), plain);
    const dome = std(0x7f949a, 0.45, 0.4);
    addMesh(g, new THREE.SphereGeometry(21, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.55, 1).translate(0, d.height + 22, 0), dome);
    const gold = std(0xd2a94c, 0.3, 0.9);
    addMesh(g, mergeAll([cyl(3.2, 3.6, 7, 12, 0, d.domeH - 12, 0), new THREE.SphereGeometry(2.6, 12, 8).translate(0, d.domeH - 3.5, 0), cyl(0.4, 0.4, 3, 6, 0, d.domeH - 2, 0)]), gold);
    plain.emissive = new THREE.Color(0.95, 0.85, 1.0); plain.emissiveIntensity = 0;
    night.push({ mat: plain, base: 0, add: 0.35 });
    dome.emissive = new THREE.Color(0.6, 0.75, 1.0); dome.emissiveIntensity = 0;
    night.push({ mat: dome, base: 0, add: 0.25 });
  }

  // ------------------------------------------------ Alcatraz
  if ((l = landmarkById(idx, 'alcatraz'))) {
    const d = DIMS.alcatraz;
    const gy = Q.heightAt(l.x, l.z);
    const g = lmGroup(l, gy);
    const wt = windowTextures({ cols: 6, rows: 3, wall: '#d9d1c0', glass: '#2a2e31', glassHi: '#4c5459', ww: 0.5, wh: 0.55, seed: 21, litFrac: 0.15 });
    wt.map.repeat.set(1, 1);
    const cell = std(0xffffff, 0.9, 0, { map: wt.map });
    const ch = box(d.cellL, d.cellH + 6, d.cellW, 0, -6, 0);
    setBoxUV(ch, d.cellL, d.cellH + 6, d.cellW, 12, 6);
    addMesh(g, ch, cell);
    addMesh(g, mergeAll([box(d.cellL + 1, 1, d.cellW + 1, 0, d.cellH, 0), box(30, 6, 20, d.cellL / 2 - 15, d.cellH, 0)]), std(0x8e8a82, 0.85));
    // lighthouse
    const lx = -d.cellL / 2 - 22, lz = 8;
    const wp = [l.x + Math.cos(l.rot) * lx - Math.sin(l.rot) * lz, l.z + Math.sin(l.rot) * lx + Math.cos(l.rot) * lz];
    const lgy = Q.heightAt(wp[0], wp[1]) - gy;
    addMesh(g, mergeAll([taperBox(4.2, 4.2, 2.6, 2.6, d.lightH - 4, lx, lgy - 1, lz), box(4, 0.6, 4, lx, lgy + d.lightH - 5, lz)]), std(0xeeeae2, 0.7));
    const lamp = glow(0xfff1b0, 0.4);
    addMesh(g, cyl(1.2, 1.2, 2.6, 8, lx, lgy + d.lightH - 4.4, lz), lamp, { cast: false });
    addMesh(g, new THREE.ConeGeometry(1.5, 1.5, 8).translate(lx, lgy + d.lightH - 1, lz), std(0x333333, 0.6));
    // water tower (north end)
    const wx = d.cellL / 2 + 40, wz = -20;
    const wgy = Q.heightAt(l.x + Math.cos(l.rot) * wx - Math.sin(l.rot) * wz, l.z + Math.sin(l.rot) * wx + Math.cos(l.rot) * wz) - gy;
    const rust = std(0x8a5a3c, 0.85, 0.3);
    const wtp = [cyl(6, 6, 7, 16, wx, wgy + 16, wz), new THREE.ConeGeometry(6.4, 2.5, 16).translate(wx, wgy + 24.2, wz)];
    for (const [ox, oz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) wtp.push(box(0.6, 17, 0.6, wx + ox, wgy - 1, wz + oz));
    addMesh(g, mergeAll(wtp), rust);
  }

  // ------------------------------------------------ Pier 39 entrance sign
  if ((l = landmarkById(idx, 'pier39'))) {
    const g = lmGroup(l);
    const tex = canvasTex(512, 128, (c, w, h) => {
      c.fillStyle = '#1d3f6e'; c.fillRect(0, 0, w, h);
      c.strokeStyle = '#f2c14e'; c.lineWidth = 8; c.strokeRect(6, 6, w - 12, h - 12);
      c.fillStyle = '#ffffff'; c.font = 'bold 84px Georgia, serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('PIER 39', w / 2, h / 2 + 4);
    }, { repeat: [1, 1] });
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    const signM = std(0xffffff, 0.6, 0, { map: tex, emissiveMap: tex, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0.05 });
    night.push({ mat: signM, base: 0.05, add: 0.9 });
    const wood = std(0x6b5440, 0.9);
    addMesh(g, mergeAll([box(1.2, 9, 1.2, -9, 0, 0), box(1.2, 9, 1.2, 9, 0, 0), box(20, 0.8, 1.6, 0, 9, 0)]), wood);
    const panel = new THREE.PlaneGeometry(16, 4);
    addMesh(g, mergeAll([panel.clone().translate(0, 11.8, 0.85), panel.clone().rotateY(Math.PI).translate(0, 11.8, -0.85)]), signM);
    addMesh(g, box(16.4, 4.4, 1.6, 0, 9.6, 0), wood);
  }

  // ------------------------------------------------ Painted Ladies
  if ((l = landmarkById(idx, 'paintedladies'))) {
    const d = DIMS.paintedladies;
    const colors = [0xb9d4c7, 0xe8c9b4, 0xd9b8c4, 0xf2e2b6, 0xa9c4d8, 0xe0c0a0, 0xc8d6b0];
    const front = victorianFront();
    for (let i = 0; i < d.n; i++) {
      const u = (i - (d.n - 1) / 2) * d.w;
      const wx = l.x + Math.cos(l.rot) * u, wz = l.z + Math.sin(l.rot) * u;
      const gy = Q.heightAt(wx, wz);
      const g = new THREE.Group();
      g.position.set(wx, gy, wz);
      g.rotation.y = -l.rot;
      root.add(g);
      const wallM = std(colors[i], 0.85);
      const w = d.w - 0.2;
      const parts = [box(w, d.h + 3, d.d, 0, -3, 0)];
      // gabled roof
      const roof = new THREE.BufferGeometry();
      const hh = d.h, rh = 4.2, hd = d.d / 2, hw = w / 2;
      const v = [-hw, hh, -hd, hw, hh, -hd, 0, hh + rh, -hd, -hw, hh, hd, 0, hh + rh, hd, hw, hh, hd];
      roof.setAttribute('position', new THREE.Float32BufferAttribute([
        ...v.slice(0, 9), ...v.slice(9, 18),
        -hw, hh, -hd, 0, hh + rh, -hd, 0, hh + rh, hd, -hw, hh, -hd, 0, hh + rh, hd, -hw, hh, hd,
        hw, hh, -hd, hw, hh, hd, 0, hh + rh, hd, hw, hh, -hd, 0, hh + rh, hd, 0, hh + rh, -hd], 3));
      roof.computeVertexNormals();
      parts.push(roof);
      addMesh(g, mergeAll(parts), wallM);
      // front facade panel (faces -V towards Steiner St) + bay window box
      const fm = std(colors[i], 0.75, 0, { map: front });
      addMesh(g, new THREE.PlaneGeometry(w, d.h).rotateY(Math.PI).translate(0, d.h / 2, -hd - 0.02), fm, { cast: false });
      const trim = std(0xf6f3ea, 0.7);
      addMesh(g, mergeAll([box(w + 0.4, 0.6, 1.0, 0, hh - 0.3, -hd - 0.4), box(2.2, 0.25, 3.0, 2.3, 0, -hd - 1.6), box(2.2, 1.6, 2.0, 2.3, 0, -hd - 1.0),
        box(3.6, 0.35, 1.3, -1.2, 9.4, -hd - 0.6), box(3.6, 0.3, 1.3, -1.2, 3.0, -hd - 0.6)]), trim);
      // two-storey bay window (front face carries the window texture)
      const bay = box(3.4, 6.4, 1.1, -1.2, 3.0, -hd - 0.55);
      const buv = bay.attributes.uv;
      for (let q = 0; q < buv.count; q++) buv.setXY(q, 0.05 + buv.getX(q) * 0.42, 0.18 + buv.getY(q) * 0.62);
      addMesh(g, bay, fm);
    }
  }

  // ------------------------------------------------ Oracle Park
  if ((l = landmarkById(idx, 'oraclepark'))) {
    const g = lmGroup(l);
    const d = DIMS.oraclepark;
    const off = d.r * 0.25;   // ring centre offset towards +U (outfield)
    const grass = std(0x3f8a3a, 0.95), dirt = std(0xa87650, 0.95);
    addMesh(g, new THREE.CircleGeometry(d.r * 0.82, 48).rotateX(-Math.PI / 2).translate(off + 6, 0.3, 0), grass, { cast: false });
    addMesh(g, new THREE.PlaneGeometry(28, 28).rotateX(-Math.PI / 2).rotateY(Math.PI / 4).translate(off - d.r * 0.45, 0.4, 0), dirt, { cast: false });
    // stands: raked ring segments
    const brick = std(0x8a4a38, 0.85), seats = std(0x26323e, 0.8);
    const sp = [], wl = [];
    const a0 = Math.PI * 0.42, a1 = Math.PI * 1.58, n = 30;
    for (let i = 0; i < n; i++) {
      const aa = a0 + ((a1 - a0) * i) / n, ab = a0 + ((a1 - a0) * (i + 1)) / n;
      const P = (r, a, y) => [Math.cos(a) * r + off, y, Math.sin(a) * r];
      const q = [P(d.r * 0.8, aa, 2), P(d.r * 0.8, ab, 2), P(d.r, ab, d.height), P(d.r, aa, d.height)];
      sp.push(quadGeo(q));
      wl.push(quadGeo([P(d.r, aa, -2), P(d.r, ab, -2), P(d.r, ab, d.height + 2), P(d.r, aa, d.height + 2)].reverse()));
    }
    addMesh(g, mergeAll(sp), seats);
    addMesh(g, mergeAll(wl), brick);
    // light towers
    const lights = [], poles = [];
    for (const a of [0.55, 0.85, 1.15, 1.45]) {
      const x = Math.cos(a * Math.PI) * d.r * 1.02 + off, z = Math.sin(a * Math.PI) * d.r * 1.02;
      poles.push(cyl(0.8, 1.1, 62, 6, x, 0, z));
      lights.push(box(10, 5, 1.5, x, 60, z));
    }
    addMesh(g, mergeAll(poles), std(0x6c7278, 0.6, 0.5));
    addMesh(g, mergeAll(lights), glow(0xf6f8ff, 0.05));
    // clock tower at the home plate entrance, Coke bottle + glove beyond left field
    addMesh(g, mergeAll([box(10, 34, 10, -d.r - 6, 0, 0), new THREE.ConeGeometry(6, 8, 4).rotateY(Math.PI / 4).translate(-d.r - 6, 38, 0)]), brick);
    const bottle = new THREE.LatheGeometry([[0, 0], [5, 0], [5.5, 6], [4.6, 12], [5.4, 18], [3.2, 24], [1.6, 29], [1.6, 32], [0, 32]].map(([x, y]) => new THREE.Vector2(x, y)), 16);
    addMesh(g, bottle.translate(off + Math.cos(Math.PI * 0.35) * d.r * 0.95, 0, -Math.sin(Math.PI * 0.35) * d.r * 0.95), std(0x5b3a24, 0.4, 0.1));
  }

  // ------------------------------------------------ Ghirardelli clock tower + sign
  if ((l = landmarkById(idx, 'ghirardelli'))) {
    const g = lmGroup(l);
    g.rotation.y = 0;
    const d = DIMS.ghirardelli;
    const wt = windowTextures({ cols: 2, rows: 1, wall: '#a5563f', glass: '#2c2a29', glassHi: '#5a5552', ww: 0.4, wh: 0.6, seed: 31, litFrac: 0.5 });
    const brick = std(0xffffff, 0.85, 0, { map: wt.map, emissiveMap: wt.lit, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0 });
    night.push({ mat: brick, base: 0, add: 0.9 });
    const b0 = box(d.w, d.h + 3, d.d, 0, -3, 0);
    setBoxUV(b0, d.w, d.h + 3, d.d, 3.5, 3.8);
    addMesh(g, b0, brick);
    addMesh(g, mergeAll([box(d.w + 1, 1, d.d + 1, 0, d.h, 0), box(6, 8, 6, 0, d.h + 1, 0), new THREE.ConeGeometry(5, 6, 4).rotateY(Math.PI / 4).translate(0, d.h + 12, 0)]), std(0x7a3a2c, 0.8));
    const tex = canvasTex(1024, 128, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      c.fillStyle = 'rgba(0,0,0,0)';
      c.font = 'bold 104px Georgia, serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = '#f4f1ea'; c.fillText('GHIRARDELLI', w / 2, h / 2 + 6);
    }, { repeat: [1, 1] });
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    const signM = new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.3, emissiveMap: tex, emissive: new THREE.Color(1, 0.95, 0.85), emissiveIntensity: 0.0, side: THREE.DoubleSide, roughness: 0.5 });
    night.push({ mat: signM, base: 0.0, add: 2.0 });
    addMesh(g, new THREE.PlaneGeometry(40, 5).translate(0, d.h + 5.5, -d.d / 2 - 1), signM, { cast: false });
    addMesh(g, mergeAll([box(40, 0.4, 0.4, 0, d.h + 2.6, -d.d / 2 - 1.2), box(0.4, 6, 0.4, -18, d.h, -d.d / 2 - 1.2), box(0.4, 6, 0.4, 18, d.h, -d.d / 2 - 1.2)]), std(0x333333, 0.6, 0.5));
  }

  // ------------------------------------------------ Dragon Gate
  if ((l = landmarkById(idx, 'dragongate'))) {
    const g = lmGroup(l);
    const d = DIMS.dragongate;
    const stone = std(0xd9d2c3, 0.85), redM = std(0xa3302a, 0.7), green = std(0x2f7350, 0.6), goldM = std(0xd4a640, 0.35, 0.8);
    const pillars = [];
    for (const v of [-d.span / 2, -3.2, 3.2, d.span / 2]) pillars.push(box(1.8, Math.abs(v) > 4 ? 6.5 : 8.2, 1.8, 0, 0, v));
    addMesh(g, mergeAll(pillars), stone);
    addMesh(g, mergeAll([box(1.2, 1.0, 7.8, 0, 7.0, 0), box(1.0, 0.8, 7.2, 0, 5.4, -6.6), box(1.0, 0.8, 7.2, 0, 5.4, 6.6)]), redM);
    const roofs = [pagodaRoof(3.6, 9.4, 1.8).translate(0, 8.2, 0), pagodaRoof(2.8, 7.6, 1.4).translate(0, 6.5, -6.6), pagodaRoof(2.8, 7.6, 1.4).translate(0, 6.5, 6.6)];
    addMesh(g, mergeAll(roofs), green);
    addMesh(g, mergeAll([box(0.5, 0.5, 6.2, 0, 10.0, 0), new THREE.SphereGeometry(0.4, 8, 6).translate(0, 10.6, -3.2), new THREE.SphereGeometry(0.4, 8, 6).translate(0, 10.6, 3.2)]), goldM);
  }

  // ------------------------------------------------ Fort Point
  if ((l = landmarkById(idx, 'fortpoint'))) {
    const g = lmGroup(l);
    const d = DIMS.fortpoint;
    const wt = windowTextures({ cols: 3, rows: 3, wall: '#9a5a44', glass: '#1d1a19', glassHi: '#3a3330', ww: 0.35, wh: 0.45, seed: 41, litFrac: 0.1 });
    const brick = std(0xffffff, 0.9, 0, { map: wt.map });
    const b0 = box(d.L, d.height + 4, d.W, 0, -4, 0);
    setBoxUV(b0, d.L, d.height + 4, d.W, 9, 6);
    addMesh(g, b0, brick);
    addMesh(g, mergeAll([box(d.L + 1, 1.2, d.W + 1, 0, d.height, 0), cyl(1.6, 2, 6, 8, d.L / 2 - 6, d.height + 1, 0)]), std(0x6d4a3c, 0.9));
  }

  // ------------------------------------------------ Lombard Street hedges + hydrangeas
  const lomb = D.roads.filter((r) => r.name === 'Lombard Street' && r.points.length > 40);
  if (lomb.length) {
    const hedge = [], flowers = [];
    for (const r of lomb) {
      const P = r.points, hw = r.width / 2 + 0.9;
      for (let i = 1; i < P.length; i++) {
        const [x0, z0] = P[i - 1], [x1, z1] = P[i];
        const L = Math.hypot(x1 - x0, z1 - z0);
        if (L < 0.5) continue;
        const nx = -(z1 - z0) / L, nz = (x1 - x0) / L;
        for (let s = 0; s < L; s += 2.2) {
          const x = x0 + ((x1 - x0) * s) / L, z = z0 + ((z1 - z0) * s) / L;
          for (const sd of [-1, 1]) {
            const px = x + nx * hw * sd, pz = z + nz * hw * sd;
            const y = Q.heightAt(px, pz);
            hedge.push(new THREE.SphereGeometry(1.0, 6, 4).scale(1.2, 0.7, 1.2).translate(px, y + 0.4, pz));
            if (((i * 31 + s * 7) | 0) % 3 === 0) flowers.push(new THREE.SphereGeometry(0.45, 5, 4).translate(px, y + 1.0, pz));
          }
        }
      }
    }
    if (hedge.length) addMesh(root, mergeAll(hedge), std(0x2f5a2a, 0.9), { cast: false });
    if (flowers.length) addMesh(root, mergeAll(flowers), std(0xd35d8a, 0.8), { cast: false });
  }

  function setNight(n) {
    for (const e of night) e.mat.emissiveIntensity = e.base + e.add * n;
  }
  root.traverse((o) => { if (o.isMesh) { o.updateMatrix(); } });
  return { group: root, setNight };
}

// ---------------------------------------------------------------- geometry utils
function quadGeo(q) {
  const g = new THREE.BufferGeometry();
  const [a, b, c, d] = q;
  g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d, ...a, ...c, ...b, ...a, ...d, ...c], 3));
  g.computeVertexNormals();
  return g;
}

function roundedSquare(h, r, seg) {
  const pts = [];
  const corners = [[h - r, h - r, 0], [-(h - r), h - r, Math.PI / 2], [-(h - r), -(h - r), Math.PI], [h - r, -(h - r), Math.PI * 1.5]];
  for (const [cx, cz, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
  }
  return pts;
}

/** prism from (x,z) polygon (CCW in x,-z), y0..y1, scaled from s0 to s1; uv u = perimeter/bayWidth-ish, v = floors */
function taperedPrism(poly, y0, y1, s0, s1, floorH = 3.8, capTop = true) {
  const n = poly.length;
  const pos = [], uv = [];
  let per = 0;
  const perim = [0];
  for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; per += Math.hypot(b[0] - a[0], b[1] - a[1]); perim.push(per); }
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const u0 = perim[i] / per, u1 = perim[i + 1] / per;
    const A0 = [a[0] * s0, y0, a[1] * s0], B0 = [b[0] * s0, y0, b[1] * s0], A1 = [a[0] * s1, y1, a[1] * s1], B1 = [b[0] * s1, y1, b[1] * s1];
    // outward winding: polygon CCW in (x,z) -> (A0, A1, B0), (B0, A1, B1)
    pos.push(...A0, ...A1, ...B0, ...B0, ...A1, ...B1);
    const v0 = 0, v1 = (y1 - y0) / floorH;
    uv.push(u0 * 8, v0, u0 * 8, v1, u1 * 8, v0, u1 * 8, v0, u0 * 8, v1, u1 * 8, v1);
  }
  if (capTop) {
    for (let i = 1; i < n - 1; i++) {
      const a = poly[0], b = poly[i], c = poly[i + 1];
      pos.push(a[0] * s1, y1, a[1] * s1, c[0] * s1, y1, c[1] * s1, b[0] * s1, y1, b[1] * s1);
      uv.push(0, 0, 0, 0, 0, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  // make sure walls face outwards (flip if polygon orientation was the other way)
  const p = g.attributes.position, nrm = g.attributes.normal;
  const cx = (p.getX(0) + p.getX(2)) / 2, cz = (p.getZ(0) + p.getZ(2)) / 2;
  if (cx * nrm.getX(0) + cz * nrm.getZ(0) < 0) {
    for (let i = 0; i < p.count; i += 3) {
      for (const k of ['X', 'Y', 'Z']) { const t = p['get' + k](i + 1); p['set' + k](i + 1, p['get' + k](i + 2)); p['set' + k](i + 2, t); }
      const t0 = g.attributes.uv.getX(i + 1), t1 = g.attributes.uv.getY(i + 1);
      g.attributes.uv.setXY(i + 1, g.attributes.uv.getX(i + 2), g.attributes.uv.getY(i + 2));
      g.attributes.uv.setXY(i + 2, t0, t1);
    }
    g.computeVertexNormals();
  }
  return g;
}

/** set world-meter UVs on a BoxGeometry (bay width / floor height tiling) */
function setBoxUV(g, w, h, d, bay, floor) {
  const uv = g.attributes.uv;
  const nrm = g.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i));
    const u = uv.getX(i), v = uv.getY(i);
    if (ny > 0.5) uv.setXY(i, 0, 0);
    else uv.setXY(i, (u * (nx > 0.5 ? d : w)) / bay, (v * h) / floor);
  }
}

function pagodaRoof(depth, width, height) {
  // curved-eave hip roof: lathe-like 4-sided pyramid with flared eaves
  const g = new THREE.CylinderGeometry(0.4, 1, height, 4, 3, false).rotateY(Math.PI / 4);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / height + 0.5;    // 0 bottom .. 1 top
    const flare = 1 + (1 - y) * (1 - y) * 0.6;
    p.setXYZ(i, p.getX(i) * depth * 0.75 * flare, p.getY(i) + height / 2 - (1 - y) * (1 - y) * 0.5, p.getZ(i) * width * 0.75 * flare);
  }
  g.computeVertexNormals();
  return g;
}

function victorianFront() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 192;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 192);
  g.fillStyle = 'rgba(0,0,0,0.08)';
  for (let y = 0; y < 192; y += 6) g.fillRect(0, y, 128, 1);
  const win = (x, y, w, h) => {
    g.fillStyle = '#fbfaf6'; g.fillRect(x - 4, y - 6, w + 8, h + 10);
    g.fillStyle = '#3b4650'; g.fillRect(x, y, w, h);
    g.fillStyle = '#fbfaf6'; g.fillRect(x, y + h / 2 - 1, w, 2);
  };
  // two floors: bay window (left) + door / window (right)
  win(14, 26, 18, 36); win(40, 26, 18, 36); win(86, 26, 22, 36);
  win(14, 96, 18, 36); win(40, 96, 18, 36);
  g.fillStyle = '#fbfaf6'; g.fillRect(82, 92, 30, 60);
  g.fillStyle = '#5a3a2a'; g.fillRect(88, 100, 18, 52);
  g.fillStyle = '#fbfaf6'; g.fillRect(0, 0, 128, 12); g.fillRect(0, 76, 128, 8); g.fillRect(0, 150, 128, 6);
  g.fillStyle = 'rgba(0,0,0,0.2)';
  for (let x = 2; x < 128; x += 8) g.fillRect(x, 12, 4, 4);
  // garage level
  g.fillStyle = '#efece4'; g.fillRect(10, 160, 60, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
