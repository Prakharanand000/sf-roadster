// SF Roadster Rush - v2 world: what holds the decks up (tools/baybridge_v2.py data). Road ribbons on
// the decks come from the tile road builder; this draws the rest, once, for the whole map:
// - a box girder under every bridge road where it stands above the ground,
// - piers down to the ground or the bay floor where the deck is a viaduct (not the suspension spans),
// - concrete barriers, tunnel walls and tunnel ceilings from the bridge solids,
// - over each tunnel bore, the hill as a roof, with portal faces above the openings.
import * as THREE from 'three';

const GIRDER = 1.9;        // m below the deck surface
const PIER_EVERY = 64;     // m along a deck
const PIER_MAX = 48;       // m: higher than this it is a suspension span (towers come from landmarks)
const BARRIER = 1.05;      // m: visible barrier height (collision walls are taller)
const TUNNEL_H = 6.5;      // m: bore height at the portals
const LAMP_L = 2.4, LAMP_W = 0.5;   // m: a ceiling light strip, one per tunnel segment (~8 m)

function quad(pos, idx, a, b, c, d) {
  // a b c d: corners in order around the face (counter-clockwise seen from outside)
  const o = pos.length / 3;
  pos.push(...a, ...b, ...c, ...d);
  idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
}

function boxAt(pos, idx, x, z, y0, y1, hx, hz, ux, uz) {
  // vertical box centred at (x, z), half sizes hx along u (ux, uz) and hz across
  const vx = -uz, vz = ux;
  const c = (sa, sb, y) => [x + ux * hx * sa + vx * hz * sb, y, z + uz * hx * sa + vz * hz * sb];
  quad(pos, idx, c(-1, -1, y0), c(1, -1, y0), c(1, -1, y1), c(-1, -1, y1));
  quad(pos, idx, c(1, -1, y0), c(1, 1, y0), c(1, 1, y1), c(1, -1, y1));
  quad(pos, idx, c(1, 1, y0), c(-1, 1, y0), c(-1, 1, y1), c(1, 1, y1));
  quad(pos, idx, c(-1, 1, y0), c(-1, -1, y0), c(-1, -1, y1), c(-1, 1, y1));
}

function mesh(pos, idx, material, name) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, material);
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  m.matrixAutoUpdate = false;
  return m;
}

