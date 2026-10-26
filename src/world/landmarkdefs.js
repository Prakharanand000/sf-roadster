// Pure (no DOM) landmark definitions shared by the collision queries (worlddata.js) and the meshes
// (landmarks.js): dimensions, Golden Gate deck profile and solid footprints.
//
// Landmark frame: bake stores `rot` = angle of the landmark's long axis in the x-z plane (atan2(dz, dx)).
// Local axis U = (cos rot, sin rot), V = (-sin rot, cos rot). A THREE object gets rotation.y = -rot so its
// local +X maps onto U and local +Z onto V.

export const GG = {
  towerHalfSpan: 637,       // default; the bake measures it from the OSM tower piers (main span ~1280 m)
  towerHeight: 227,         // above water
  deckTower: 66.0,          // deck height at the towers
  deckMid: 68.0,            // deck height at mid-span
  halfW: 13.6,              // deck half width (roadway between the legs + walkways outside them)
  legInner: 10.6, legOuter: 18.6, legHalfLen: 8.0,  // tower legs: the 6-lane roadway passes between them
  railThick: 0.6,
};

export const DIMS = {
  transamerica: { base: 44, height: 260 },
  salesforce: { base: 52, height: 326 },
  coit: { r: 6.2, height: 64 },
  ferry: { L: 200, W: 36, height: 15, towerW: 14, towerH: 75 },
  cityhall: { L: 125, W: 90, height: 26, domeR: 26, domeH: 94 },
  finearts: { r: 21, height: 49 },
  alcatraz: { cellL: 150, cellW: 34, cellH: 14, lightR: 3, lightH: 26 },
  paintedladies: { n: 7, w: 7.6, d: 18, h: 11.5 },
  oraclepark: { r: 120, height: 34 },
  fortpoint: { L: 76, W: 50, height: 14 },
  dragongate: { span: 20, height: 11 },
  ghirardelli: { w: 14, d: 14, h: 26 },
};

export function makeDeckProfile(gg) {
  const ax = gg.axis[0], az = gg.axis[1];
  const cx = gg.centre[0], cz = gg.centre[1];
  const tmin = gg.tmin, tmax = gg.tmax;
  const gS = gg.groundSouth, gN = gg.groundNorth;
  const T = gg.halfSpan || GG.towerHalfSpan;
  // approach ends meet the real road height; main span is a gentle crown
  function heightAtT(t) {
    if (t <= -T) {
      const u = (t - tmin) / (-T - tmin);
      return gS + (GG.deckTower - gS) * Math.min(1, Math.max(0, u));
    }
    if (t >= T) {
      const u = (tmax - t) / (tmax - T);
      return gN + (GG.deckTower - gN) * Math.min(1, Math.max(0, u));
    }
    const q = t / T;
    return GG.deckTower + (GG.deckMid - GG.deckTower) * (1 - q * q);
  }
  // lateral coverage per 10 m slice (handles the curved approach viaducts)
  const sl = gg.slices || { t0: tmin, step: tmax - tmin, lmin: [-GG.halfW, -GG.halfW], lmax: [GG.halfW, GG.halfW] };
  const ns = sl.lmin.length;
  function lateralRange(t, out) {
    let f = (t - sl.t0) / sl.step;
    if (f < 0) f = 0; else if (f > ns - 1.001) f = ns - 1.001;
    const i = f | 0, u = f - i;
    out[0] = sl.lmin[i] + (sl.lmin[i + 1] - sl.lmin[i]) * u;
    out[1] = sl.lmax[i] + (sl.lmax[i + 1] - sl.lmax[i]) * u;
    return out;
  }
  // world bbox for a quick reject
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (let i = 0; i < ns; i++) {
    const t = sl.t0 + i * sl.step;
    for (const l of [sl.lmin[i], sl.lmax[i]]) {
      const x = cx + ax * t - az * l, z = cz + az * t + ax * l;
      minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z);
    }
  }
  return { cx, cz, ax, az, tmin, tmax, halfW: GG.halfW, heightAtT, lateralRange, towerT: [-T, T], halfSpan: T, slices: sl,
    bbox: { minx: minx - 2, maxx: maxx + 2, minz: minz - 2, maxz: maxz + 2 } };
}

