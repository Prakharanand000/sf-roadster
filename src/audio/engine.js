// Engine + continuous driving layers (fully synthesized).
//
// Powertrain voices (swapped per profile with a short crossfade):
//   combustion: firing-frequency periodic wave (rpm*cyl/120) + half-order "burble" wave
//               + sub sine -> load-driven waveshaper -> load filter (throttle opens it)
//               -> exhaust resonance; pulse-modulated noise ("rasp") + intake noise;
//               slow random pitch jitter; turbo whistle + blow-off; overrun crackle pops.
//   electric:   inverter whine (two detuned tones + faint high carrier) + motor hum.
//   hybrid-v8:  combustion V8 + electric layer (stronger at low rpm).
// Continuous layers (always present): road roar, wind, tyre squeal, thruster hiss/whoosh/roar.

import {
  clamp, smoothstep, setTarget, getNoise, tanhCurve, asymCurve, harmonicWave, autoDisconnect,
} from './util.js';

export const ENGINE_PROFILES = {
  flat6: {
    cyl: 6, idle: 950, red: 9000,
    harm: [1, 0.8, 0.62, 0.55, 0.38, 0.33, 0.22, 0.18, 0.12, 0.1, 0.07, 0.05],
    half: 0.22, sub: 0.32, drive: 3.4, lpLow: 650, lpHigh: 7800,
    resF: 420, resQ: 2.4, resGain: 6, rasp: 0.6, intake: 0.45,
    turbo: 0, crackle: 0.8, level: 0.85, electric: 0,
  },
  v8: {
    cyl: 8, idle: 850, red: 8200,
    harm: [1, 0.62, 0.5, 0.36, 0.26, 0.18, 0.12, 0.08, 0.06],
    half: 0.5, sub: 0.55, drive: 3.8, lpLow: 480, lpHigh: 5600,
    resF: 165, resQ: 1.4, resGain: 8, rasp: 0.5, intake: 0.35,
    turbo: 0.65, turboLow: 2400, turboHigh: 7600, crackle: 0.95, level: 0.95, electric: 0,
  },
  v10: {
    cyl: 10, idle: 1000, red: 8700,
    harm: [1, 0.72, 0.62, 0.44, 0.4, 0.26, 0.2, 0.13, 0.1, 0.07],
    half: 0.18, sub: 0.28, drive: 3.0, lpLow: 780, lpHigh: 9500,
    resF: 540, resQ: 2.5, resGain: 5, rasp: 0.42, intake: 0.5,
    turbo: 0, crackle: 0.75, level: 0.85, electric: 0,
  },
  v12: {
    cyl: 12, idle: 950, red: 9300,
    harm: [1, 0.55, 0.46, 0.3, 0.28, 0.2, 0.15, 0.1, 0.08],
    half: 0.08, sub: 0.24, drive: 2.4, lpLow: 850, lpHigh: 10500,
    resF: 720, resQ: 2.0, resGain: 5, rasp: 0.3, intake: 0.55,
    turbo: 0, crackle: 0.55, level: 0.8, electric: 0.18,
  },
  w16: {
    cyl: 16, idle: 750, red: 6800,
    harm: [1, 0.5, 0.42, 0.26, 0.18, 0.12, 0.08],
    half: 0.32, sub: 0.62, drive: 2.6, lpLow: 380, lpHigh: 4200,
    resF: 115, resQ: 1.2, resGain: 9, rasp: 0.36, intake: 0.5,
    turbo: 1.0, turboLow: 1600, turboHigh: 4800, crackle: 0.25, level: 1.0, electric: 0,
  },
  'hybrid-v8': {
    cyl: 8, idle: 900, red: 8600,
    harm: [1, 0.66, 0.52, 0.42, 0.28, 0.2, 0.14, 0.1],
    half: 0.3, sub: 0.45, drive: 3.4, lpLow: 580, lpHigh: 7200,
    resF: 240, resQ: 1.6, resGain: 7, rasp: 0.45, intake: 0.42,
    turbo: 0.55, turboLow: 2600, turboHigh: 8200, crackle: 0.7, level: 0.9, electric: 0.5,
  },
  electric: {
    cyl: 0, electric: 1, whineLow: 160, whineHigh: 3900, level: 1.0,
  },
};

