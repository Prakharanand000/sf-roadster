// SF Roadster Rush — heading-up minimap (2D canvas).
//
// * Base layer: world.minimapImage if present (assumed to cover world.bounds with pixel (0,0)
//   at (minX, minZ), i.e. north-up, east-right), else world.roads pre-rendered ONCE into an
//   offscreen canvas. Per frame we only drawImage() that base through one affine transform.
// * Rotates so the player's heading points up. Redraw is throttled to <= 30 Hz.
// * World -> screen: right = (-cos h, sin h), forward = (sin h, cos h) (CONTRACTS heading).
import { clamp } from './dom.js';

const C = {
  bg: '#050a15', land: '#0b1527', out: '#070d1a',
  casing: '#050a14', minor: '#1f2e4a', mid: '#2c4066', major: '#4a6290',
  route: 'rgba(255,179,32,0.9)', routeGlow: 'rgba(255,120,30,0.25)',
  cp: '#35e0ff', cpDim: 'rgba(53,224,255,0.45)',
  rival: '#ff5a1f', lmOpen: '#9fb0cc', lmFound: '#ffb320',
  player: '#ffffff', playerEdge: '#060a14', north: '#9fb0cc',
};

export class Minimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.px = 0;
    this.base = null;
    this.rect = null;
    this.route = null;
    this.radius = 260;
    this.speed = 0;      // display units (km/h or mph) - only used for zoom
    this.last = 0;
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);
    } else {
      addEventListener('resize', () => this.resize());
    }
  }

  resize() {
    const w = this.canvas.clientWidth;
    if (!w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(w * dpr);
    if (px !== this.canvas.width) { this.canvas.width = px; this.canvas.height = px; }
    this.px = px;
    this.dpr = dpr;
    this.last = 0;
  }

  setWorld(world) {
    this.base = null;
    this.rect = null;
    if (!world) return;
    let b = world.bounds;
    if (!b && world.roads && world.roads.length) {
      b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      for (const r of world.roads) for (const p of r.points) {
        if (p[0] < b.minX) b.minX = p[0]; if (p[0] > b.maxX) b.maxX = p[0];
        if (p[1] < b.minZ) b.minZ = p[1]; if (p[1] > b.maxZ) b.maxZ = p[1];
      }
    }
    if (!b || !isFinite(b.minX)) return;
    this.rect = { x: b.minX, z: b.minZ, w: b.maxX - b.minX, h: b.maxZ - b.minZ };
    if (world.minimapImage) this.base = world.minimapImage;
    else if (world.roads && world.roads.length) this.base = renderRoads(world.roads, this.rect);
    this.last = 0;
  }

  /** path: [[x,z],...] or null to clear */
  setRoute(path, loop = false) {
    if (!path || path.length < 2 || typeof Path2D === 'undefined') { this.route = null; return; }
    const p = new Path2D();
    p.moveTo(path[0][0], path[0][1]);
    for (let i = 1; i < path.length; i++) p.lineTo(path[i][0], path[i][1]);
    if (loop) p.closePath();
    this.route = p;
    this.last = 0;
  }

  update(m, now) {
    if (!m || !m.player) return;
    if (!this.px) { this.resize(); if (!this.px) return; }
    if (now - this.last < 33) return;
    this.last = now;

    const ctx = this.ctx, S = this.px, dpr = this.dpr;
    const target = 230 + clamp(this.speed || 0, 0, 320) * 1.1;
    this.radius += (target - this.radius) * 0.08;
    const s = (S * 0.5) / this.radius; // device px per meter
    const pl = m.player, hd = pl.heading || 0;
    const cs = Math.cos(hd), sn = Math.sin(hd);
    const a = -s * cs, c = s * sn, b = -s * sn, d = -s * cs;
    const cx = S * 0.5, cy = S * 0.6;
    const e = cx - (a * pl.x + c * pl.z), f = cy - (b * pl.x + d * pl.z);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.out;
    ctx.fillRect(0, 0, S, S);

    ctx.setTransform(a, b, c, d, e, f);
    const r = this.rect;
    if (r) {
      if (this.base) { ctx.imageSmoothingEnabled = true; ctx.drawImage(this.base, r.x, r.z, r.w, r.h); }
      else { ctx.fillStyle = C.land; ctx.fillRect(r.x, r.z, r.w, r.h); }
    }
    if (this.route) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = C.routeGlow; ctx.lineWidth = (9 * dpr) / s; ctx.stroke(this.route);
      ctx.strokeStyle = C.route; ctx.lineWidth = (3.2 * dpr) / s; ctx.stroke(this.route);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const pad = 9 * dpr;
    // Landmarks
    const lms = m.landmarks;
    if (lms && lms.length) {
      ctx.lineWidth = 1.6 * dpr;
      for (let i = 0; i < lms.length; i++) {
        const l = lms[i];
        let x = a * l.x + c * l.z + e, y = b * l.x + d * l.z + f;
        const inside = x > pad && x < S - pad && y > pad && y < S - pad;
        if (!inside) {
          if (l.found) continue;
          // unfound landmarks hug the edge so the player can find them
          const k = edgeT(cx, cy, x, y, S, pad);
          x = cx + (x - cx) * k; y = cy + (y - cy) * k;
          ctx.globalAlpha = 0.55;
        }
        ctx.beginPath();
        ctx.arc(x, y, (l.found ? 3.6 : 4.2) * dpr, 0, Math.PI * 2);
        if (l.found) { ctx.fillStyle = C.lmFound; ctx.fill(); }
        else { ctx.strokeStyle = C.lmOpen; ctx.stroke(); }
        ctx.globalAlpha = 1;
      }
    }

    // Checkpoints: next (bright, clamped to the edge) + the one after (dim)
    const cps = m.checkpoints;
    if (cps && cps.length) {
      const n = cps.length, ni = ((m.next | 0) % n + n) % n;
      const c2 = cps[(ni + 1) % n];
      if (n > 1) {
        const x = a * c2.x + c * c2.z + e, y = b * c2.x + d * c2.z + f;
        if (x > 0 && x < S && y > 0 && y < S) {
          ctx.beginPath(); ctx.arc(x, y, 3.5 * dpr, 0, Math.PI * 2);
          ctx.fillStyle = C.cpDim; ctx.fill();
        }
      }
      const c1 = cps[ni];
      let x = a * c1.x + c * c1.z + e, y = b * c1.x + d * c1.z + f;
      const inside = x > pad && x < S - pad && y > pad && y < S - pad;
      if (inside) {
        ctx.beginPath(); ctx.arc(x, y, 6.5 * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = C.cp; ctx.lineWidth = 2.4 * dpr; ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 2.4 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = C.cp; ctx.fill();
      } else {
        const k = edgeT(cx, cy, x, y, S, pad);
        const ex = cx + (x - cx) * k, ey = cy + (y - cy) * k;
        const ang = Math.atan2(y - cy, x - cx);
        ctx.save();
        ctx.translate(ex, ey); ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(6 * dpr, 0); ctx.lineTo(-5 * dpr, -5.5 * dpr); ctx.lineTo(-5 * dpr, 5.5 * dpr); ctx.closePath();
        ctx.fillStyle = C.cp; ctx.fill();
        ctx.restore();
      }
    }

    // Rivals
    const rv = m.rivals;
    if (rv && rv.length) {
      ctx.fillStyle = C.rival; ctx.strokeStyle = C.playerEdge; ctx.lineWidth = 1.5 * dpr;
      for (let i = 0; i < rv.length; i++) {
        const o = rv[i];
        const x = a * o.x + c * o.z + e, y = b * o.x + d * o.z + f;
        if (x < -10 || x > S + 10 || y < -10 || y > S + 10) continue;
        ctx.beginPath(); ctx.arc(x, y, 3.6 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }

    // Player arrow (always points up)
    const u = dpr;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 9 * u); ctx.lineTo(cx + 6.5 * u, cy + 7 * u); ctx.lineTo(cx, cy + 3.5 * u); ctx.lineTo(cx - 6.5 * u, cy + 7 * u);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3 * u; ctx.strokeStyle = C.playerEdge; ctx.stroke();
    ctx.fillStyle = C.player; ctx.fill();

    // North marker on the rim
    const nx = -c, nz = -d, nl = Math.hypot(nx, nz) || 1;
    const rr = S * 0.5 - 11 * dpr;
    const mx = S * 0.5 + (nx / nl) * rr, my = S * 0.5 + (nz / nl) * rr;
    ctx.font = `700 ${10 * dpr}px "Chivo Mono", ui-monospace, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = C.north;
    ctx.fillText('N', mx, my);
  }
}

/** factor along (cx,cy)->(x,y) that lands on the inset box edge */
function edgeT(cx, cy, x, y, S, pad) {
  const dx = x - cx, dy = y - cy;
  let k = 1;
  if (dx > 0) k = Math.min(k, (S - pad - cx) / dx); else if (dx < 0) k = Math.min(k, (pad - cx) / dx);
  if (dy > 0) k = Math.min(k, (S - pad - cy) / dy); else if (dy < 0) k = Math.min(k, (pad - cy) / dy);
  return k;
}

function roadClass(t) {
  t = String(t || '');
  if (/motorway|trunk|primary/.test(t)) return 2;
  if (/secondary|tertiary/.test(t)) return 1;
  return 0;
}

function renderRoads(roads, rect) {
  const k = Math.min(0.5, 3072 / Math.max(rect.w, rect.h, 1)); // px per meter
  const W = Math.max(1, Math.ceil(rect.w * k)), H = Math.max(1, Math.ceil(rect.h * k));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = C.land;
  g.fillRect(0, 0, W, H);
  g.lineCap = 'round'; g.lineJoin = 'round';
  const byClass = [[], [], []];
  for (const r of roads) if (r && r.points && r.points.length > 1) byClass[roadClass(r.type)].push(r);
  const colors = [C.minor, C.mid, C.major];
  const minW = [1.2, 1.6, 2.2];
  for (let pass = 0; pass < 2; pass++) {
    for (let cl = 0; cl < 3; cl++) {
      g.strokeStyle = pass === 0 ? C.casing : colors[cl];
      for (const r of byClass[cl]) {
        const w = Math.max(minW[cl], (r.width || (cl === 2 ? 18 : cl === 1 ? 13 : 9)) * k);
        g.lineWidth = pass === 0 ? w + 2 : w;
        g.beginPath();
        const p = r.points;
        g.moveTo((p[0][0] - rect.x) * k, (p[0][1] - rect.z) * k);
        for (let i = 1; i < p.length; i++) g.lineTo((p[i][0] - rect.x) * k, (p[i][1] - rect.z) * k);
        g.stroke();
      }
    }
  }
  return cv;
}
