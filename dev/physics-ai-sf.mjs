// Headless AI race sim on the REAL San Francisco world (PHYSICS agent).
//   node dev/physics-ai-sf.mjs [trackId|all] [--verbose] [--seed N] [--laps N]
// Mirrors src/main.js race loop: Roadster "player" on an AIDriver autopilot (skill 1),
// 3 rivals (skill 0.55 / 0.75 / 0.95), traffic count 18, racers' vehicles as `others`,
// needsReset -> resetToTrack, water > 1.4 s -> respawn.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';
import { createWorldData } from '../src/world/city.js';
import { CARS } from '../src/cars/models.js';
import { Vehicle, resolveVehicleCollisions } from '../src/physics/vehicle.js';
import { AIDriver } from '../src/physics/ai.js';
import { Traffic } from '../src/physics/traffic.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = JSON.parse(readFileSync(path.join(root, 'data/world.json'), 'utf8'));
const bin = readFileSync(path.join(root, existsSync(path.join(root, 'data/world.bin')) ? 'data/world.bin' : 'data/world.bin.wasm'));
const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const { D, Q, tracks, spawn } = createWorldData(index, buffer);
const world = { ...Q, bounds: Q.bounds, roads: D.roads, roadGraph: D.graph, tracks, spawn };

const args = process.argv.slice(2);
const which = args.find(a => !a.startsWith('--')) || 'all';
const verbose = args.includes('--verbose');
const lapsArg = args.includes('--laps') ? +args[args.indexOf('--laps') + 1] : null;
const DT = 1 / 60;
const stubModel = () => ({ group: new THREE.Group(), wheels: [], setBrake() {}, dispose() {} });

function runTrack(track) {
  const laps = track.loop ? (lapsArg || track.laps || 1) : 1;
  const roadster = CARS.find(c => c.id === 'roadster');
  let rivalsSpecs = (process.env.CARS || 'gt3rs,revuelto,chiron').split(',').map(id => CARS.find(c => c.id === id));
  let skills = [1.0, ...(process.env.SKILLS || '0.55,0.75,0.95').split(',').map(Number)];
  let aggr = [0.5, ...(process.env.AGGR || '0.2,0.5,0.9').split(',').map(Number)];
  if (process.env.SEED) { // like src/main.js: random rivals (not the roadster), skill 0.55..0.95, random aggression
    let a = (+process.env.SEED * 2654435761) >>> 0;
    const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pool = CARS.filter(c => c.id !== 'roadster').sort(() => rnd() - 0.5);
    rivalsSpecs = pool.slice(0, 3);
    skills = [1.0, ...[0, 1, 2].map(() => 0.55 + rnd() * 0.4)];
    aggr = [0.5, ...[0, 1, 2].map(() => rnd())];
  }
  const racers = [];
  const specs = [roadster, ...rivalsSpecs];
  for (let i = 0; i < 4; i++) {
    const v = new Vehicle(specs[i], world);
    const slot = track.grid[(i + 3) % 4] || track.grid[0];
    v.reset(slot.x, slot.z, slot.heading);
    v.thrusterFuel = 1;
    if (i === 0) v.isPlayer = true;
    const r = { name: i === 0 ? 'autopilot' : specs[i].id + '@' + skills[i].toFixed(2), v, recov: [], resets: [], water: 0, waterT: 0, hardHits: 0, finishT: null, lapT: [] };
    racers.push(r);
  }
  for (const r of racers) r.ai = new AIDriver(r.v, track, { skill: skills[racers.indexOf(r)], aggression: aggr[racers.indexOf(r)], name: r.name, player: racers[0].v });
  for (const r of racers) {
    r.v.onSplash = () => { r.water++; r.events = r.events || []; };
    r.v.onCollision = (s) => { if (s > 0.45) r.hardHits++; };
  }
  const traffic = new Traffic(null, world, stubModel, { count: 18 });
  const L = r0 => r0.ai.path.length;
  const limit = (L(racers[0]) * laps) / 12 + 150;
  let t = 0;
  const lastRec = racers.map(() => 0);
  const lastLap = racers.map(() => 0);
  while (t < limit) {
    t += DT;
    const others = racers.map(r => r.v);
    for (let i = 0; i < racers.length; i++) {
      const r = racers[i];
      let inp = r.ai.getInput(DT, world, others);
      if (r.finishT !== null) inp = { ...inp, throttle: Math.min(inp.throttle, 0.3) };
      r.v.update(DT, inp);
      if (process.env.WHO && r.name.startsWith(process.env.WHO) && t >= +process.env.FROM && t <= +process.env.TO && Math.round(t * 60) % (+process.env.EVERY || 6) === 0) {
        const near = traffic.proxies.concat(racers.map(o => o.v)).filter(o => o !== r.v && o.position.distanceTo(r.v.position) < 12).map(o => (o.isTraffic ? 'T' : 'R') + o.position.distanceTo(r.v.position).toFixed(1) + (o.isTraffic ? `[h${((o.heading - r.v.heading) * 57.3).toFixed(0)} v${o.speed.toFixed(0)} road${o.car.road} ${o.car.state}]` : '')).join(',');
        console.log(`${t.toFixed(2)} s ${r.ai.tracker.s.toFixed(0)} lat ${r.ai.tracker.lat.toFixed(1)} off ${r.ai.offset.toFixed(1)} v ${r.v.speed.toFixed(1)} tgt ${r.ai.targetSpeed.toFixed(1)} thr ${inp.throttle.toFixed(2)} brk ${inp.brake.toFixed(2)} st ${inp.steer.toFixed(2)} b ${r.v.driftAngle.toFixed(2)} gnd ${r.v.wheelsOnGround} y ${r.v.position.y.toFixed(1)} upY ${r.v._upV.y.toFixed(2)} ${r.ai.mode} pos (${r.v.position.x.toFixed(1)},${r.v.position.z.toFixed(1)}) imp ${r.v.lastImpactStrength.toFixed(2)} near ${near}`);
      }
      if (r.ai.recoveries > lastRec[i]) { lastRec[i] = r.ai.recoveries; r.recov.push([t, r.v.position.x, r.v.position.z, r.ai.tracker.s]); }
      if (r.ai.needsReset) { r.resets.push([t, r.ai.resetReason, r.v.position.x, r.v.position.z, r.ai.tracker.s]); r.ai.resetToTrack(); r.ai.needsReset = false; }
      if (r.v.inWater) { r.waterT += DT; if (r.waterT > 1.4) { r.resets.push([t, 'water-respawn', r.v.position.x, r.v.position.z, r.ai.tracker.s]); r.ai.resetToTrack(); r.waterT = 0; } } else r.waterT = 0;
      const done = track.loop ? r.ai.lapsCompleted : (r.ai.finished ? 1 : 0);
      if (done > lastLap[i]) { r.lapT.push(t); lastLap[i] = done; }
      if (r.finishT === null && done >= laps) r.finishT = t;
    }
    traffic.update(DT, racers[0].v, racers.slice(1).map(r => r.v));
    resolveVehicleCollisions([...racers.map(r => r.v), ...traffic.proxies]);
    if (racers.every(r => r.finishT !== null)) break;
    if (process.env.TRACE && Math.round(t * 60) % 120 === 0) console.log(t.toFixed(0), racers.map(r => `${r.name.slice(0, 6)} s${r.ai.tracker.s.toFixed(0)} L${r.ai.tracker.lap} v${r.v.speed.toFixed(0)} ${r.ai.mode}`).join(' | '));
  }
  return { track, laps, racers, t };
}

