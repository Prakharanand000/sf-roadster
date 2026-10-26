// Track objects (CONTRACTS.md) from the baked dense paths: checkpoints, grid, length. Pure (Node-safe).
//
// Conventions chosen here:
// - path[0] is the start/finish line for circuits; checkpoints are spaced evenly (~200 m) and the LAST
//   checkpoint of a circuit sits on path[0] (crossing it completes the lap).
// - point-to-point: the start line is 30 m along the path, the grid sits behind it, the last checkpoint
//   is the end of the path (finish).
// - grid: 6 slots in 2 staggered columns, 8 m row spacing, +-2.6 m lateral, facing along the path.

function cumulative(path, loop) {
  const s = [0];
  for (let i = 1; i < path.length; i++) s.push(s[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const total = loop ? s[s.length - 1] + Math.hypot(path[0][0] - path[path.length - 1][0], path[0][1] - path[path.length - 1][1]) : s[s.length - 1];
  return { s, total };
}

/** position + heading at distance d along the path */
export function samplePath(path, cum, d, loop) {
  const { s, total } = cum;
  if (loop) d = ((d % total) + total) % total;
  else d = Math.max(0, Math.min(total, d));
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m] <= d) lo = m; else hi = m - 1; }
  const i = lo, j = loop ? (i + 1) % path.length : Math.min(i + 1, path.length - 1);
  const segLen = (j === 0 && loop ? total : s[j]) - s[i] || 1e-6;
  const t = Math.min(1, Math.max(0, (d - s[i]) / segLen));
  const x = path[i][0] + (path[j][0] - path[i][0]) * t, z = path[i][1] + (path[j][1] - path[i][1]) * t;
  let dx = path[j][0] - path[i][0], dz = path[j][1] - path[i][1];
  if (i === j) { const k = Math.max(0, i - 1); dx = path[i][0] - path[k][0]; dz = path[i][1] - path[k][1]; }
  return { x, z, heading: Math.atan2(dx, dz) };
}

export function buildTracks(index, Q) {
  return (index.tracks || []).map((t) => {
    const path = t.path.map((p) => [p[0], p[1]]);
    const loop = !!t.loop;
    const cum = cumulative(path, loop);
    const L = cum.total;
    const widthAt = (x, z) => {
      if (Q && Q.roadAt(x, z)) return Math.max(10, Q.roadHit.halfWidth * 2 + 6);
      return 14;
    };
    const s0 = loop ? 0 : 30;
    const n = Math.max(3, Math.round((L - s0) / 200));
    const cps = [];
    for (let k = 1; k <= n; k++) {
      const d = s0 + ((L - s0) * k) / n;
      const p = samplePath(path, cum, loop && k === n ? 0 : d, loop);
      cps.push({ x: p.x, z: p.z, heading: p.heading, width: widthAt(p.x, p.z) });
    }
    const grid = [];
    for (let k = 0; k < 6; k++) {
      const row = k >> 1, col = k & 1;
      const d = s0 - 7 - row * 8 - col * 3;
      const p = samplePath(path, cum, d, loop);
      const lx = Math.cos(p.heading), lz = -Math.sin(p.heading);   // car-left vector
      const off = col ? -2.6 : 2.6;
      grid.push({ x: p.x + lx * off, z: p.z + lz * off, heading: p.heading });
    }
    return {
      id: t.id, name: t.name, area: t.area, description: t.description, laps: t.laps, loop,
      path, checkpoints: cps, grid, lengthMeters: Math.round(L), difficulty: t.difficulty,
      startDistance: s0,
    };
  });
}
