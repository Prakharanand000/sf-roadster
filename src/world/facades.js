// Procedural facade texture array: 8 styles x (upper floor, ground floor) tiles of 1 bay x 1 floor.
// RGB = albedo detail (walls white-ish so the per-building wall colour tints them), A = window glass mask
// (drives glass roughness/metalness and the night window glow).
import * as THREE from 'three';

// bay width (m) and floor height (m) per style; tint = how much the wall colour tints window glass
export const STYLE_PARAMS = [
  { name: 'glass', bay: 3.0, floor: 3.9, tint: 0.85, lit: 0.45 },
  { name: 'office', bay: 3.2, floor: 3.8, tint: 0.15, lit: 0.42 },
  { name: 'brick', bay: 3.0, floor: 3.5, tint: 0.1, lit: 0.38 },
  { name: 'victorian', bay: 2.7, floor: 3.6, tint: 0.1, lit: 0.45 },
  { name: 'stucco', bay: 3.4, floor: 3.1, tint: 0.1, lit: 0.4 },
  { name: 'deco', bay: 2.4, floor: 3.6, tint: 0.1, lit: 0.4 },
  { name: 'warehouse', bay: 4.4, floor: 4.6, tint: 0.1, lit: 0.25 },
  { name: 'modern', bay: 3.4, floor: 3.2, tint: 0.3, lit: 0.5 },
];

function rnd(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function tileCanvas(S) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  return c;
}