export function buildStructures(D, Q) {
  const group = new THREE.Group();
  group.name = 'structures';
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8d8a84, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  // tunnel roofs reach a cell past the cut onto the hill; pushed back in depth so the hill's own
  // ground wins where the two meet
  const hill = new THREE.MeshStandardMaterial({ color: 0x5b6640, roughness: 1, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 });
  // tunnel ceilings read as lit concrete (no sun reaches them), with lamp strips along the bore
  const ceiling = new THREE.MeshStandardMaterial({ color: 0x8d8a84, roughness: 0.92, metalness: 0, emissive: 0x2b2a27, side: THREE.DoubleSide });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xfff0cc, side: THREE.DoubleSide });
  const gp = [], gi = [], pp = [], pi = [], bp = [], bi = [], rp = [], ri = [], cp = [], ci = [], lp = [], li = [];
  for (const d of D.decks || []) {
    const n = d.x.length;
    if (d.kind === 0 && !(d.flags & 1)) {
      const hw = d.hw + 0.7;
      let along = PIER_EVERY * 0.5;
      for (let i = 0; i + 1 < n; i++) {
        const ax = d.x[i], az = d.z[i], bx = d.x[i + 1], bz = d.z[i + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.01) continue;
        const ux = (bx - ax) / L, uz = (bz - az) / L, vx = -uz, vz = ux;
        const ha = d.h[i], hb = d.h[i + 1];
        const ga = Q.heightAt(ax, az), gb = Q.heightAt(bx, bz);
        if (Math.min(ha - ga, hb - gb) > 1.2) {
          // girder: two sides and the soffit (the road ribbon is the top)
          const A = (s, y) => [ax + vx * hw * s, y, az + vz * hw * s], B = (s, y) => [bx + vx * hw * s, y, bz + vz * hw * s];
          quad(gp, gi, A(1, ha + 0.05), B(1, hb + 0.05), B(1, hb - GIRDER), A(1, ha - GIRDER));
          quad(gp, gi, B(-1, hb + 0.05), A(-1, ha + 0.05), A(-1, ha - GIRDER), B(-1, hb - GIRDER));
          quad(gp, gi, A(1, ha - GIRDER), B(1, hb - GIRDER), B(-1, hb - GIRDER), A(-1, ha - GIRDER));
          // top strips beyond the road edge, up to the barrier
          for (const s of [1, -1]) {
            const o0 = d.hw * s, o1 = hw * s;
            const P = (o, x, z, y) => [x + vx * o, y, z + vz * o];
            if (s > 0) quad(gp, gi, P(o0, ax, az, ha + 0.05), P(o0, bx, bz, hb + 0.05), P(o1, bx, bz, hb + 0.05), P(o1, ax, az, ha + 0.05));
            else quad(gp, gi, P(o1, ax, az, ha + 0.05), P(o1, bx, bz, hb + 0.05), P(o0, bx, bz, hb + 0.05), P(o0, ax, az, ha + 0.05));
          }
        }
        // piers, every PIER_EVERY m along the deck
        while (along <= L) {
          const t = along / L, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          const h = ha + (hb - ha) * t, g = Q.heightAt(x, z);
          const clear = h - GIRDER - g;
          if (clear > 3 && h - g < PIER_MAX) {
            const y0 = g - 2, y1 = h - GIRDER;
            if (d.hw > 6) for (const s of [-0.55, 0.55]) boxAt(pp, pi, x + vx * d.hw * s, z + vz * d.hw * s, y0, y1, 1.2, 1.6, ux, uz);
            else boxAt(pp, pi, x, z, y0, y1, 1.1, 1.4, ux, uz);
            boxAt(pp, pi, x, z, y1 - 1.4, y1, 1.0, hw, ux, uz);   // cap beam
          }
          along += PIER_EVERY;
        }
        along -= L;
      }
    } else if (d.kind === 1) {
      // tunnel roof: left edge, centre, right edge per point (the hill as it was)
      const o = rp.length / 3;
      for (let i = 0; i < n; i++) {
        const j0 = Math.max(0, i - 1), j1 = Math.min(n - 1, i + 1);
        let ux = d.x[j1] - d.x[j0], uz = d.z[j1] - d.z[j0];
        const L = Math.hypot(ux, uz) || 1; ux /= L; uz /= L;
        const vx = -uz, vz = ux;
        rp.push(d.x[i] - vx * d.hw, d.hl[i], d.z[i] - vz * d.hw, d.x[i], d.h[i], d.z[i], d.x[i] + vx * d.hw, d.hr[i], d.z[i] + vz * d.hw);
      }
      for (let i = 0; i + 1 < n; i++) {
        const a = o + i * 3, b = a + 3;
        // up-facing: (left, next left, centre) etc. with the right-hand normal at +v
        ri.push(a, a + 1, b, b, a + 1, b + 1, a + 1, a + 2, b + 1, b + 1, a + 2, b + 2);
      }
      // portal faces at both ends, above the bore opening
      for (const i of [0, n - 1]) {
        const deck = Q.deckAt(d.x[i], d.z[i]);
        const floor = deck === deck ? deck : Q.heightAt(d.x[i], d.z[i]);
        const j = i === 0 ? 1 : n - 2;
        let ux = d.x[j] - d.x[i], uz = d.z[j] - d.z[i];
        const L = Math.hypot(ux, uz) || 1; ux /= L; uz /= L;
        const vx = -uz, vz = ux;
        const P = (s, y) => [d.x[i] + vx * d.hw * s, y, d.z[i] + vz * d.hw * s];
        const top = Math.max(d.hl[i], d.h[i], d.hr[i]);
        const a = P(-1, floor + TUNNEL_H), b = P(1, floor + TUNNEL_H), c = P(1, top), e = P(-1, top);
        quad(bp, bi, a, b, c, e);
        quad(bp, bi, b, a, e, c);
      }
    }
  }
  // barriers and tunnel walls (from the collision solids; drawn from the deck up)
  const S = D.bsolids;
  for (let q = 0; q < S.base.length; q++) {
    const xs = [], zs = [];
    for (let v = 0; v < 4; v++) { xs.push(S.xz[q * 8 + v * 2]); zs.push(S.xz[q * 8 + v * 2 + 1]); }
    const tunnel = S.top[q] - S.base[q] > 8;
    const hc = S.hc ? [S.hc[q * 4], S.hc[q * 4 + 1], S.hc[q * 4 + 2], S.hc[q * 4 + 3]] : null;
    const bot = (v) => (hc ? hc[v] : S.base[q] + (tunnel ? 3 : 1.5)) - 0.05;
    const top = (v) => (hc ? hc[v] : S.base[q] + (tunnel ? 3 : 1.5)) + (tunnel ? TUNNEL_H : BARRIER);
    const P = (v, y) => [xs[v], y, zs[v]];
    for (let e = 0; e < 4; e++) {
      const f = (e + 1) % 4;
      quad(bp, bi, P(e, bot(e)), P(f, bot(f)), P(f, top(f)), P(e, top(e)));
      quad(bp, bi, P(f, bot(f)), P(e, bot(e)), P(e, top(e)), P(f, top(f)));
    }
    quad(bp, bi, P(0, top(0)), P(1, top(1)), P(2, top(2)), P(3, top(3)));
    quad(bp, bi, P(3, top(3)), P(2, top(2)), P(1, top(1)), P(0, top(0)));
  }
  // tunnel ceilings at wall height (without them the bore is open up to the hill roof). The bake
  // writes a tunnel segment's two walls one after the other, mirror images across the segment;
  // the ceiling spans their outer corners (3: segment start, 2: end), wall tops included.
  if (S.hc) {
    const tun = (q) => S.top[q] - S.base[q] > 8;
    const C = (q, v) => [S.xz[q * 8 + v * 2], S.xz[q * 8 + v * 2 + 1]];
    for (let q = 0; q + 1 < S.base.length; q++) {
      if (!tun(q) || !tun(q + 1)) continue;
      const [a0x, a0z] = C(q, 0), [a1x, a1z] = C(q, 1), [b0x, b0z] = C(q + 1, 0), [b1x, b1z] = C(q + 1, 1);
      const ux = a1x - a0x, uz = a1z - a0z, L = Math.hypot(ux, uz);
      const across = Math.hypot(b0x - a0x, b0z - a0z);
      if (L < 0.01 || Math.abs(Math.hypot(b1x - b0x, b1z - b0z) - L) > 0.05 || across > 40) continue;
      if (Math.abs((b0x - a0x) * ux + (b0z - a0z) * uz) > 0.01 * L * across) continue;
      const Y = (s, v) => { const [x, z] = C(s, v); return [x, S.hc[s * 4 + v] + TUNNEL_H, z]; };
      quad(cp, ci, Y(q, 3), Y(q + 1, 3), Y(q + 1, 2), Y(q, 2));
      // lamp strip at the segment's middle, just under the ceiling
      const mx = (a0x + a1x + b0x + b1x) / 4, mz = (a0z + a1z + b0z + b1z) / 4;
      const my = (S.hc[q * 4] + S.hc[q * 4 + 1]) / 2 + TUNNEL_H - 0.05;
      const fx = ux / L * Math.min(LAMP_L, L) / 2, fz = uz / L * Math.min(LAMP_L, L) / 2;
      const sx = -uz / L * LAMP_W / 2, sz = ux / L * LAMP_W / 2;
      quad(lp, li, [mx - fx - sx, my, mz - fz - sz], [mx + fx - sx, my, mz + fz - sz], [mx + fx + sx, my, mz + fz + sz], [mx - fx + sx, my, mz - fz + sz]);
      q++;   // the pair is used
    }
  }
  let tris = 0;
  for (const [p, i, mat, name] of [[gp, gi, concrete, 'girders'], [pp, pi, concrete, 'piers'], [bp, bi, concrete, 'barriers'], [rp, ri, hill, 'tunnel-roofs'],
    [cp, ci, ceiling, 'tunnel-ceilings'], [lp, li, lamp, 'tunnel-lamps']]) {
    if (!i.length) continue;
    const m = mesh(p, i, mat, name);
    if (mat === lamp) m.castShadow = m.receiveShadow = false;
    group.add(m);
    tris += i.length / 3;
  }
  return {
    group,
    materials: [concrete, hill, ceiling, lamp],
    stats: { triangles: tris, decks: (D.decks || []).length, solids: S.base.length },
  };
}