export function ccw(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a < 0 ? poly.slice().reverse() : poly;
}

/** rectangle centred at (cx,cz), long axis angle a, half sizes hu (along U) and hv (along V). */
export function boxPoly(cx, cz, a, hu, hv) {
  const c = Math.cos(a), s = Math.sin(a);
  const P = (u, v) => [cx + u * c - v * s, cz + u * s + v * c];
  return ccw([P(-hu, -hv), P(hu, -hv), P(hu, hv), P(-hu, hv)]);
}

export function circlePoly(cx, cz, r, n = 12) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(t) * r, cz + Math.sin(t) * r]);
  }
  return ccw(out);
}

export function landmarkById(index, id) {
  return (index.landmarks || []).find((l) => l.id === id);
}

/** local (u,v) -> world (x,z) for a landmark */
export function lmToWorld(lm, u, v) {
  const c = Math.cos(lm.rot || 0), s = Math.sin(lm.rot || 0);
  return [lm.x + u * c - v * s, lm.z + u * s + v * c];
}

/** Solid parts used for collision + roofs. heightAt(x,z) gives terrain height. */
export function buildLandmarkSolids(index, heightAt) {
  const out = [];
  const add = (id, poly, base, top, roof) => out.push({ id, poly: ccw(poly), base, top, roof });
  // --- Golden Gate Bridge
  const gg = index.ggbridge;
  if (gg) {
    const P = makeDeckProfile(gg);
    const W = (t, l) => [P.cx + P.ax * t - P.az * l, P.cz + P.az * t + P.ax * l];
    for (const tt of P.towerT) {
      for (const side of [-1, 1]) {
        const l0 = side * GG.legInner, l1 = side * GG.legOuter;
        add('goldengate', [W(tt - GG.legHalfLen, l0), W(tt + GG.legHalfLen, l0), W(tt + GG.legHalfLen, l1), W(tt - GG.legHalfLen, l1)], -30, GG.towerHeight, false);
      }
    }
    // railings along the outer edges of the deck coverage, 20 m pieces
    const sl = P.slices;
    for (let i = 0; i + 2 < sl.lmin.length; i += 2) {
      const t0 = sl.t0 + i * sl.step, t1 = t0 + 2 * sl.step;
      if (t0 < P.tmin + 3 || t1 > P.tmax - 3) continue;
      const h0 = P.heightAtT(t0), h1 = P.heightAtT(t1);
      for (const side of [0, 1]) {
        const a0 = side ? sl.lmax[i] : sl.lmin[i], a1 = side ? sl.lmax[i + 2] : sl.lmin[i + 2];
        const o = side ? GG.railThick : -GG.railThick;
        // only where there is a real drop beside the deck (approaches over land need no wall)
        const [mx, mz] = W((t0 + t1) / 2, (a0 + a1) / 2 + o * 3);
        if ((h0 + h1) / 2 - heightAt(mx, mz) < 2.5) continue;
        add('goldengate', [W(t0, a0), W(t1, a1), W(t1, a1 + o), W(t0, a0 + o)], Math.min(h0, h1) - 1.5, Math.max(h0, h1) + 1.1, false);
      }
    }
  }
  const lm = (id) => landmarkById(index, id);
  const G = (l) => heightAt(l.x, l.z);
  let l;
  if ((l = lm('transamerica'))) add('transamerica', boxPoly(l.x, l.z, l.rot, DIMS.transamerica.base / 2, DIMS.transamerica.base / 2), G(l) - 3, G(l) + DIMS.transamerica.height, false);
  if ((l = lm('salesforce'))) add('salesforce', boxPoly(l.x, l.z, l.rot, DIMS.salesforce.base / 2, DIMS.salesforce.base / 2), G(l) - 3, G(l) + DIMS.salesforce.height, false);
  if ((l = lm('coit'))) add('coit', circlePoly(l.x, l.z, DIMS.coit.r, 12), G(l) - 3, G(l) + DIMS.coit.height, true);
  if ((l = lm('ferry'))) {
    const d = DIMS.ferry, L = Math.max(l.L || d.L, 120), Wd = Math.min(Math.max(l.W || d.W, 25), 45);
    add('ferry', boxPoly(l.x, l.z, l.rot, L / 2, Wd / 2), G(l) - 3, G(l) + d.height, true);
    add('ferry', boxPoly(l.x, l.z, l.rot, d.towerW / 2, d.towerW / 2), G(l) - 3, G(l) + d.towerH, false);
  }
  if ((l = lm('cityhall'))) {
    const d = DIMS.cityhall, L = Math.max(l.L || d.L, 90), Wd = Math.max(l.W || d.W, 60);
    add('cityhall', boxPoly(l.x, l.z, l.rot, L / 2, Wd / 2), G(l) - 3, G(l) + d.height, true);
    add('cityhall', circlePoly(l.x, l.z, d.domeR * 0.8, 12), G(l) - 3, G(l) + d.domeH, false);
  }
  if ((l = lm('finearts'))) add('finearts', circlePoly(l.x, l.z, DIMS.finearts.r, 8), G(l) - 3, G(l) + DIMS.finearts.height, false);
  if ((l = lm('alcatraz'))) {
    const d = DIMS.alcatraz;
    const g = heightAt(l.x, l.z);
    add('alcatraz', boxPoly(l.x, l.z, l.rot, d.cellL / 2, d.cellW / 2), g - 6, g + d.cellH, true);
    const [lx, lz] = lmToWorld(l, -d.cellL / 2 - 22, 8);
    add('alcatraz', circlePoly(lx, lz, d.lightR, 8), heightAt(lx, lz) - 3, heightAt(lx, lz) + d.lightH, false);
  }
  if ((l = lm('paintedladies'))) {
    const d = DIMS.paintedladies;
    for (let i = 0; i < d.n; i++) {
      const u = (i - (d.n - 1) / 2) * d.w;
      const [hx, hz] = lmToWorld(l, u, 0);
      const g = heightAt(hx, hz);
      add('paintedladies', boxPoly(hx, hz, l.rot, d.w / 2 - 0.1, d.d / 2), g - 3, g + d.h, false);
    }
  }
  if ((l = lm('fortpoint'))) {
    const d = DIMS.fortpoint;
    add('fortpoint', boxPoly(l.x, l.z, l.rot, d.L / 2, d.W / 2), G(l) - 3, G(l) + d.height, true);
  }
  if ((l = lm('oraclepark'))) {
    // grandstand ring segments around home plate (stand opens towards +U = outfield/bay)
    const d = DIMS.oraclepark;
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a0 = Math.PI * 0.42 + (i / n) * Math.PI * 1.16, a1 = Math.PI * 0.42 + ((i + 1) / n) * Math.PI * 1.16;
      const r0 = d.r * 0.78, r1 = d.r;
      const p = [[r0, a0], [r1, a0], [r1, a1], [r0, a1]].map(([r, a]) => lmToWorld(l, Math.cos(a) * r + d.r * 0.25, Math.sin(a) * r));
      add('oraclepark', p, G(l) - 3, G(l) + d.height, false);
    }
  }
  if ((l = lm('dragongate'))) {
    const d = DIMS.dragongate;
    for (const v of [-d.span / 2, -3.2, 3.2, d.span / 2]) {
      const [px, pz] = lmToWorld(l, 0, v);
      add('dragongate', boxPoly(px, pz, l.rot, 0.9, 0.9), G(l) - 3, G(l) + d.height, false);
    }
  }
  if ((l = lm('ghirardelli'))) {
    const d = DIMS.ghirardelli;
    add('ghirardelli', boxPoly(l.x, l.z, l.rot, d.w / 2, d.d / 2), G(l) - 3, G(l) + d.h, false);
  }
  return out;
}

/** World.landmarks list (id, name, x, z, radius, blurb). */
export function landmarkList(index) {
  const R = { goldengate: 700, baybridge: 600, transamerica: 90, salesforce: 90, coit: 70, ferry: 120, finearts: 110, cityhall: 110,
    alcatraz: 260, pier39: 120, paintedladies: 70, oraclepark: 150, ghirardelli: 80, dragongate: 40, lombard: 80, fortpoint: 80 };
  return (index.landmarks || []).map((l) => ({ id: l.id, name: l.name, x: l.x, z: l.z, radius: R[l.id] || 80, blurb: l.blurb }));
}
