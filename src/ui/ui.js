// SF Roadster Rush — UI overlay (CONTRACTS.md: UI section). Plain DOM + styles.css.
//
// Choices / additions on top of the contract (all optional for the integrator):
// * Extra screens for show(): 'radio' (station panel). 'pause', 'settings', 'controls' and
//   'radio' are overlays: when opened from the HUD the HUD stays visible (dimmed) underneath.
// * navigate('up'|'down'|'left'|'right'), select(), back() for gamepad mapping. The UI itself
//   handles Arrow keys / Enter / Esc / Backspace while a menu screen is open (window keydown,
//   capture phase, propagation stopped for those keys only). It ignores keys on 'hud'/'none'/
//   'loading', so the game's Esc/P pause handling is untouched. Esc on 'pause' = resume.
// * The UI switches screens itself BEFORE firing navigation callbacks (onStartRace/onFreeRoam
//   -> 'hud', onResume/onRestart -> 'hud', onQuit -> 'menu'), so any show() the integrator
//   does inside the callback wins. Leaving the garage always fires onGarageClose first.
// * flash(text, kind, ms), setStation(id), setMinimapRoute(path, loop), setTouchMode(bool|'auto'),
//   isMenuOpen(), screen (getter), selectedCar (getter), keyboardNav (bool), callbacks (mutable).
// * Optional callback onPause(): fired by the touch pause button. If absent, the UI dispatches a
//   synthetic Escape keydown/keyup on window (what src/main.js listens for).
// * h.speed is read as already being in display units (h.units), as src/main.js sends it.
// * Time Trial starts send rivals: 0.
import { h, fmtTime, ordinalSuffix, fmtLength, fmtInt, clamp, store, prefersReducedMotion, ICONS } from './dom.js';
import { DEFAULT_SETTINGS, sanitizeSettings, loadSettings, saveSettings } from './settings.js';
import { HUD } from './hud.js';

const SCREENS = ['loading', 'menu', 'garage', 'tracks', 'hud', 'pause', 'results', 'settings', 'controls', 'radio', 'none'];
const OVERLAYS = new Set(['pause', 'settings', 'controls', 'radio']);
const MENUS = new Set(['menu', 'garage', 'tracks', 'pause', 'results', 'settings', 'controls', 'radio']);
const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]), [tabindex="0"], input[type="color"]';

const ENGINE_LABEL = {
  electric: 'Electric · tri-motor', flat6: 'Flat-six', v8: 'Twin-turbo V8', v10: 'V10',
  v12: 'V12 hybrid', w16: 'Quad-turbo W16', 'hybrid-v8': 'Hybrid V8',
};
const STATIONS = [
  { id: 'bollywood-fm', name: 'Bollywood FM', freq: '९१.१', desc: 'Composed live as you drive — dhol, tabla, sitar and shehnai in real raags.' },
  { id: 'my-playlist', name: 'My Playlist', freq: 'MP3', desc: 'Songs you load from your own computer.' },
  { id: 'off', name: 'Radio off', freq: 'OFF', desc: 'Just engines, thrusters and the city.' },
];
const TIPS = [
  'Hold E in the air to hover — Roadster style.',
  'Karl the Fog rolls in at dawn.',
  'Drifting refills your thrusters. Slide the hills.',
  'Tap E at a crest and hop onto the rooftops.',
  'Shift fires the cold-gas thrusters. Save some for the bridge deck.',
  'Lombard’s crooked block has eight hairpins. Count them, or don’t.',
  'N flips the radio station. M skips the song.',
  'Load your own songs from the Radio panel — they never leave your computer.',
  'Cable cars have right of way. Mostly.',
  'Lost? R drops you back onto the nearest road.',
  'Bollywood FM is composed live: every song sits in a real raag.',
  'Near misses with traffic score bonus points.',
];
const CREDITS = 'Fan-made project; not affiliated with any car maker. Map © OpenStreetMap contributors.';

export class UI {
  constructor(root, callbacks = {}) {
    this.root = root;
    this.callbacks = callbacks || {};
    this.keyboardNav = true;
    this.settings = loadSettings();
    this.cars = [];
    this.tracks = [];
    this._screen = 'none';
    this.inGame = false;
    this.reduced = prefersReducedMotion();
    this.station = store.get('sfrr.ui.station', 'bollywood-fm');
    this.nowPlaying = null;
    this.playlistCount = 0;
    const sel = store.get('sfrr.ui.car', null);
    this.car = sel && sel.id ? sel : { id: null, color: null };
    this.carColors = store.get('sfrr.ui.carColors', {}) || {};
    this.gIndex = 0;
    this.trackIdx = 0;
    this.mode = 'race';
    this.laps = 3;
    this.session = null;   // { mode, trackId, trackName }
    this.lastRace = null;
    this._garageReturn = 'menu';
    this._tracksReturn = 'menu';
    this._overlayReturn = 'menu';
    this._lastFocus = Object.create(null);
    this._hoverT = 0;
    this._tipT = 0;
    this._tipI = Math.floor(Math.random() * TIPS.length);
    this._closingGarage = false;
    this._touchPref = 'auto';

    root.classList.add('ui-root');
    root.innerHTML = '';
    this.sections = {};
    this._buildLoading();
    this._buildMenu();
    this._buildGarage();
    this._buildTracks();
    this._buildResults();
    const hudSec = this._section('hud');
    this.hud = new HUD(hudSec, this);
    this._buildPause();
    this._buildSettings();
    this._buildControls();
    this._buildRadio();
    this.$toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
    root.append(this.$toasts);

    this._bindGlobal();
    this._detectTouch();
    this._applyStation(this.station, false);
    this.show('loading');
  }

  // ===================================================================== public API

  get screen() { return this._screen; }
  get selectedCar() { return { id: this.car.id, color: this.car.color }; }
  isMenuOpen() { return MENUS.has(this._screen); }

  show(name) {
    if (!SCREENS.includes(name)) name = 'none';
    if (name === this._screen) return;
    if (this._screen === 'garage' && !this._closingGarage) {
      this._closingGarage = true;
      try { this._emit('onGarageClose'); } finally { this._closingGarage = false; }
    }
    const from = this._screen;
    if (from === name) return;
    this._apply(name);
    if (name === 'garage') {
      this._emit('onGarageOpen');
      const cur = this._curCar();
      if (cur) this._emit('onGarageCar', cur.id, this.car.color || cur.colors[0]);
    }
  }

  setLoading(fraction, message) {
    const f = clamp(+fraction || 0, 0, 1);
    this.$ldFill.style.transform = `scaleX(${f.toFixed(3)})`;
    this.$ldPct.textContent = Math.round(f * 100) + '%';
    if (message != null) this.$ldMsg.textContent = message;
    this.$ld.classList.toggle('is-error', !!message && /could not|error|failed/i.test(message));
  }

  setCars(cars) {
    this.cars = Array.isArray(cars) ? cars : [];
    this.$gStrip.textContent = '';
    this.cars.forEach((c, i) => {
      this.$gStrip.append(h('button', { type: 'button', class: 'g-tab', dataset: { i }, onclick: () => this._garageGo(i) },
        h('span', { class: 'g-tab-n', text: String(i + 1).padStart(2, '0') }), h('span', { text: shortName(c) })));
    });
    let i = this.cars.findIndex(c => c.id === this.car.id);
    if (i < 0) { i = 0; if (this.cars[0]) this.car = { id: this.cars[0].id, color: this.carColors[this.cars[0].id] || this.cars[0].colors[0] }; }
    this.gIndex = i;
    this._renderGarage();
    this._renderCarChips();
  }

