// SF Roadster Rush — in-race HUD.
//
// Cheap updates: every field is cached; the DOM is written only when the (rounded) value
// changes. No layout reads in update(). The tach/fuel arcs are SVG paths with
// pathLength=100 driven by stroke-dashoffset; the nav arrow is a transform.
//
// h.speed is taken as ALREADY in display units (h.units: 'kmh'|'mph'), matching src/main.js.
// h.nextDir: radians, positive = clockwise on screen. h.nextDist: meters.
// h.checkpoint: index of the next gate (= gates passed this lap).
import { h, fmtTime, ordinalSuffix, fmtDist, fmtInt, clamp, prefersReducedMotion, ICONS } from './dom.js';
import { Minimap } from './minimap.js';
import { TouchControls } from './touch.js';

const ARC_OUT = 'M39.19 160.81 A86 86 0 1 1 160.81 160.81';
const ARC_IN = 'M52.62 147.38 A67 67 0 1 1 147.38 147.38';

function tickPath() {
  let d = '';
  for (let i = 0; i <= 20; i++) {
    const a = ((135 + i * 13.5) * Math.PI) / 180;
    const major = i % 2 === 0;
    const r0 = major ? 93 : 95, r1 = 99;
    d += `M${(100 + Math.cos(a) * r0).toFixed(2)} ${(100 + Math.sin(a) * r0).toFixed(2)}L${(100 + Math.cos(a) * r1).toFixed(2)} ${(100 + Math.sin(a) * r1).toFixed(2)}`;
  }
  return d;
}

const SPEEDO_SVG = `<svg class="sp-svg" viewBox="0 0 200 200" aria-hidden="true">
  <path class="sp-ticks" d="${tickPath()}"/>
  <path class="sp-track" d="${ARC_OUT}" pathLength="100"/>
  <path class="sp-red" d="${ARC_OUT}" pathLength="100"/>
  <path class="sp-rpm" d="${ARC_OUT}" pathLength="100"/>
  <path class="sp-ftrack" d="${ARC_IN}" pathLength="100"/>
  <path class="sp-fuel" d="${ARC_IN}" pathLength="100"/>
</svg>`;

