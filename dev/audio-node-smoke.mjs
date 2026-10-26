// Node smoke test for src/audio with a minimal fake Web Audio context.
// Catches runtime exceptions / bad automation values across all songs, engines and SFX.
// Run: node dev/audio-node-smoke.mjs
import { AudioSystem } from '../src/audio/audio.js';
import { SONGS } from '../src/audio/songs.js';

let errors = 0, nodesCreated = 0, live = 0, maxLive = 0;
function bad(msg) { errors++; if (errors < 25) console.error('ERR', msg); }

class Param {
  constructor(v = 0) { this.value = v; this.last = -1; }
  _chk(name, v, t) {
    if (!Number.isFinite(v)) bad(`${name} non-finite value ${v}`);
    if (t !== undefined && !Number.isFinite(t)) bad(`${name} non-finite time ${t}`);
  }
  setValueAtTime(v, t) { this._chk('setValueAtTime', v, t); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this._chk('linearRamp', v, t); this.value = v; return this; }
  exponentialRampToValueAtTime(v, t) { this._chk('expRamp', v, t); if (v <= 0) bad('expRamp to <= 0: ' + v); this.value = v; return this; }
  setTargetAtTime(v, t, tc) { this._chk('setTarget', v, t); if (!(tc > 0)) bad('setTarget tc ' + tc); this.value = v; return this; }
  cancelScheduledValues() { return this; }
}
class Node {
  constructor(ctx, params = []) {
    this.ctx = ctx; nodesCreated++;
    for (const p of params) this[p] = new Param(p === 'gain' ? 1 : 0);
  }
  connect(d) { if (!d) bad('connect to undefined'); return d; }
  disconnect() {}
}
class Src extends Node {
  constructor(ctx, params) { super(ctx, params); this.onended = null; this.started = false; }
  start(t, off, dur) {
    if (this.started) bad('start twice'); this.started = true; live++; maxLive = Math.max(maxLive, live);
    if (t !== undefined && !Number.isFinite(t)) bad('start t');
    const t0 = t ?? this.ctx.currentTime;
    if (dur !== undefined) this.stop(t0 + dur);
    else if (this.buffer && !this.loop) this.stop(t0 + this.buffer.duration);
  }
  stop(t) { if (!this.started) bad('stop before start'); if (this.stopped && this._end <= (t ?? 0)) return; this._end = t; if (t !== undefined && !Number.isFinite(t)) bad('stop t'); if (!this.stopped) { this.stopped = true; this.ctx._ends.push([t ?? this.ctx.currentTime, this]); } }
  setPeriodicWave() {}
}
class FakeCtx {
  constructor(sr = 44100) { this.sampleRate = sr; this.currentTime = 0; this.state = 'running'; this.destination = new Node(this); this._ends = []; }
  startRendering() {}
  advance(dt) {
    this.currentTime += dt;
    const keep = [];
    for (const e of this._ends) { if (e[0] <= this.currentTime) { live--; if (e[1].onended) e[1].onended(); } else keep.push(e); }
    this._ends = keep;
  }
  createGain() { return new Node(this, ['gain']); }
  createBiquadFilter() { const n = new Node(this, ['frequency', 'Q', 'gain', 'detune']); n.type = 'lowpass'; return n; }
  createOscillator() { return new Src(this, ['frequency', 'detune']); }
  createBufferSource() { const s = new Src(this, ['playbackRate', 'detune']); s.buffer = null; s.loop = false; return s; }
  createBuffer(ch, len, sr) {
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: (i) => data[i] };
  }
  createWaveShaper() { const n = new Node(this); n.curve = null; n.oversample = 'none'; return n; }
  createDynamicsCompressor() { return new Node(this, ['threshold', 'knee', 'ratio', 'attack', 'release']); }
  createConvolver() { const n = new Node(this); n.buffer = null; return n; }
  createDelay() { return new Node(this, ['delayTime']); }
  createStereoPanner() { return new Node(this, ['pan']); }
  createPeriodicWave() { return {}; }
}

const ctx = new FakeCtx();
const A = new AudioSystem({ context: ctx });
const seen = [];
A.onTrackChange = (i) => seen.push(i.title);
await A.unlock();
if (!A.unlocked) bad('not unlocked');

// engines
for (const p of AudioSystem.ENGINE_PROFILES) {
  A.setEngineProfile(p);
  for (let i = 0; i < 240; i++) {
    const ph = i / 240;
    const thr = ph < 0.6 ? 1 : ph < 0.8 ? 0 : 0.5;
    A.updateEngine({ rpm: (ph * 3) % 1, throttle: thr, speed: ph * 80, gear: 1 + Math.floor(ph * 6), boosting: ph > 0.3 && ph < 0.5,
      hovering: ph > 0.7, onGround: ph < 0.7, slip: ph > 0.4 ? 0.9 : 0, inWater: ph > 0.9 });
    if (i % 40 === 0) A.play('gear');
    ctx.advance(1 / 60); A.tick();
  }
}
for (const n of AudioSystem.SFX_NAMES) { A.play(n, { intensity: 0.8 }); ctx.advance(0.1); A.tick(); }
A.setPaused(true); A.duck(0.5); A.setVolumes({ master: 0.5, music: 0.4, sfx: 0.7 }); A.setPaused(false); A.duck(0);

// run each song fully at 25 ms ticks (fast)
const t0 = Date.now();
for (let s = 0; s < SONGS.length; s++) {
  A.playSong(s);
  const end = ctx.currentTime + 200;
  while (ctx.currentTime < end) { ctx.advance(0.05); A.tick(); }
  const np = A.getNowPlaying();
  if (!np) bad('no now playing');
}
A.nextTrack(); A.prevTrack(); A.setRadio('off'); A.setRadio('my-playlist'); A.setRadio('bollywood-fm');
for (let i = 0; i < 200; i++) { ctx.advance(0.05); A.tick(); }
console.log('songs announced:', seen.length, 'unique:', new Set(seen).size);
console.log('nodes created:', nodesCreated, 'max live sources:', maxLive, 'live now:', live, 'time ms:', Date.now() - t0);
if (A.fm.errorCount) { bad("fm errors " + A.fm.errorCount); console.error(A.fm.lastError); }
console.log(errors ? `FAILED with ${errors} errors` : 'OK no errors');
process.exit(errors ? 1 : 0);
