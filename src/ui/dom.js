// SF Roadster Rush — small DOM + formatting helpers shared by the UI modules.
// No framework: h() builds elements, text always goes through textContent
// (car names, song titles etc. are never parsed as HTML).

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'svg') el.innerHTML = v; // trusted, static markup authored in this folder only
      else if (k === 'style' && typeof v === 'object') { for (const sk in v) { if (sk.startsWith('--')) el.style.setProperty(sk, v[sk]); else el.style[sk] = v[sk]; } }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendKids(el, children);
  return el;
}

function appendKids(el, kids) {
  for (const c of kids) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendKids(el, c);
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** m:ss.mmm (decimals 3) or m:ss.cc (decimals 2). null/NaN/Infinity -> dashes. */
export function fmtTime(sec, decimals = 3) {
  if (sec == null || !isFinite(sec) || sec < 0) return decimals === 2 ? '-:--.--' : '-:--.---';
  const unit = decimals === 2 ? 10 : 1;
  const t = Math.floor((sec * 1000) / unit); // in ms or cs
  const per = 1000 / unit;
  const totalS = Math.floor(t / per);
  const frac = t - totalS * per;
  const m = Math.floor(totalS / 60);
  const s = totalS - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s + '.' + String(frac).padStart(decimals, '0');
}

export function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (n % 10) { case 1: return 'st'; case 2: return 'nd'; case 3: return 'rd'; default: return 'th'; }
}

/** meters -> short readable distance in the chosen units */
export function fmtDist(m, units) {
  if (m == null || !isFinite(m)) return '';
  if (units === 'mph') {
    const ft = m * 3.28084;
    return ft < 1000 ? Math.round(ft / 10) * 10 + ' ft' : (m / 1609.344).toFixed(1) + ' mi';
  }
  return m < 1000 ? Math.round(m / 5) * 5 + ' m' : (m / 1000).toFixed(1) + ' km';
}

export function fmtLength(m, units) {
  if (!isFinite(m)) return '';
  return units === 'mph' ? (m / 1609.344).toFixed(1) + ' mi' : (m / 1000).toFixed(1) + ' km';
}

export function fmtInt(n) {
  n = Math.round(n || 0);
  return n.toLocaleString('en-US');
}

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked / private mode */ }
  },
};

export const prefersReducedMotion = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

export const ICONS = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4l-8 8 8 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="square"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4l8 8-8 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="square"/></svg>',
  skipPrev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M19 5l-10 7 10 7z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  skipNext: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14M5 5l10 7-10 7z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h7l2 2h9v11H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 11v6M9 14h6" stroke="currentColor" stroke-width="2"/></svg>',
  arrow: '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 L34 31 L20 24 L6 31 Z" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="2.6"/></svg>',
  flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4h13l-2.5 4L18 12H5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};
