// SF Roadster Rush - AudioSystem (AUDIO agent entry point). Web Audio only; everything is
// synthesized live, no audio files are bundled or fetched.
//
// Contract (CONTRACTS.md) + documented choices:
// - new AudioSystem(opts?)   opts.context: optional (Offline)AudioContext to render into (tests).
// - unlock()                 creates/resumes the AudioContext; call from a user gesture (first
//                            click/keydown). Safe to call repeatedly. Returns Promise<boolean>.
//                            Every other method is a silent no-op until unlock succeeded.
// - The default radio station is 'bollywood-fm': music starts on unlock. Call setRadio('off')
//   first if settings say so (the station choice is remembered before unlock too).
// - updateEngine(state) must be called every frame while a car is being driven. If it is not
//   called for ~0.35 s the engine + driving layers fade out by themselves (menus, garage).
//   Optional extra field: maxSpeed (m/s, CarSpec.physics.maxSpeed) improves EV whine pitch.
// - duck(amount): music gain *= (1 - amount). duck(0) restores. Independent of setPaused.
// - setPaused(true): engine/thruster/tyre layers fade out and music ducks to ~35% (radio
//   keeps playing quietly in the pause menu). setPaused(false) restores.
// - addUserFiles(fileList): adds the player's own audio files and switches to 'my-playlist'.
//   Returns the number of playable files added.
// - setVolumes({ master, music, sfx, engine? }): 0..1. The engine bus follows sfx * engine.
//
// Graph: [engine bus, sfx bus] -> underwater muffle -> master -> limiter -> destination
//        [Bollywood FM, My Playlist] -> music bus (duck/pause) -> music compressor -> master
//        song channels -> reverb (generated impulse) -> music bus

import { clamp, setTarget, makeImpulse, isOfflineContext } from './util.js';
import { EngineSound, ENGINE_PROFILES } from './engine.js';
import { SFX, SFX_NAMES } from './sfx.js';
import { BollywoodFM, songList, STATION_NAME } from './music.js';
import { UserPlaylist } from './playlist.js';

const STATIONS = { 'bollywood-fm': 'bollywood-fm', fm: 'bollywood-fm', radio: 'bollywood-fm', bollywood: 'bollywood-fm',
  'my-playlist': 'my-playlist', playlist: 'my-playlist', mine: 'my-playlist', off: 'off', none: 'off' };

const MIN_GAP = { 'ui-hover': 0.04, 'ui-click': 0.03, collision: 0.06, land: 0.08, nearmiss: 0.25, gear: 0.05 };

export class AudioSystem {
  constructor(opts = {}) {
    this._opts = opts || {};
    this.ctx = null;
    this._built = false;
    this._started = false;
    this.onTrackChange = null;
    this._vol = { master: 0.85, music: 0.6, sfx: 0.9, engine: 1 };
    this._duck = 0;
    this.paused = false;
    this._profile = 'v8';
    this._station = 'bollywood-fm';
    this._pendingFiles = [];
    this._lastSfx = {};
    this._lastEngineT = -1;
    this._timer = null;
    this._lastInfo = null;
    this._muffled = false;
  }

  // -------------------------------------------------------------------------
  // lifecycle

  get unlocked() { return this._ok(); }
  get context() { return this.ctx; }

  _ok() {
    const c = this.ctx;
    return !!(c && this._built && (this._offline || c.state === 'running'));
  }