const ALIASES = { ev: 'electric', hybrid: 'hybrid-v8', v6: 'v8', i4: 'flat6' };

function normProfile(name) {
  if (ENGINE_PROFILES[name]) return name;
  if (ALIASES[name]) return ALIASES[name];
  return 'v8';
}

// ---------------------------------------------------------------------------

class CombustionVoice {
  constructor(ctx, dest, p, noise) {
    this.ctx = ctx; this.p = p; this.noise = noise;
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const bq = (type, f, q) => {
      const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n;
    };
    this.out = g(0); this.out.connect(dest);
    this.dip = g(1); this.dip.connect(this.out);
    this.res = bq('peaking', p.resF, p.resQ); this.res.gain.value = p.resGain; this.res.connect(this.dip);
    this.lp = bq('lowpass', p.lpLow, 0.75); this.lp.connect(this.res);
    this.hp = bq('highpass', 28, 0.7); this.hp.connect(this.lp);
    this.post = g(0.5); this.post.connect(this.hp);
    this.shaper = ctx.createWaveShaper(); this.shaper.curve = asymCurve(1.7); this.shaper.oversample = '2x';
    this.shaper.connect(this.post);
    this.pre = g(1); this.pre.connect(this.shaper);

    // tonal layers
    this.main = ctx.createOscillator(); this.main.setPeriodicWave(harmonicWave(ctx, p.harm));
    this.gMain = g(0.55); this.main.connect(this.gMain); this.gMain.connect(this.pre);
    this.half = ctx.createOscillator();
    this.half.setPeriodicWave(harmonicWave(ctx, [1, 0.12, 0.75, 0.08, 0.45, 0.05, 0.25, 0.03, 0.12]));
    this.gHalf = g(0); this.half.connect(this.gHalf); this.gHalf.connect(this.pre);
    this.sub = ctx.createOscillator(); this.sub.type = 'sine';
    this.gSub = g(0); this.sub.connect(this.gSub); this.gSub.connect(this.lp);

    // rasp: noise amplitude-modulated by a firing-rate pulse train
    this.raspBP = bq('bandpass', 900, 0.7);
    this.am = g(0.5);
    this.gRasp = g(0);
    noise.white.connect(this.raspBP); this.raspBP.connect(this.am); this.am.connect(this.gRasp);
    this.gRasp.connect(this.pre);
    this.pulse = ctx.createOscillator();
    this.pulse.setPeriodicWave(harmonicWave(ctx, [1, 1, 0.95, 0.9, 0.8, 0.65, 0.5, 0.35, 0.2], true));
    this.pulseDepth = g(0.5); this.pulse.connect(this.pulseDepth); this.pulseDepth.connect(this.am.gain);

    // intake
    this.intBP = bq('bandpass', 600, 1.1);
    this.gIntake = g(0);
    noise.pink.connect(this.intBP); this.intBP.connect(this.gIntake); this.gIntake.connect(this.lp);

    // pitch jitter (slow random detune) for an organic, unsteady idle
    this.jLP = bq('lowpass', 7, 0.5);
    this.jit = g(90);
    noise.brown.connect(this.jLP); this.jLP.connect(this.jit);
    this.oscs = [this.main, this.half, this.sub, this.pulse];
    for (const o of this.oscs) this.jit.connect(o.detune);

    // turbo
    this.turbo = null;
    if (p.turbo > 0) {
      const w = ctx.createOscillator(); w.type = 'sine'; w.frequency.value = p.turboLow;
      const gw = g(0); w.connect(gw); gw.connect(dest);
      const tbp = bq('bandpass', p.turboLow, 16); const gwn = g(0);
      noise.white.connect(tbp); tbp.connect(gwn); gwn.connect(dest);
      this.turbo = { w, gw, tbp, gwn };
      this.oscs.push(w);
    }
    this.boost = 0; // turbo pressure 0..1
    this.prevLoad = 0;
    this.lastPopCheck = 0;
    this.dest = dest;

    const t = ctx.currentTime;
    for (const o of this.oscs) o.start(t);
    this.started = t;
  }

