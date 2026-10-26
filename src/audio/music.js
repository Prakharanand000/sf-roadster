// Bollywood FM: real-time generative radio.
//
// Lookahead scheduler on AudioContext time: tick() (called ~every 25 ms by AudioSystem)
// turns the next bar of the composed song plan (songs.js) into time-stamped events, then
// creates audio nodes only for events inside the lookahead window (~0.25 s; longer while
// the tab is hidden). Each song gets its own bus (for crossfades) with persistent channel
// gains/panners, persistent mono leads + bass (automation only), and short-lived nodes
// for plucks/percussion that disconnect themselves when finished.

import { SONGS, STATION_NAME, composeSong, degToSemi } from './songs.js';
import * as I from './instruments.js';
import { mtof, rng, setTarget } from './util.js';

const SONG_GAIN = 0.5; // headroom: raw song mix peaks ~1.4 at unity
const PLUCKED = new Set(['sitar', 'santoor', 'tumbi', 'harp']);
const OCT = { sitar: 0, santoor: 12, tumbi: 12, harp: 12, shehnai: 12, bansuri: 12, synth: 12 };
const PLUCK_VEL = { sitar: 0.9, santoor: 0.75, tumbi: 0.5, harp: 0.5 };

const SECTION = {
  intro: { drone: 1, pad: 0.1, cutoff: 1100, swell: true, bass: null },
  verse: { drone: 0.55, pad: 0.085, cutoff: 1400, bass: 'simple' },
  chorus: { drone: 0.4, pad: 0.11, cutoff: 2600, seventh: true, bass: 'busy' },
  break: { drone: 0.9, pad: 0.06, cutoff: 1200, bass: 'sparse' },
  build: { drone: 0, pad: 0.08, cutoff: 1500, swell: true, bass: null },
  drop: { drone: 0.25, pad: 0.1, cutoff: 3200, bass: 'edm', pump: true },
  outro: { drone: 1, pad: 0.1, cutoff: 1200, bass: 'sparse' },
};

const BASS = {
  16: {
    simple: [[0, 'R', 3], [6, 'R', 2], [8, 'F', 3], [14, 'A', 2]],
    busy: [[0, 'R', 2], [3, 'R', 1], [6, 'F', 2], [8, 'R', 2], [10, 'O', 2], [12, 'F', 2], [14, 'A', 2]],
    sparse: [[0, 'R', 12], [12, 'F', 4]],
    edm: [[0, 'R', 1.5], [2, 'O', 1.5], [4, 'R', 1], [6, 'O', 1.5], [8, 'R', 1], [10, 'O', 1.5], [12, 'R', 1], [14, 'O', 1.5]],
  },
  12: {
    simple: [[0, 'R', 3], [6, 'F', 3], [9, 'R', 2]],
    busy: [[0, 'R', 2], [3, 'R', 1], [5, 'F', 1], [6, 'R', 2], [9, 'O', 2], [11, 'A', 1]],
    sparse: [[0, 'R', 9], [9, 'F', 3]],
    edm: [[0, 'R', 1], [2, 'O', 1], [3, 'R', 1], [5, 'O', 1], [6, 'R', 1], [8, 'O', 1], [9, 'R', 1], [11, 'O', 1]],
  },
};

function fold(m, lo, hi) { while (m < lo) m += 12; while (m > hi) m -= 12; return m; }

