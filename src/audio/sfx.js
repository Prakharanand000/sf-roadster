// One-shot synthesized sound effects. Each function builds a few short-lived nodes that
// disconnect themselves when finished. `dest` is the SFX bus; `echo` an optional small
// feedback-delay send for chimes/fanfares.

import { clamp, getNoise, autoDisconnect, mtof } from './util.js';
import { pluck } from './instruments.js';

function env(g, t, a, peak, d, hold = 0) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  if (hold) g.gain.setValueAtTime(peak, t + a + hold);
  g.gain.setTargetAtTime(0.0001, t + a + hold, d);
}

function osc(ctx, dest, t, { type = 'sine', f0, f1, glide = 0.1, a = 0.003, peak = 0.3, d = 0.1, hold = 0, len, detune = 0, linear = false }) {
  const o = ctx.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 != null && f1 !== f0) {
    if (linear) o.frequency.linearRampToValueAtTime(f1, t + glide);
    else o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + glide);
  }
  o.detune.value = detune;
  const g = ctx.createGain();
  env(g, t, a, peak, d, hold);
  o.connect(g); g.connect(dest);
  o.start(t); o.stop(t + (len || a + hold + d * 7));
  autoDisconnect(o, [o, g]);
  return o;
}

function noise(ctx, dest, t, { type = 'white', filt = 'bandpass', f = 1000, f1, glide = 0.2, q = 1, a = 0.002, peak = 0.3, d = 0.1, hold = 0, len, pan }) {
  const s = ctx.createBufferSource(); s.buffer = getNoise(ctx, type);
  const bq = ctx.createBiquadFilter(); bq.type = filt; bq.Q.value = q;
  bq.frequency.setValueAtTime(f, t);
  if (f1 != null) bq.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + glide);
  const g = ctx.createGain();
  env(g, t, a, peak, d, hold);
  s.connect(bq); bq.connect(g);
  const nodes = [s, bq, g];
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.setValueAtTime(pan[0], t);
    p.pan.linearRampToValueAtTime(pan[1], t + (pan[2] || 0.4));
    g.connect(p); p.connect(dest); nodes.push(p);
  } else g.connect(dest);
  const L = len || a + hold + d * 7;
  s.start(t, Math.random() * 3, L);
  autoDisconnect(s, nodes);
  return s;
}

function bell(ctx, dest, t, f, peak = 0.2, d = 0.35) {
  // inharmonic-ish bell partials
  const parts = [[1, 1], [2.0, 0.5], [2.76, 0.32], [5.4, 0.12]];
  for (const [r, a] of parts) osc(ctx, dest, t, { f0: f * r, peak: peak * a, d: d / Math.sqrt(r), a: 0.002 });
}

function brass(ctx, dest, t, midi, dur, peak = 0.18) {
  const f = mtof(midi);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.5;
  lp.frequency.setValueAtTime(500, t);
  lp.frequency.linearRampToValueAtTime(3200, t + 0.06);
  lp.frequency.setTargetAtTime(1500, t + 0.08, 0.2);
  const g = ctx.createGain(); env(g, t, 0.02, peak, 0.12, dur);
  lp.connect(g);
  const oscs = [];
  for (const det of [-7, 6]) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
    o.connect(lp); o.start(t); o.stop(t + dur + 1.0); oscs.push(o);
  }
  autoDisconnect(oscs[0], [...oscs, lp, g]);
  return g;
}