  update(st, dt) {
    const ctx = this.ctx, p = this.p, t = ctx.currentTime;
    const rpm = clamp(st.rpm, 0, 1.05), load = st.load;
    const actual = p.idle + rpm * (p.red - p.idle);
    const f = actual * p.cyl / 120;
    const tc = 0.025;
    setTarget(this.main.frequency, f, t, tc);
    setTarget(this.pulse.frequency, f, t, tc);
    setTarget(this.half.frequency, f * 0.5, t, tc);
    setTarget(this.sub.frequency, f * 0.5, t, tc);
    setTarget(this.raspBP.frequency, clamp(f * 2.6, 180, 6500), t, 0.05);
    setTarget(this.intBP.frequency, 280 + rpm * 2600 + load * 400, t, 0.05);

    const drive = 0.6 + p.drive * (0.25 + 0.75 * load) * (0.55 + 0.45 * rpm);
    setTarget(this.pre.gain, drive, t, 0.04);
    setTarget(this.post.gain, 0.55 / Math.sqrt(drive), t, 0.04);
    const open = clamp(0.08 + 0.42 * rpm + 0.5 * load * (0.4 + 0.6 * rpm), 0, 1);
    setTarget(this.lp.frequency, p.lpLow * Math.pow(p.lpHigh / p.lpLow, open), t, 0.04);

    setTarget(this.gHalf.gain, p.half * (1 - 0.55 * rpm) * (0.55 + 0.7 * (1 - load)), t, 0.05);
    setTarget(this.gSub.gain, p.sub * (0.45 + 0.55 * load) * (1 - 0.6 * rpm), t, 0.05);
    setTarget(this.gRasp.gain, p.rasp * (0.18 + 0.82 * load) * (0.3 + 0.7 * rpm), t, 0.04);
    setTarget(this.gIntake.gain, p.intake * load * (0.15 + rpm), t, 0.04);
    const lvl = p.level * (0.3 + 0.32 * rpm + 0.38 * load) * st.mix;
    setTarget(this.out.gain, lvl * 0.5, t, 0.04);

    // turbo spool: lagging pressure
    if (this.turbo) {
      const target = load * Math.pow(rpm, 0.7);
      const tau = target > this.boost ? 0.55 : 0.18;
      this.boost += (target - this.boost) * (1 - Math.exp(-dt / tau));
      const tf = p.turboLow + (p.turboHigh - p.turboLow) * this.boost;
      setTarget(this.turbo.w.frequency, tf, t, 0.05);
      setTarget(this.turbo.tbp.frequency, tf * 1.01, t, 0.05);
      const tg = p.turbo * this.boost * this.boost * st.mix;
      setTarget(this.turbo.gw.gain, tg * 0.025, t, 0.05);
      setTarget(this.turbo.gwn.gain, tg * 0.18, t, 0.05);
    }

    // lift-off events
    const lifted = this.prevLoad > 0.5 && load < 0.18;
    if (lifted) {
      if (this.turbo && this.boost > 0.3) this.blowOff(t, this.boost);
      if (rpm > 0.4 && p.crackle > 0) this.crackleBurst(t, rpm, p.crackle);
      if (this.turbo) this.boost *= 0.4;
    } else if (load < 0.08 && rpm > 0.55 && p.crackle > 0 && t - this.lastPopCheck > 0.05) {
      this.lastPopCheck = t;
      if (Math.random() < 0.06 * p.crackle) this.pop(t + 0.01, 0.35 + Math.random() * 0.4);
    }
    this.prevLoad = load;
  }