export class BollywoodFM {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} out station bus input
   * @param {AudioNode} reverbIn reverb send input
   */
  constructor(ctx, out, reverbIn) {
    this.ctx = ctx; this.out = out; this.reverbIn = reverbIn;
    this.songs = SONGS;
    this.lookahead = 0.25;
    this.onSongStart = null;
    this.cur = null;
    this.old = [];
    this.history = [];
    this.plans = new Map();
    const n = SONGS.length;
    this.order = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this.order[i], this.order[j]] = [this.order[j], this.order[i]]; }
    this.pos = -1;
  }

  get playing() { return !!this.cur; }

  _err(e) { this.errorCount = (this.errorCount || 0) + 1; this.lastError = e; }

  plan(idx) {
    if (!this.plans.has(idx)) this.plans.set(idx, composeSong(SONGS[idx]));
    return this.plans.get(idx);
  }

  info(S = this.cur) {
    if (!S) return null;
    const d = S.plan.def;
    return { title: d.title, artist: d.artist, station: 'bollywood-fm', stationName: STATION_NAME,
      raag: S.plan.raag.name, taal: d.taal, bpm: d.bpm, duration: S.plan.totalSec, index: S.idx };
  }

  /** Current position for a now-playing display. */
  state() {
    const S = this.cur;
    if (!S) return null;
    const now = this.ctx.currentTime;
    const bi = Math.max(0, Math.min(S.plan.bars.length - 1, Math.floor((now - S.startAt) / S.plan.barDur) + S.firstBar));
    return { ...this.info(S), position: Math.max(0, now - S.startAt + S.firstBar * S.plan.barDur), section: S.plan.bars[bi].sec };
  }

  // -------------------------------------------------------------------------
  // transport

  /** Start song `idx` (default: next in shuffled order). opts: { section, fade, at } */
  start(idx, opts = {}) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (idx == null || !(idx >= 0 && idx < SONGS.length)) {
      this.pos = (this.pos + 1) % this.order.length;
      idx = this.order[this.pos];
    } else {
      const p = this.order.indexOf(idx); if (p >= 0) this.pos = p;
    }
    const fade = opts.fade == null ? 1.2 : opts.fade;
    if (this.cur) this._retire(this.cur, opts.at != null ? opts.at : now, fade);
    const at = opts.at != null ? opts.at : now + (this.cur || this.old.length ? 0.35 : 0.12);
    const S = this._createSong(idx, at, opts);
    this.cur = S;
    this.history.push(idx);
    if (this.history.length > 50) this.history.shift();
    return this.info(S);
  }

  next() { return this.start(null, { fade: 1.2 }); }

  prev() {
    const S = this.cur;
    if (S && this.ctx.currentTime - S.startAt > 6) return this.start(S.idx, { fade: 0.8 });
    if (this.history.length >= 2) {
      this.history.pop();
      const idx = this.history.pop();
      return this.start(idx, { fade: 1.0 });
    }
    return this.start(S ? S.idx : null, { fade: 0.8 });
  }

  stop(fade = 1.0) {
    if (this.cur) this._retire(this.cur, this.ctx.currentTime, fade);
    this.cur = null;
  }

  _retire(S, t, fade) {
    S.stopAt = t + fade;
    S.killAt = t + fade + 4.5;
    try {
      S.bus.gain.cancelScheduledValues(t);
      S.bus.gain.setValueAtTime(S.bus.gain.value, t);
      S.bus.gain.setTargetAtTime(0, t, Math.max(0.02, fade / 3.5));
      S.rev.gain.setTargetAtTime(0, t + fade, 0.6);
    } catch (e) { /* */ }
    this.old.push(S);
  }

  _createSong(idx, at, opts) {
    const ctx = this.ctx;
    const plan = this.plan(idx);
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0, Math.max(0, ctx.currentTime));
    bus.gain.setValueAtTime(opts.fadeIn ? 0 : SONG_GAIN, at);
    if (opts.fadeIn) bus.gain.setTargetAtTime(SONG_GAIN, at, opts.fadeIn / 3);
    bus.connect(this.out);
    const rev = ctx.createGain(); rev.gain.value = SONG_GAIN; rev.connect(this.reverbIn);
    const nodes = [bus, rev];
    const ch = (level, pan, send) => {
      const g = ctx.createGain(); g.gain.value = level;
      let last = g;
      if (pan && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); last = p; nodes.push(p);
      }
      last.connect(bus);
      if (send) { const s = ctx.createGain(); s.gain.value = send; g.connect(s); s.connect(rev); nodes.push(s); }
      nodes.push(g);
      return g;
    };
    const pump = ctx.createGain(); pump.gain.value = 1; nodes.push(pump);
    const chans = {
      tabla: ch(0.95, 0.12, 0.12),
      dhol: ch(0.8, -0.12, 0.08),
      perc: ch(1.0, 0.22, 0.15),
      kit: ch(0.65, 0, 0.05),
      lead: ch(1.3, 0, 0.3),
      lead2: ch(1.1, -0.3, 0.35),
      pad: ch(0.6, 0, 0.35),
      bass: ch(0.55, 0, 0),
      drone: ch(0.42, -0.25, 0.3),
    };
    // pad goes through the side-chain "pump" for drops
    chans.pad.disconnect();
    chans.pad.connect(pump);
    pump.connect(bus);
    const sendPad = ctx.createGain(); sendPad.gain.value = 0.35; pump.connect(sendPad); sendPad.connect(rev); nodes.push(sendPad);

    let firstBar = 0;
    if (opts.section) {
      const k = plan.bars.findIndex((b) => b.sec === opts.section);
      if (k > 0) firstBar = k;
    }
    return {
      idx, plan, bus, rev, ch: chans, pump, nodes, monos: {}, bass: null,
      bar: firstBar, firstBar, nextBarT: at, startAt: at, queue: [], qi: 0,
      announced: false, done: false, advanced: false, stopAt: null, killAt: null,
      r: rng((plan.def.seed || 1) * 977 + 13), tan: 0, lastBass: 0,
      tune: mtof(plan.def.tonic),
    };
  }

  _kill(S) {
    const t = this.ctx.currentTime;
    for (const k in S.monos) S.monos[k].stop(t);
    if (S.bass) S.bass.stop(t);
    S.queue.length = 0;
    setTimeout(() => { for (const n of S.nodes) { try { n.disconnect(); } catch (e) { /* */ } } }, 800);
  }

  // -------------------------------------------------------------------------
  // scheduler

  tick() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const horizon = now + this.lookahead;
    const S = this.cur;
    if (S) {
      this._pump(S, now, horizon);
      if (!S.announced && now >= S.startAt - 0.06) {
        S.announced = true;
        if (this.onSongStart) { try { this.onSongStart(this.info(S)); } catch (e) { /* */ } }
      }
      if (S.done && !S.advanced && now > S.endAt - 1.5) {
        S.advanced = true;
        // auto-advance: let the old tail ring, start next after a short gap
        this.pos = (this.pos + 1) % this.order.length;
        const nIdx = this.order[this.pos];
        S.stopAt = S.endAt; S.killAt = S.endAt + 5;
        this.old.push(S);
        this.cur = this._createSong(nIdx, S.endAt + 1.4, {});
        this.history.push(nIdx);
      }
    }
    for (let i = this.old.length - 1; i >= 0; i--) {
      const O = this.old[i];
      if (O.stopAt != null && now < O.stopAt) this._pump(O, now, Math.min(horizon, O.stopAt));
      if (O.killAt != null && now > O.killAt) { this._kill(O); this.old.splice(i, 1); }
    }
  }

  _pump(S, now, horizon) {
    const P = S.plan;
    const limit = S.stopAt != null ? S.stopAt : Infinity;
    // resync after a long stall (throttled background tab)
    if (S.nextBarT < now - 0.5 && !S.done) {
      while (S.nextBarT + P.barDur < now && S.bar < P.bars.length) { S.bar++; S.nextBarT += P.barDur; }
    }
    while (!S.done && S.nextBarT < horizon + 0.05 && S.nextBarT < limit) {
      if (S.bar >= P.bars.length) { S.done = true; S.endAt = S.nextBarT + P.barDur * 0.5; break; }
      const evs = [];
      try { this._bar(S, S.bar, S.nextBarT, evs); } catch (e) { this._err(e); }
      evs.sort((a, b) => a.t - b.t);
      for (const e of evs) S.queue.push(e);
      S.bar++;
      S.nextBarT += P.barDur;
    }
    const q = S.queue;
    let i = S.qi;
    while (i < q.length && q[i].t < horizon) {
      const e = q[i++];
      if (e.t < now - 0.08 || e.t > limit) continue;
      try { e.fn(e.t); } catch (err) { this._err(err); }
    }
    if (i > 200) { q.splice(0, i); i = 0; }
    S.qi = i;
  }

  // -------------------------------------------------------------------------
  // bar -> events

  _bar(S, bi, t0, ev) {
    const ctx = this.ctx;
    const P = S.plan, bar = P.bars[bi], taal = P.taal, def = P.def;
    const sd = P.stepDur, steps = P.steps, scale = P.raag.scale, tonic = def.tonic;
    const cfg = SECTION[bar.sec] || SECTION.verse;
    const r = S.r;
    const C = S.ch;
    const push = (s, fn, jitter = 0.004) => ev.push({ t: t0 + s * sd + (jitter ? (r() - 0.5) * jitter : 0), fn });
    const tune = S.tune;
    const sec = bar.sec;
    const dance = def.form === 'dance';
    const bhangra = def.taal === 'bhangra';

    // --- tanpura drone
    if (cfg.drone > 0) {
      const strings = [tonic - 17, tonic - 12, tonic - 12, tonic - 24];
      const tp = def.taal === 'dadra' ? [0, 6] : taal.tanpura;
      for (const s of tp) {
        const m = strings[S.tan++ % 4];
        const v = cfg.drone * (0.8 + r() * 0.2);
        push(s, (t) => I.tanpuraPluck(ctx, C.drone, t, m, v), 0.01);
      }
    }

    // --- pad (hold through repeated chords)
    const prevBar = bi > 0 ? P.bars[bi - 1] : null;
    if (!prevBar || prevBar.chord !== bar.chord || prevBar.sec !== bar.sec || bar.first) {
      let run = 1;
      while (bi + run < P.bars.length && P.bars[bi + run].chord === bar.chord && P.bars[bi + run].sec === bar.sec && !P.bars[bi + run].first) run++;
      const degs = [bar.chord, bar.chord + 2, bar.chord + 4];
      if (cfg.seventh) degs.push(bar.chord + 6);
      const midis = degs.map((d) => fold(tonic - 12 + degToSemi(scale, d), 52, 71)).sort((a, b) => a - b);
      const dur = run * P.barDur;
      push(0, (t) => I.padChord(ctx, C.pad, t, dur, midis, { vel: cfg.pad, cutoff: cfg.cutoff, swell: cfg.swell }), 0);
    }

    // --- bass
    if (cfg.bass && !(sec === 'outro' && bar.last)) {
      const pat = BASS[steps][cfg.bass];
      const R = fold(tonic - 24 + degToSemi(scale, bar.chord), 34, 46);
      const F = R + (((degToSemi(scale, bar.chord + 4) - degToSemi(scale, bar.chord)) % 12) + 12) % 12;
      const NR = fold(tonic - 24 + degToSemi(scale, bar.nextChord), 34, 46);
      const A = fold(tonic - 24 + degToSemi(scale, bar.nextChord + (NR > R ? -1 : 1)), NR - 3, NR + 3);
      for (const [s, k, d] of pat) {
        const m = k === 'R' ? R : k === 'F' ? F : k === 'O' ? R + 12 : A;
        const dur = d * sd;
        const vel = (s === 0 ? 0.95 : 0.78) * (cfg.bass === 'edm' ? 1.05 : 1);
        push(s, (t) => {
          if (!S.bass) S.bass = new I.MonoBass(ctx, C.bass);
          S.bass.note(t, mtof(m), dur, vel, { bright: cfg.bass === 'edm' ? 1600 : 900 });
        }, 0);
      }
    } else if (sec === 'outro' && bar.last) {
      const R = fold(tonic - 24, 34, 46);
      push(0, (t) => { if (!S.bass) S.bass = new I.MonoBass(ctx, C.bass); S.bass.note(t, mtof(R), P.barDur * 1.5, 0.9); }, 0);
    }

    // --- percussion
    const theka = (alt, vel) => {
      const set = alt ? taal.thekaB : taal.theka;
      const pat = set[bar.bis % set.length];
      for (const [s, bol] of pat) {
        if (bar.last && sec !== 'break' && s >= steps - taal.spb) continue; // leave room for the fill
        const v = vel * (s === 0 ? 1 : 0.62 + r() * 0.25);
        push(s, (t) => I.tabla(ctx, C.tabla, t, bol, v, tune));
      }
    };
    const fill = (vel) => {
      const st = steps - taal.spb;
      const bols = ['ti', 'ra', 'ki', 'ta', 'ti', 'ra'];
      const n = taal.spb;
      for (let i = 0; i < n; i++) {
        const v = vel * (0.6 + 0.4 * (i / n));
        push(st + i, (t) => I.tabla(ctx, C.tabla, t, bols[i % bols.length], v, tune));
      }
    };
    const dholPat = (vel, tilliOnly) => {
      if (!tilliOnly) for (const s of taal.dagga) push(s, (t) => I.dhol(ctx, C.dhol, t, 'dagga', vel * (s === 0 ? 1 : 0.8)));
      for (const s of taal.tilli) push(s, (t) => I.dhol(ctx, C.dhol, t, 'tilli', vel * (0.6 + r() * 0.3)));
    };
    const dholRoll = (from, vel) => {
      for (let s = from; s < steps; s++) push(s, (t) => I.dhol(ctx, C.dhol, t, s === steps - 1 ? 'both' : 'tilli', vel * (0.5 + 0.5 * (s - from) / (steps - from))));
    };
    const beats = [];
    for (let b = 0; b < taal.beats; b++) beats.push(b * taal.spb);

    if (sec === 'intro') {
      if (bar.last) { fill(0.8); if (dance || bhangra) dholRoll(steps - taal.spb, 0.7); }
    } else if (sec === 'verse') {
      theka(bar.pb === 3, 0.75);
      if (bhangra) dholPat(0.55, false);
      if (def.qawwali) for (const s of beats) push(s, (t) => I.clap(ctx, C.perc, t, 0.4));
      else for (const s of taal.chutki) push(s, (t) => I.chutki(ctx, C.perc, t, 0.35));
      if (dance) for (const s of taal.hat) push(s, (t) => I.shaker(ctx, C.perc, t, 0.12));
      if (bar.last) { fill(0.85); if (dance) dholRoll(steps - taal.spb, 0.6); }
    } else if (sec === 'chorus') {
      theka(def.taal === 'teental' || bar.pb % 2 === 1, 0.8);
      dholPat(0.75, false);
      const claps = def.qawwali ? beats : taal.clap;
      for (const s of claps) push(s, (t) => I.clap(ctx, C.perc, t, 0.55));
      if (dance) for (const s of taal.hat) push(s, (t) => I.shaker(ctx, C.perc, t, 0.14));
      if (bar.first) push(0, (t) => I.crash(ctx, C.kit, t, 0.18), 0);
      if (bar.last) { fill(0.9); dholRoll(steps - taal.spb, 0.75); }
      // tumbi riff in bhangra choruses
      if (bhangra && def.inst.answer === 'tumbi') {
        const riff = steps === 12 ? [[0, 7], [2, 7], [3, 4], [5, 7], [6, 8], [8, 7], [9, 4], [11, 5]] : [[0, 7], [3, 7], [4, 4], [6, 7], [8, 8], [11, 7], [12, 4], [14, 5]];
        for (const [s, d] of riff) {
          const m = tonic + 12 + degToSemi(scale, d);
          push(s, (t) => I.pluck(ctx, C.lead2, t, 'tumbi', m, { vel: 0.28, dur: sd * 1.6 }), 0);
        }
      }
    } else if (sec === 'break') {
      if (bar.last) {
        const bols = ['dha', 'ti', 'ra', 'ki'];
        bar.mel.forEach((n, i) => push(n.s, (t) => I.tabla(ctx, C.tabla, t, bols[i % 4], i % 4 === 0 ? 0.9 : 0.6, tune)));
      } else {
        theka(true, 0.7);
      }
    } else if (sec === 'build') {
      const n = bar.bis === bar.len - 1 ? 1 : 2;
      for (let s = 0; s < steps - (bar.bis === bar.len - 1 ? 2 : 0); s += n) {
        const prog = (bar.bis * steps + s) / (bar.len * steps);
        push(s, (t) => I.snare(ctx, C.kit, t, 0.2 + 0.5 * prog), 0);
        if (s % 2 === 0) push(s, (t) => I.dhol(ctx, C.dhol, t, 'tilli', 0.3 + 0.5 * prog), 0);
      }
      if (bar.first) push(0, (t) => I.riser(ctx, C.kit, t, bar.len * P.barDur - sd * 2, 0.22), 0);
    } else if (sec === 'drop') {
      for (const s of taal.kick) push(s, (t) => I.kick(ctx, C.kit, t, 0.95), 0);
      for (const s of taal.clap) push(s, (t) => I.clap(ctx, C.perc, t, 0.6), 0);
      for (const s of taal.hat) push(s, (t) => I.hat(ctx, C.kit, t, 0.2), 0);
      dholPat(0.6, true);
      if (bar.first) { push(0, (t) => { I.crash(ctx, C.kit, t, 0.32); I.boom(ctx, C.kit, t, 0.7); }, 0); }
      // pumping pad + offbeat stabs
      const degs = [bar.chord, bar.chord + 2, bar.chord + 4];
      const midis = degs.map((d) => fold(tonic + degToSemi(scale, d), 60, 76));
      for (const s of beats) {
        push(s, (t) => {
          const g = S.pump.gain;
          g.setValueAtTime(0.22, t); g.setTargetAtTime(1, t + 0.02, sd * taal.spb * 0.28);
        }, 0);
      }
      const off = taal.spb === 3 ? [2, 8] : [2, 6, 10, 14].filter((x) => x < steps);
      for (const s of off) push(s, (t) => I.stab(ctx, C.lead2, t, midis, 0.055, sd * 1.2), 0);
      if (bar.last) dholRoll(steps - taal.spb, 0.8);
    } else if (sec === 'outro') {
      if (bar.last) {
        push(0, (t) => { I.tabla(ctx, C.tabla, t, 'dha', 0.9, tune); I.tabla(ctx, C.tabla, t, 'ghe', 0.7, tune); I.crash(ctx, C.kit, t, 0.12); }, 0);
      } else theka(false, 0.6);
    }

    // --- melody + answers
    for (const n of bar.mel) push(n.s, (t) => this._lead(S, C.lead, t, n), 0);
    for (const n of bar.ans) push(n.s, (t) => this._lead(S, C.lead2, t, n), 0);
  }

  _lead(S, dest, t, n) {
    const ctx = this.ctx;
    const P = S.plan, scale = P.raag.scale, tonic = P.def.tonic, sd = P.stepDur;
    const inst = n.inst || 'sitar';
    const base = tonic + (OCT[inst] || 0);
    const midi = base + degToSemi(scale, n.deg);
    const dur = n.d * sd;
    const prevMidi = n.prevDeg != null ? base + degToSemi(scale, n.prevDeg) : null;
    if (PLUCKED.has(inst)) {
      const o = { vel: (PLUCK_VEL[inst] || 0.6) * (0.85 + S.r() * 0.15) };
      if (n.orn === 'meend' && prevMidi != null && prevMidi !== midi && Math.abs(prevMidi - midi) <= 5) {
        o.slideFrom = prevMidi; o.slideTime = Math.min(0.26, dur * 0.45); o.slideDelay = 0.03;
      } else if (n.orn === 'kan') {
        o.kan = base + degToSemi(scale, n.deg + 1);
      }
      o.dur = dur * (inst === 'sitar' ? 1.5 : 1.25) + 0.05;
      I.pluck(ctx, dest, t, inst, midi, o);
      // santoor tremolo on long notes
      if (inst === 'santoor' && n.d >= 4) {
        for (let k = 1; k < n.d; k++) I.pluck(ctx, dest, t + k * sd, inst, midi, { vel: o.vel * (0.5 - 0.25 * k / n.d), dur: sd * 1.5 });
      }
      return;
    }
    let lead = S.monos[inst];
    if (!lead) lead = S.monos[inst] = new I.MonoLead(ctx, dest, inst);
    const f = mtof(midi);
    const o = { vel: 0.85 + S.r() * 0.15, legato: !!n.legato, tieNext: !!n.tieNext };
    if (n.orn === 'meend' && prevMidi != null && prevMidi !== midi) {
      o.slideFrom = mtof(prevMidi); o.slideTime = Math.min(0.24, dur * 0.5);
    } else if (n.legato && prevMidi != null && prevMidi !== midi) {
      o.slideFrom = mtof(prevMidi); o.slideTime = 0.035;
    } else if (n.orn === 'kan') {
      o.kan = mtof(base + degToSemi(scale, n.deg + 1));
    }
    if (n.orn === 'gamak') o.gamak = degToSemi(scale, n.deg + 1) - degToSemi(scale, n.deg);
    lead.note(t, f, dur, o);
  }
}

export { SONGS, STATION_NAME };
export function songList() { return SONGS.map((s, i) => ({ index: i, title: s.title, artist: s.artist, raag: s.raag, taal: s.taal, bpm: s.bpm })); }
export { setTarget };