// Each painter draws into a 2D ctx of size S; a mask ctx receives white where glass is.
function glassGrad(ctx, x, y, w, h, top, bot) {
  const g = ctx.createLinearGradient(x, y, x + w * 0.4, y + h);
  g.addColorStop(0, top);
  g.addColorStop(1, bot);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

function noiseFill(ctx, S, amt, seed, cell = 2) {
  const r = rnd(seed);
  for (let y = 0; y < S; y += cell) {
    for (let x = 0; x < S; x += cell) {
      const v = (r() - 0.5) * amt;
      ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
      ctx.fillRect(x, y, cell, cell);
    }
  }
}

function win(ctx, m, x, y, w, h, opts = {}) {
  const { frame = 0, frameCol = '#f4f2ec', top = '#5d6b78', bot = '#26313b', mullV = 0, mullH = 0, mullCol = '#e8e6e0' } = opts;
  if (frame) {
    ctx.fillStyle = frameCol;
    ctx.fillRect(x - frame, y - frame, w + frame * 2, h + frame * 2);
  }
  glassGrad(ctx, x, y, w, h, top, bot);
  m.fillStyle = '#fff';
  m.fillRect(x, y, w, h);
  ctx.fillStyle = mullCol;
  m.fillStyle = '#000';
  for (let i = 1; i <= mullV; i++) {
    const xx = x + (w * i) / (mullV + 1);
    ctx.fillRect(xx - 1.5, y, 3, h);
    m.fillRect(xx - 1.5, y, 3, h);
  }
  for (let i = 1; i <= mullH; i++) {
    const yy = y + (h * i) / (mullH + 1);
    ctx.fillRect(x, yy - 1.5, w, 3);
    m.fillRect(x, yy - 1.5, w, 3);
  }
}

const PAINTERS = [
  // 0 glass curtain wall
  (c, m, S, ground) => {
    c.fillStyle = '#d8dde2'; c.fillRect(0, 0, S, S);
    if (ground) {
      win(c, m, S * 0.04, S * 0.12, S * 0.92, S * 0.88, { top: '#70808c', bot: '#2a333b', mullV: 1 });
      c.fillStyle = '#9aa3aa'; c.fillRect(0, 0, S, S * 0.1);
      return;
    }
    win(c, m, S * 0.025, 0, S * 0.95, S * 0.8, { top: '#a9b8c4', bot: '#4b5a68', mullV: 1 });
    c.fillStyle = '#7f8a94'; c.fillRect(0, S * 0.8, S, S * 0.2);   // spandrel
    c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(0, S * 0.8, S, 3);
  },
  // 1 office: concrete with ribbon windows
  (c, m, S, ground) => {
    c.fillStyle = '#eceae4'; c.fillRect(0, 0, S, S);
    noiseFill(c, S, 0.06, 11, 4);
    if (ground) {
      c.fillStyle = '#8c8a84'; c.fillRect(0, 0, S, S * 0.16);
      win(c, m, S * 0.06, S * 0.22, S * 0.88, S * 0.78, { top: '#73828c', bot: '#252c33', mullV: 1, frame: 4, frameCol: '#5c5f62' });
      return;
    }
    win(c, m, 0, S * 0.26, S, S * 0.5, { top: '#8494a0', bot: '#323c46', mullV: 1, mullCol: '#9a9c9e' });
    c.fillStyle = 'rgba(0,0,0,0.12)'; c.fillRect(0, S * 0.76, S, 4);
  },
  // 2 brick with punched windows
  (c, m, S, ground) => {
    c.fillStyle = '#e6e0d8'; c.fillRect(0, 0, S, S);
    c.fillStyle = 'rgba(80,60,50,0.22)';
    const bh = S / 22;
    for (let r = 0; r < 22; r++) {
      c.fillRect(0, r * bh, S, 1.5);
      const off = (r % 2) * (S / 12);
      for (let x = off; x < S; x += S / 6) c.fillRect(x, r * bh, 1.5, bh);
    }
    noiseFill(c, S, 0.08, 23, 4);
    if (ground) {
      c.fillStyle = '#3c3a38'; c.fillRect(S * 0.04, S * 0.08, S * 0.92, S * 0.16);   // sign band
      win(c, m, S * 0.08, S * 0.3, S * 0.84, S * 0.7, { top: '#6f7d86', bot: '#232a30', mullV: 2, frame: 5, frameCol: '#4a3b30' });
      return;
    }
    c.fillStyle = '#f2ede2'; c.fillRect(S * 0.27, S * 0.17, S * 0.46, S * 0.06);        // lintel
    c.fillRect(S * 0.27, S * 0.8, S * 0.46, S * 0.05);                                // sill
    win(c, m, S * 0.3, S * 0.23, S * 0.4, S * 0.57, { top: '#6d7c88', bot: '#29323a', mullH: 1, mullCol: '#e8e2d6' });
  },
  // 3 Victorian: clapboard siding, tall trimmed window, cornice
  (c, m, S, ground) => {
    c.fillStyle = '#f4f2ee'; c.fillRect(0, 0, S, S);
    c.fillStyle = 'rgba(0,0,0,0.10)';
    for (let y = 0; y < S; y += S / 26) c.fillRect(0, y, S, 2);
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.fillRect(0, 0, S * 0.05, S); c.fillRect(S * 0.95, 0, S * 0.05, S);              // corner boards
    if (ground) {
      // garage door + entry stair
      c.fillStyle = '#fbfaf6'; c.fillRect(S * 0.12, S * 0.28, S * 0.76, S * 0.72);
      c.fillStyle = 'rgba(0,0,0,0.13)';
      for (let y = S * 0.36; y < S; y += S * 0.16) c.fillRect(S * 0.14, y, S * 0.72, 3);
      c.fillStyle = '#ffffff'; c.fillRect(S * 0.08, S * 0.2, S * 0.84, S * 0.07);
      win(c, m, S * 0.3, S * 0.04, S * 0.4, S * 0.12, { top: '#7d8a94', bot: '#3a434c', mullV: 2 });
      return;
    }
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, S, S * 0.07);                            // cornice band
    c.fillStyle = 'rgba(0,0,0,0.18)';
    for (let x = 4; x < S; x += S / 16) c.fillRect(x, S * 0.07, S / 32, S * 0.03);      // dentils
    c.fillStyle = '#ffffff';
    c.fillRect(S * 0.24, S * 0.14, S * 0.52, S * 0.08);                                 // pediment cap
    win(c, m, S * 0.3, S * 0.24, S * 0.4, S * 0.58, { frame: 9, frameCol: '#ffffff', top: '#6e7e8a', bot: '#2b343c', mullH: 1, mullCol: '#ffffff' });
    c.fillStyle = '#ffffff'; c.fillRect(S * 0.24, S * 0.86, S * 0.52, S * 0.05);
  },
  // 4 stucco (Marina / Mediterranean): arched window
  (c, m, S, ground) => {
    c.fillStyle = '#f6f3ec'; c.fillRect(0, 0, S, S);
    noiseFill(c, S, 0.07, 41, 3);
    if (ground) {
      c.fillStyle = '#ece8e0'; c.fillRect(S * 0.1, S * 0.3, S * 0.8, S * 0.7);
      c.fillStyle = 'rgba(0,0,0,0.14)';
      for (let y = S * 0.4; y < S; y += S * 0.15) c.fillRect(S * 0.12, y, S * 0.76, 3);
      c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(S * 0.08, S * 0.27, S * 0.84, 4);
      return;
    }
    const x = S * 0.28, w = S * 0.44, y = S * 0.3, h = S * 0.5;
    c.save(); m.save();
    for (const g of [c, m]) {
      g.beginPath(); g.moveTo(x, y + h); g.lineTo(x, y); g.arc(x + w / 2, y, w / 2, Math.PI, 0); g.lineTo(x + w, y + h); g.closePath();
    }
    c.fillStyle = '#ffffff'; c.lineWidth = 10; c.strokeStyle = '#ffffff'; c.stroke();
    c.clip(); m.clip();
    glassGrad(c, x, y - w / 2, w, h + w / 2, '#768590', '#2c353d');
    m.fillStyle = '#fff'; m.fillRect(x, y - w / 2, w, h + w / 2);
    c.fillStyle = '#ffffff'; m.fillStyle = '#000';
    c.fillRect(x + w / 2 - 1.5, y - w / 2, 3, h + w / 2); m.fillRect(x + w / 2 - 1.5, y - w / 2, 3, h + w / 2);
    c.restore(); m.restore();
    c.fillStyle = 'rgba(120,70,40,0.5)'; c.fillRect(x - 6, y + h, w + 12, 6);          // tile sill
  },
  // 5 art deco: piers + recessed windows + spandrel ornament
  (c, m, S, ground) => {
    c.fillStyle = '#efe9de'; c.fillRect(0, 0, S, S);
    noiseFill(c, S, 0.05, 57, 4);
    c.fillStyle = '#faf6ee'; c.fillRect(0, 0, S * 0.14, S); c.fillRect(S * 0.86, 0, S * 0.14, S);
    c.fillStyle = 'rgba(0,0,0,0.08)'; c.fillRect(S * 0.14, 0, 3, S); c.fillRect(S * 0.86 - 3, 0, 3, S);
    if (ground) {
      win(c, m, S * 0.18, S * 0.2, S * 0.64, S * 0.8, { top: '#6c7a84', bot: '#20272d', mullV: 1, frame: 4, frameCol: '#b89a5a' });
      c.fillStyle = '#b89a5a'; c.fillRect(S * 0.14, S * 0.08, S * 0.72, S * 0.06);
      return;
    }
    win(c, m, S * 0.2, S * 0.14, S * 0.6, S * 0.62, { top: '#717f8a', bot: '#2a3239', mullH: 2, mullCol: '#d9d2c2' });
    c.fillStyle = 'rgba(150,120,70,0.35)';
    for (let i = 0; i < 5; i++) c.fillRect(S * (0.22 + i * 0.12), S * 0.82, S * 0.06, S * 0.1);
  },
  // 6 warehouse: big multi-pane industrial windows
  (c, m, S, ground) => {
    c.fillStyle = '#e8e2da'; c.fillRect(0, 0, S, S);
    noiseFill(c, S, 0.1, 71, 4);
    c.fillStyle = 'rgba(0,0,0,0.08)';
    for (let y = 0; y < S; y += S / 18) c.fillRect(0, y, S, 1.5);
    if (ground) {
      c.fillStyle = '#9ea2a4'; c.fillRect(S * 0.1, S * 0.18, S * 0.8, S * 0.82);       // roll-up door
      c.fillStyle = 'rgba(0,0,0,0.18)';
      for (let y = S * 0.2; y < S; y += S * 0.05) c.fillRect(S * 0.1, y, S * 0.8, 2);
      return;
    }
    win(c, m, S * 0.1, S * 0.2, S * 0.8, S * 0.62, { top: '#7c8a90', bot: '#3a4448', mullV: 3, mullH: 2, mullCol: '#3b3f42', frame: 5, frameCol: '#d8d2c8' });
  },
  // 7 modern apartments: floor-to-ceiling glass + balcony rail
  (c, m, S, ground) => {
    c.fillStyle = '#f0f0ee'; c.fillRect(0, 0, S, S);
    if (ground) {
      win(c, m, S * 0.04, S * 0.1, S * 0.92, S * 0.9, { top: '#6f7f8a', bot: '#1f262c', mullV: 1 });
      return;
    }
    win(c, m, S * 0.06, S * 0.08, S * 0.88, S * 0.8, { top: '#8a9aa6', bot: '#2f3942', mullV: 1, mullCol: '#cfd2d4' });
    c.fillStyle = 'rgba(40,44,48,0.85)'; c.fillRect(0, S * 0.62, S, 4);                 // rail
    c.fillStyle = 'rgba(40,44,48,0.5)';
    for (let x = 6; x < S; x += S / 12) c.fillRect(x, S * 0.62, 2, S * 0.26);
    c.fillStyle = '#d4d6d8'; c.fillRect(0, S * 0.88, S, S * 0.12);                      // slab edge
  },
];