  pop(t, strength) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource(); s.buffer = getNoise(ctx, 'white');
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = 500 + Math.random() * 2200; bp.Q.value = 1.2;
    const ge = ctx.createGain(); ge.gain.value = 0;
    const len = 0.012 + Math.random() * 0.03;
    ge.gain.setValueAtTime(0, t);
    ge.gain.linearRampToValueAtTime(0.55 * strength, t + 0.0015);
    ge.gain.exponentialRampToValueAtTime(0.001, t + len);
    s.connect(bp); bp.connect(ge); ge.connect(this.dest);
    s.start(t, Math.random() * 3.5, len + 0.02);
    autoDisconnect(s, [s, bp, ge]);
    // low thump body
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(90 + Math.random() * 60, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.04);
    const go = ctx.createGain(); go.gain.setValueAtTime(0.4 * strength, t);
    go.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(go); go.connect(this.dest);
    o.start(t); o.stop(t + 0.06);
    autoDisconnect(o, [o, go]);
  }

  crackleBurst(t, rpm, amount) {
    const n = Math.round(2 + 9 * rpm * amount);
    let tt = t + 0.06;
    for (let i = 0; i < n; i++) {
      tt += 0.03 + Math.random() * 0.11 * (1 + i * 0.15);
      if (tt > t + 1.3) break;
      this.pop(tt, (0.45 + Math.random() * 0.55) * (1 - i / (n + 2)));
    }
  }

  blowOff(t, boost) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource(); s.buffer = getNoise(ctx, 'white');
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.8;
    bp.frequency.setValueAtTime(4200, t);
    bp.frequency.exponentialRampToValueAtTime(1300, t + 0.45);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 700;
    const ge = ctx.createGain();
    const pk = 0.5 * boost * this.p.turbo;
    ge.gain.setValueAtTime(0.0001, t);
    ge.gain.exponentialRampToValueAtTime(pk, t + 0.03);
    ge.gain.setTargetAtTime(0.0001, t + 0.12, 0.13);
    // flutter ("chutter") for the big turbo engines
    const fl = ctx.createOscillator(); fl.frequency.value = 22 + Math.random() * 8;
    const flg = ctx.createGain(); flg.gain.value = pk * 0.45 * this.p.turbo;
    fl.connect(flg); flg.connect(ge.gain);
    s.connect(bp); bp.connect(hp); hp.connect(ge); ge.connect(this.dest);
    s.start(t, Math.random() * 3, 0.9);
    fl.start(t); fl.stop(t + 0.9);
    autoDisconnect(s, [s, bp, hp, ge]);
    autoDisconnect(fl, [fl, flg]);
  }

  shift(t) {
    const d = this.dip.gain;
    try {
      d.cancelScheduledValues(t);
      d.setValueAtTime(d.value, t);
      d.setTargetAtTime(0.3, t, 0.012);
      d.setTargetAtTime(1, t + 0.075, 0.05);
    } catch (e) { /* ignore */ }
    if (this.p.crackle > 0.4 && Math.random() < 0.7) this.pop(t + 0.03, 0.5);
    if (this.turbo && this.boost > 0.5) this.boost *= 0.7;
  }

  stop(t) {
    setTarget(this.out.gain, 0, t, 0.08);
    if (this.turbo) { setTarget(this.turbo.gw.gain, 0, t, 0.05); setTarget(this.turbo.gwn.gain, 0, t, 0.05); }
    const end = t + 0.6;
    for (const o of this.oscs) { try { o.stop(end); } catch (e) { /* */ } }
    const all = [this.out, this.dip, this.res, this.lp, this.hp, this.post, this.shaper, this.pre,
      this.gMain, this.gHalf, this.gSub, this.raspBP, this.am, this.gRasp, this.pulseDepth, this.intBP,
      this.gIntake, this.jLP, this.jit, ...this.oscs];
    if (this.turbo) all.push(this.turbo.gw, this.turbo.tbp, this.turbo.gwn);
    const noise = this.noise;
    this.main.onended = () => {
      try { noise.white.disconnect(this.raspBP); } catch (e) { /* */ }
      try { noise.pink.disconnect(this.intBP); } catch (e) { /* */ }
      try { noise.brown.disconnect(this.jLP); } catch (e) { /* */ }
      if (this.turbo) { try { noise.white.disconnect(this.turbo.tbp); } catch (e) { /* */ } }
      for (const n of all) { try { n.disconnect(); } catch (e) { /* */ } }
    };
  }
}

