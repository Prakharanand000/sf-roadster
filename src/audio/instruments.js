// Synthesized instruments for Bollywood FM (and a few SFX).
//
// - Plucked strings (sitar / santoor / tumbi): Karplus-Strong rendered in JS into cached
//   AudioBuffers (a DelayNode feedback loop can't go below one 128-sample render quantum,
//   so high strings are impossible that way). Pitch slides (meend) = playbackRate ramps.
//   Sitar gets a one-sided "jawari" bridge clip inside the KS loop -> the buzzy bloom.
// - Tanpura: additive synthesis with a sweeping formant (the jawari "bloom"), cached.
// - Percussion: tabla bols (dayan + bayan with pitch bends), dhol (dagga/tilli), claps,
//   chutki, EDM kick/hat/snare/crash/riser - short-lived nodes, auto-disconnected.
// - MonoLead: persistent monophonic shehnai / bansuri / synth voice driven by automation
//   (legato meend glides, delayed vibrato, gamak), so a whole song reuses one node chain.
// - MonoBass: persistent synth bass. padChord: detuned-saw string pad per chord.

import { clamp, rng, getNoise, autoDisconnect, setTarget, harmonicWave, tanhCurve } from './util.js';

const bufCache = new WeakMap();
function cacheFor(ctx) {
  let c = bufCache.get(ctx);
  if (!c) { c = new Map(); bufCache.set(ctx, c); }
  return c;
}

// ---------------------------------------------------------------------------
// Karplus-Strong

const PLUCK_TYPES = {
  sitar:   { dur: 2.0, t60: 2.6, damp: 0.42, pick: 0.13, bright: 0.75, buzz: 0.32, hammer: false, strings: 1 },
  santoor: { dur: 1.5, t60: 1.5, damp: 0.30, pick: 0.21, bright: 0.95, buzz: 0, hammer: true, strings: 2, detune: 3.5 },
  tumbi:   { dur: 0.9, t60: 0.6, damp: 0.25, pick: 0.07, bright: 1.0, buzz: 0.18, hammer: false, strings: 1 },
  harp:    { dur: 1.6, t60: 1.8, damp: 0.45, pick: 0.25, bright: 0.6, buzz: 0, hammer: false, strings: 1 },
};

function renderKS(out, sr, freq, cfg, seed, gain) {
  const len = out.length;
  const damp = cfg.damp;
  let N = sr / freq - damp;
  if (N < 2) N = 2;
  const Ni = Math.floor(N), fr = N - Ni;
  const decay = Math.pow(0.001, 1 / (freq * cfg.t60));
  const y = new Float32Array(len);
  const r = rng(seed);
  // excitation
  const exLen = Math.min(len, Ni + 1);
  const ex = new Float32Array(exLen);
  if (cfg.hammer) {
    const w = Math.max(2, Math.floor(sr / 3000));
    for (let i = 0; i < exLen; i++) {
      const hw = i < w ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / w) : 0;
      ex[i] = hw * 1.4 + (r() * 2 - 1) * 0.15 * Math.exp(-i / (w * 2));
    }
  } else {
    let lp = 0;
    const a = 0.2 + 0.8 * cfg.bright;
    for (let i = 0; i < exLen; i++) { lp += a * ((r() * 2 - 1) - lp); ex[i] = lp; }
    // pick-position comb
    const pd = Math.max(1, Math.floor(cfg.pick * exLen));
    for (let i = exLen - 1; i >= pd; i--) ex[i] -= ex[i - pd];
  }
  const buzz = cfg.buzz;
  const thr = 0.28;
  for (let n = 0; n < len; n++) {
    let v = n < exLen ? ex[n] : 0;
    const i0 = n - Ni, i1 = i0 - 1, i2 = i0 - 2;
    const a0 = i0 >= 0 ? y[i0] : 0, a1 = i1 >= 0 ? y[i1] : 0, a2 = i2 >= 0 ? y[i2] : 0;
    const d0 = (1 - fr) * a0 + fr * a1;
    const d1 = (1 - fr) * a1 + fr * a2;
    v += decay * ((1 - damp) * d0 + damp * d1);
    if (buzz > 0 && v > thr) v = thr + (v - thr) * (1 - buzz); // one-sided bridge (jawari)
    y[n] = v;
  }
  for (let n = 0; n < len; n++) out[n] += y[n] * gain;
}