export class HUD {
  constructor(section, ui) {
    this.ui = ui;
    this.el = section;
    this.c = Object.create(null);
    this.reduced = prefersReducedMotion();
    this._countT = 0;
    this._bankT = 0;

    // ---- top-left: position / lap / checkpoints / landmarks / score
    this.$posN = h('span', { class: 'pos-n', text: '1' });
    this.$posS = h('span', { class: 'pos-s', text: 'st' });
    this.$posOf = h('span', { class: 'pos-of', text: '/6' });
    this.$lap = h('b', { text: '1/3' });
    this.$cp = h('b', { text: '0/0' });
    this.$lm = h('b', { text: '0/0' });
    this.$score = h('b', { text: '0' });
    const stat = (cls, label, val) => h('div', { class: 'hud-stat ' + cls }, h('span', { text: label }), val);
    this.$pauseBtn = h('button', { class: 'hud-pausebtn', type: 'button', 'aria-label': 'Pause', svg: ICONS.pause });
    this.$pauseBtn.addEventListener('click', () => ui._requestPause());
    const tl = h('div', { class: 'hud-tl' },
      this.$pauseBtn,
      h('div', { class: 'hud-tl-in' },
        h('div', { class: 'hud-pos' }, this.$posN, this.$posS, this.$posOf),
        h('div', { class: 'hud-stats' },
          stat('st-lap', 'Lap', this.$lap),
          stat('st-cp', 'Gate', this.$cp),
          stat('st-lm', 'Landmarks', this.$lm),
          stat('st-score', 'Score', this.$score))));

    // ---- top-center: timers + next-gate arrow
    this.$time = h('div', { class: 'hud-time', text: '0:00.00' });
    this.$lapT = h('b', { text: '-:--.--' });
    this.$best = h('b', { text: '-:--.--' });
    this.$arrow = h('div', { class: 'nav-arrow', svg: ICONS.arrow });
    this.$dist = h('div', { class: 'nav-dist', text: '' });
    this.$nav = h('div', { class: 'hud-nav' }, h('div', { class: 'nav-ring' }, this.$arrow), this.$dist);
    const tc = h('div', { class: 'hud-tc' },
      h('div', { class: 'hud-timer' },
        this.$time,
        h('div', { class: 'hud-laps' }, h('span', null, 'Lap ', this.$lapT), h('span', { class: 'best' }, 'Best ', this.$best))),
      this.$nav);

    // ---- top-right: minimap
    this.$map = h('canvas', { class: 'hud-map-cv', 'aria-hidden': 'true' });
    const tr = h('div', { class: 'hud-tr' }, h('div', { class: 'hud-map' }, this.$map, h('div', { class: 'map-rim' })));
    this.minimap = new Minimap(this.$map);

    // ---- center: message + countdown + drift
    this.$msg = h('div', { class: 'hud-msg', role: 'status', 'aria-live': 'polite' });
    this.$count = h('div', { class: 'hud-count', 'aria-live': 'assertive' });
    this.$driftN = h('div', { class: 'drift-n', text: '0' });
    this.$drift = h('div', { class: 'hud-drift' }, h('div', { class: 'drift-k', text: 'Drift' }), this.$driftN);
    this.$bank = h('div', { class: 'hud-bank' });

    // ---- bottom-right: speedo cluster
    this.$speed = h('div', { class: 'sp-num', text: '0' });
    this.$unit = h('div', { class: 'sp-unit', text: 'KM/H' });
    this.$gear = h('div', { class: 'sp-gear', text: 'N' });
    this.$fuelPct = h('b', { text: '100' });
    this.$fuelLbl = h('span', { class: 'sp-flbl', text: 'Thrust' });
    this.$speedo = h('div', { class: 'hud-speedo', svg: SPEEDO_SVG });
    this.$speedo.append(h('div', { class: 'sp-read' },
      h('div', { class: 'sp-gearwrap' }, h('span', { text: 'Gear' }), this.$gear),
      this.$speed, this.$unit,
      h('div', { class: 'sp-fuelrow' }, this.$fuelLbl, this.$fuelPct, h('i', { text: '%' }))));
    this.$rpmArc = this.$speedo.querySelector('.sp-rpm');
    this.$fuelArc = this.$speedo.querySelector('.sp-fuel');
    const br = h('div', { class: 'hud-br' }, this.$speedo);

    // ---- bottom-left: now playing
    this.$npSt = h('span', { class: 'np-st', text: 'Bollywood FM' });
    this.$npT = h('span', { class: 'np-t', text: '' });
    this.$np = h('div', { class: 'hud-np', 'aria-live': 'polite' },
      h('span', { class: 'eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')),
      h('span', { class: 'np-txt' }, this.$npSt, this.$npT));

    this.el.append(tl, tc, tr, this.$msg, this.$count, this.$drift, this.$bank, br, this.$np);
    this.touch = new TouchControls(this.el);
    this.reset();
  }

  reset() {
    this.c = Object.create(null);
    this.$msg.className = 'hud-msg';
    this.$msg.textContent = '';
    this.$drift.classList.remove('on');
    this.el.classList.remove('is-boost', 'is-hover', 'is-redline');
  }

  _txt(key, el, v) {
    if (this.c[key] !== v) { this.c[key] = v; el.textContent = v; }
  }
  _cls(key, el, name, on) {
    on = !!on;
    if (this.c[key] !== on) { this.c[key] = on; el.classList.toggle(name, on); }
  }