class ElectricVoice {
  constructor(ctx, dest, p, amount) {
    this.ctx = ctx; this.p = p; this.amount = amount;
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.out = g(0); this.out.connect(dest);
    this.dip = g(1); this.dip.connect(this.out);
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 7000; this.lp.Q.value = 0.6;
    this.lp.connect(this.dip);
    this.a = ctx.createOscillator(); this.a.type = 'sine';
    this.b = ctx.createOscillator(); this.b.type = 'triangle'; this.b.detune.value = 9;
    this.c = ctx.createOscillator(); this.c.type = 'sine'; this.c.detune.value = -14;
    this.ga = g(0); this.gb = g(0); this.gc = g(0);
    this.a.connect(this.ga); this.b.connect(this.gb); this.c.connect(this.gc);
    this.ga.connect(this.lp); this.gb.connect(this.lp); this.gc.connect(this.lp);
    // motor hum
    this.hum = ctx.createOscillator(); this.hum.type = 'sawtooth';
    this.humLP = ctx.createBiquadFilter(); this.humLP.type = 'lowpass'; this.humLP.frequency.value = 240;
    this.gHum = g(0);
    this.hum.connect(this.humLP); this.humLP.connect(this.gHum); this.gHum.connect(this.out);
    // slow wobble on the whine for a "living" inverter
    this.lfo = ctx.createOscillator(); this.lfo.frequency.value = 0.37;
    this.lfoG = g(6); this.lfo.connect(this.lfoG);
    this.lfoG.connect(this.a.detune); this.lfoG.connect(this.b.detune);
    this.oscs = [this.a, this.b, this.c, this.hum, this.lfo];
    const t = ctx.currentTime;
    for (const o of this.oscs) o.start(t);
    this.prevU = 0;
  }

  update(st) {
    const p = this.p, t = this.ctx.currentTime;
    const ms = st.maxSpeed > 1 ? st.maxSpeed : 100;
    const u = clamp(Math.abs(st.speed) / ms * 0.88 + st.rpm * 0.12, 0, 1.05);
    const lo = p.whineLow || 160, hi = p.whineHigh || 3900;
    const fw = lo + (hi - lo) * Math.pow(u, 0.92);
    setTarget(this.a.frequency, fw, t, 0.03);
    setTarget(this.b.frequency, fw * 1.5, t, 0.03);
    setTarget(this.c.frequency, fw * 4.02 + 900, t, 0.03);
    setTarget(this.hum.frequency, 45 + 90 * u, t, 0.05);
    const load = st.load;
    const regen = load < 0.1 && u > 0.05 ? 0.55 : 1;
    const moving = smoothstep(0.0, 0.08, u);
    const k = this.amount * st.mix * (p.level || 1);
    setTarget(this.ga.gain, k * 0.09 * moving * (0.35 + 0.65 * load) * regen, t, 0.05);
    setTarget(this.gb.gain, k * 0.045 * moving * (0.25 + 0.75 * load), t, 0.05);
    setTarget(this.gc.gain, k * 0.012 * moving * (0.2 + 0.8 * load) * (1 - 0.6 * u), t, 0.05);
    setTarget(this.gHum.gain, k * 0.08 * (0.15 + 0.85 * load) * (0.3 + 0.7 * smoothstep(0, 0.3, u)), t, 0.06);
    setTarget(this.out.gain, 1, t, 0.05);
  }

  shift(t) {
    const d = this.dip.gain;
    try {
      d.cancelScheduledValues(t); d.setValueAtTime(d.value, t);
      d.setTargetAtTime(0.7, t, 0.01); d.setTargetAtTime(1, t + 0.05, 0.04);
    } catch (e) { /* */ }
  }

  stop(t) {
    setTarget(this.out.gain, 0, t, 0.08);
    for (const o of this.oscs) { try { o.stop(t + 0.6); } catch (e) { /* */ } }
    const all = [this.out, this.dip, this.lp, this.ga, this.gb, this.gc, this.humLP, this.gHum, this.lfoG, ...this.oscs];
    this.a.onended = () => { for (const n of all) { try { n.disconnect(); } catch (e) { /* */ } } };
  }
}