/** Cached KS buffer for an instrument + midi note (integer). */
export function pluckBuffer(ctx, type, midi) {
  const key = 'ks:' + type + ':' + midi;
  const c = cacheFor(ctx);
  if (c.has(key)) return c.get(key);
  const cfg = PLUCK_TYPES[type] || PLUCK_TYPES.sitar;
  const sr = ctx.sampleRate;
  const len = Math.floor(cfg.dur * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  renderKS(out, sr, f, cfg, 1000 + midi * 7, 1);
  if (cfg.strings > 1) {
    const det = Math.pow(2, (cfg.detune || 3) / 1200);
    renderKS(out, sr, f * det, cfg, 2000 + midi * 13, 0.8);
  }
  // DC block + normalize + fade tail
  let prevX = 0, prevY = 0, peak = 0;
  for (let i = 0; i < len; i++) {
    const x = out[i];
    const yv = x - prevX + 0.995 * prevY;
    prevX = x; prevY = yv; out[i] = yv;
    const a = Math.abs(yv); if (a > peak) peak = a;
  }
  const g = peak > 0 ? 0.85 / peak : 1;
  const fade = Math.floor(sr * 0.12);
  for (let i = 0; i < len; i++) {
    let v = out[i] * g;
    if (i > len - fade) v *= (len - i) / fade;
    out[i] = v;
  }
  c.set(key, buf);
  return buf;
}

/** Play a plucked note. slideFrom (midi) => meend glide from that pitch into `midi`. */
export function pluck(ctx, dest, t, type, midi, o = {}) {
  const base = Math.round(midi);
  const buf = pluckBuffer(ctx, type, base);
  const s = ctx.createBufferSource();
  s.buffer = buf;
  const fine = Math.pow(2, (midi - base) / 12);
  const pr = s.playbackRate;
  if (o.slideFrom != null) {
    const r0 = Math.pow(2, (o.slideFrom - base) / 12);
    const st = t + (o.slideDelay || 0.02);
    pr.setValueAtTime(r0, t);
    pr.setValueAtTime(r0, st);
    pr.exponentialRampToValueAtTime(fine, st + (o.slideTime || 0.14));
  } else if (o.kan != null) {
    pr.setValueAtTime(Math.pow(2, (o.kan - base) / 12), t);
    pr.setValueAtTime(fine, t + 0.04);
  } else {
    pr.setValueAtTime(fine, t);
  }
  if (o.bendTo != null && o.bendAt != null) {
    pr.setValueAtTime(fine, t + o.bendAt);
    pr.exponentialRampToValueAtTime(Math.pow(2, (o.bendTo - base) / 12), t + o.bendAt + (o.bendTime || 0.15));
  }
  const g = ctx.createGain();
  const vel = o.vel == null ? 0.8 : o.vel;
  g.gain.value = vel;
  let end = t + buf.duration / Math.max(0.5, fine);
  if (o.dur != null) {
    const rel = o.release || 0.09;
    g.gain.setValueAtTime(vel, t + o.dur);
    g.gain.setTargetAtTime(0, t + o.dur, rel);
    end = Math.min(end, t + o.dur + rel * 6);
  }
  s.connect(g); g.connect(dest);
  s.start(t);
  s.stop(end);
  autoDisconnect(s, [s, g]);
  return s;
}

// ---------------------------------------------------------------------------
// Tanpura (additive with jawari formant sweep)

export function tanpuraBuffer(ctx, midi, dur = 3.6) {
  const key = 'tan:' + midi + ':' + dur;
  const c = cacheFor(ctx);
  if (c.has(key)) return c.get(key);
  const sr = ctx.sampleRate;
  const len = Math.floor(dur * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  const f0 = 440 * Math.pow(2, (midi - 69) / 12);
  const H = Math.max(1, Math.min(30, Math.floor((sr * 0.42) / f0)));
  const BL = 64;
  const r = rng(midi * 31 + 7);
  for (let h = 1; h <= H; h++) {
    const fh = f0 * h * (1 + 0.00008 * h * h);
    const w = (2 * Math.PI * fh) / sr;
    const cr = Math.cos(w), sw = Math.sin(w);
    let cs = Math.cos(r() * 6.28), sn = Math.sin(r() * 6.28);
    const base = 1 / Math.pow(h, 0.85);
    for (let b = 0; b < len; b += BL) {
      const t = b / sr;
      const att = t < 0.012 ? t / 0.012 : 1;
      const env = att * Math.exp(-t / 1.5);
      const cc = 2.5 + 15 * Math.pow(t / dur, 0.7);
      const dh = h - cc;
      const form = 0.3 + 1.7 * Math.exp(-(dh * dh) / 8);
      const amp = base * env * form;
      const end = Math.min(len, b + BL);
      for (let i = b; i < end; i++) {
        const nc = cs * cr - sn * sw;
        sn = sn * cr + cs * sw; cs = nc;
        out[i] += sn * amp;
      }
    }
  }
  let peak = 0;
  for (let i = 0; i < len; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
  const g = peak > 0 ? 0.8 / peak : 1;
  const fade = Math.floor(sr * 0.3);
  for (let i = 0; i < len; i++) {
    let v = out[i] * g;
    if (i > len - fade) v *= (len - i) / fade;
    out[i] = v;
  }
  c.set(key, buf);
  return buf;
}

export function tanpuraPluck(ctx, dest, t, midi, vel = 0.5) {
  const s = ctx.createBufferSource();
  s.buffer = tanpuraBuffer(ctx, midi);
  const g = ctx.createGain(); g.gain.value = vel;
  s.connect(g); g.connect(dest);
  s.start(t);
  autoDisconnect(s, [s, g]);
}

// ---------------------------------------------------------------------------
// Percussion helpers

function wave(ctx, name, amps, cos) {
  const key = 'pw:' + name;
  const c = cacheFor(ctx);
  if (!c.has(key)) c.set(key, harmonicWave(ctx, amps, cos));
  return c.get(key);
}

function noiseBurst(ctx, dest, t, { type = 'white', filt = 'bandpass', f = 1000, q = 1, vel = 0.5, attack = 0.001, decay = 0.05, len } = {}) {
  const s = ctx.createBufferSource();
  s.buffer = getNoise(ctx, type);
  const bq = ctx.createBiquadFilter(); bq.type = filt; bq.frequency.value = f; bq.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vel, t + attack);
  g.gain.setTargetAtTime(0.0001, t + attack, decay);
  s.connect(bq); bq.connect(g); g.connect(dest);
  const L = len || attack + decay * 7;
  s.start(t, Math.random() * 3, L);
  autoDisconnect(s, [s, bq, g]);
  return { s, bq, g };
}

function tone(ctx, dest, t, { type = 'sine', wave: pw, f0, f1, glide = 0.03, vel = 0.5, attack = 0.002, decay = 0.1, len, detune = 0 }) {
  const o = ctx.createOscillator();
  if (pw) o.setPeriodicWave(pw); else o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 != null && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + glide);
  if (detune) o.detune.value = detune;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vel, t + attack);
  g.gain.setTargetAtTime(0.0001, t + attack, decay);
  o.connect(g); g.connect(dest);
  o.start(t);
  o.stop(t + (len || attack + decay * 7));
  autoDisconnect(o, [o, g]);
  return { o, g };
}