/** Returns a THREE.DataArrayTexture with 16 layers (style*2 + ground). Browser only. */
export function createFacadeTexture(size = 256) {
  const S = size, L = PAINTERS.length * 2;
  const data = new Uint8Array(S * S * 4 * L);
  const c = tileCanvas(S), m = tileCanvas(S);
  const cx = c.getContext('2d', { willReadFrequently: true }), mx = m.getContext('2d', { willReadFrequently: true });
  for (let st = 0; st < PAINTERS.length; st++) {
    for (let g = 0; g < 2; g++) {
      cx.setTransform(1, 0, 0, 1, 0, 0); mx.setTransform(1, 0, 0, 1, 0, 0);
      cx.clearRect(0, 0, S, S);
      mx.fillStyle = '#000'; mx.fillRect(0, 0, S, S);
      PAINTERS[st](cx, mx, S, g === 1);
      const a = cx.getImageData(0, 0, S, S).data, b = mx.getImageData(0, 0, S, S).data;
      const off = (st * 2 + g) * S * S * 4;
      for (let i = 0; i < S * S; i++) {
        data[off + i * 4] = a[i * 4];
        data[off + i * 4 + 1] = a[i * 4 + 1];
        data[off + i * 4 + 2] = a[i * 4 + 2];
        data[off + i * 4 + 3] = b[i * 4];
      }
    }
  }
  const tex = new THREE.DataArrayTexture(data, S, S, L);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