  setTracks(tracks) {
    this.tracks = Array.isArray(tracks) ? tracks : [];
    this.$tGrid.textContent = '';
    this.$tCards = this.tracks.map((t, i) => {
      const cv = h('canvas', { class: 't-cv', width: 560, height: 240, 'aria-hidden': 'true' });
      const pips = h('span', { class: 'pips', 'aria-label': `Difficulty ${t.difficulty || 1} of 5` });
      for (let k = 1; k <= 5; k++) pips.append(h('i', { class: k <= (t.difficulty || 1) ? 'on' : '' }));
      const card = h('button', { type: 'button', class: 't-card', 'aria-pressed': 'false', dataset: { i },
        onclick: () => this._pickTrack(i, true) },
        h('div', { class: 't-map' }, cv, h('span', { class: 't-kind', text: t.loop ? 'Circuit' : 'Sprint' })),
        h('div', { class: 't-body' },
          h('span', { class: 't-area', text: t.area || 'San Francisco' }),
          h('h3', { class: 't-name', text: t.name || t.id }),
          h('p', { class: 't-desc', text: t.description || '' }),
          h('div', { class: 't-meta' },
            h('span', null, h('b', { text: t.loop ? String(t.laps || 1) : 'A→B' }), t.loop ? ' laps' : ''),
            h('span', { class: 't-len', dataset: { m: t.lengthMeters || 0 }, text: fmtLength(t.lengthMeters || 0, this.settings.units) }),
            h('span', { class: 't-diff' }, pips))));
      drawRoute(cv, t);
      this.$tGrid.append(card);
      return card;
    });
    this._pickTrack(clamp(this.trackIdx, 0, Math.max(0, this.tracks.length - 1)), false);
  }

  setSelectedCar(id, color) {
    const i = this.cars.findIndex(c => c.id === id);
    if (i >= 0) this.gIndex = i;
    const spec = this.cars[i >= 0 ? i : this.gIndex];
    this.car = { id: spec ? spec.id : id, color: color || (spec ? this.carColors[spec.id] || spec.colors[0] : null) };
    if (spec && color) this.carColors[spec.id] = color;
    this._saveCar();
    this._renderGarage();
    this._renderCarChips();
  }

  updateHUD(hd) { this.hud.update(hd); if (hd && hd.mode && this.session) this.session.mode = hd.mode; }
  countdown(n) { this.hud.countdown(n); }
  flash(text, kind, ms) { this.hud.flash(text, kind, ms); }