// ---------------------------------------------------------------------------
// Tabla

/** tune = dayan fundamental (Hz), roughly the song's Sa (~250-330 Hz). */
export function tabla(ctx, dest, t, bol, vel = 0.7, tune = 280) {
  switch (bol) {
    case 'dha': dayan(ctx, dest, t, vel, tune, 'na'); bayan(ctx, dest, t, vel * 0.9, false); break;
    case 'dhin': case 'dhi': dayan(ctx, dest, t, vel, tune, 'tin'); bayan(ctx, dest, t, vel * 0.9, false); break;
    case 'dhe': dayan(ctx, dest, t, vel * 0.7, tune, 'closed'); bayan(ctx, dest, t, vel * 0.8, false); break;
    case 'na': case 'ta': dayan(ctx, dest, t, vel, tune, 'na'); break;
    case 'tin': case 'tun': dayan(ctx, dest, t, vel, tune, 'tin'); break;
    case 'ti': case 'te': case 'ra': case 'ki': case 'ta-': dayan(ctx, dest, t, vel, tune, 'closed'); break;
    case 'ge': bayan(ctx, dest, t, vel, false); break;
    case 'ghe': bayan(ctx, dest, t, vel, true); break;
    case 'ke': case 'ka': case 'kat': bayanSlap(ctx, dest, t, vel); break;
    default: break;
  }
}

