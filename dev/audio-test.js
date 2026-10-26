// Audio test bench (dev only). Live controls + OfflineAudioContext level tests.
import { AudioSystem } from '../src/audio/audio.js';

const $ = (id) => document.getElementById(id);
const log = (m) => { const el = $('log'); el.textContent = `[${new Date().toLocaleTimeString()}] ${m}\n` + el.textContent; };
window.addEventListener('error', (e) => log('ERROR ' + e.message));
window.addEventListener('unhandledrejection', (e) => log('REJECTION ' + (e.reason && e.reason.message)));

const audio = new AudioSystem();
window.__audio = audio;
audio.onTrackChange = (i) => { log(`track: ${i.title} - ${i.artist} [${i.station}]`); };

$('unlock').onclick = async () => {
  const ok = await audio.unlock();
  $('state').textContent = ok ? 'running (' + audio.context.sampleRate + ' Hz)' : 'blocked: ' + (audio.context && audio.context.state);
  renderSongs();
};
// any gesture unlocks too (what the game should do)
document.addEventListener('pointerdown', () => audio.unlock(), { once: true });

// --- engine
let profile = 'v8';
const pdiv = $('profiles');
for (const p of AudioSystem.ENGINE_PROFILES) {
  const b = document.createElement('button'); b.textContent = p; b.dataset.p = p;
  b.onclick = () => { profile = p; audio.setEngineProfile(p); [...pdiv.children].forEach((c) => c.classList.toggle('on', c.dataset.p === p)); };
  pdiv.appendChild(b);
}
pdiv.querySelector('[data-p="v8"]').classList.add('on');
audio.setEngineProfile('v8');

const sim = { gear: 1, rpm: 0.05, speed: 0, phase: 'accel', pt: 0, thr: 0 };
function sweep(dt) {
  sim.pt += dt;
  if (sim.phase === 'accel') {
    sim.thr = 1;
    sim.rpm += dt * 1.1 / (0.6 + sim.gear * 0.45);
    if (sim.rpm > 0.96) {
      if (sim.gear < 7) { sim.gear++; sim.rpm = 0.58; audio.play('gear'); } else { sim.phase = 'lift'; sim.pt = 0; }
    }
    sim.speed = Math.min(105, (sim.gear - 1 + sim.rpm) * 15);
  } else if (sim.phase === 'lift') {
    sim.thr = 0;
    sim.rpm = Math.max(0.3, sim.rpm - dt * 0.35);
    sim.speed = Math.max(0, sim.speed - dt * 12);
    if (sim.pt > 2.2) { sim.phase = 'idle'; sim.pt = 0; }
  } else {
    sim.thr = 0; sim.gear = 1;
    sim.rpm += (0.03 - sim.rpm) * Math.min(1, dt * 4);
    sim.speed = Math.max(0, sim.speed - dt * 40);
    if (sim.pt > 1.5) { sim.phase = 'accel'; sim.pt = 0; }
  }
  $('rpm').value = sim.rpm; $('thr').value = sim.thr; $('spd').value = sim.speed;
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if ($('sweep').checked) sweep(dt);
  for (const [id, d] of [['rpm', 3], ['thr', 2], ['spd', 1], ['slip', 2], ['inten', 2]]) $(id + 'V').textContent = (+$(id).value).toFixed(d);
  $('gearV').textContent = 'gear ' + sim.gear;
  if ($('engOn').checked) {
    audio.updateEngine({
      rpm: +$('rpm').value, throttle: +$('thr').value, speed: +$('spd').value, gear: sim.gear,
      boosting: $('boost').checked, hovering: $('hover').checked, onGround: $('ground').checked,
      slip: +$('slip').value, inWater: $('water').checked, maxSpeed: 100,
    });
  }
  const np = audio.getNowPlaying();
  if (np) {
    const pos = np.position != null ? ` ${fmt(np.position)} / ${fmt(np.duration)}` : '';
    $('np').innerHTML = `<b>${esc(np.title)}</b> - ${esc(np.artist || '')}<small>${esc(np.station)}${np.raag ? ' | raag ' + np.raag + ' | ' + np.taal + ' ' + np.bpm + ' bpm' : ''}${np.section ? ' | ' + np.section : ''}${pos}</small>`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
$('gearBtn').onclick = () => audio.play('gear');

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --- sfx
for (const n of AudioSystem.SFX_NAMES) {
  const b = document.createElement('button'); b.textContent = n;
  b.onclick = () => audio.play(n, { intensity: +$('inten').value });
  if (n === 'ui-hover') b.onmouseenter = () => audio.play('ui-hover');
  $('sfx').appendChild(b);
}

// --- radio
for (const b of document.querySelectorAll('[data-st]')) b.onclick = () => audio.setRadio(b.dataset.st);
$('next').onclick = () => audio.nextTrack();
$('prev').onclick = () => audio.prevTrack();
$('files').onchange = (e) => { const n = audio.addUserFiles(e.target.files); log(`added ${n} file(s)`); };
const vols = () => audio.setVolumes({ master: +$('vMaster').value, music: +$('vMusic').value, sfx: +$('vSfx').value });
for (const id of ['vMaster', 'vMusic', 'vSfx']) $(id).oninput = vols;
$('duck').oninput = () => audio.duck(+$('duck').value);
$('paused').onchange = () => audio.setPaused($('paused').checked);
function renderSongs() {
  const d = $('songs'); d.innerHTML = '';
  audio.getSongs().forEach((s) => {
    const b = document.createElement('button');
    b.textContent = `${s.title} (${s.raag}, ${s.taal})`;
    b.onclick = () => audio.playSong(s.index, { section: $('section').value || undefined });
    d.appendChild(b);
  });
}
renderSongs();

// --- offline tests
function analyse(buf) {
  const chs = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  const n = buf.length;
  let sum = 0, peak = 0;
  const win = Math.floor(buf.sampleRate * 0.1);
  let wsum = 0, wcount = 0, silent = 0, windows = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const d of chs) { const x = d[i]; v += x * x; const a = Math.abs(x); if (a > peak) peak = a; }
    v /= chs.length; sum += v; wsum += v; wcount++;
    if (wcount === win) { windows++; if (Math.sqrt(wsum / win) < 0.002) silent++; wsum = 0; wcount = 0; }
  }
  return { rms: Math.sqrt(sum / n), peak, silent: windows ? silent / windows : 0 };
}