// ---------------------------------------------------------------------------

export class EngineSound {
  /** @param {BaseAudioContext} ctx  @param {AudioNode} dest engine bus input */
  constructor(ctx, dest) {
    this.ctx = ctx;
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const bq = (type, f, q) => {
      const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n;
    };
    this.master = g(0); this.master.connect(dest);      // activity / pause gate
    this.ptBus = g(1); this.ptBus.connect(this.master);  // powertrain
    this.envBus = g(1); this.envBus.connect(this.master);

    // shared noise sources (fan out to many filters)
    const t = ctx.currentTime;
    const mk = (type) => {
      const s = ctx.createBufferSource(); s.buffer = getNoise(ctx, type); s.loop = true;
      s.start(t, Math.random() * 3.5); return s;
    };
    this.noise = { white: mk('white'), pink: mk('pink'), brown: mk('brown') };

    // road roar
    this.roadLP = bq('lowpass', 300, 0.7); this.gRoad = g(0);
    this.noise.brown.connect(this.roadLP); this.roadLP.connect(this.gRoad); this.gRoad.connect(this.envBus);
    // wind
    this.windLP = bq('lowpass', 500, 0.5); this.windHP = bq('highpass', 140, 0.5); this.gWind = g(0);
    this.noise.pink.connect(this.windHP); this.windHP.connect(this.windLP); this.windLP.connect(this.gWind);
    this.gWind.connect(this.envBus);
    // tyre squeal: two narrow noise bands with a fast chatter wobble
    this.sq1 = bq('bandpass', 1250, 11); this.sq2 = bq('bandpass', 2550, 14);
    this.sqDist = ctx.createWaveShaper(); this.sqDist.curve = tanhCurve(2.5);
    this.gSq = g(0);
    this.noise.white.connect(this.sq1); this.noise.white.connect(this.sq2);
    this.sq1.connect(this.sqDist); this.sq2.connect(this.sqDist); this.sqDist.connect(this.gSq);
    this.gSq.connect(this.envBus);
    this.sqLfo = ctx.createOscillator(); this.sqLfo.frequency.value = 9.5;
    this.sqLfoG = g(70); this.sqLfo.connect(this.sqLfoG); this.sqLfoG.connect(this.sq1.frequency);
    this.sqLfo.start(t);
    // thrusters (cold gas): airy hiss + resonant whoosh + low roar
    this.thrHP = bq('highpass', 2200, 0.7); this.gHiss = g(0);
    this.thrBP = bq('bandpass', 950, 3.2); this.gWhoosh = g(0);
    this.thrLP = bq('lowpass', 280, 0.8); this.gRoar = g(0);
    this.noise.white.connect(this.thrHP); this.thrHP.connect(this.gHiss);
    this.noise.white.connect(this.thrBP); this.thrBP.connect(this.gWhoosh);
    this.noise.brown.connect(this.thrLP); this.thrLP.connect(this.gRoar);
    this.thrOut = g(1);
    this.gHiss.connect(this.thrOut); this.gWhoosh.connect(this.thrOut); this.gRoar.connect(this.thrOut);
    this.thrOut.connect(this.master);
    this.thrLfo = ctx.createOscillator(); this.thrLfo.frequency.value = 0.65;
    this.thrLfoG = g(380); this.thrLfo.connect(this.thrLfoG); this.thrLfoG.connect(this.thrBP.frequency);
    this.thrLfo.start(t);

    this.profile = null;
    this.voices = [];
    this.active = false;
    this.lastT = t;
    this.load = 0;
    this.thr = 0;
  }

  setProfile(name) {
    const key = normProfile(name);
    if (key === this.profile) return;
    this.profile = key;
    const ctx = this.ctx, t = ctx.currentTime;
    for (const v of this.voices) v.stop(t);
    this.voices = [];
    const p = ENGINE_PROFILES[key];
    if (p.cyl > 0) this.voices.push(new CombustionVoice(ctx, this.ptBus, p, this.noise));
    if (p.electric > 0) {
      this.voices.push(new ElectricVoice(ctx, this.ptBus, p.cyl > 0 ? { whineLow: 220, whineHigh: 4600, level: 1 } : p, p.electric));
    }
    this.electricOnly = p.cyl === 0;
  }