function dayan(ctx, dest, t, vel, f, kind) {
  if (kind === 'closed') {
    noiseBurst(ctx, dest, t, { f: 2100, q: 1.2, vel: vel * 0.55, decay: 0.012 });
    tone(ctx, dest, t, { f0: f * 2.02, vel: vel * 0.18, decay: 0.018 });
    return;
  }
  if (kind === 'na') {
    const pw = wave(ctx, 'tabla-na', [0.55, 1, 0.7, 0.42, 0.22, 0.1]);
    tone(ctx, dest, t, { wave: pw, f0: f * 1.025, f1: f, glide: 0.04, vel: vel * 0.42, decay: 0.16 });
    noiseBurst(ctx, dest, t, { filt: 'highpass', f: 3200, q: 0.7, vel: vel * 0.35, decay: 0.006 });
  } else {
    const pw = wave(ctx, 'tabla-tin', [1, 0.45, 0.22, 0.1]);
    tone(ctx, dest, t, { wave: pw, f0: f * 1.01, f1: f, glide: 0.05, vel: vel * 0.38, attack: 0.004, decay: 0.28 });
    noiseBurst(ctx, dest, t, { filt: 'highpass', f: 2500, q: 0.7, vel: vel * 0.15, decay: 0.006 });
  }
}

function bayan(ctx, dest, t, vel, bend) {
  const o = ctx.createOscillator(); o.type = 'sine';
  if (bend) {
    o.frequency.setValueAtTime(78, t);
    o.frequency.linearRampToValueAtTime(82, t + 0.05);
    o.frequency.exponentialRampToValueAtTime(118, t + 0.3);
  } else {
    o.frequency.setValueAtTime(112, t);
    o.frequency.exponentialRampToValueAtTime(92, t + 0.08);
  }
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vel * 0.75, t + 0.004);
  g.gain.setTargetAtTime(0.0001, t + 0.004, bend ? 0.22 : 0.16);
  const sh = ctx.createWaveShaper(); sh.curve = tanhCurve(1.4);
  o.connect(sh); sh.connect(g); g.connect(dest);
  o.start(t); o.stop(t + (bend ? 1.6 : 1.2));
  autoDisconnect(o, [o, sh, g]);
  noiseBurst(ctx, dest, t, { filt: 'lowpass', f: 700, q: 0.7, vel: vel * 0.25, decay: 0.01 });
}

function bayanSlap(ctx, dest, t, vel) {
  noiseBurst(ctx, dest, t, { filt: 'lowpass', f: 1100, q: 0.9, vel: vel * 0.5, decay: 0.018 });
  tone(ctx, dest, t, { f0: 150, f1: 95, glide: 0.03, vel: vel * 0.35, decay: 0.025 });
}

// ---------------------------------------------------------------------------
// Dhol

