// SF Roadster Rush — Settings object (CONTRACTS.md: UI section) + persistence.
import { store, clamp } from './dom.js';

export const SETTINGS_KEY = 'sfrr.ui.settings';

export const DEFAULT_SETTINGS = Object.freeze({
  quality: 'high', units: 'kmh', master: 0.9, music: 0.7, sfx: 0.9, camera: 'chase',
  traffic: true, timeOfDay: 'auto', fog: true, rivals: 5,
});

const ENUMS = {
  quality: ['low', 'medium', 'high'],
  units: ['kmh', 'mph'],
  camera: ['chase', 'far', 'hood'],
  timeOfDay: ['auto', 'dawn', 'day', 'golden', 'night'],
};

/** Returns a complete, valid Settings object: base merged with patch, bad values dropped. */
export function sanitizeSettings(patch, base = DEFAULT_SETTINGS) {
  const out = { ...DEFAULT_SETTINGS, ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const k in ENUMS) if (ENUMS[k].includes(patch[k])) out[k] = patch[k];
  for (const k of ['master', 'music', 'sfx']) {
    const v = Number(patch[k]);
    if (patch[k] != null && isFinite(v)) out[k] = clamp(Math.round(v * 100) / 100, 0, 1);
  }
  for (const k of ['traffic', 'fog']) if (typeof patch[k] === 'boolean') out[k] = patch[k];
  if (patch.rivals != null && isFinite(Number(patch.rivals))) out.rivals = clamp(Math.round(Number(patch.rivals)), 1, 7);
  return out;
}

export function loadSettings() { return sanitizeSettings(store.get(SETTINGS_KEY, null)); }
export function saveSettings(s) { store.set(SETTINGS_KEY, s); }