async function renderCase(name, dur, setup, step) {
  const sr = 44100;
  const off = new OfflineAudioContext(2, Math.floor(sr * dur), sr);
  const A = new AudioSystem({ context: off });
  setup.pre && setup.pre(A);
  await A.unlock();
  setup.post && setup.post(A);
  const dt = 1 / 30;
  for (let t = dt; t < dur - 0.01; t += dt) {
    const tq = Math.round((t * sr) / 128) * 128 / sr;
    off.suspend(tq).then(() => { try { step(A, tq); A.tick(); } catch (e) { log('step error ' + e.message); } off.resume(); });
  }
  const t0 = performance.now();
  const buf = await off.startRendering();
  const ms = performance.now() - t0;
  const r = analyse(buf);
  r.name = name; r.speed = (dur * 1000) / ms;
  r.errors = A.fm ? A.fm.errorCount || 0 : 0;
  return r;
}

function engineStep(profileName) {
  const st = { gear: 1, rpm: 0.05, speed: 0 };
  return (A, t) => {
    // 0-0.4 idle, 0.4-2.6 full throttle through gears, 2.6-3.4 lift (crackle/blow-off), 3.4-4 boost+slip
    let thr = 0, boosting = false, slip = 0;
    if (t > 0.4 && t < 2.6) {
      thr = 1; st.rpm += (1 / 30) * 1.6 / (0.5 + st.gear * 0.3);
      if (st.rpm > 0.95) { st.gear++; st.rpm = 0.6; A.play('gear'); }
    } else if (t >= 2.6 && t < 3.4) { st.rpm = Math.max(0.35, st.rpm - 0.012); } else if (t >= 3.4) { thr = 0.8; boosting = true; slip = 0.8; st.rpm = Math.min(0.9, st.rpm + 0.01); }
    st.speed = (st.gear - 1 + st.rpm) * 12;
    A.updateEngine({ rpm: st.rpm, throttle: thr, speed: st.speed, gear: st.gear, boosting, hovering: false, onGround: true, slip, inWater: false, maxSpeed: 100 });
  };
}

$('offline').onclick = async () => {
  const tb = $('offTable').querySelector('tbody'); tb.innerHTML = '';
  $('offState').textContent = 'rendering...';
  const results = [];
  const add = (r, kind) => {
    const loud = kind === 'engine' ? r.rms > 0.01 : r.rms > 0.02;
    const okClip = r.peak < 0.995;
    const okSil = kind === 'engine' ? r.silent < 0.15 : r.silent < 0.35;
    r.ok = loud && okClip && okSil && !r.errors;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(r.name)}</td><td>${r.rms.toFixed(4)}</td><td>${r.peak.toFixed(3)}</td><td>${(r.silent * 100).toFixed(0)}</td><td>${r.speed.toFixed(1)}</td><td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? 'OK' : (!loud ? 'too quiet' : !okClip ? 'CLIPPING' : !okSil ? 'gaps' : 'errors ' + r.errors)}</td>`;
    tb.appendChild(tr);
    results.push(r);
  };
  try {
    for (const p of AudioSystem.ENGINE_PROFILES) {
      add(await renderCase('engine ' + p, 4, { pre: (A) => { A.setRadio('off'); A.setEngineProfile(p); } }, engineStep(p)), 'engine');
    }
    const songs = new AudioSystem().getSongs();
    const cases = [[0, 'chorus'], [1, 'verse'], [2, 'break'], [3, 'drop'], [4, 'chorus'], [5, 'intro'], [6, 'build'], [7, 'chorus'], [8, 'chorus'], [9, 'drop'], [10, 'chorus'], [11, 'verse']];
    for (const [i, sec] of cases) {
      if (!songs[i]) continue;
      add(await renderCase(`${songs[i].title} / ${sec}`, 8, { post: (A) => A.playSong(i, { section: sec }) }, () => {}), 'music');
    }
    // sfx burst
    add(await renderCase('all sfx', 6, { pre: (A) => A.setRadio('off') }, (() => {
      let k = 0; const names = AudioSystem.SFX_NAMES;
      return (A, t) => { if (t > k * 0.4 && k < names.length) { A.play(names[k], { intensity: 0.9 }); k++; } };
    })()), 'sfx');
  } catch (e) { log('offline error ' + e.message); }
  window.__audioTest = results;
  $('offState').textContent = results.every((r) => r.ok) ? 'all OK' : 'issues found';
  log('offline tests done: ' + results.filter((r) => r.ok).length + '/' + results.length + ' OK');
};