export function dhol(ctx, dest, t, stroke, vel = 0.8) {
  if (stroke === 'dagga' || stroke === 'both') {
    tone(ctx, dest, t, { f0: 130, f1: 54, glide: 0.07, vel: vel * 0.95, attack: 0.002, decay: 0.2, len: 1.0 });
    tone(ctx, dest, t, { type: 'triangle', f0: 210, f1: 120, glide: 0.05, vel: vel * 0.25, decay: 0.06 });
    noiseBurst(ctx, dest, t, { filt: 'lowpass', f: 500, q: 0.8, vel: vel * 0.4, decay: 0.02 });
  }
  if (stroke === 'tilli' || stroke === 'both') {
    noiseBurst(ctx, dest, t, { f: 2600, q: 1.5, vel: vel * 0.5, decay: 0.03 });
    tone(ctx, dest, t, { type: 'triangle', f0: 470, f1: 400, glide: 0.03, vel: vel * 0.32, decay: 0.045 });
    noiseBurst(ctx, dest, t, { filt: 'highpass', f: 5000, q: 0.7, vel: vel * 0.22, decay: 0.006 });
  }
}

// ---------------------------------------------------------------------------
// Hand percussion + EDM kit

export function clap(ctx, dest, t, vel = 0.6) {
  const s = ctx.createBufferSource(); s.buffer = getNoise(ctx, 'white');
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1150 + Math.random() * 200; bp.Q.value = 0.9;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  for (let k = 0; k < 3; k++) {
    const tt = t + k * 0.0105 + Math.random() * 0.002;
    g.gain.setValueAtTime(vel * (0.7 + 0.15 * k), tt);
    g.gain.setTargetAtTime(0.0001, tt + 0.001, 0.004);
  }
  g.gain.setValueAtTime(vel, t + 0.033);
  g.gain.setTargetAtTime(0.0001, t + 0.034, 0.06);
  s.connect(bp); bp.connect(g); g.connect(dest);
  s.start(t, Math.random() * 3, 0.5);
  autoDisconnect(s, [s, bp, g]);
}

export function chutki(ctx, dest, t, vel = 0.4) {
  noiseBurst(ctx, dest, t, { f: 2900, q: 2.2, vel: vel * 0.8, decay: 0.012 });
  tone(ctx, dest, t, { f0: 2100, f1: 1500, glide: 0.015, vel: vel * 0.15, decay: 0.01 });
}

export function shaker(ctx, dest, t, vel = 0.2) {
  noiseBurst(ctx, dest, t, { filt: 'highpass', f: 6000, q: 0.7, vel, attack: 0.008, decay: 0.025 });
}

export function kick(ctx, dest, t, vel = 0.9) {
  tone(ctx, dest, t, { f0: 165, f1: 46, glide: 0.09, vel, attack: 0.002, decay: 0.17, len: 0.8 });
  noiseBurst(ctx, dest, t, { filt: 'highpass', f: 2500, vel: vel * 0.25, decay: 0.004 });
}

export function hat(ctx, dest, t, vel = 0.25, open = false) {
  noiseBurst(ctx, dest, t, { filt: 'highpass', f: 7600, q: 0.8, vel, decay: open ? 0.12 : 0.022 });
}

export function snare(ctx, dest, t, vel = 0.6) {
  noiseBurst(ctx, dest, t, { f: 1900, q: 0.7, vel: vel * 0.8, decay: 0.07 });
  tone(ctx, dest, t, { type: 'triangle', f0: 210, f1: 165, glide: 0.04, vel: vel * 0.45, decay: 0.05 });
}

export function crash(ctx, dest, t, vel = 0.4) {
  noiseBurst(ctx, dest, t, { filt: 'highpass', f: 4200, q: 0.6, vel, attack: 0.002, decay: 0.55, len: 3.5 });
  noiseBurst(ctx, dest, t, { f: 8500, q: 1.5, vel: vel * 0.5, attack: 0.002, decay: 0.3, len: 2.2 });
}

export function boom(ctx, dest, t, vel = 0.8) {
  tone(ctx, dest, t, { f0: 90, f1: 38, glide: 0.4, vel, attack: 0.003, decay: 0.5, len: 3.2 });
}