export const SFX = {
  collision(ctx, dest, t, k, echo) {
    const i = clamp(k, 0.05, 1);
    // body thud
    osc(ctx, dest, t, { f0: 95 + 30 * i, f1: 38, glide: 0.18, peak: 0.55 * i + 0.1, d: 0.12 + 0.1 * i });
    noise(ctx, dest, t, { type: 'brown', filt: 'lowpass', f: 500, q: 0.7, peak: 0.5 * i + 0.1, d: 0.06 });
    // metal crunch: distorted mid noise + inharmonic ring
    const s = ctx.createBufferSource(); s.buffer = getNoise(ctx, 'white');
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400 + Math.random() * 1200; bp.Q.value = 0.9;
    const sh = ctx.createWaveShaper();
    const c = new Float32Array(256); for (let n = 0; n < 256; n++) { const x = n / 127.5 - 1; c[n] = Math.sign(x) * Math.pow(Math.abs(x), 0.4); }
    sh.curve = c;
    const g = ctx.createGain();
    // grainy amplitude: several crunch spikes
    g.gain.setValueAtTime(0.0001, t);
    const spikes = 2 + Math.round(5 * i);
    let tt = t;
    for (let n = 0; n < spikes; n++) {
      g.gain.setValueAtTime((0.12 + 0.3 * i) * (1 - n / (spikes + 1)), tt);
      g.gain.setTargetAtTime(0.0001, tt + 0.002, 0.012 + 0.01 * Math.random());
      tt += 0.012 + Math.random() * 0.03;
    }
    s.connect(bp); bp.connect(sh); sh.connect(g); g.connect(dest);
    s.start(t, Math.random() * 3, 0.5);
    autoDisconnect(s, [s, bp, sh, g]);
    if (i > 0.3) {
      for (const f of [523 * (0.9 + Math.random() * 0.2), 1187, 2011 * (0.95 + Math.random() * 0.1)]) {
        osc(ctx, dest, t + 0.005, { type: 'triangle', f0: f, f1: f * 0.97, glide: 0.4, peak: 0.05 * i, d: 0.12 + 0.15 * i });
      }
    }
    if (i > 0.7) { // glass / debris tinkles
      for (let n = 0; n < 5; n++) osc(ctx, dest, t + 0.04 + Math.random() * 0.25, { f0: 3000 + Math.random() * 4000, peak: 0.03, d: 0.03 });
    }
  },

  land(ctx, dest, t, k) {
    const i = clamp(k, 0.1, 1);
    osc(ctx, dest, t, { f0: 70, f1: 34, glide: 0.15, peak: 0.6 * i, d: 0.12 });
    noise(ctx, dest, t, { type: 'brown', filt: 'lowpass', f: 350, q: 0.8, peak: 0.45 * i, d: 0.08 });
    // spring / damper creak
    noise(ctx, dest, t + 0.03, { filt: 'bandpass', f: 900, f1: 500, glide: 0.15, q: 6, peak: 0.06 * i, d: 0.06 });
    if (i > 0.6) noise(ctx, dest, t + 0.01, { filt: 'highpass', f: 2500, q: 0.7, peak: 0.08 * i, d: 0.05 });
  },

  jump(ctx, dest, t) {
    // pneumatic pop + hiss
    noise(ctx, dest, t, { filt: 'bandpass', f: 450, q: 1.2, peak: 0.5, d: 0.025 });
    osc(ctx, dest, t, { f0: 190, f1: 85, glide: 0.08, peak: 0.35, d: 0.05 });
    noise(ctx, dest, t + 0.02, { filt: 'highpass', f: 3000, f1: 1800, glide: 0.4, q: 0.8, a: 0.01, peak: 0.22, d: 0.16 });
  },

  boost(ctx, dest, t) {
    // ignition click + whoosh sweep + low roar
    noise(ctx, dest, t, { filt: 'highpass', f: 4000, q: 0.7, peak: 0.25, d: 0.008 });
    noise(ctx, dest, t, { filt: 'bandpass', f: 280, f1: 3200, glide: 0.45, q: 1.6, a: 0.04, peak: 0.42, d: 0.22 });
    noise(ctx, dest, t, { type: 'brown', filt: 'lowpass', f: 300, q: 0.8, a: 0.03, peak: 0.5, d: 0.25 });
    osc(ctx, dest, t, { f0: 60, f1: 110, glide: 0.3, peak: 0.25, a: 0.02, d: 0.15 });
  },

  checkpoint(ctx, dest, t, k, echo) {
    bell(ctx, dest, t, 1318.5, 0.16, 0.25);
    bell(ctx, dest, t + 0.07, 1975.5, 0.14, 0.35);
    if (echo) bell(ctx, echo, t + 0.07, 1975.5, 0.08, 0.3);
  },

  lap(ctx, dest, t, k, echo) {
    brass(ctx, dest, t, 67, 0.12, 0.16);
    brass(ctx, dest, t, 71, 0.12, 0.1);
    brass(ctx, dest, t + 0.17, 72, 0.45, 0.2);
    brass(ctx, dest, t + 0.17, 76, 0.45, 0.13);
    brass(ctx, dest, t + 0.17, 79, 0.45, 0.1);
    bell(ctx, echo || dest, t + 0.17, 2093, 0.08, 0.4);
  },

  countdown(ctx, dest, t) {
    osc(ctx, dest, t, { type: 'square', f0: 660, peak: 0.12, a: 0.004, d: 0.04, hold: 0.14 });
    osc(ctx, dest, t, { f0: 1320, peak: 0.05, a: 0.004, d: 0.04, hold: 0.14 });
  },

  go(ctx, dest, t) {
    osc(ctx, dest, t, { type: 'square', f0: 1320, peak: 0.12, a: 0.004, d: 0.15, hold: 0.55 });
    osc(ctx, dest, t, { f0: 2640, peak: 0.05, a: 0.004, d: 0.15, hold: 0.55 });
  },

  finish(ctx, dest, t, k, echo) {
    const notes = [60, 64, 67, 72];
    notes.forEach((m, i) => brass(ctx, dest, t + i * 0.12, m + 7, 0.1, 0.15));
    for (const m of [72, 76, 79, 84]) brass(ctx, dest, t + 0.5, m, 0.9, 0.11);
    noise(ctx, dest, t + 0.5, { filt: 'highpass', f: 5000, q: 0.6, peak: 0.1, d: 0.6, len: 3 });
    for (let i = 0; i < 6; i++) bell(ctx, echo || dest, t + 0.55 + i * 0.09, mtof(84 + [0, 4, 7, 12, 7, 12][i]), 0.05, 0.3);
  },

  splash(ctx, dest, t, k) {
    const i = clamp(k, 0.2, 1);
    noise(ctx, dest, t, { filt: 'lowpass', f: 4000, f1: 400, glide: 0.6, q: 0.7, a: 0.01, peak: 0.55 * i, d: 0.3 });
    noise(ctx, dest, t, { type: 'brown', filt: 'lowpass', f: 250, q: 0.7, peak: 0.5 * i, d: 0.15 });
    for (let n = 0; n < 7; n++) {
      const tt = t + 0.1 + Math.random() * 0.6;
      const f = 400 + Math.random() * 900;
      osc(ctx, dest, tt, { f0: f, f1: f * 2.2, glide: 0.05, peak: 0.04 * i, d: 0.02 });
    }
  },

  nearmiss(ctx, dest, t, k) {
    const side = Math.random() < 0.5 ? -1 : 1;
    noise(ctx, dest, t, { filt: 'bandpass', f: 2600, f1: 700, glide: 0.5, q: 2.2, a: 0.12, peak: 0.32, d: 0.12, pan: [-0.9 * side, 0.9 * side, 0.5] });
    noise(ctx, dest, t, { type: 'pink', filt: 'lowpass', f: 1200, f1: 300, glide: 0.5, q: 0.7, a: 0.1, peak: 0.25, d: 0.12 });
    osc(ctx, dest, t + 0.05, { type: 'sawtooth', f0: 520, f1: 390, glide: 0.4, peak: 0.025, a: 0.06, d: 0.1 });
  },

  discover(ctx, dest, t, k, echo) {
    // sitar-ish Yaman arpeggio + sparkle
    const tonic = 61;
    const degs = [0, 2, 4, 6, 7, 11, 12];
    degs.forEach((s, i) => {
      pluck(ctx, dest, t + i * 0.075, 'sitar', tonic + s, { vel: 0.35, slideFrom: i === degs.length - 1 ? tonic + 11 : undefined, slideTime: 0.12 });
    });
    for (let i = 0; i < 8; i++) {
      const tt = t + 0.3 + i * 0.05 + Math.random() * 0.03;
      osc(ctx, echo || dest, tt, { f0: 2600 + Math.random() * 3000, peak: 0.035, d: 0.08 });
    }
  },

  'ui-click'(ctx, dest, t) {
    osc(ctx, dest, t, { f0: 1800, f1: 1200, glide: 0.02, peak: 0.12, a: 0.001, d: 0.012 });
    noise(ctx, dest, t, { filt: 'highpass', f: 4000, q: 0.7, peak: 0.05, d: 0.004 });
  },

  'ui-hover'(ctx, dest, t) {
    osc(ctx, dest, t, { f0: 2400, peak: 0.02, a: 0.002, d: 0.01 });
  },

  gear(ctx, dest, t) {
    // mechanical clunk + pneumatic chirp of a paddle shift
    noise(ctx, dest, t, { filt: 'bandpass', f: 1800, q: 2, peak: 0.08, d: 0.01 });
    osc(ctx, dest, t, { f0: 140, f1: 80, glide: 0.04, peak: 0.12, d: 0.025 });
  },
};

export const SFX_NAMES = Object.keys(SFX);
