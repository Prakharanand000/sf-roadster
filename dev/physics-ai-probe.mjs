// Diagnostics for AI on the real SF world.  node dev/physics-ai-probe.mjs path <track> <s0> <s1>
//                                            node dev/physics-ai-probe.mjs drive <track> <carId> <skill> <t0> <t1>
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createWorldData } from '../src/world/city.js';
import { CARS } from '../src/cars/models.js';
import { Vehicle } from '../src/physics/vehicle.js';
import { AIDriver, TrackPath } from '../src/physics/ai.js';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = JSON.parse(readFileSync(path.join(root, 'data/world.json'), 'utf8'));
const bin = readFileSync(path.join(root, existsSync(path.join(root, 'data/world.bin')) ? 'data/world.bin' : 'data/world.bin.wasm'));
const { D, Q, tracks, spawn } = createWorldData(index, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const world = { ...Q, bounds: Q.bounds, roads: D.roads, tracks, spawn };
const [mode, tid, a1, a2, a3, a4] = process.argv.slice(2);
const track = tracks.find(t => t.id === tid);
const P = TrackPath.for(track, world);
const hit = {};
if (mode === 'path') {
  for (let i = 0; i < P.n; i++) {
    const s = P.s[i]; if (s < +a1 || s > +a2) continue;
    // free width: probe left/right for walls
    const lx = P.tz[i], lz = -P.tx[i];
    let L = 0, R = 0;
    for (let d = 0; d <= 20; d += 0.5) { if (Q.collideCircle(P.x[i] + lx * d, P.z[i] + lz * d, 0.5, P.h[i], hit)) break; L = d; }
    for (let d = 0; d <= 20; d += 0.5) { if (Q.collideCircle(P.x[i] - lx * d, P.z[i] - lz * d, 0.5, P.h[i], hit)) break; R = d; }
    console.log(`s ${s.toFixed(0)} (${P.x[i].toFixed(0)},${P.z[i].toFixed(0)}) h ${P.h[i].toFixed(1)} slope ${(P.slope[i]*100).toFixed(0)}% k ${P.k[i].toFixed(3)} (R ${(1/Math.abs(P.k[i]||1e-9)).toFixed(0)}) vk ${P.vk[i].toFixed(4)} free L ${L} R ${R} surf ${Q.surfaceAt(P.x[i], P.z[i], P.h[i]+1)}`);
  }
} else {
  const spec = CARS.find(c => c.id === a1);
  const v = new Vehicle(spec, world);
  const g = track.grid[0]; v.reset(g.x, g.z, g.heading);
  const ai = new AIDriver(v, track, { skill: +a2, aggression: 0.5, name: 'probe' });
  let t = 0; const DT = 1 / 60;
  v.onCollision = (s, p) => { if (t >= +a3 && t <= +a4) console.log(`   HIT ${s.toFixed(2)} at (${p.x.toFixed(1)},${p.z.toFixed(1)})`); };
  while (t < +a4) {
    t += DT;
    const inp = ai.getInput(DT, world, [v]);
    v.update(DT, inp);
    if (ai.needsReset) { if (t >= +a3) console.log('   RESET', ai.resetReason); ai.resetToTrack(); }
    if (t >= +a3 && Math.round(t * 60) % 10 === 0)
      console.log(`${t.toFixed(2)} s ${ai.tracker.s.toFixed(0)} lat ${ai.tracker.lat.toFixed(1)} off ${ai.offset.toFixed(1)} v ${v.speed.toFixed(1)} tgt ${ai.targetSpeed.toFixed(1)} thr ${inp.throttle.toFixed(2)} brk ${inp.brake.toFixed(2)} st ${inp.steer.toFixed(2)} ang ${v.steerAngle.toFixed(2)} b ${v.driftAngle.toFixed(2)} gnd ${v.wheelsOnGround} y ${v.position.y.toFixed(1)} ${ai.mode} pos (${v.position.x.toFixed(0)},${v.position.z.toFixed(0)}) gear ${v.gear}`);
  }
}