/** Noise riser + rising saw over `dur` seconds. */
export function riser(ctx, dest, t, dur, vel = 0.3) {
  const s = ctx.createBufferSource(); s.buffer = getNoise(ctx, 'white'); s.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2.5;
  bp.frequency.setValueAtTime(250, t);
  bp.frequency.exponentialRampToValueAtTime(7500, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vel, t + dur);
  g.gain.setTargetAtTime(0.0001, t + dur, 0.03);
  s.connect(bp); bp.connect(g); g.connect(dest);
  s.start(t, Math.random() * 3); s.stop(t + dur + 0.3);
  autoDisconnect(s, [s, bp, g]);
  const o = ctx.createOscillator(); o.type = 'sawtooth';
  o.frequency.setValueAtTime(110, t);
  o.frequency.exponentialRampToValueAtTime(880, t + dur);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
  lp.frequency.setValueAtTime(400, t); lp.frequency.exponentialRampToValueAtTime(4000, t + dur);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, t);
  og.gain.exponentialRampToValueAtTime(vel * 0.25, t + dur);
  og.gain.setTargetAtTime(0.0001, t + dur, 0.03);
  o.connect(lp); lp.connect(og); og.connect(dest);
  o.start(t); o.stop(t + dur + 0.3);
  autoDisconnect(o, [o, lp, og]);
}

// ---------------------------------------------------------------------------
// String pad

/** Detuned-saw chord. midis: array. Returns nothing; self-cleaning. */
export function padChord(ctx, dest, t, dur, midis, o = {}) {
  const vel = o.vel == null ? 0.12 : o.vel;
  const attack = o.attack || 0.35, release = o.release || 0.6;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
  lp.frequency.setValueAtTime(o.cutoff || 1600, t); lp.Q.value = 0.6;
  if (o.swell) lp.frequency.linearRampToValueAtTime((o.cutoff || 1600) * 1.8, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.setTargetAtTime(vel, t, attack / 3);
  g.gain.setValueAtTime(vel, t + dur);
  g.gain.setTargetAtTime(0.0001, t + dur, release / 3);
  lp.connect(g); g.connect(dest);
  const end = t + dur + release * 2.5;
  const oscs = [];
  const dets = o.dets || [-8, 7];
  for (const m of midis) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    for (const d of dets) {
      const osc = ctx.createOscillator(); osc.type = 'sawtooth';
      osc.frequency.value = f; osc.detune.value = d + (Math.random() - 0.5) * 3;
      osc.connect(lp); osc.start(t); osc.stop(end);
      oscs.push(osc);
    }
  }
  if (oscs.length) autoDisconnect(oscs[0], [...oscs, lp, g]);
}

/** Short supersaw stab (drop). */
export function stab(ctx, dest, t, midis, vel = 0.1, len = 0.18) {
  padChord(ctx, dest, t, len, midis, { vel, attack: 0.01, release: 0.12, cutoff: 3200, dets: [-14, 0, 13] });
}

// ---------------------------------------------------------------------------
// Persistent monophonic lead (shehnai / bansuri / synth)