  update(hd) {
    if (!hd) return;
    const c = this.c, el = this.el;
    if (hd.mode == null && hd.speed == null) { this.reset(); return; } // updateHUD({}) = new session
    const mode = hd.mode || 'race';
    if (c.mode !== mode) { c.mode = mode; el.dataset.mode = mode; }
    const units = hd.units || this.ui.settings.units;
    if (c.units !== units) { c.units = units; this.$unit.textContent = units === 'mph' ? 'MPH' : 'KM/H'; }

    // speed (display units) + gear + rpm
    const spd = Math.abs(+hd.speed || 0);
    this.minimap.speed = units === 'mph' ? spd * 1.609 : spd;
    this._txt('sp', this.$speed, String(Math.round(spd)));
    const g = hd.gear;
    const gs = g === 'R' || g === -1 || (typeof g === 'number' && g < 0) ? 'R' : g === 0 || g === 'N' || g == null ? 'N' : String(g);
    if (c.gear !== gs) { c.gear = gs; this.$gear.textContent = gs; this.$gear.classList.toggle('is-r', gs === 'R'); }
    const rpm = Math.round(clamp(+hd.rpm || 0, 0, 1) * 200) / 2; // 0..100 in 0.5 steps
    if (c.rpm !== rpm) {
      c.rpm = rpm;
      this.$rpmArc.style.strokeDashoffset = String(100 - rpm);
      this._cls('red', el, 'is-redline', rpm > 88);
    }

    // thruster fuel
    const fuel = Math.round(clamp(hd.boost == null ? 1 : +hd.boost, 0, 1) * 100);
    if (c.fuel !== fuel) {
      c.fuel = fuel;
      this.$fuelArc.style.strokeDashoffset = String(100 - fuel);
      this.$fuelPct.textContent = String(fuel);
      this._cls('low', el, 'is-fuel-low', fuel < 15);
    }
    this._cls('boost', el, 'is-boost', hd.boosting);
    this._cls('hover', el, 'is-hover', hd.hovering);
    const fl = hd.hovering ? 'Hover' : hd.boosting ? 'Boost' : 'Thrust';
    this._txt('fl', this.$fuelLbl, fl);

    if (mode !== 'free') {
      const laps = hd.laps | 0 || 1;
      this._txt('lap', this.$lap, `${clamp(hd.lap | 0 || 1, 1, laps)}/${laps}`);
      const cps = hd.checkpoints | 0;
      this._txt('cp', this.$cp, cps ? `${clamp(hd.checkpoint | 0, 0, cps)}/${cps}` : '–');
      const pos = hd.position | 0;
      if (c.pos !== pos) {
        c.pos = pos;
        this.$posN.textContent = pos ? String(pos) : '–';
        this.$posS.textContent = pos ? ordinalSuffix(pos) : '';
        el.classList.toggle('is-p1', pos === 1);
      }
      this._txt('of', this.$posOf, '/' + (hd.racers | 0 || 1));
      this._txt('rt', this.$time, fmtTime(hd.raceTime || 0, 2));
      this._txt('lt', this.$lapT, fmtTime(hd.lapTime, 2));
      this._txt('bl', this.$best, fmtTime(hd.bestLap, 2));
      // next-gate arrow
      if (hd.nextDir != null && isFinite(hd.nextDir)) {
        const deg = Math.round((hd.nextDir * 180) / Math.PI);
        if (c.dir !== deg) { c.dir = deg; this.$arrow.style.transform = `rotate(${deg}deg)`; }
        this._cls('navOn', this.$nav, 'on', true);
      } else this._cls('navOn', this.$nav, 'on', false);
      this._txt('nd', this.$dist, fmtDist(hd.nextDist, units));
    } else {
      this._txt('lm', this.$lm, `${hd.landmarksFound | 0}/${hd.landmarksTotal | 0}`);
      this._cls('navOn', this.$nav, 'on', false);
    }
    this._txt('sc', this.$score, fmtInt(hd.score));

    // drift combo
    const drift = Math.round(+hd.drift || 0);
    if (c.drift !== drift) {
      const prev = c.drift | 0;
      c.drift = drift;
      if (drift > 0) {
        this.$driftN.textContent = fmtInt(drift);
        if (prev <= 0) this.$drift.classList.add('on');
        this.$drift.classList.toggle('is-big', drift >= 1000);
      } else if (prev > 0) {
        this.$drift.classList.remove('on', 'is-big');
      }
    }

    // center message
    const msg = hd.message || '';
    if (c.msg !== msg) {
      c.msg = msg;
      this.$msg.textContent = msg;
      const kind = !msg ? '' : /WRONG|SPLASH|RESPAWN/i.test(msg) ? 'warn' : /BEST|FINAL/i.test(msg) ? 'good' : /^\+/.test(msg) ? 'bonus' : 'info';
      this.$msg.className = 'hud-msg' + (msg ? ' on k-' + kind : '');
      if (msg && !this.reduced && this.$msg.animate) {
        this.$msg.animate([{ transform: 'translateX(-50%) scale(1.25) skewX(-8deg)', opacity: 0 }, { transform: 'translateX(-50%) scale(1) skewX(-8deg)', opacity: 1 }],
          { duration: 220, easing: 'cubic-bezier(.2,.9,.25,1)' });
      }
    }
  }

