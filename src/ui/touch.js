// SF Roadster Rush — on-screen touch controls (multi-touch via Pointer Events).
//
// Steering zone (bottom-left): press anywhere in it; steer = horizontal offset from the
// zone's center (so holding the far left/right edge = full lock, sliding = analog).
// Buttons (bottom-right): GAS, BRAKE, BOOST, HOP (hold in air = hover), DRIFT.
// getInput() returns one reused object shaped like the contract's input object.
import { h, clamp } from './dom.js';

export class TouchControls {
  constructor(parent) {
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, jump: false, jumpPressed: false };
    this._jumpEdge = false;
    this._steerId = null;
    this._zone = null;

    this.knob = h('div', { class: 'tc-knob' });
    this.steerEl = h('div', { class: 'tc-steer', 'aria-label': 'Steering: hold left or right, or slide' },
      h('span', { class: 'tc-steer-l', 'aria-hidden': 'true' }),
      h('span', { class: 'tc-steer-r', 'aria-hidden': 'true' }),
      h('div', { class: 'tc-rail' }, this.knob));

    const btn = (key, label, cls) => {
      const b = h('div', { class: 'tc-btn ' + cls, role: 'button', 'aria-label': label, dataset: { k: key } }, h('span', { text: label }));
      this._bindButton(b, key);
      return b;
    };
    this.btns = h('div', { class: 'tc-btns' },
      btn('boost', 'Boost', 'tc-boost'),
      btn('jump', 'Hop', 'tc-hop'),
      btn('handbrake', 'Drift', 'tc-drift'),
      btn('brake', 'Brake', 'tc-brake'),
      btn('throttle', 'Gas', 'tc-gas'));

    this.el = h('div', { class: 'tc' }, this.steerEl, this.btns);
    parent.append(this.el);
    this._bindSteer();
    this.el.addEventListener('contextmenu', e => e.preventDefault());
  }

  _bindButton(b, key) {
    const down = e => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      b.classList.add('is-down');
      this._set(key, true);
      if (key === 'jump') { this._jumpEdge = true; try { navigator.vibrate && navigator.vibrate(8); } catch { /* ignore */ } }
    };
    const up = e => {
      b.classList.remove('is-down');
      this._set(key, false);
      try { b.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', () => { if (b.classList.contains('is-down')) { b.classList.remove('is-down'); this._set(key, false); } });
  }

  _set(key, on) {
    const i = this.input;
    if (key === 'throttle') i.throttle = on ? 1 : 0;
    else if (key === 'brake') i.brake = on ? 1 : 0;
    else i[key] = on;
  }

  _bindSteer() {
    const z = this.steerEl;
    const move = e => {
      const r = this._zone;
      if (!r) return;
      const half = r.width * 0.5;
      const dx = e.clientX - (r.left + half);
      const v = clamp(dx / (half * 0.72), -1, 1);
      this.input.steer = Math.abs(v) < 0.06 ? 0 : v;
      this.knob.style.transform = `translateX(${(v * 100).toFixed(1)}%)`;
      z.classList.toggle('is-l', v < -0.2);
      z.classList.toggle('is-r', v > 0.2);
    };
    const end = e => {
      if (e.pointerId !== this._steerId) return;
      this._steerId = null;
      this._zone = null;
      this.input.steer = 0;
      this.knob.style.transform = '';
      z.classList.remove('is-on', 'is-l', 'is-r');
    };
    z.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (this._steerId != null) return;
      this._steerId = e.pointerId;
      this._zone = z.getBoundingClientRect(); // one layout read per touch, not per frame
      try { z.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      z.classList.add('is-on');
      move(e);
    });
    z.addEventListener('pointermove', e => { if (e.pointerId === this._steerId) move(e); });
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
  }

  /** Release everything (e.g. when the HUD hides mid-press). */
  reset() {
    const i = this.input;
    i.throttle = 0; i.brake = 0; i.steer = 0; i.handbrake = false; i.boost = false; i.jump = false; i.jumpPressed = false;
    this._jumpEdge = false;
    this._steerId = null;
    this.knob.style.transform = '';
    this.steerEl.classList.remove('is-on', 'is-l', 'is-r');
    for (const b of this.btns.children) b.classList.remove('is-down');
  }

  getInput() {
    const i = this.input;
    i.jumpPressed = this._jumpEdge;
    this._jumpEdge = false;
    return i;
  }
}