export class MonoLead {
  constructor(ctx, dest, type = 'shehnai') {
    this.ctx = ctx; this.type = type;
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const bq = (ty, f, q) => { const n = ctx.createBiquadFilter(); n.type = ty; n.frequency.value = f; n.Q.value = q; return n; };
    this.amp = g(0); this.amp.connect(dest);
    this.nodes = [this.amp];
    this.fparams = []; // [AudioParam, ratio]
    this.oscs = [];
    const t = ctx.currentTime;
    const osc = (ty, ratio, gain, to, det = 0) => {
      const o = ctx.createOscillator(); o.type = ty; o.frequency.value = 440 * ratio; o.detune.value = det;
      const og = g(gain); o.connect(og); og.connect(to);
      this.oscs.push(o); this.nodes.push(o, og); this.fparams.push([o.frequency, ratio]);
      return o;
    };
    this.vib = ctx.createOscillator(); this.vib.type = 'sine';
    this.vibG = g(0); this.vib.connect(this.vibG);
    this.oscs.push(this.vib); this.nodes.push(this.vib, this.vibG);
    let breathF = 3000, breathQ = 0.9, breathAmt = 0.05;
    if (type === 'shehnai') {
      const mix = g(1);
      const sh = ctx.createWaveShaper(); sh.curve = tanhCurve(1.8);
      const f1 = bq('bandpass', 1150, 2.6), f2 = bq('bandpass', 2700, 3.5), f3 = bq('lowpass', 2000, 0.7);
      const g1 = g(1.3), g2 = g(0.75), g3 = g(0.35), sum = g(0.55);
      mix.connect(f1); mix.connect(f2); mix.connect(f3);
      f1.connect(g1); f2.connect(g2); f3.connect(g3);
      g1.connect(sum); g2.connect(sum); g3.connect(sum);
      sum.connect(sh); sh.connect(this.amp);
      const a = osc('sawtooth', 1, 0.6, mix); const b = osc('square', 1, 0.35, mix, 4);
      this.vibG.connect(a.frequency); this.vibG.connect(b.frequency);
      this.vib.frequency.value = 6.2;
      this.nodes.push(mix, sh, f1, f2, f3, g1, g2, g3, sum);
      breathF = 3400; breathAmt = 0.035;
      this.peak = 0.3; this.atk = 0.025; this.vibDepth = 0.011;
    } else if (type === 'bansuri') {
      const lp = bq('lowpass', 3200, 0.5); lp.connect(this.amp);
      const a = osc('sine', 1, 0.75, lp); const b = osc('triangle', 1, 0.18, lp, -3); osc('sine', 2, 0.07, lp);
      this.vibG.connect(a.frequency); this.vibG.connect(b.frequency);
      this.vib.frequency.value = 5.1;
      this.nodes.push(lp);
      breathF = 2200; breathQ = 0.7; breathAmt = 0.13;
      this.peak = 0.36; this.atk = 0.05; this.vibDepth = 0.009;
    } else { // synth (drop lead)
      const lp = bq('lowpass', 3400, 1.6); lp.connect(this.amp);
      const a = osc('sawtooth', 1, 0.45, lp, -12); const b = osc('sawtooth', 1, 0.45, lp, 12); const c = osc('square', 0.5, 0.25, lp);
      this.vibG.connect(a.frequency); this.vibG.connect(b.frequency); this.vibG.connect(c.frequency);
      this.vib.frequency.value = 5.6;
      this.nodes.push(lp);
      breathAmt = 0;
      this.peak = 0.27; this.atk = 0.008; this.vibDepth = 0.006;
    }
    if (breathAmt > 0) {
      const ns = ctx.createBufferSource(); ns.buffer = getNoise(ctx, 'white'); ns.loop = true;
      const nb = bq('bandpass', breathF, breathQ); const ng = g(breathAmt);
      ns.connect(nb); nb.connect(ng); ng.connect(this.amp);
      this.oscs.push(ns); this.nodes.push(ns, nb, ng);
    }
    for (const o of this.oscs) o.start(t, o.buffer ? Math.random() * 3 : undefined);
    this.lastEnd = 0;
  }

  setFreq(t, f) { for (const [p, r] of this.fparams) p.setValueAtTime(f * r, t); }
  rampFreq(t, f, exp = true) {
    for (const [p, r] of this.fparams) { if (exp) p.exponentialRampToValueAtTime(f * r, t); else p.linearRampToValueAtTime(f * r, t); }
  }