  toast(text, kind = 'info', ms = 2800) {
    const label = { discover: 'Discovered', music: 'Now playing', warn: 'Heads up', good: 'Nice' }[kind];
    let body = String(text == null ? '' : text);
    if (kind === 'discover') body = body.replace(/^Discovered\s+/i, '');
    const t = h('div', { class: 'toast k-' + (kind || 'info'), role: 'status' },
      label ? h('span', { class: 'toast-k', text: label }) : null,
      h('span', { class: 'toast-t', text: body }));
    this.$toasts.append(t);
    while (this.$toasts.children.length > 4) this.$toasts.firstChild.remove();
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), this.reduced ? 0 : 320);
    }, Math.max(800, ms || 2800));
  }

  showResults(r) {
    r = r || {};
    const pos = r.position | 0;
    const trial = r.mode === 'trial' || (this.session && this.session.mode === 'trial');
    this.$rsKicker.textContent = (trial ? 'Time trial' : 'Race') + ' · ' + (r.trackName || '');
    this.$rsPos.textContent = '';
    if (trial || !pos) {
      this.$rsPos.append(h('span', { class: 'rs-time-hero', text: fmtTime(r.time) }));
      this.$rsSub.textContent = 'Finish time';
    } else {
      this.$rsPos.append(h('span', { class: 'rs-n', text: String(pos) }), h('span', { class: 'rs-s', text: ordinalSuffix(pos) }));
      const n = (r.standings && r.standings.length) || r.racers || 0;
      this.$rsSub.textContent = pos === 1 ? 'Winner winner, samosa dinner' : n ? `of ${n} racers` : '';
    }
    this.$rsWrap.classList.toggle('is-win', pos === 1 && !trial);
    this.$rsTime.textContent = fmtTime(r.time);
    this.$rsBest.textContent = fmtTime(r.bestLap);
    this.$rsScore.textContent = fmtInt(r.score);
    const tb = this.$rsBody;
    tb.textContent = '';
    (r.standings || []).forEach((s, i) => {
      tb.append(h('tr', { class: s.isPlayer ? 'is-you' : '' },
        h('td', { class: 'c-pos', text: String(i + 1) }),
        h('td', { class: 'c-name' }, h('span', { text: s.name || '' }), s.isPlayer && !/^you$/i.test(s.name || '') ? h('em', { text: 'You' }) : null),
        h('td', { class: 'c-car', text: s.car || '' }),
        h('td', { class: 'c-time', text: s.time != null && isFinite(s.time) ? fmtTime(s.time) : 'DNF' })));
    });
    this.$rsTable.hidden = !(r.standings && r.standings.length);
    this.$rsNext.disabled = this.tracks.length < 2;
    this.show('results');
  }

  setMinimap(world) {
    this.world = world || null;
    this.hud.minimap.setWorld(world);
  }
  updateMinimap(m) { if (this._screen === 'hud') this.hud.minimap.update(m, performance.now()); }
  setMinimapRoute(path, loop) { this.hud.minimap.setRoute(path, loop); }

  setNowPlaying(info) {
    this.nowPlaying = info || null;
    if (info && info.station) this._applyStation(info.station, false);
    this.hud.setNowPlaying(info);
    const title = info && info.title ? info.title : '';
    const artist = info && info.artist ? info.artist : '';
    for (const el of this.$npTitles) el.textContent = title || (this.station === 'off' ? 'Radio off' : 'Tuning in…');
    for (const el of this.$npArtists) el.textContent = artist;
  }

  setStation(id) { this._applyStation(id, false); }

  getTouchInput() {
    if (!this.touchMode || this._screen !== 'hud') return null;
    return this.hud.touch.getInput();
  }

  setTouchMode(v) {
    this._touchPref = v;
    const on = v === 'auto' ? this._autoTouch : !!v;
    this.touchMode = on;
    this.root.classList.toggle('is-touch', on);
    if (!on) this.hud.touch.reset();
  }

  getSettings() { return { ...this.settings }; }
  setSettings(s) {
    this.settings = sanitizeSettings(s, this.settings);
    saveSettings(this.settings);
    this._refreshSettings();
  }

  navigate(dir) {
    if (!MENUS.has(this._screen)) return;
    this._kbd(true);
    const scr = this.sections[this._screen];
    const cur = document.activeElement;
    if (!cur || !scr.contains(cur) || cur === scr) { this._focusDefault(this._screen); return; }
    if ((dir === 'left' || dir === 'right') && cur._adjust) { cur._adjust(dir === 'right' ? 1 : -1); this._hover(); return; }
    const next = spatialNext(scr, cur, dir);
    if (next) { focusEl(next); this._hover(); }
  }

  select() {
    if (!MENUS.has(this._screen)) return;
    this._kbd(true);
    const scr = this.sections[this._screen];
    const cur = document.activeElement;
    if (!cur || !scr.contains(cur)) { this._focusDefault(this._screen); return; }
    if (cur._activate) { cur._activate(); return; }
    if (typeof cur.click === 'function') cur.click();
  }

  back() {
    const s = this._screen;
    this._kbd(true);
    switch (s) {
      case 'garage': this._click(); this.show(this._garageReturn === 'tracks' ? 'tracks' : 'menu'); return true;
      case 'tracks': this._click(); this.show(this._tracksReturn === 'garage' ? 'garage' : 'menu'); return true;
      case 'settings': case 'controls': case 'radio':
        this._click(); this.show(this._overlayReturn || (this.inGame ? 'pause' : 'menu')); return true;
      case 'pause': this._click(); this._resume(); return true;
      case 'results': this._click(); this._quit(); return true;
      default: return false;
    }
  }

  destroy() {
    removeEventListener('keydown', this._onKey, true);
    clearInterval(this._tipT);
    this.root.textContent = '';
  }

  // ===================================================================== screens

  _section(name, extraClass = '') {
    const s = h('section', { class: `scr scr-${name} ${extraClass}`.trim(), dataset: { screen: name }, 'aria-hidden': 'true' });
    this.sections[name] = s;
    this.root.append(s);
    return s;
  }

  _apply(name) {
    const from = this._screen;
    if (from === name) return;
    const prevFocus = document.activeElement;
    if (from && this.sections[from] && prevFocus && this.sections[from].contains(prevFocus)) this._lastFocus[from] = prevFocus;
    this._screen = name;
    this.root.dataset.screen = name;
    if (name === 'hud') this.inGame = true;
    else if (!OVERLAYS.has(name)) this.inGame = false;
    for (const k in this.sections) {
      const on = k === name || (k === 'hud' && this.inGame && OVERLAYS.has(name));
      const sec = this.sections[k];
      if (sec.classList.contains('is-active') !== on) {
        sec.classList.toggle('is-active', on);
        sec.setAttribute('aria-hidden', on ? 'false' : 'true');
      }
    }
    this.sections.hud.classList.toggle('is-under', name !== 'hud');
    if (from === 'hud') this.hud.touch.reset();
    if (name === 'loading') this._startTips(); else this._stopTips();
    if (name === 'pause') this._fillPause();
    if (name === 'tracks') this._syncTrackBar();
    markLit(null);
    if (MENUS.has(name)) this._focusDefault(name);
    else if (document.activeElement && this.root.contains(document.activeElement)) document.activeElement.blur();
  }

  _focusDefault(name) {
    const scr = this.sections[name];
    if (!scr) return;
    let el = this._lastFocus[name];
    if (name === 'tracks') el = scr.querySelector('.t-card.is-on') || el;
    if (!el || !scr.contains(el) || !isVisible(el) || el.disabled) el = scr.querySelector('[data-autofocus]');
    if (!el || !isVisible(el) || el.disabled) el = [...scr.querySelectorAll(FOCUSABLE)].find(isVisible);
    if (el) focusEl(el);
  }

  // ---- loading
  _buildLoading() {
    const s = this._section('loading');
    this.$ld = s;
    this.$ldFill = h('i');
    this.$ldPct = h('span', { class: 'ld-pct', text: '0%' });
    this.$ldMsg = h('span', { class: 'ld-msg', text: 'Starting up' });
    this.$tip = h('span', { class: 'tip-t', text: TIPS[this._tipI] });
    s.append(
      h('div', { class: 'rays', 'aria-hidden': 'true' }),
      h('div', { class: 'ld-in' },
        lockup('lockup-xl'),
        h('div', { class: 'ld-bar', role: 'progressbar', 'aria-label': 'Loading' }, this.$ldFill),
        h('div', { class: 'ld-meta' }, this.$ldMsg, this.$ldPct),
        h('p', { class: 'ld-tip' }, h('span', { class: 'tip-k', text: 'Tip' }), this.$tip)),
      bridge(),
      h('p', { class: 'credits', text: CREDITS }));
  }
  _startTips() {
    if (this._tipT) return;
    this._tipT = setInterval(() => {
      this._tipI = (this._tipI + 1) % TIPS.length;
      this.$tip.textContent = TIPS[this._tipI];
      if (!this.reduced && this.$tip.animate) this.$tip.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'ease-out' });
    }, 3800);
  }
  _stopTips() { if (this._tipT) { clearInterval(this._tipT); this._tipT = 0; } }

  // ---- menu
  _buildMenu() {
    const s = this._section('menu');
    const items = [
      ['race', 'Race', 'Six routes on real SF streets', () => this._openTracks('race', 'menu')],
      ['trial', 'Time Trial', 'You, the clock and the hills', () => this._openTracks('trial', 'menu')],
      ['free', 'Free Roam', 'Find landmarks. Hop the rooftops.', () => this._freeRoam()],
      ['garage', 'Garage', 'Eight supercars, any paint', () => this._openGarage('menu')],
      ['radio', 'Radio', 'Bollywood FM or your own songs', () => this._openOverlay('radio')],
      ['settings', 'Settings', 'Graphics, sound, Karl the Fog', () => this._openOverlay('settings')],
      ['controls', 'Controls', 'Keyboard, gamepad, touch', () => this._openOverlay('controls')],
    ];
    const list = h('nav', { class: 'mn-list', 'aria-label': 'Main menu', dataset: { wrap: '' } });
    items.forEach(([id, label, desc, fn], i) => {
      list.append(h('button', { type: 'button', class: 'mi', dataset: { id, ...(i === 0 ? { autofocus: '' } : {}) }, onclick: fn },
        h('span', { class: 'mi-n', text: String(i + 1).padStart(2, '0') }),
        h('span', { class: 'mi-t', text: label }),
        h('span', { class: 'mi-d', text: desc })));
    });
    this.$mnCar = h('span', { class: 'chip-t', text: '' });
    this.$mnCarMake = h('span', { class: 'chip-k', text: 'Your ride' });
    this.$mnSwatch = h('i', { class: 'chip-sw' });
    const np = this._npCard('mn-np');
    s.append(
      h('div', { class: 'mn-scrim', 'aria-hidden': 'true' }),
      h('div', { class: 'rays rays-menu', 'aria-hidden': 'true' }),
      h('div', { class: 'mn-in' },
        h('header', { class: 'mn-head' }, lockup('lockup-md')),
        list),
      h('aside', { class: 'mn-side' },
        h('button', { type: 'button', class: 'chip mn-car', onclick: () => this._openGarage('menu') }, this.$mnSwatch, h('span', { class: 'chip-txt' }, this.$mnCarMake, this.$mnCar)),
        np),
      bridge(),
      h('p', { class: 'credits', text: CREDITS }));
  }

  _npCard(cls, interactive = true) {
    this.$npTitles = this.$npTitles || [];
    this.$npArtists = this.$npArtists || [];
    this.$npStations = this.$npStations || [];
    const t = h('span', { class: 'np-title', text: 'Tuning in…' });
    const a = h('span', { class: 'np-artist', text: '' });
    const st = h('span', { class: 'np-stn', text: 'Bollywood FM' });
    this.$npTitles.push(t); this.$npArtists.push(a); this.$npStations.push(st);
    return h(interactive ? 'button' : 'div', interactive ? { type: 'button', class: 'np-card ' + cls, onclick: () => this._openOverlay('radio') } : { class: 'np-card ' + cls },
      h('span', { class: 'eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')),
      h('span', { class: 'np-col' }, st, t, a));
  }

  // ---- garage
  _buildGarage() {
    const s = this._section('garage');
    this.$gCount = h('span', { class: 'g-count', text: '01 / 08' });
    this.$gMake = h('span', { class: 'g-make' });
    this.$gName = h('h2', { class: 'g-name' });
    this.$gTag = h('p', { class: 'g-tag' });
    this.$gEngine = h('span', { class: 'g-engine' });
    this.$gCar = h('div', { class: 'g-car', tabindex: '0', role: 'group', 'aria-roledescription': 'carousel', 'aria-label': 'Car. Left and right to change', dataset: { autofocus: '' } },
      h('div', { class: 'g-car-top' }, this.$gMake, this.$gCount),
      this.$gName, this.$gTag, this.$gEngine,
      h('span', { class: 'g-hint', 'aria-hidden': 'true' }, h('kbd', { text: '←' }), h('kbd', { text: '→' }), ' change car'));
    this.$gCar._adjust = d => this._garageStep(d);
    this.$gCar._activate = () => this._garageStep(1);
    this.$gStats = {};
    const statsEl = h('div', { class: 'g-stats' });
    for (const [k, label] of [['speed', 'Top speed'], ['accel', 'Acceleration'], ['handling', 'Handling'], ['thrusters', 'Thrusters']]) {
      const bar = h('span', { class: 'bar' });
      for (let i = 0; i < 10; i++) bar.append(h('i'));
      const val = h('b', { class: 'bar-v', text: '0' });
      this.$gStats[k] = { bar, val };
      statsEl.append(h('div', { class: 'g-stat' + (k === 'thrusters' ? ' is-thr' : '') }, h('span', { class: 'bar-l', text: label }), bar, val));
    }
    this.$gSwatches = h('div', { class: 'g-sw', role: 'radiogroup', 'aria-label': 'Paint' });
    this.$gCustom = h('input', { type: 'color', class: 'g-color', 'aria-label': 'Custom paint color' });
    let raf = 0;
    this.$gCustom.addEventListener('input', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; this._garageColor(this.$gCustom.value, false); });
    });
    this.$gCustom.addEventListener('change', () => this._garageColor(this.$gCustom.value, true));
    this.$gCustomWrap = h('label', { class: 'sw sw-custom', title: 'Custom color' }, this.$gCustom, h('span', { text: '+' }));
    this.$gActions = h('div', { class: 'g-actions' });
    this.$gPrimary = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => this._garagePrimary() }, h('span', { text: 'Race' }));
    this.$gFree = h('button', { type: 'button', class: 'btn', onclick: () => this._freeRoam() }, h('span', { text: 'Free Roam' }));
    this.$gActions.append(this.$gPrimary, this.$gFree);

    this.$gStrip = h('div', { class: 'g-strip' });
    s.append(
      h('div', { class: 'g-vignette', 'aria-hidden': 'true' }),
      h('header', { class: 'top' },
        h('button', { type: 'button', class: 'btn-back', 'aria-label': 'Back', onclick: () => this.back() }, h('span', { svg: ICONS.back }), h('span', { text: 'Back' })),
        h('h1', { class: 'top-t' }, h('span', { text: 'Garage' })),
        h('span', { class: 'top-hint', text: 'Drag the car to spin it' })),
      h('div', { class: 'g-nav' },
        h('button', { type: 'button', class: 'g-arrow', 'aria-label': 'Previous car', onclick: () => this._garageStep(-1), svg: ICONS.prev }),
        this.$gStrip,
        h('button', { type: 'button', class: 'g-arrow', 'aria-label': 'Next car', onclick: () => this._garageStep(1), svg: ICONS.next })),
      h('aside', { class: 'g-panel panel' },
        this.$gCar,
        statsEl,
        h('div', { class: 'g-paint' }, h('span', { class: 'lbl', text: 'Paint' }), h('div', { class: 'g-sw-row' }, this.$gSwatches, this.$gCustomWrap)),
        this.$gActions));
  }

  _curCar() { return this.cars[this.gIndex] || null; }

  _renderGarage() {
    const c = this._curCar();
    if (!c) return;
    const n = this.cars.length;
    this.$gCount.textContent = `${String(this.gIndex + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`;
    this.$gMake.textContent = c.make || '';
    this.$gName.textContent = shortName(c);
    this.$gTag.textContent = c.tagline || '';
    this.$gEngine.textContent = ENGINE_LABEL[c.engine] || c.engine || '';
    this.$gEngine.dataset.engine = c.engine || '';
    const st = c.stats || {};
    for (const k in this.$gStats) {
      const v = clamp(+st[k] || 0, 0, 10);
      const { bar, val } = this.$gStats[k];
      const full = Math.floor(v), half = v - full >= 0.5;
      [...bar.children].forEach((seg, i) => { seg.className = i < full ? 'on' : i === full && half ? 'half' : ''; });
      val.textContent = (Math.round(v * 10) / 10).toString();
    }
    const color = (this.car.id === c.id && this.car.color) || this.carColors[c.id] || c.colors[0];
    this.$gSwatches.textContent = '';
    (c.colors || []).forEach((hex, i) => {
      const b = h('button', { type: 'button', class: 'sw', role: 'radio', 'aria-label': `Paint ${i + 1} (${hex})`, title: hex,
        style: { '--sw': hex }, onclick: () => this._garageColor(hex, true) });
      b.dataset.hex = hex.toLowerCase();
      this.$gSwatches.append(b);
    });
    this._markSwatch(color);
    for (const t of this.$gStrip.children) t.classList.toggle('is-on', +t.dataset.i === this.gIndex);
    this.$gPrimary.firstChild.textContent = this._garageReturn === 'tracks' ? 'Use this car' : 'Race';
    this.$gFree.hidden = this._garageReturn === 'tracks';
  }

  _markSwatch(color) {
    const hex = String(color || '').toLowerCase();
    let matched = false;
    for (const b of this.$gSwatches.children) {
      const on = b.dataset.hex === hex;
      matched = matched || on;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    this.$gCustomWrap.classList.toggle('is-on', !matched && !!hex);
    if (/^#[0-9a-f]{6}$/.test(hex)) { this.$gCustom.value = hex; this.$gCustomWrap.style.setProperty('--sw', hex); }
  }

  _garageGo(i) {
    if (!this.cars.length) return;
    this.gIndex = (i + this.cars.length) % this.cars.length;
    const c = this._curCar();
    this.car = { id: c.id, color: this.carColors[c.id] || c.colors[0] };
    this._saveCar();
    this._renderGarage();
    this._renderCarChips();
    if (this._screen === 'garage') this._emit('onGarageCar', c.id, this.car.color);
    if (!this.reduced && this.$gCar.animate) this.$gCar.animate([{ opacity: 0.2, transform: 'translateX(14px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  _garageStep(d) { this._garageGo(this.gIndex + d); }

  _garageColor(hex, commit) {
    const c = this._curCar();
    if (!c || !hex) return;
    this.car = { id: c.id, color: hex };
    this.carColors[c.id] = hex;
    this._markSwatch(hex);
    this._renderCarChips();
    this._emit('onGarageCar', c.id, hex);
    if (commit) this._saveCar();
  }

  _garagePrimary() {
    if (this._garageReturn === 'tracks') this.show('tracks');
    else this._openTracks('race', 'garage');
  }

  _openGarage(from) {
    this._garageReturn = from === 'tracks' ? 'tracks' : 'menu';
    if (from === 'tracks' && this._tracksReturn === 'garage') this._tracksReturn = 'menu'; // no garage<->tracks back loop
    this._renderGarage();
    this.show('garage');
  }

  _saveCar() {
    store.set('sfrr.ui.car', this.car);
    store.set('sfrr.ui.carColors', this.carColors);
  }

  _renderCarChips() {
    const c = this.cars.find(x => x.id === this.car.id) || this._curCar();
    const name = c ? shortName(c) : '—';
    const make = c ? c.make || 'Your ride' : 'Your ride';
    const color = this.car.color || (c && c.colors[0]) || '#ffb320';
    if (this.$mnCar) { this.$mnCar.textContent = name; this.$mnCarMake.textContent = make; this.$mnSwatch.style.background = color; }
    if (this.$tCarName) { this.$tCarName.textContent = name; this.$tCarSw.style.background = color; }
  }

  // ---- tracks
  _buildTracks() {
    const s = this._section('tracks');
    this.$tGrid = h('div', { class: 't-grid' });
    this.$tCards = [];
    this.$tMode = segControl({
      label: 'Mode', cls: 't-mode',
      options: [['race', 'Race'], ['trial', 'Time Trial']],
      get: () => this.mode, set: v => { this.mode = v; this._syncTrackBar(); },
    });
    this.$tLaps = stepper({ label: 'Laps', min: 1, max: 9, get: () => this.laps, set: v => { this.laps = v; } });
    this.$tRivals = stepper({ label: 'Rivals', min: 1, max: 7, get: () => this.settings.rivals, set: v => this._changeSetting('rivals', v) });
    this.$tCarName = h('span', { class: 'chip-t', text: '' });
    this.$tCarSw = h('i', { class: 'chip-sw' });
    this.$tGo = h('button', { type: 'button', class: 'btn btn-primary t-go', onclick: () => this._startRace() }, h('span', { text: 'Start race' }));
    s.append(
      h('div', { class: 't-bg', 'aria-hidden': 'true' }),
      h('header', { class: 'top' },
        h('button', { type: 'button', class: 'btn-back', 'aria-label': 'Back', onclick: () => this.back() }, h('span', { svg: ICONS.back }), h('span', { text: 'Back' })),
        h('h1', { class: 'top-t' }, h('span', { text: 'Choose a route' })),
        this.$tMode.el),
      this.$tGrid,
      h('footer', { class: 't-bar panel' },
        this.$tLaps.el, this.$tRivals.el,
        h('button', { type: 'button', class: 'chip t-car', onclick: () => this._openGarage('tracks') },
          this.$tCarSw, h('span', { class: 'chip-txt' }, h('span', { class: 'chip-k', text: 'Car · change' }), this.$tCarName)),
        this.$tGo));
  }

  _openTracks(mode, from) {
    this.mode = mode === 'trial' ? 'trial' : 'race';
    this._tracksReturn = from === 'garage' ? 'garage' : 'menu';
    this.show('tracks');
  }

  _pickTrack(i, fromUser) {
    if (!this.tracks.length) return;
    const changed = i !== this.trackIdx || !this._trackPicked;
    this.trackIdx = i;
    this._trackPicked = true;
    const t = this.tracks[i];
    if (changed) this.laps = clamp(t.laps || 1, 1, 9);
    this.$tCards.forEach((c, k) => { c.classList.toggle('is-on', k === i); c.setAttribute('aria-pressed', k === i ? 'true' : 'false'); });
    this._syncTrackBar();
    if (fromUser) focusEl(this.$tGo);
  }

  _syncTrackBar() {
    const t = this.tracks[this.trackIdx];
    const trial = this.mode === 'trial';
    this.$tMode.refresh();
    const loop = !!(t && t.loop);
    this.$tLaps.setDisabled(!loop, loop ? null : 'Sprint');
    this.$tLaps.refresh();
    this.$tRivals.setDisabled(trial, trial ? 'Solo' : null);
    this.$tRivals.refresh();
    this.$tGo.firstChild.textContent = trial ? 'Start trial' : 'Start race';
    this.sections.tracks.dataset.mode = this.mode;
    for (const el of this.$tGrid.querySelectorAll('.t-len')) el.textContent = fmtLength(+el.dataset.m, this.settings.units);
  }

  _startRace() {
    const t = this.tracks[this.trackIdx];
    if (!t) return;
    const c = this._curCar();
    const cfg = {
      trackId: t.id, mode: this.mode, carId: this.car.id || (c && c.id), color: this.car.color || (c && c.colors[0]),
      rivals: this.mode === 'trial' ? 0 : this.settings.rivals, laps: t.loop ? this.laps : 1,
    };
    this.lastRace = cfg;
    this.session = { mode: cfg.mode, trackId: t.id, trackName: t.name };
    this.hud.minimap.setRoute(t.path, !!t.loop);
    this.hud.reset();
    this.show('hud');
    this._emit('onStartRace', cfg);
  }

  _freeRoam() {
    const c = this._curCar();
    this.session = { mode: 'free', trackId: null, trackName: 'Free Roam' };
    this.hud.minimap.setRoute(null);
    this.hud.reset();
    this.show('hud');
    this._emit('onFreeRoam', { carId: this.car.id || (c && c.id), color: this.car.color || (c && c.colors[0]) });
  }

  // ---- results
  _buildResults() {
    const s = this._section('results');
    this.$rsKicker = h('span', { class: 'kicker' });
    this.$rsPos = h('div', { class: 'rs-pos' });
    this.$rsSub = h('div', { class: 'rs-sub' });
    this.$rsTime = h('b');
    this.$rsBest = h('b');
    this.$rsScore = h('b');
    this.$rsBody = h('tbody');
    this.$rsTable = h('table', { class: 'rs-table' },
      h('thead', null, h('tr', null, h('th', { text: '#' }), h('th', { text: 'Driver' }), h('th', { class: 'c-car', text: 'Car' }), h('th', { class: 'c-time', text: 'Time' }))),
      this.$rsBody);
    this.$rsNext = h('button', { type: 'button', class: 'btn', onclick: () => this._nextTrack() }, h('span', { text: 'Next track' }));
    this.$rsWrap = h('div', { class: 'rs-wrap panel' },
      h('div', { class: 'rs-hero' }, this.$rsKicker, this.$rsPos, this.$rsSub),
      h('div', { class: 'rs-stats' },
        h('div', null, h('span', { text: 'Time' }), this.$rsTime),
        h('div', null, h('span', { text: 'Best lap' }), this.$rsBest),
        h('div', null, h('span', { text: 'Score' }), this.$rsScore)),
      h('div', { class: 'rs-tablewrap' }, this.$rsTable),
      h('div', { class: 'rs-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', dataset: { autofocus: '' }, onclick: () => this._retry() }, h('span', { text: 'Retry' })),
        this.$rsNext,
        h('button', { type: 'button', class: 'btn', onclick: () => this._quit() }, h('span', { text: 'Menu' }))));
    s.append(h('div', { class: 'rays rays-results', 'aria-hidden': 'true' }), this.$rsWrap);
  }

  _retry() {
    this.hud.reset();
    this.show('hud');
    this._emit('onRestart');
  }

  _nextTrack() {
    if (!this.tracks.length) return;
    let i = this.tracks.findIndex(t => this.lastRace && t.id === this.lastRace.trackId);
    if (i < 0) i = this.trackIdx;
    this._pickTrack((i + 1) % this.tracks.length, false);
    if (this.lastRace) this.mode = this.lastRace.mode;
    this._startRace();
  }

  // ---- pause
  _buildPause() {
    const s = this._section('pause');
    this.$pzTitle = h('h2', { class: 'pz-title', text: '' });
    this.$pzMode = h('span', { class: 'kicker', text: 'Paused' });
    const list = h('nav', { class: 'pz-list', dataset: { wrap: '' } });
    const items = [
      ['Resume', () => this._resume(), true],
      ['Restart', () => { this.hud.reset(); this.show('hud'); this._emit('onRestart'); }],
      ['Radio', () => this._openOverlay('radio')],
      ['Settings', () => this._openOverlay('settings')],
      ['Controls', () => this._openOverlay('controls')],
      ['Quit to menu', () => this._quit()],
    ];
    for (const [label, fn, af] of items) {
      list.append(h('button', { type: 'button', class: 'pi', dataset: af ? { autofocus: '' } : {}, onclick: fn }, h('span', { text: label })));
    }
    s.append(h('div', { class: 'pz-scrim', 'aria-hidden': 'true' }),
      h('div', { class: 'pz-panel panel' }, this.$pzMode, this.$pzTitle, list, this._npCard('pz-np'),
        h('p', { class: 'pz-hint' }, h('kbd', { text: 'Esc' }), ' resume')));
  }

  _fillPause() {
    const s = this.session;
    this.$pzTitle.textContent = s ? s.trackName || (s.mode === 'free' ? 'Free Roam' : '') : '';
    this.$pzMode.textContent = 'Paused' + (s && s.mode === 'trial' ? ' · Time trial' : s && s.mode === 'free' ? ' · Free roam' : '');
  }

  _resume() { this.show('hud'); this._emit('onResume'); }
  _quit() { this.session = null; this.show('menu'); this._emit('onQuit'); }

  _requestPause() {
    if (typeof this.callbacks.onPause === 'function') { this.callbacks.onPause(); return; }
    const opts = { key: 'Escape', code: 'Escape', bubbles: true };
    dispatchEvent(new KeyboardEvent('keydown', opts));
    setTimeout(() => dispatchEvent(new KeyboardEvent('keyup', opts)), 50);
  }

  _openOverlay(name) {
    this._overlayReturn = this._screen === 'pause' ? 'pause' : this.inGame ? 'pause' : 'menu';
    this.show(name);
  }

  // ---- settings
  _buildSettings() {
    const s = this._section('settings');
    const S = () => this.settings;
    const set = k => v => this._changeSetting(k, v);
    const onOff = [[true, 'On'], [false, 'Off']];
    this.$set = [
      ['Graphics', [
        segRow('Quality', 'Shadows, draw distance, traffic', segControl({ label: 'Quality', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], get: () => S().quality, set: set('quality') })),
        segRow('Camera', 'C cycles it while driving', segControl({ label: 'Camera', options: [['chase', 'Chase'], ['far', 'Far'], ['hood', 'Hood']], get: () => S().camera, set: set('camera') })),
        segRow('Speed units', null, segControl({ label: 'Units', options: [['kmh', 'km/h'], ['mph', 'mph']], get: () => S().units, set: set('units') })),
      ]],
      ['City', [
        segRow('Time of day', null, segControl({ label: 'Time of day', cls: 'seg-wrap', options: [['auto', 'Auto'], ['dawn', 'Dawn'], ['day', 'Day'], ['golden', 'Golden'], ['night', 'Night']], get: () => S().timeOfDay, set: set('timeOfDay') })),
        segRow('Karl the Fog', 'SF’s famous marine layer', segControl({ label: 'Karl the Fog', options: onOff, get: () => S().fog, set: set('fog') })),
        segRow('Traffic', null, segControl({ label: 'Traffic', options: onOff, get: () => S().traffic, set: set('traffic') })),
        segRow('Rivals', 'Default grid size', stepper({ label: 'Rivals', min: 1, max: 7, get: () => S().rivals, set: set('rivals') })),
      ]],
      ['Sound', [
        segRow('Master', null, slider({ label: 'Master volume', get: () => S().master, set: set('master') })),
        segRow('Music', null, slider({ label: 'Music volume', get: () => S().music, set: set('music') })),
        segRow('Effects', null, slider({ label: 'Effects volume', get: () => S().sfx, set: set('sfx') })),
      ]],
    ];
    const body = h('div', { class: 'set-body' });
    for (const [title, rows] of this.$set) {
      body.append(h('section', { class: 'set-group' }, h('h3', { class: 'set-h', text: title }), rows.map(r => r.el)));
    }
    this.$setCtl = this.$set.flatMap(([, rows]) => rows.map(r => r.ctl));
    s.append(h('div', { class: 'ov-scrim', 'aria-hidden': 'true' }),
      h('div', { class: 'ov-panel panel set-panel' },
        h('header', { class: 'ov-top' },
          h('button', { type: 'button', class: 'btn-back', 'aria-label': 'Back', onclick: () => this.back() }, h('span', { svg: ICONS.back }), h('span', { text: 'Back' })),
          h('h1', { class: 'top-t' }, h('span', { text: 'Settings' }))),
        body,
        h('footer', { class: 'ov-foot' },
          h('span', { class: 'muted', text: 'Saved automatically on this device' }),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { this.settings = sanitizeSettings(DEFAULT_SETTINGS); this._persistSettings(); } }, h('span', { text: 'Reset defaults' })))));
    if (this.$setCtl[0]) this.$setCtl[0].el.dataset.autofocus = '';
  }

  _changeSetting(key, value) {
    if (this.settings[key] === value) return;
    this.settings = sanitizeSettings({ [key]: value }, this.settings);
    this._persistSettings(key);
  }

  _persistSettings(key) {
    saveSettings(this.settings);
    this._refreshSettings();
    // volume sliders fire continuously while dragging: coalesce to <= ~16 calls/s
    const slow = key === 'master' || key === 'music' || key === 'sfx';
    clearTimeout(this._setT);
    if (slow) {
      const now = performance.now();
      if (now - (this._setLast || 0) > 60) { this._setLast = now; this._emit('onSettings', this.getSettings()); }
      else this._setT = setTimeout(() => { this._setLast = performance.now(); this._emit('onSettings', this.getSettings()); }, 70);
    } else this._emit('onSettings', this.getSettings());
  }

  _refreshSettings() {
    if (this.$setCtl) for (const c of this.$setCtl) c.refresh();
    if (this.$tRivals) { this.$tRivals.refresh(); this._syncTrackBar(); }
  }

  // ---- controls
  _buildControls() {
    const s = this._section('controls');
    const row = (keys, action) => h('li', null, h('span', { class: 'keys' }, keys.map(k => k === '/' ? h('i', { text: '/' }) : h('kbd', { text: k }))), h('span', { class: 'act', text: action }));
    const kb = h('ul', { class: 'ctl-list' },
      row(['W', '/', '↑'], 'Throttle'),
      row(['S', '/', '↓'], 'Brake / reverse'),
      row(['A', 'D', '/', '←', '→'], 'Steer'),
      row(['Space'], 'Handbrake / drift'),
      row(['Shift'], 'Boost thrusters'),
      row(['E'], 'Thruster hop · hold in air to hover'),
      row(['C'], 'Camera'),
      row(['R'], 'Reset to road'),
      row(['H'], 'Headlights'),
      row(['M'], 'Next song'),
      row(['N'], 'Radio station'),
      row(['Esc', '/', 'P'], 'Pause'));
    const gp = h('ul', { class: 'ctl-list' },
      row(['RT'], 'Throttle'),
      row(['LT'], 'Brake / reverse'),
      row(['L-stick'], 'Steer'),
      row(['X'], 'Handbrake / drift'),
      row(['RB', '/', 'B'], 'Boost thrusters'),
      row(['A'], 'Hop · hold to hover'),
      row(['Y'], 'Camera'),
      row(['Start'], 'Pause'),
      row(['D-pad'], 'Menus: move'),
      row(['A'], 'Menus: select'),
      row(['B'], 'Menus: back'));
    const tc = h('ul', { class: 'ctl-list' },
      row(['Left pad'], 'Steer — hold a side or slide'),
      row(['Gas'], 'Throttle'),
      row(['Brake'], 'Brake / reverse'),
      row(['Drift'], 'Handbrake'),
      row(['Boost'], 'Thrusters'),
      row(['Hop'], 'Hop · hold in air to hover'),
      row(['❚❚'], 'Pause'));
    const col = (t, list, cls) => h('section', { class: 'ctl-col ' + cls }, h('h3', { class: 'set-h', text: t }), list);
    s.append(h('div', { class: 'ov-scrim', 'aria-hidden': 'true' }),
      h('div', { class: 'ov-panel panel ctl-panel' },
        h('header', { class: 'ov-top' },
          h('button', { type: 'button', class: 'btn-back', 'aria-label': 'Back', dataset: { autofocus: '' }, onclick: () => this.back() }, h('span', { svg: ICONS.back }), h('span', { text: 'Back' })),
          h('h1', { class: 'top-t' }, h('span', { text: 'Controls' }))),
        h('div', { class: 'ctl-cols' }, col('Keyboard', kb, 'c-kb'), col('Gamepad', gp, 'c-gp'), col('Touch', tc, 'c-tc')),
        h('p', { class: 'ctl-note muted', text: 'Drifting charges thruster fuel. Boost and hover spend it.' })));
  }

  // ---- radio
  _buildRadio() {
    const s = this._section('radio');
    this.$stBtns = STATIONS.map((st, i) => {
      const b = h('button', { type: 'button', class: 'st st-' + st.id, role: 'radio', 'aria-checked': 'false', dataset: { id: st.id, ...(i === 0 ? { autofocus: '' } : {}) },
        onclick: () => this._applyStation(st.id, true) },
        h('span', { class: 'st-freq', lang: st.id === 'bollywood-fm' ? 'hi' : null, text: st.freq }),
        h('span', { class: 'st-col' }, h('span', { class: 'st-name', text: st.name }), h('span', { class: 'st-desc', text: st.desc })),
        h('span', { class: 'st-dot', 'aria-hidden': 'true' }));
      if (st.id === 'my-playlist') { this.$plCount = h('span', { class: 'st-count', text: '' }); b.querySelector('.st-col').append(this.$plCount); }
      return b;
    });
    this.$file = h('input', { type: 'file', accept: 'audio/*', multiple: true, class: 'vh', tabindex: '-1', 'aria-hidden': 'true' });
    this.$file.addEventListener('change', () => {
      const files = this.$file.files;
      if (files && files.length) {
        this.playlistCount += files.length;
        this._emit('onMusicFiles', files);
        this._applyStation('my-playlist', false);
        this.toast(`${files.length} song${files.length > 1 ? 's' : ''} added to My Playlist`, 'music', 2600);
      }
      this.$file.value = '';
    });
    const np = this._npCard('rd-np', false);
    s.append(h('div', { class: 'ov-scrim', 'aria-hidden': 'true' }),
      h('div', { class: 'ov-panel panel rd-panel' },
        h('header', { class: 'ov-top' },
          h('button', { type: 'button', class: 'btn-back', 'aria-label': 'Back', onclick: () => this.back() }, h('span', { svg: ICONS.back }), h('span', { text: 'Back' })),
          h('h1', { class: 'top-t' }, h('span', { text: 'Radio' }))),
        h('div', { class: 'rd-st', role: 'radiogroup', 'aria-label': 'Station' }, this.$stBtns),
        h('div', { class: 'rd-player' }, np,
          h('div', { class: 'rd-skip' },
            h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Previous song', svg: ICONS.skipPrev, onclick: () => this._emit('onPrevTrack') }),
            h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Next song', svg: ICONS.skipNext, onclick: () => this._emit('onNextTrack') }))),
        h('div', { class: 'rd-load' },
          h('button', { type: 'button', class: 'btn btn-load', onclick: () => this.$file.click() }, h('span', { class: 'ic', svg: ICONS.folder }), h('span', { text: 'Load your songs' })),
          this.$file,
          h('p', { class: 'rd-note' }, 'My Playlist plays files only from your own computer. Nothing is uploaded — pick MP3, M4A, OGG or WAV files you own.'))));
  }

  _applyStation(id, user) {
    if (!STATIONS.some(s => s.id === id)) return;
    const changed = id !== this.station;
    this.station = id;
    store.set('sfrr.ui.station', id);
    if (this.$stBtns) for (const b of this.$stBtns) { const on = b.dataset.id === id; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); }
    const name = (STATIONS.find(s => s.id === id) || STATIONS[0]).name;
    if (this.$npStations) for (const el of this.$npStations) el.textContent = name;
    this.root.classList.toggle('radio-off', id === 'off');
    if (this.$plCount) this.$plCount.textContent = this.playlistCount ? `${this.playlistCount} song${this.playlistCount > 1 ? 's' : ''} loaded` : 'No songs loaded yet';
    if (id === 'off' && this.$npTitles) for (const el of this.$npTitles) el.textContent = 'Radio off';
    if (user) this._emit('onRadio', id);
    void changed;
  }

  // ===================================================================== input plumbing

  _bindGlobal() {
    this._onKey = e => {
      if (!this.keyboardNav || !MENUS.has(this._screen)) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      let handled = true;
      switch (e.key) {
        case 'ArrowUp': this.navigate('up'); break;
        case 'ArrowDown': this.navigate('down'); break;
        case 'ArrowLeft': this.navigate('left'); break;
        case 'ArrowRight': this.navigate('right'); break;
        case 'Enter': this.select(); break;
        case ' ': {
          const a = document.activeElement;
          if (a && a._activate) { this._kbd(true); a._activate(); } else handled = false; // native buttons handle Space
          break;
        }
        case 'Escape': case 'Backspace': handled = this.back(); break;
        case 'Tab': this._kbd(true); handled = false; break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    addEventListener('keydown', this._onKey, true);

    const r = this.root;
    r.addEventListener('focusin', e => { if (e.target && e.target !== r) markLit(e.target); });
    r.addEventListener('pointerdown', e => { if (e.pointerType !== 'touch') this._kbd(false); });
    r.addEventListener('mousemove', () => { if (this._kbdOn) this._kbd(false); }, { passive: true });
    r.addEventListener('pointerover', e => {
      if (e.pointerType === 'touch') return;
      const t = e.target.closest && e.target.closest(FOCUSABLE + ', .t-card');
      if (!t || !r.contains(t) || t.closest('.scr-hud')) return;
      const scr = this.sections[this._screen];
      if (!scr || !scr.contains(t)) return;
      if (document.activeElement !== t && !t.matches('input')) { focusEl(t); this._hover(); }
    });
    r.addEventListener('click', e => {
      const t = e.target.closest && e.target.closest('button, [role="button"], label.sw');
      if (t && !t.closest('.tc')) this._click();
    });
  }

  _detectTouch() {
    let auto = false;
    try { auto = matchMedia('(pointer: coarse)').matches || matchMedia('(hover: none)').matches && navigator.maxTouchPoints > 0; } catch { /* ignore */ }
    this._autoTouch = auto;
    this.setTouchMode('auto');
    addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' && !this._autoTouch) { this._autoTouch = true; if (this._touchPref === 'auto') this.setTouchMode('auto'); }
    }, { capture: true, passive: true });
  }

  _kbd(on) {
    if (this._kbdOn === on) return;
    this._kbdOn = on;
    this.root.classList.toggle('is-kbd', on);
  }

  _emit(name, ...args) {
    const f = this.callbacks && this.callbacks[name];
    if (typeof f === 'function') return f(...args);
    return undefined;
  }
  _click() { this._emit('onUIClick'); }
  _hover() {
    const now = performance.now();
    if (now - this._hoverT < 70) return;
    this._hoverT = now;
    this._emit('onUIHover');
  }
}

// ===================================================================== helpers

function shortName(c) {
  const n = String(c.name || c.id || '');
  const m = String(c.make || '');
  return m && n.toLowerCase().startsWith(m.toLowerCase() + ' ') ? n.slice(m.length + 1) : n;
}

function isVisible(el) {
  if (!el || !el.getClientRects().length) return false;
  if (el.closest('[hidden]')) return false;
  return true;
}

let litEl = null;
/** "lit" state as a class: :focus does not match while the window itself is unfocused */
function markLit(el) {
  if (litEl === el) return;
  if (litEl) litEl.classList.remove('is-f');
  litEl = el;
  if (el) el.classList.add('is-f');
}

function focusEl(el) {
  try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  markLit(el);
  if (el.scrollIntoView) {
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* ignore */ }
  }
}

function spatialNext(scope, cur, dir) {
  const r0 = cur.getBoundingClientRect();
  const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
  const vert = dir === 'up' || dir === 'down';
  const sign = dir === 'down' || dir === 'right' ? 1 : -1;
  let best = null, bestScore = Infinity;
  const cands = [...scope.querySelectorAll(FOCUSABLE)].filter(el => el !== cur && !el.disabled && isVisible(el));
  for (const el of cands) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const primary = (vert ? y - cy : x - cx) * sign;
    if (primary <= 2) continue;
    // ignore elements that overlap on the primary axis (same row/column) unless clearly past
    const gap = vert ? (sign > 0 ? r.top - r0.bottom : r0.top - r.bottom) : (sign > 0 ? r.left - r0.right : r0.left - r.right);
    if (gap < -Math.min(r.height, r0.height) * 0.5 && vert) continue;
    if (gap < -Math.min(r.width, r0.width) * 0.5 && !vert) continue;
    const overlap = vert ? r.left < r0.right && r.right > r0.left : r.top < r0.bottom && r.bottom > r0.top;
    // same column/row: prefer the item aligned with our leading edge (first swatch, first card)
    const ortho = overlap ? Math.abs(vert ? r.left - r0.left : r.top - r0.top) * 0.05 : Math.abs(vert ? x - cx : y - cy);
    const score = Math.max(0, gap) + primary * 0.25 + ortho * 2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (!best && vert) {
    const list = cur.closest('[data-wrap]');
    if (list) {
      const items = [...list.querySelectorAll(FOCUSABLE)].filter(isVisible);
      best = sign > 0 ? items[0] : items[items.length - 1];
      if (best === cur) best = null;
    }
  }
  return best;
}

function lockup(cls) {
  return h('div', { class: 'lockup ' + cls, role: 'img', 'aria-label': 'SF Roadster Rush' },
    h('span', { class: 'lk-k', 'aria-hidden': 'true', text: '37.7880° N · 122.4075° W' }),
    h('span', { class: 'lk-1', 'aria-hidden': 'true', text: 'SF Roadster' }),
    h('span', { class: 'lk-2', 'aria-hidden': 'true' }, h('span', { class: 'lk-lines' }), h('span', { class: 'lk-rush', text: 'Rush' })),
    h('span', { class: 'lk-hi', lang: 'hi', 'aria-hidden': 'true', text: 'शहर की रफ़्तार' }));
}

function bridge() {
  // Golden Gate-ish main cable + suspenders, drawn as a low-contrast silhouette
  let sus = '';
  for (let i = 1; i < 60; i++) {
    const x = i * 20;
    // two spans hung from towers at x=300 and x=900
    let y;
    if (x < 300) y = 40 + Math.pow((300 - x) / 300, 2) * 60;
    else if (x < 900) { const u = (x - 600) / 300; y = 40 + (1 - u * u) * 70; }
    else y = 40 + Math.pow((x - 900) / 300, 2) * 60;
    if (Math.abs(x - 300) < 10 || Math.abs(x - 900) < 10) continue;
    sus += `M${x} ${y.toFixed(1)}V150`;
  }
  const svg = `<svg viewBox="0 0 1200 160" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <path class="br-sus" d="${sus}"/>
    <path class="br-cable" d="M0 100 Q150 75 300 40 Q600 110 900 40 Q1050 75 1200 100"/>
    <path class="br-tower" d="M292 18h16v132h-16zM892 18h16v132h-16zM288 52h24v5h-24zM888 52h24v5h-24zM288 92h24v5h-24zM888 92h24v5h-24z"/>
    <path class="br-deck" d="M0 148H1200V156H0z"/>
  </svg>`;
  return h('div', { class: 'bridge', 'aria-hidden': 'true', svg });
}

function drawRoute(cv, t) {
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  // street-grid texture
  g.strokeStyle = 'rgba(159,176,204,0.07)';
  g.lineWidth = 1;
  for (let x = 0; x < W; x += 28) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
  for (let y = 0; y < H; y += 28) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke(); }
  const p = t.path;
  if (!p || p.length < 2) return;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const q of p) { if (q[0] < minX) minX = q[0]; if (q[0] > maxX) maxX = q[0]; if (q[1] < minZ) minZ = q[1]; if (q[1] > maxZ) maxZ = q[1]; }
  const pad = 26;
  const sc = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxZ - minZ));
  const ox = (W - (maxX - minX) * sc) / 2, oz = (H - (maxZ - minZ) * sc) / 2;
  const X = x => ox + (x - minX) * sc, Z = z => oz + (z - minZ) * sc;
  const trace = () => {
    g.beginPath();
    g.moveTo(X(p[0][0]), Z(p[0][1]));
    for (let i = 1; i < p.length; i++) g.lineTo(X(p[i][0]), Z(p[i][1]));
    if (t.loop) g.closePath();
  };
  g.lineJoin = 'round'; g.lineCap = 'round';
  trace(); g.strokeStyle = 'rgba(255,90,31,0.28)'; g.lineWidth = 14; g.stroke();
  trace(); g.strokeStyle = '#ffb320'; g.lineWidth = 4.5; g.stroke();
  // checkpoints
  g.fillStyle = 'rgba(53,224,255,0.9)';
  let lx = -1e9, lz = -1e9;
  for (const c of t.checkpoints || []) {
    const x = X(c.x), z = Z(c.z);
    if ((x - lx) ** 2 + (z - lz) ** 2 < 22 * 22) continue; // keep dense gate sets readable
    lx = x; lz = z;
    g.beginPath(); g.arc(x, z, 3.4, 0, Math.PI * 2); g.fill();
  }
  // start (checkered square) + finish
  const sx = X(p[0][0]), sz = Z(p[0][1]);
  g.fillStyle = '#060a14'; g.fillRect(sx - 9, sz - 9, 18, 18);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { g.fillStyle = (i + j) % 2 ? '#060a14' : '#ffffff'; g.fillRect(sx - 7.5 + i * 5, sz - 7.5 + j * 5, 5, 5); }
  if (!t.loop) {
    const e = p[p.length - 1];
    g.beginPath(); g.arc(X(e[0]), Z(e[1]), 8, 0, Math.PI * 2);
    g.fillStyle = '#ff2d7a'; g.fill();
    g.lineWidth = 3; g.strokeStyle = '#060a14'; g.stroke();
  }
}