  unlock() {
    try {
      if (!this.ctx) {
        let c = this._opts.context || null;
        if (!c) {
          const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
          if (!AC) return Promise.resolve(false);
          try { c = new AC({ latencyHint: 'interactive' }); } catch (e) { c = new AC(); }
        }
        this.ctx = c;
        this._offline = isOfflineContext(c);
        this._build();
      }
      if (this._offline) { this._onRunning(); return Promise.resolve(true); }
      const c = this.ctx;
      if (c.state === 'running') { this._onRunning(); return Promise.resolve(true); }
      let p;
      try { p = c.resume(); } catch (e) { p = null; }
      if (!p || !p.then) { if (c.state === 'running') this._onRunning(); return Promise.resolve(c.state === 'running'); }
      return p.then(() => { if (c.state === 'running') this._onRunning(); return c.state === 'running'; })
        .catch(() => false);
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  _build() {
    const ctx = this.ctx;
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -4; this.limiter.knee.value = 4; this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.2;
    this.limiter.connect(ctx.destination);
    this.master = g(this._vol.master); this.master.connect(this.limiter);

    this.muffle = ctx.createBiquadFilter(); this.muffle.type = 'lowpass';
    this._open = Math.min(20000, ctx.sampleRate * 0.45);
    this.muffle.frequency.value = this._open; this.muffle.Q.value = 0.5;
    this.muffle.connect(this.master);
    this.sfxBus = g(this._vol.sfx); this.sfxBus.connect(this.muffle);
    this.engineBus = g(this._vol.sfx * this._vol.engine); this.engineBus.connect(this.muffle);

    // small echo send for chimes / fanfares
    this.echo = ctx.createDelay(1.0); this.echo.delayTime.value = 0.19;
    this.echoFb = g(0.3); this.echoLP = ctx.createBiquadFilter(); this.echoLP.type = 'lowpass'; this.echoLP.frequency.value = 3500;
    this.echoIn = g(0.6);
    this.echoIn.connect(this.echo); this.echo.connect(this.echoLP); this.echoLP.connect(this.echoFb);
    this.echoFb.connect(this.echo); this.echoLP.connect(this.sfxBus);

    // music
    this.musicComp = ctx.createDynamicsCompressor();
    this.musicComp.threshold.value = -16; this.musicComp.knee.value = 10; this.musicComp.ratio.value = 3;
    this.musicComp.attack.value = 0.01; this.musicComp.release.value = 0.25;
    this.musicComp.connect(this.master);
    this.musicBus = g(this._musicLevel()); this.musicBus.connect(this.musicComp);
    this.reverb = ctx.createConvolver();
    try { this.reverb.buffer = makeImpulse(ctx, 2.3, 3.0); } catch (e) { /* */ }
    this.reverbRet = g(0.55); this.reverb.connect(this.reverbRet); this.reverbRet.connect(this.musicBus);
    this.fmGain = g(0); this.fmGain.connect(this.musicBus);
    this.plGain = g(0); this.plGain.connect(this.musicBus);

    this.fm = new BollywoodFM(ctx, this.fmGain, this.reverb);
    this.fm.onSongStart = (info) => this._emit(info);
    this.playlist = new UserPlaylist(ctx, this.plGain);
    this.playlist.onTrackChange = (info) => { if (this._station === 'my-playlist') this._emit(info); };

    this.engine = new EngineSound(ctx, this.engineBus);
    this.engine.setProfile(this._profile);
    this._built = true;

    if (typeof document !== 'undefined' && document.addEventListener) {
      this._vis = () => { if (this.fm) this.fm.lookahead = document.hidden ? 1.6 : 0.25; };
      document.addEventListener('visibilitychange', this._vis);
    }
  }

  _onRunning() {
    if (this._started || !this._built) return;
    this._started = true;
    if (this._pendingFiles.length) {
      for (const fl of this._pendingFiles) this.playlist.add(fl);
      this._pendingFiles = [];
    }
    this._applyStation(true);
    if (!this._offline && typeof setInterval !== 'undefined') {
      this._timer = setInterval(() => this.tick(), 25);
    }
  }

  /** Scheduler heartbeat (called automatically every 25 ms; call manually for offline tests). */
  tick() {
    if (!this._ok()) return;
    try {
      const now = this.ctx.currentTime;
      if (this.engine.active && now - this._lastEngineT > 0.35) this.engine.setActive(false);
      this.fm.tick();
    } catch (e) { /* never throw from the timer */ }
  }

  dispose() {
    try {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
      if (this._vis) document.removeEventListener('visibilitychange', this._vis);
      if (this.fm) this.fm.stop(0.2);
      if (this.playlist) this.playlist.clear();
      if (this.engine) this.engine.dispose();
      if (this.ctx && !this._offline && this.ctx.close) this.ctx.close();
    } catch (e) { /* */ }
  }

  // -------------------------------------------------------------------------
  // volumes

  _musicLevel() {
    return this._vol.music * (1 - this._duck) * (this.paused ? 0.35 : 1);
  }

  setVolumes(v = {}) {
    try {
      for (const k of ['master', 'music', 'sfx', 'engine']) {
        if (v[k] != null && Number.isFinite(+v[k])) this._vol[k] = clamp(+v[k], 0, 1);
      }
      if (!this._built) return;
      const t = this.ctx.currentTime;
      setTarget(this.master.gain, this._vol.master, t, 0.05);
      setTarget(this.sfxBus.gain, this._vol.sfx, t, 0.05);
      setTarget(this.engineBus.gain, this._vol.sfx * this._vol.engine, t, 0.05);
      setTarget(this.musicBus.gain, this._musicLevel(), t, 0.08);
    } catch (e) { /* */ }
  }

  duck(amount = 0.5) {
    try {
      this._duck = clamp(+amount || 0, 0, 1);
      if (this._built) setTarget(this.musicBus.gain, this._musicLevel(), this.ctx.currentTime, 0.15);
    } catch (e) { /* */ }
  }

  setPaused(p) {
    try {
      this.paused = !!p;
      if (!this._built) return;
      if (this.paused) this.engine.setActive(false);
      setTarget(this.musicBus.gain, this._musicLevel(), this.ctx.currentTime, 0.2);
    } catch (e) { /* */ }
  }

  // -------------------------------------------------------------------------
  // engine

  setEngineProfile(engine) {
    try {
      this._profile = engine || 'v8';
      if (this._built) this.engine.setProfile(this._profile);
    } catch (e) { /* */ }
  }

  updateEngine(s) {
    if (!s || !this._ok()) return;
    try {
      this._lastEngineT = this.ctx.currentTime;
      if (!this.paused) this.engine.setActive(true);
      this.engine.update(s);
      const wet = !!s.inWater;
      if (wet !== this._muffled) {
        this._muffled = wet;
        setTarget(this.muffle.frequency, wet ? 600 : this._open, this.ctx.currentTime, wet ? 0.04 : 0.15);
      }
    } catch (e) { /* */ }
  }

  // -------------------------------------------------------------------------
  // sfx

  play(name, opts = {}) {
    if (!this._ok()) return;
    try {
      const fn = SFX[name];
      if (!fn) return;
      const t = this.ctx.currentTime;
      const gap = MIN_GAP[name] != null ? MIN_GAP[name] : 0.02;
      if (this._lastSfx[name] != null && t - this._lastSfx[name] < gap) return;
      this._lastSfx[name] = t;
      const k = opts && opts.intensity != null && Number.isFinite(+opts.intensity) ? clamp(+opts.intensity, 0, 1) : 1;
      if (name === 'gear' && !this.paused) this.engine.gearShift();
      fn(this.ctx, this.sfxBus, t + 0.005, k, this.echoIn);
    } catch (e) { /* */ }
  }

  // -------------------------------------------------------------------------
  // radio

  get station() { return this._station; }

  setRadio(station) {
    try {
      const st = STATIONS[station] || 'bollywood-fm';
      const changed = st !== this._station;
      this._station = st;
      if (this._started) this._applyStation(changed);
    } catch (e) { /* */ }
  }

  _applyStation(changed) {
    const t = this.ctx.currentTime;
    const st = this._station;
    setTarget(this.fmGain.gain, st === 'bollywood-fm' ? 1 : 0, t, 0.35);
    setTarget(this.plGain.gain, st === 'my-playlist' ? 1 : 0, t, 0.35);
    if (st === 'bollywood-fm') {
      if (this.playlist.active) this.playlist.stop(1.0);
      if (!this.fm.playing) this.fm.start(null, { fade: 0.5 });
      else if (changed) this._emit(this.fm.info());
    } else if (st === 'my-playlist') {
      if (this.fm.playing) this.fm.stop(1.2);
      if (!this.playlist.active) this.playlist.play();
      else if (changed) this._emit(this.playlist.info());
    } else {
      if (this.fm.playing) this.fm.stop(1.0);
      if (this.playlist.active) this.playlist.stop(1.0);
      this._emit({ title: 'Radio off', artist: '', station: 'off' });
    }
  }

  nextTrack() {
    if (!this._ok()) return;
    try {
      if (this._station === 'bollywood-fm') this.fm.start(null, { fade: 1.2, fadeIn: 0.6 });
      else if (this._station === 'my-playlist') this.playlist.next();
    } catch (e) { /* */ }
  }

  prevTrack() {
    if (!this._ok()) return;
    try {
      if (this._station === 'bollywood-fm') this.fm.prev();
      else if (this._station === 'my-playlist') this.playlist.prev();
    } catch (e) { /* */ }
  }

  addUserFiles(fileList) {
    try {
      const files = Array.from(fileList || []);
      if (!files.length) return 0;
      let added;
      if (!this._started) {
        this._pendingFiles.push(files);
        added = files.filter((f) => f && ((f.type || '').startsWith('audio/') || /\.(mp3|m4a|aac|mp4|ogg|oga|opus|wav|flac|webm|weba)$/i.test(f.name || ''))).length;
        if (added) this._station = 'my-playlist';
        return added;
      }
      const wasEmpty = this.playlist.size === 0;
      added = this.playlist.add(files);
      if (added) {
        if (this._station !== 'my-playlist') this.setRadio('my-playlist');
        else if (!this.playlist.active || wasEmpty) this.playlist.play();
      }
      return added;
    } catch (e) { return 0; }
  }

  _emit(info) {
    if (!info) return;
    this._lastInfo = info;
    if (typeof this.onTrackChange === 'function') {
      try { this.onTrackChange({ title: info.title, artist: info.artist, station: info.station, ...info }); } catch (e) { /* */ }
    }
  }

  // -------------------------------------------------------------------------
  // extras (API additions)

  /** Last announced track info ({ title, artist, station, ... }) or null. */
  getNowPlaying() {
    if (this._station === 'bollywood-fm' && this.fm && this.fm.playing) return this.fm.state();
    return this._lastInfo;
  }

  /** Bollywood FM song list. */
  getSongs() { return songList(); }

  /** Jump Bollywood FM to a song (index into getSongs()), optionally at a section name. */
  playSong(index, opts = {}) {
    if (!this._ok()) return;
    try {
      if (this._station !== 'bollywood-fm') this.setRadio('bollywood-fm');
      this.fm.start(index, { fade: 0.8, ...opts });
    } catch (e) { /* */ }
  }

  setShuffle(on) { if (this.playlist) { this.playlist.shuffle = !!on; this.playlist._reshuffle(true); } }

  static get ENGINE_PROFILES() { return Object.keys(ENGINE_PROFILES); }
  static get SFX_NAMES() { return SFX_NAMES.slice(); }
  static get STATION_NAME() { return STATION_NAME; }
}

export default AudioSystem;