  /** Activity gate (watchdog / pause). */
  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    setTarget(this.master.gain, on ? 1 : 0, this.ctx.currentTime, on ? 0.05 : 0.12);
  }

  update(s) {
    const ctx = this.ctx, t = ctx.currentTime;
    let dt = t - this.lastT; this.lastT = t;
    if (!(dt > 0)) dt = 1 / 60; if (dt > 0.1) dt = 0.1;
    const speed = Number.isFinite(s.speed) ? s.speed : 0;
    const rpm = clamp(Number.isFinite(s.rpm) ? s.rpm : 0, 0, 1.05);
    const throttle = clamp(Number.isFinite(s.throttle) ? s.throttle : 0, 0, 1);
    const onGround = s.onGround !== false;
    // smooth load a little (keyboard throttle is 0/1)
    this.load += (throttle - this.load) * (1 - Math.exp(-dt / 0.05));
    const st = {
      rpm, load: this.load, speed, mix: 1,
      maxSpeed: s.maxSpeed,
    };
    for (const v of this.voices) v.update(st, dt);

    // continuous layers
    const sp = Math.abs(speed);
    const sn = clamp(sp / 85, 0, 1.3);
    const roadAmt = this.electricOnly ? 0.2 : 0.11;
    setTarget(this.gRoad.gain, onGround ? roadAmt * clamp(sp / 50, 0, 1.2) : 0, t, 0.08);
    setTarget(this.roadLP.frequency, 180 + 260 * clamp(sp / 70, 0, 1), t, 0.1);
    setTarget(this.gWind.gain, 0.16 * sn * sn + (onGround ? 0 : 0.03 * sn), t, 0.08);
    setTarget(this.windLP.frequency, 350 + 3200 * clamp(sn, 0, 1), t, 0.1);
    const slip = clamp(Number.isFinite(s.slip) ? s.slip : 0, 0, 1);
    const sq = onGround && !s.inWater ? smoothstep(0.22, 0.85, slip) * clamp(sp / 7, 0, 1) : 0;
    setTarget(this.gSq.gain, 0.09 * sq, t, sq > 0 ? 0.03 : 0.07);
    setTarget(this.sq1.frequency, 1150 + 380 * slip + (Math.random() - 0.5) * 60, t, 0.05);
    setTarget(this.sq2.frequency, 2350 + 500 * slip, t, 0.05);
    // thrusters
    const boosting = !!s.boosting, hovering = !!s.hovering;
    const target = boosting ? 1 : hovering ? 0.65 : 0;
    this.thr += (target - this.thr) * (1 - Math.exp(-dt / (target > this.thr ? 0.04 : 0.18)));
    const th = this.thr;
    setTarget(this.gHiss.gain, th * (boosting ? 0.22 : 0.16), t, 0.03);
    setTarget(this.gWhoosh.gain, th * (boosting ? 0.32 : 0.24), t, 0.03);
    setTarget(this.gRoar.gain, th * (boosting ? 0.55 : 0.14), t, 0.03);
    setTarget(this.thrBP.frequency, boosting ? 1150 : 820, t, 0.2);
  }

  gearShift() {
    const t = this.ctx.currentTime;
    for (const v of this.voices) v.shift(t);
  }

  dispose() {
    const t = this.ctx.currentTime;
    for (const v of this.voices) v.stop(t);
    this.voices = [];
    try {
      for (const k of ['white', 'pink', 'brown']) this.noise[k].stop(t + 0.7);
      this.sqLfo.stop(t + 0.7); this.thrLfo.stop(t + 0.7);
    } catch (e) { /* */ }
    setTarget(this.master.gain, 0, t, 0.1);
    setTimeout(() => { try { this.master.disconnect(); } catch (e) { /* */ } }, 900);
  }
}