// ---- form controls: each returns { el (focusable), refresh(), ctl } and sets el._adjust/_activate

function segControl({ label, options, get, set, cls = '' }) {
  const btns = options.map(([v, text]) => {
    const b = h('button', { type: 'button', tabindex: '-1', role: 'radio', 'aria-checked': 'false', text });
    b.addEventListener('click', () => { set(v); api.refresh(); });
    return b;
  });
  const el = h('div', { class: ('seg ' + cls).trim(), tabindex: '0', role: 'radiogroup', 'aria-label': label }, btns);
  const idx = () => Math.max(0, options.findIndex(o => o[0] === get()));
  el._adjust = d => { const i = clamp(idx() + d, 0, options.length - 1); if (i !== idx()) { set(options[i][0]); api.refresh(); } };
  el._activate = () => { set(options[(idx() + 1) % options.length][0]); api.refresh(); };
  const api = {
    el,
    refresh() { const i = idx(); btns.forEach((b, k) => { b.classList.toggle('is-on', k === i); b.setAttribute('aria-checked', k === i ? 'true' : 'false'); }); },
  };
  api.ctl = api;
  api.refresh();
  return api;
}

function stepper({ label, min, max, get, set }) {
  const val = h('b', { class: 'stp-v' });
  const dec = h('button', { type: 'button', tabindex: '-1', 'aria-label': 'Fewer ' + label.toLowerCase(), svg: ICONS.prev });
  const inc = h('button', { type: 'button', tabindex: '-1', 'aria-label': 'More ' + label.toLowerCase(), svg: ICONS.next });
  const el = h('div', { class: 'stp', tabindex: '0', role: 'spinbutton', 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max },
    h('span', { class: 'stp-l', text: label }), h('span', { class: 'stp-in' }, dec, val, inc));
  let disabled = false, disText = null;
  const step = d => { if (disabled) return; const v = clamp(get() + d, min, max); if (v !== get()) { set(v); api.refresh(); } };
  dec.addEventListener('click', () => step(-1));
  inc.addEventListener('click', () => step(1));
  el._adjust = step;
  el._activate = () => { if (disabled) return; set(get() >= max ? min : get() + 1); api.refresh(); };
  const api = {
    el,
    refresh() {
      const v = get();
      val.textContent = disabled && disText ? disText : String(v);
      el.setAttribute('aria-valuenow', v);
      dec.disabled = disabled || v <= min;
      inc.disabled = disabled || v >= max;
    },
    setDisabled(d, text) { disabled = !!d; disText = text; el.classList.toggle('is-disabled', disabled); el.setAttribute('aria-disabled', disabled ? 'true' : 'false'); },
  };
  api.ctl = api;
  api.refresh();
  return api;
}

