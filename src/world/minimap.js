import { buildingMask } from './terrain.js';
// Dark, sleek top-down minimap canvas covering world.bounds exactly (north up, x -> right, z -> down).
const LC_DARK = [[14, 26, 38], [34, 37, 43], [26, 52, 38], [22, 46, 32], [70, 66, 52], [20, 40, 56], [44, 44, 48], [30, 60, 40],
  [36, 46, 36], [44, 42, 40], [42, 44, 50]];

export function drawMinimap(D, { width = 2048 } = {}) {
  const b = D.index.bounds;
  const W = width, H = Math.round((width * (b.maxZ - b.minZ)) / (b.maxX - b.minX));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const lc = D.lcInfo;
  // landcover -> small canvas, then scaled into bounds
  const src = document.createElement('canvas');
  src.width = lc.nx; src.height = lc.nz;
  const sctx = src.getContext('2d');
  const img = sctx.createImageData(lc.nx, lc.nz);
  for (let i = 0; i < D.landcover.length; i++) {
    const c = LC_DARK[D.landcover[i]] || LC_DARK[1];
    img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  const sx = W / (b.maxX - b.minX), sz = H / (b.maxZ - b.minZ);
  const px = (x) => (x - b.minX) * sx, pz = (z) => (z - b.minZ) * sz;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, px(lc.x0), pz(lc.z0), lc.nx * lc.res * sx, lc.nz * lc.res * sz);
  // buildings (faint), from a rasterised footprint mask
  {
    const mask = buildingMask(D);
    const mc = document.createElement('canvas');
    mc.width = lc.nx; mc.height = lc.nz;
    const mctx = mc.getContext('2d');
    const mi = mctx.createImageData(lc.nx, lc.nz);
    for (let i = 0; i < mask.length; i++) { mi.data[i * 4] = 70; mi.data[i * 4 + 1] = 76; mi.data[i * 4 + 2] = 92; mi.data[i * 4 + 3] = mask[i] * 0.55; }
    mctx.putImageData(mi, 0, 0);
    ctx.drawImage(mc, px(lc.x0), pz(lc.z0), lc.nx * lc.res * sx, lc.nz * lc.res * sz);
  }
  // roads by importance
  const rank = (t) => (t.startsWith('motorway') || t === 'trunk' ? 3 : t === 'primary' || t === 'secondary' ? 2 : t === 'service' ? 0 : 1);
  const style = [['rgba(120,128,145,0.45)', 0.6], ['rgba(150,158,176,0.75)', 1.0], ['rgba(205,212,228,0.95)', 1.2], ['rgba(255,196,120,0.95)', 1.4]];
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let r0 = 0; r0 <= 3; r0++) {
    ctx.strokeStyle = style[r0][0];
    ctx.beginPath();
    let any = false;
    for (const r of D.roads) {
      if (rank(r.type) !== r0) continue;
      r.points.forEach(([x, z], i) => (i ? ctx.lineTo(px(x), pz(z)) : ctx.moveTo(px(x), pz(z))));
      any = true;
    }
    if (any) {
      ctx.lineWidth = Math.max(1, (r0 === 0 ? 4 : r0 === 1 ? 9 : r0 === 2 ? 12 : 14) * sx * style[r0][1]);
      ctx.stroke();
    }
  }
  // Golden Gate deck in international orange
  ctx.strokeStyle = '#e0533a';
  ctx.lineWidth = Math.max(2, 26 * sx);
  ctx.beginPath();
  const gg = D.index.ggbridge;
  ctx.moveTo(px(gg.south[0]), pz(gg.south[1]));
  ctx.lineTo(px(gg.north[0]), pz(gg.north[1]));
  ctx.stroke();
  // Bay Bridge west span (scenery) in silver
  const bb = (D.index.landmarks || []).find((l) => l.id === 'baybridge');
  if (bb && bb.span) {
    ctx.strokeStyle = 'rgba(190,200,215,0.8)';
    ctx.lineWidth = Math.max(2, 22 * sx);
    ctx.beginPath(); ctx.moveTo(px(bb.span[0][0]), pz(bb.span[0][1])); ctx.lineTo(px(bb.span[1][0]), pz(bb.span[1][1])); ctx.stroke();
  }
  return cv;
}