  countdown(n) {
    const el = this.$count;
    clearTimeout(this._countT);
    if (n == null || n < 0) { el.className = 'hud-count'; el.textContent = ''; return; }
    const go = n <= 0;
    el.textContent = go ? 'GO' : String(n);
    el.className = 'hud-count on ' + (go ? 'is-go' : 'is-n');
    if (!this.reduced && el.animate) {
      el.animate(go
        ? [{ transform: 'translate(-50%,-50%) scale(.6) skewX(-10deg)', opacity: 0 }, { transform: 'translate(-50%,-50%) scale(1.08) skewX(-10deg)', opacity: 1, offset: 0.18 }, { transform: 'translate(-50%,-50%) scale(1) skewX(-10deg)', opacity: 1, offset: 0.7 }, { transform: 'translate(-50%,-50%) scale(1.4) skewX(-10deg)', opacity: 0 }]
        : [{ transform: 'translate(-50%,-50%) scale(1.7)', opacity: 0 }, { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.22 }, { transform: 'translate(-50%,-50%) scale(.94)', opacity: 1, offset: 0.8 }, { transform: 'translate(-50%,-50%) scale(.9)', opacity: 0 }],
        { duration: go ? 1100 : 960, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    }
    this._countT = setTimeout(() => { el.className = 'hud-count'; }, go ? 1100 : 990);
  }

  /** transient center callout driven by the UI (h.message has priority while non-empty) */
  flash(text, kind = 'info', ms = 1400) {
    const b = this.$bank;
    clearTimeout(this._bankT);
    b.textContent = text;
    b.className = 'hud-bank on k-' + kind;
    this._bankT = setTimeout(() => { b.className = 'hud-bank'; }, ms);
  }

  setNowPlaying(info) {
    const st = info && info.station;
    const stName = st === 'my-playlist' ? 'My Playlist' : st === 'off' ? 'Radio off' : 'Bollywood FM';
    this.$npSt.textContent = stName;
    const t = info && info.title ? info.title + (info.artist ? ' — ' + info.artist : '') : '';
    this.$npT.textContent = t;
    this.$np.classList.toggle('is-off', st === 'off' || !t);
    if (!this.reduced && this.$np.animate && t) {
      this.$np.animate([{ boxShadow: '0 0 0 1px rgba(255,46,136,.9), 0 0 24px rgba(255,46,136,.45)' }, { boxShadow: '0 0 0 1px rgba(255,46,136,0), 0 0 0 rgba(255,46,136,0)' }], { duration: 1600, easing: 'ease-out' });
    }
  }
}