const list = which === 'all' ? tracks : tracks.filter(t => t.id === which);
const out = [];
for (const tr of list) {
  const t0 = performance.now();
  const res = runTrack(tr);
  const ms = performance.now() - t0;
  let line = `${tr.id.padEnd(19)} L=${tr.path ? res.racers[0].ai.path.length.toFixed(0) : '?'}m laps=${res.laps} sim ${res.t.toFixed(0)}s (${(ms / 1000).toFixed(1)}s wall)`;
  console.log(line);
  for (const r of res.racers) {
    const lt = r.lapT.map((x, k) => (k ? x - r.lapT[k - 1] : x).toFixed(1)).join('/');
    const recPerLap = r.ai.recoveries / res.laps;
    console.log(`   ${r.name.padEnd(14)} ${r.finishT !== null ? 'finished ' + r.finishT.toFixed(1) + 's' : 'DNF'.padEnd(15)} laps[${lt}] recov ${r.ai.recoveries} (${recPerLap.toFixed(1)}/lap) resets ${r.resets.length} water ${r.water} hardHits ${r.hardHits}`);
    if (verbose) {
      for (const e of r.recov) console.log(`      recovery t=${e[0].toFixed(1)} at (${e[1].toFixed(0)},${e[2].toFixed(0)}) s=${e[3].toFixed(0)}`);
      for (const e of r.resets) console.log(`      reset ${e[1]} t=${e[0].toFixed(1)} at (${e[2].toFixed(0)},${e[3].toFixed(0)}) s=${e[4].toFixed(0)}`);
    }
    out.push({ track: tr.id, name: r.name, finish: r.finishT, recov: r.ai.recoveries, resets: r.resets.length, water: r.water, laps: res.laps, lapT: r.lapT.slice(0, res.laps).map((x, k) => (k ? x - r.lapT[k - 1] : x)) });
  }
}
if (process.env.JSON) console.log('JSON' + JSON.stringify(out));
const ais = out.filter(o => o.name !== 'autopilot');
console.log(`\nSUMMARY rivals: avg recov/lap ${(ais.reduce((a, o) => a + o.recov / o.laps, 0) / ais.length).toFixed(2)}, max recov/lap ${Math.max(...ais.map(o => o.recov / o.laps)).toFixed(1)}, resets ${out.reduce((a, o) => a + o.resets, 0)}, water ${out.reduce((a, o) => a + o.water, 0)}, DNF ${out.filter(o => o.finish === null).length}`);