  /**
   * f Hz, dur s. o: { vel, slideFrom Hz, slideTime, kan Hz, legato, tieNext, gamak semis }
   */
  note(t, f, dur, o = {}) {
    if (!(f > 0) || !(dur > 0)) return;
    const vel = (o.vel == null ? 1 : o.vel) * this.peak;
    const amp = this.amp.gain;
    try {
      if (o.slideFrom > 0) {
        this.setFreq(t, o.slideFrom);
        this.rampFreq(t + Math.min(dur * 0.6, o.slideTime || 0.12), f);
      } else if (o.kan > 0) {
        this.setFreq(t, o.kan);
        this.setFreq(t + 0.045, f);
      } else {
        this.setFreq(t, f);
      }
      if (o.gamak && dur > 0.3) {
        const up = f * Math.pow(2, o.gamak / 12);
        const rate = 6.5, half = 0.5 / rate;
        let tt = t + 0.12;
        this.setFreq(tt, f);
        while (tt + 2 * half < t + dur - 0.06) {
          this.rampFreq(tt + half, up, false);
          this.rampFreq(tt + 2 * half, f, false);
          tt += 2 * half;
        }
      }
      if (o.legato && t - this.lastEnd < 0.03) {
        amp.setTargetAtTime(vel * 0.75, t, 0.008);
        amp.setTargetAtTime(vel, t + 0.025, 0.03);
      } else {
        amp.setTargetAtTime(vel, t, this.atk);
      }
      const vg = this.vibG.gain;
      vg.setTargetAtTime(0, t, 0.02);
      if (dur > 0.32 && !o.gamak) vg.setTargetAtTime(f * this.vibDepth, t + 0.2, 0.12);
      if (!o.tieNext) amp.setTargetAtTime(0, t + dur - 0.02, this.type === 'synth' ? 0.03 : 0.06);
      this.lastEnd = t + dur;
    } catch (e) { /* automation glitch -> skip note */ }
  }

  stop(t) {
    try { this.amp.gain.cancelScheduledValues(t); } catch (e) { /* */ }
    setTarget(this.amp.gain, 0, t, 0.08);
    for (const o of this.oscs) { try { o.stop(t + 0.6); } catch (e) { /* */ } }
    const nodes = this.nodes;
    if (this.oscs[0]) this.oscs[0].onended = () => { for (const n of nodes) { try { n.disconnect(); } catch (e) { /* */ } } };
  }
}

// ---------------------------------------------------------------------------
// Persistent synth bass

export class MonoBass {
  constructor(ctx, dest) {
    this.ctx = ctx;
    const t = ctx.currentTime;
    this.amp = ctx.createGain(); this.amp.gain.value = 0; this.amp.connect(dest);
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 300; this.lp.Q.value = 3;
    this.lp.connect(this.amp);
    this.a = ctx.createOscillator(); this.a.type = 'sawtooth';
    this.b = ctx.createOscillator(); this.b.type = 'sine';
    this.ga = ctx.createGain(); this.ga.gain.value = 0.5;
    this.gb = ctx.createGain(); this.gb.gain.value = 0.8;
    this.a.connect(this.ga); this.ga.connect(this.lp);
    this.b.connect(this.gb); this.gb.connect(this.amp);
    this.a.start(t); this.b.start(t);
    this.nodes = [this.amp, this.lp, this.a, this.b, this.ga, this.gb];
  }
  note(t, f, dur, vel = 0.8, o = {}) {
    if (!(f > 0)) return;
    try {
      const ap = this.a.frequency, bp = this.b.frequency;
      if (o.glideFrom > 0) {
        ap.setValueAtTime(o.glideFrom, t); bp.setValueAtTime(o.glideFrom, t);
        ap.exponentialRampToValueAtTime(f, t + 0.06); bp.exponentialRampToValueAtTime(f, t + 0.06);
      } else { ap.setValueAtTime(f, t); bp.setValueAtTime(f, t); }
      const g = this.amp.gain;
      g.setTargetAtTime(vel * 0.5, t, 0.004);
      g.setTargetAtTime(vel * 0.38, t + 0.05, 0.08);
      g.setTargetAtTime(0, t + Math.max(0.05, dur - 0.03), 0.025);
      const lf = this.lp.frequency;
      lf.setTargetAtTime((o.bright || 900), t, 0.003);
      lf.setTargetAtTime(220, t + 0.02, 0.09);
    } catch (e) { /* */ }
  }
  stop(t) {
    setTarget(this.amp.gain, 0, t, 0.05);
    try { this.a.stop(t + 0.5); this.b.stop(t + 0.5); } catch (e) { /* */ }
    const nodes = this.nodes;
    this.a.onended = () => { for (const n of nodes) { try { n.disconnect(); } catch (e) { /* */ } } };
  }
}

export { clamp };
