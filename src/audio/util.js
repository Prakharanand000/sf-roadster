// Shared audio helpers: math, seeded RNG, cached noise buffers, waveshaper curves,
// generated reverb impulse, and safe node cleanup. No samples are ever loaded:
// every buffer here is computed in JS.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Small fast seeded PRNG (mulberry32). Returns () => [0,1). */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** setTargetAtTime that never throws (NaN / non-finite guard). */
export function setTarget(param, value, time, tc) {
  if (!param || !Number.isFinite(value) || !Number.isFinite(time)) return;
  try { param.setTargetAtTime(value, time, Math.max(0.001, tc)); } catch (e) { /* ignore */ }
}
export function setNow(param, value, time) {
  if (!param || !Number.isFinite(value)) return;
  try { param.setValueAtTime(value, time); } catch (e) { /* ignore */ }
}

/** Disconnect a list of nodes when `src` ends. */
export function autoDisconnect(src, nodes) {
  src.onended = () => {
    for (let i = 0; i < nodes.length; i++) {
      try { nodes[i].disconnect(); } catch (e) { /* ignore */ }
    }
    src.onended = null;
  };
}

// ---------------------------------------------------------------------------
// Noise buffers (cached per context)

const noiseCache = new WeakMap();

/** type: 'white' | 'pink' | 'brown'. 4 s mono loopable buffer. */
export function getNoise(ctx, type = 'white') {
  let c = noiseCache.get(ctx);
  if (!c) { c = {}; noiseCache.set(ctx, c); }
  if (c[type]) return c[type];
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 4);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const r = rng(type === 'white' ? 1234 : type === 'pink' ? 5678 : 9012);
  if (type === 'white') {
    for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
  } else if (type === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = r() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = r() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  // crossfade the loop seam
  const fade = Math.floor(sr * 0.01);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    d[len - fade + i] = d[len - fade + i] * (1 - t) + d[i] * t;
  }
  c[type] = buf;
  return buf;
}

/** Start a looping noise source (random offset so layers decorrelate). */
export function loopNoise(ctx, type, dest, when = 0) {
  const s = ctx.createBufferSource();
  s.buffer = getNoise(ctx, type);
  s.loop = true;
  s.connect(dest);
  s.start(when || ctx.currentTime, Math.random() * 3.5);
  return s;
}

/** One-shot noise burst source (not looping). Caller connects + stops. */
export function noiseSource(ctx, type = 'white') {
  const s = ctx.createBufferSource();
  s.buffer = getNoise(ctx, type);
  return s;
}

// ---------------------------------------------------------------------------
// Curves + impulse

const curveCache = new Map();
/** tanh soft-clip curve with drive k (cached). */
export function tanhCurve(k = 2, n = 2048) {
  const key = k + ':' + n;
  if (curveCache.has(key)) return curveCache.get(key);
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  curveCache.set(key, c);
  return c;
}

/** Asymmetric "tube-ish" curve: adds even harmonics. */
export function asymCurve(k = 2, n = 2048) {
  const key = 'a' + k + ':' + n;
  if (curveCache.has(key)) return curveCache.get(key);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const y = x >= 0 ? Math.tanh(k * x) : Math.tanh(k * 0.6 * x) * 0.85;
    c[i] = y;
  }
  curveCache.set(key, c);
  return c;
}

/** Generated stereo room/plate impulse: decaying noise, darker over time. */
export function makeImpulse(ctx, seconds = 2.2, decay = 3.2, seed = 77) {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const r = rng(seed + ch * 101);
    let lp = 0;
    const pre = Math.floor(sr * 0.012);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, decay);
      // one-pole lowpass whose coefficient closes as the tail decays
      const a = 0.85 - 0.7 * t;
      lp = lp + a * ((r() * 2 - 1) - lp);
      d[i] = i < pre ? 0 : lp * env;
    }
    // a few early reflections
    for (let k = 0; k < 6; k++) {
      const idx = pre + Math.floor(r() * sr * 0.06);
      if (idx < len) d[idx] += (r() * 0.6 + 0.2) * (r() < 0.5 ? -1 : 1);
    }
  }
  return buf;
}

/** Custom periodic wave from harmonic amplitude list (sine phase). */
export function harmonicWave(ctx, amps, cosPhase = false) {
  const n = amps.length + 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    if (cosPhase) real[i] = amps[i - 1]; else imag[i] = amps[i - 1];
  }
  return ctx.createPeriodicWave(real, imag);
}

export function isOfflineContext(ctx) {
  return !!ctx && typeof ctx.startRendering === 'function';
}