function slider({ label, get, set }) {
  const fill = h('i', { class: 'sld-fill' });
  const thumb = h('i', { class: 'sld-thumb' });
  const track = h('span', { class: 'sld-track' }, fill, thumb);
  const val = h('b', { class: 'sld-v' });
  const el = h('div', { class: 'sld', tabindex: '0', role: 'slider', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100 }, track, val);
  const setV = v => { set(clamp(Math.round(v * 100) / 100, 0, 1)); api.refresh(); };
  el._adjust = d => setV(get() + d * 0.05);
  let rect = null;
  const fromX = x => setV((x - rect.left) / Math.max(1, rect.width));
  track.addEventListener('pointerdown', e => {
    rect = track.getBoundingClientRect();
    try { track.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    fromX(e.clientX);
    e.preventDefault();
  });
  track.addEventListener('pointermove', e => { if (rect && e.buttons) fromX(e.clientX); });
  track.addEventListener('pointerup', () => { rect = null; });
  track.addEventListener('pointercancel', () => { rect = null; });
  const api = {
    el,
    refresh() {
      const v = clamp(get(), 0, 1);
      fill.style.transform = `scaleX(${v})`;
      thumb.style.left = v * 100 + '%';
      val.textContent = Math.round(v * 100);
      el.setAttribute('aria-valuenow', Math.round(v * 100));
    },
  };
  api.ctl = api;
  api.refresh();
  return api;
}

function segRow(title, hint, ctl) {
  const el = h('div', { class: 'set-row' },
    h('div', { class: 'set-l' }, h('span', { class: 'set-t', text: title }), hint ? h('span', { class: 'set-d', text: hint }) : null),
    ctl.el);
  return { el, ctl };
}
