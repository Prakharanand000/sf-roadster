// Run dev/physics-ai-sf.mjs for many random race setups and aggregate per track.
//   node dev/physics-ai-batch.mjs [nSeeds=8]
import { execFileSync } from 'node:child_process';
const N = +(process.argv[2] || 8);
const agg = {};
for (let seed = 1; seed <= N; seed++) {
  const outp = execFileSync(process.execPath, ['dev/physics-ai-sf.mjs', 'all'], { env: { ...process.env, SEED: String(seed), JSON: '1' }, encoding: 'utf8', maxBuffer: 1 << 26 });
  const line = outp.split('\n').find(l => l.startsWith('JSON'));
  for (const r of JSON.parse(line.slice(4))) {
    const a = agg[r.track] || (agg[r.track] = { rivals: { laps: 0, recov: 0, resets: 0, water: 0, dnf: 0, maxRecLap: 0, lapSum: 0, lapN: 0 }, auto: { laps: 0, recov: 0, resets: 0, water: 0, dnf: 0, lapSum: 0, lapN: 0, maxRecLap: 0 } });
    const b = r.name === 'autopilot' ? a.auto : a.rivals;
    b.laps += r.laps; b.recov += r.recov; b.resets += r.resets; b.water += r.water; if (r.finish === null) b.dnf++;
    b.maxRecLap = Math.max(b.maxRecLap, r.recov / r.laps);
    for (const t of r.lapT) { b.lapSum += t; b.lapN++; }
  }
}
console.log(`${N} random race setups (3 rivals skill 0.55-0.95 + skill-1 Roadster autopilot, traffic 18)`);
console.log('| track | rival laps | recov/lap avg (max per car) | resets/lap | water | DNF | rival avg lap s | autopilot recov/lap | autopilot resets | autopilot water | autopilot avg lap s |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const [t, a] of Object.entries(agg)) {
  const r = a.rivals, p = a.auto;
  console.log(`| ${t} | ${r.laps} | ${(r.recov / r.laps).toFixed(2)} (${r.maxRecLap.toFixed(1)}) | ${(r.resets / r.laps).toFixed(2)} | ${r.water} | ${r.dnf} | ${(r.lapSum / r.lapN).toFixed(1)} | ${(p.recov / p.laps).toFixed(2)} | ${p.resets} | ${p.water} | ${(p.lapSum / p.lapN).toFixed(1)} |`);
}
