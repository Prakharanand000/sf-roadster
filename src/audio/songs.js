// Bollywood FM song book + deterministic composer (pure data, no Web Audio here).
//
// Every song is composed from a seed: raag scale + characteristic phrases (pakad),
// a taal (keherwa / dadra / teental / bhangra chaal), filmi chord progressions built from
// the raag's own scale, and motif-based melodies (A A' B cadence; hook H1 H2 H1 H2').
// Verses and choruses repeat the same composed melody each time they come back, so songs
// have recognisable hooks instead of random noodling. Breaks have taan runs + a tihai.
// All titles / artists are invented; no real songs, singers or recordings are used.

import { rng } from './util.js';

export const RAAGS = {
  yaman: {
    name: 'Yaman', scale: [0, 2, 4, 6, 7, 9, 11],
    pakad: [[-1, 1, 2, 1, 0], [-1, 1, 2, 3, 5, 6, 7], [2, 3, 5, 6, 7, 6, 5, 4, 2]],
    progV: [[0, 1, 4, 0], [0, 5, 1, 4]], progC: [[0, 4, 5, 1], [5, 1, 4, 0]],
  },
  bhairavi: {
    name: 'Bhairavi', scale: [0, 1, 3, 5, 7, 8, 10],
    pakad: [[3, 2, 1, 0], [-2, -1, 0, 1, 2, 3, 2, 1, 0], [4, 5, 4, 3, 2, 1, 0]],
    progV: [[0, 6, 5, 6], [0, 3, 6, 0]], progC: [[5, 6, 0, 0], [0, 6, 5, 1]],
  },
  kafi: {
    name: 'Kafi', scale: [0, 2, 3, 5, 7, 9, 10],
    pakad: [[1, 2, 1, 3, 3, 4], [4, 3, 2, 1, 0], [0, 1, 2, 3, 4, 6, 7]],
    progV: [[0, 3, 6, 0], [0, 6, 3, 0]], progC: [[3, 6, 0, 0], [2, 3, 6, 0]],
  },
  khamaj: {
    name: 'Khamaj', scale: [0, 2, 4, 5, 7, 9, 10],
    pakad: [[2, 3, 4, 5, 6, 5, 4, 3, 2], [0, 2, 3, 4, 5, 7], [7, 6, 5, 4, 3, 2]],
    progV: [[0, 6, 3, 0], [0, 3, 4, 3]], progC: [[3, 0, 6, 0], [0, 5, 3, 6]],
  },
  bilawal: {
    name: 'Bilawal', scale: [0, 2, 4, 5, 7, 9, 11],
    pakad: [[2, 1, 2, 4, 5, 6, 7], [7, 6, 5, 4, 3, 2, 1, 0], [4, 5, 4, 3, 2]],
    progV: [[0, 4, 5, 3], [0, 3, 4, 3]], progC: [[5, 3, 0, 4], [0, 4, 5, 3]],
  },
  pilu: {
    name: 'Pilu', scale: [0, 2, 3, 5, 7, 8, 11],
    pakad: [[-1, 0, 2, 1, 0], [4, 5, 4, 3, 2], [0, 2, 3, 4, 5, 4, 2, 1, 0]],
    progV: [[0, 3, 4, 0], [0, 5, 3, 4]], progC: [[5, 3, 4, 0], [3, 4, 0, 0]],
  },
};

// stepsPerBar, beats, stepsPerBeat, theka (tabla bols), dhol chaal, claps, chutki
export const TAALS = {
  keherwa: {
    steps: 16, beats: 4, spb: 4,
    theka: [[[0, 'dha'], [2, 'ge'], [4, 'na'], [6, 'ti'], [8, 'na'], [10, 'ke'], [12, 'dhi'], [14, 'na']]],
    thekaB: [[[0, 'dha'], [3, 'ge'], [4, 'na'], [6, 'ti'], [7, 'na'], [8, 'ta'], [10, 'ke'], [11, 'dhi'], [12, 'na'], [14, 'dhi'], [15, 'na']]],
    dagga: [0, 6, 8, 11], tilli: [2, 4, 10, 12, 14, 15],
    clap: [4, 12], chutki: [2, 6, 10, 14], hat: [2, 6, 10, 14], kick: [0, 4, 8, 12],
    tanpura: [0, 4, 8, 12],
  },
  teental: {
    steps: 16, beats: 4, spb: 4,
    theka: [
      [[0, 'dha'], [2, 'dhin'], [4, 'dhin'], [6, 'dha'], [8, 'dha'], [10, 'dhin'], [12, 'dhin'], [14, 'dha']],
      [[0, 'dha'], [2, 'tin'], [4, 'tin'], [6, 'ta'], [8, 'ta'], [10, 'dhin'], [12, 'dhin'], [14, 'dha']],
    ],
    thekaB: [
      [[0, 'dha'], [2, 'dhin'], [3, 'ge'], [4, 'dhin'], [6, 'dha'], [7, 'ti'], [8, 'dha'], [10, 'dhin'], [12, 'dhin'], [13, 'na'], [14, 'dha']],
      [[0, 'dha'], [2, 'tin'], [4, 'tin'], [5, 'na'], [6, 'ta'], [8, 'ta'], [10, 'dhin'], [11, 'ge'], [12, 'dhin'], [14, 'dha'], [15, 'ghe']],
    ],
    dagga: [0, 6, 8, 14], tilli: [2, 4, 10, 12, 13],
    clap: [4, 12], chutki: [2, 6, 10, 14], hat: [2, 6, 10, 14], kick: [0, 4, 8, 12],
    tanpura: [0, 4, 8, 12],
  },
  dadra: {
    steps: 12, beats: 2, spb: 6,
    theka: [[[0, 'dha'], [2, 'dhi'], [4, 'na'], [6, 'dha'], [8, 'ti'], [10, 'na']]],
    thekaB: [[[0, 'dha'], [2, 'dhi'], [3, 'ge'], [4, 'na'], [6, 'dha'], [8, 'tin'], [9, 'ke'], [10, 'na'], [11, 'ti']]],
    dagga: [0, 6, 9], tilli: [2, 4, 8, 10],
    clap: [6], chutki: [3, 9], hat: [3, 9], kick: [0, 6],
    tanpura: [0, 3, 6, 9],
  },
  bhangra: {
    steps: 12, beats: 4, spb: 3,
    theka: [[[0, 'dha'], [3, 'na'], [5, 'ge'], [6, 'dha'], [9, 'na'], [11, 'ke']]],
    thekaB: [[[0, 'dha'], [2, 'ti'], [3, 'na'], [5, 'ghe'], [6, 'dha'], [8, 'ti'], [9, 'na'], [11, 'ke']]],
    dagga: [0, 5, 6], tilli: [2, 4, 8, 10, 11],
    clap: [3, 9], chutki: [2, 8], hat: [2, 5, 8, 11], kick: [0, 3, 6, 9],
    tanpura: [0, 3, 6, 9],
  },
};

const RHYTHMS = {
  16: {
    verse: [
      [[0, 4], [4, 2], [6, 2], [8, 4], [12, 4]],
      [[0, 2], [2, 2], [4, 4], [8, 2], [10, 2], [12, 4]],
      [[0, 6], [6, 2], [8, 4], [12, 2], [14, 2]],
      [[2, 2], [4, 2], [6, 4], [10, 2], [12, 4]],
      [[0, 4], [6, 2], [8, 2], [10, 2], [12, 4]],
      [[0, 2], [2, 2], [4, 2], [6, 2], [8, 6]],
    ],
    hook: [
      [[0, 3], [3, 3], [6, 2], [8, 3], [11, 3], [14, 2]],
      [[0, 2], [2, 1], [3, 3], [6, 2], [8, 4], [12, 4]],
      [[0, 3], [3, 3], [6, 4], [12, 2], [14, 2]],
      [[0, 2], [2, 2], [4, 2], [6, 2], [8, 3], [11, 5]],
      [[0, 4], [4, 2], [6, 2], [8, 2], [10, 2], [12, 4]],
    ],
    cad: [[[0, 4], [4, 4], [8, 8]], [[0, 2], [2, 2], [4, 12]], [[0, 3], [3, 3], [6, 10]], [[0, 2], [2, 2], [4, 4], [8, 8]]],
  },
  12: {
    verse: [
      [[0, 3], [3, 3], [6, 3], [9, 3]],
      [[0, 2], [2, 1], [3, 3], [6, 2], [8, 1], [9, 3]],
      [[0, 6], [6, 3], [9, 3]],
      [[0, 3], [3, 2], [5, 1], [6, 6]],
      [[0, 2], [2, 2], [4, 2], [6, 6]],
    ],
    hook: [
      [[0, 2], [2, 1], [3, 2], [5, 1], [6, 3], [9, 3]],
      [[0, 3], [3, 3], [6, 2], [8, 1], [9, 3]],
      [[0, 1], [1, 2], [3, 3], [6, 1], [7, 2], [9, 3]],
      [[0, 2], [2, 2], [4, 2], [6, 3], [9, 3]],
    ],
    cad: [[[0, 3], [3, 3], [6, 6]], [[0, 2], [2, 2], [4, 8]], [[0, 3], [3, 9]]],
  },
};

export const SONGS = [
  { id: 'golden-gate-pe-dil', title: 'Golden Gate Pe Dil', artist: 'Pooja & The Painted Ladies',
    raag: 'yaman', taal: 'keherwa', bpm: 94, tonic: 61, seed: 101, form: 'classic',
    inst: { alaap: 'bansuri', verse: 'bansuri', hook: 'shehnai', taan: 'sitar', answer: 'santoor' } },
  { id: 'karl-ki-dhundh', title: 'Karl Ki Dhundh', artist: 'The Fog Horn Gharana',
    raag: 'bhairavi', taal: 'dadra', bpm: 66, tonic: 62, seed: 202, form: 'classic',
    inst: { alaap: 'sitar', verse: 'bansuri', hook: 'bansuri', taan: 'sitar', answer: 'sitar' } },
  { id: 'lombard-lehra', title: 'Lombard Lehra', artist: 'Ustad Hyde Street Khan',
    raag: 'kafi', taal: 'teental', bpm: 112, tonic: 60, seed: 303, form: 'classic',
    inst: { alaap: 'sitar', verse: 'santoor', hook: 'sitar', taan: 'santoor', answer: 'santoor' } },
  { id: 'bay-bridge-bhangra', title: 'Bay Bridge Bhangra', artist: 'Dhol Dynamics feat. MC Muni',
    raag: 'bilawal', taal: 'bhangra', bpm: 100, tonic: 62, seed: 404, form: 'dance',
    inst: { alaap: 'shehnai', verse: 'tumbi', hook: 'shehnai', taan: 'tumbi', answer: 'tumbi', drop: 'synth' } },
  { id: 'mission-masala', title: 'Mission Masala', artist: 'Valencia Street Vibes',
    raag: 'pilu', taal: 'keherwa', bpm: 108, tonic: 60, seed: 505, form: 'dance',
    inst: { alaap: 'shehnai', verse: 'sitar', hook: 'shehnai', taan: 'santoor', answer: 'sitar', drop: 'synth' } },
  { id: 'nob-hill-nights', title: 'Nob Hill Nights', artist: 'Raja Roadster & The Cable Car Kaka',
    raag: 'khamaj', taal: 'keherwa', bpm: 86, tonic: 63, seed: 606, form: 'classic',
    inst: { alaap: 'sitar', verse: 'sitar', hook: 'bansuri', taan: 'sitar', answer: 'santoor' } },
  { id: 'roadster-rani', title: 'Roadster Rani', artist: 'DJ Thruster Tiwari',
    raag: 'kafi', taal: 'bhangra', bpm: 106, tonic: 61, seed: 707, form: 'dance',
    inst: { alaap: 'bansuri', verse: 'santoor', hook: 'synth', taan: 'tumbi', answer: 'tumbi', drop: 'synth' } },
  { id: 'embarcadero-express', title: 'Embarcadero Express', artist: 'Ferry Building Philharmonic',
    raag: 'bilawal', taal: 'keherwa', bpm: 122, tonic: 60, seed: 808, form: 'dance',
    inst: { alaap: 'santoor', verse: 'santoor', hook: 'shehnai', taan: 'santoor', answer: 'sitar', drop: 'synth' } },
  { id: 'painted-ladies-pyaar', title: 'Painted Ladies Pyaar', artist: 'Alamo Square Allstars',
    raag: 'khamaj', taal: 'dadra', bpm: 72, tonic: 62, seed: 909, form: 'classic',
    inst: { alaap: 'bansuri', verse: 'bansuri', hook: 'sitar', taan: 'santoor', answer: 'santoor' } },
  { id: 'twin-peaks-tadka', title: 'Twin Peaks Tadka', artist: 'Sutro Tower Sound System',
    raag: 'bhairavi', taal: 'bhangra', bpm: 98, tonic: 60, seed: 1010, form: 'dance',
    inst: { alaap: 'shehnai', verse: 'tumbi', hook: 'shehnai', taan: 'sitar', answer: 'tumbi', drop: 'synth' } },
  { id: 'cable-car-qawwali', title: 'Cable Car Qawwali', artist: 'Powell Street Party Wale',
    raag: 'pilu', taal: 'keherwa', bpm: 92, tonic: 61, seed: 1111, form: 'classic', qawwali: true,
    inst: { alaap: 'shehnai', verse: 'shehnai', hook: 'shehnai', taan: 'sitar', answer: 'sitar' } },
  { id: 'karl-the-fog-remix', title: 'Fog Horn Phir Se (Karl Remix)', artist: 'Lil Muni & The Muni Metro Massive',
    raag: 'yaman', taal: 'teental', bpm: 118, tonic: 62, seed: 1212, form: 'dance',
    inst: { alaap: 'sitar', verse: 'sitar', hook: 'synth', taan: 'santoor', answer: 'santoor', drop: 'synth' } },
];

export const STATION_NAME = 'Bollywood FM 104.8';

// ---------------------------------------------------------------------------

export function degToSemi(scale, deg) {
  const o = Math.floor(deg / 7);
  const i = ((deg % 7) + 7) % 7;
  return scale[i] + 12 * o;
}

function chordTones(chord) { return [chord % 7, (chord + 2) % 7, (chord + 4) % 7]; }
function isChordTone(chord, deg) {
  const m = ((deg % 7) + 7) % 7;
  return chordTones(chord).includes(m);
}
function nearestChordTone(chord, target, lo, hi) {
  let best = target, bd = 1e9;
  for (let d = lo - 2; d <= hi + 2; d++) {
    if (!isChordTone(chord, d)) continue;
    const dist = Math.abs(d - target) + (d < lo || d > hi ? 3 : 0);
    if (dist < bd) { bd = dist; best = d; }
  }
  return best;
}
function pickW(r, items, weights) {
  let s = 0; for (const w of weights) s += w;
  let x = r() * s;
  for (let i = 0; i < items.length; i++) { x -= weights[i]; if (x <= 0) return items[i]; }
  return items[items.length - 1];
}
function pick(r, arr) { return arr[Math.floor(r() * arr.length) % arr.length]; }

function makeMotif(r, steps, kind) {
  const pool = RHYTHMS[steps][kind === 'hook' ? 'hook' : 'verse'];
  const rhythm = pick(r, pool);
  const contour = [0];
  const arch = kind === 'hook';
  for (let i = 1; i < rhythm.length; i++) {
    const up = arch ? (i < rhythm.length / 2 ? 0.68 : 0.32) : 0.5;
    const mag = pickW(r, [0, 1, 2, 3, 4], [1.2, 4, 2, 0.8, 0.4]);
    contour.push(mag === 0 ? 0 : (r() < up ? mag : -mag));
  }
  return { rhythm, contour, anchor: pickW(r, [0, 1, 2], [2, 1.2, 1.4]) };
}

function realize(motif, chord, prevDeg, lo, hi, steps, spb) {
  const tones = chordTones(chord);
  const anchorClass = tones[motif.anchor];
  // start: the anchor chord tone nearest to the previous note
  let start = prevDeg, bd = 1e9;
  for (let d = lo; d <= hi; d++) {
    if (((d % 7) + 7) % 7 !== anchorClass) continue;
    const dist = Math.abs(d - prevDeg);
    if (dist < bd) { bd = dist; start = d; }
  }
  const out = [];
  let deg = start;
  for (let i = 0; i < motif.rhythm.length; i++) {
    const [s, d] = motif.rhythm[i];
    if (i > 0) deg += motif.contour[i];
    if (deg > hi) deg = hi - (deg - hi);
    if (deg < lo) deg = lo + (lo - deg);
    const strong = s % (spb * 2) === 0 || d >= spb * 2;
    if (strong) deg = nearestChordTone(chord, deg, lo, hi);
    out.push({ s, d, deg });
  }
  return out;
}

function cadence(r, steps, prevDeg, lo, hi, endOn) {
  const rh = pick(r, RHYTHMS[steps].cad);
  // target Sa (0 / 7) or Pa (4) nearest to prevDeg
  const cands = endOn === 'pa' ? [-3, 4, 11] : [0, 7];
  let target = cands[0];
  for (const c of cands) if (c >= lo && c <= hi && Math.abs(c - prevDeg) < Math.abs(target - prevDeg)) target = c;
  const n = rh.length;
  const out = [];
  const fromAbove = prevDeg > target;
  for (let i = 0; i < n; i++) {
    const k = n - 1 - i; // steps away from target
    const deg = target + (fromAbove ? k : (k === 1 ? -1 : k > 1 ? k - 2 : 0));
    out.push({ s: rh[i][0], d: rh[i][1], deg });
  }
  return out;
}

function answerFill(mel, chord, nextChord, steps, spb, lo, hi) {
  let end = 0;
  for (const n of mel) end = Math.max(end, n.s + n.d);
  const start = Math.max(end, steps - spb);
  if (end > steps - spb || start >= steps) return [];
  // short descending run to the next chord's tone
  const target = nearestChordTone(nextChord, (mel[mel.length - 1] || { deg: 4 }).deg + 2, lo, hi);
  const out = [];
  const step = spb === 3 || spb === 6 ? 1 : 1;
  const count = Math.min(4, Math.floor((steps - start) / step));
  for (let i = 0; i < count; i++) {
    out.push({ s: start + i * step, d: step, deg: Math.max(lo, Math.min(hi, target + (count - 1 - i))) });
  }
  return out;
}

function taanBar(r, steps, bi, lo, hi) {
  const out = [];
  const patterns = [
    (i) => Math.floor(i / 4) + (i % 4),                  // 0123 1234 2345 ...
    (i) => [0, 1, 2, 1][i % 4] + Math.floor(i / 4),      // 0121 1232 ...
    (i) => 7 - (Math.floor(i / 4) + (i % 4)),            // descending groups
    (i) => (i < steps / 2 ? i : steps - i) % 9,          // straight up then down
  ];
  const f = patterns[(bi + Math.floor(r() * 2)) % patterns.length];
  for (let i = 0; i < steps; i++) {
    let d = f(i);
    if (d > hi) d = hi; if (d < lo) d = lo;
    out.push({ s: i, d: 1, deg: d });
  }
  return out;
}

function tihai(steps, phraseDegs) {
  // 3 repetitions landing on the next bar's sam
  const L = steps === 16 ? 4 : 2, G = steps === 16 ? 2 : 3;
  const out = [];
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < L; i++) {
      out.push({ s: k * (L + G) + i, d: i === L - 1 ? G || 1 : 1, deg: phraseDegs[i % phraseDegs.length] });
    }
  }
  return out;
}

function alaap(r, raag, bars, steps) {
  // free, slow phrases from the pakad with long notes + meend
  const total = bars * steps;
  const out = [];
  let s = 0;
  let pi = Math.floor(r() * raag.pakad.length);
  while (s < total - steps * 0.75) {
    const ph = raag.pakad[pi % raag.pakad.length]; pi++;
    for (let i = 0; i < ph.length && s < total - steps * 0.5; i++) {
      const d = pickW(r, [2, 3, 4, 6, 8], [1, 2, 3, 2, 1]);
      out.push({ s, d, deg: ph[i], orn: i > 0 && r() < 0.55 ? 'meend' : null });
      s += d;
    }
    s += pickW(r, [2, 4], [1, 1]);
  }
  // land on Sa, held until the verse
  if (s < total) out.push({ s, d: total - s, deg: 0, orn: 'meend' });
  return out;
}

function buildForm(def, taal) {
  const barDur = (60 / def.bpm) * taal.beats;
  const x = barDur < 2 ? 2 : 1; // short (6/8) bars -> twice as many phrases
  let f;
  if (def.form === 'dance') {
    f = [['intro', 1], ['verse', 2 * x], ['chorus', 2 * x], ['build', 0.5], ['drop', 2], ['break', 1],
      ['verse', 1 * x], ['chorus', 2 * x], ['build', 0.5], ['drop', 2], ['outro', 1]];
  } else {
    f = [['intro', 1], ['verse', 2 * x], ['chorus', 2 * x], ['break', 1], ['verse', 2 * x], ['chorus', 2 * x],
      ['break', 1 * x], ['chorus', 2 * x], ['outro', 1]];
  }
  const secs = () => f.reduce((a, [, p]) => a + p * 4, 0) * barDur;
  let guard = 0;
  while (secs() < 160 && guard++ < 6) {
    const at = f.length - 1;
    if (guard % 2) f.splice(at, 0, ['break', 1], ['chorus', 2]);
    else f.splice(at, 0, ['verse', 1 * x], ['chorus', 1 * x]);
  }
  while (secs() > 235 && f.length > 5) {
    // drop the second-to-last non-essential section
    const idx = f.findIndex(([n], i) => i > 3 && (n === 'break' || n === 'verse'));
    if (idx < 0) break;
    f.splice(idx, 1);
  }
  return { form: f, barDur };
}

/**
 * Compose a whole song -> { def, raag, taal, barDur, stepDur, bars: [...] }.
 * bar = { sec, si (section index), bis (bar in section), len (section bars), chord, nextChord,
 *         mel: [{s,d,deg,orn,inst}], ans: [...], first, last, phraseBar }
 */
export function composeSong(def) {
  const raag = RAAGS[def.raag] || RAAGS.yaman;
  const taal = TAALS[def.taal] || TAALS.keherwa;
  const r = rng(def.seed || 1);
  const steps = taal.steps, spb = taal.spb;
  const { form, barDur } = buildForm(def, taal);
  const stepDur = (60 / def.bpm) / spb;
  const lo = -3, hi = 10;

  // motifs (fixed per song so sections recur identically)
  const mA = makeMotif(r, steps, 'verse');
  const mB = makeMotif(r, steps, 'verse');
  const mB2 = makeMotif(r, steps, 'verse');
  const h1 = makeMotif(r, steps, 'hook');
  const h2 = makeMotif(r, steps, 'hook');
  const verseOrn = r();

  const sectionCache = {};
  function composeSection(name, phrases) {
    const key = name + ':' + phrases;
    if (sectionCache[key]) return sectionCache[key];
    const nb = Math.max(1, Math.round(phrases * 4));
    const bars = [];
    let prev = name === 'chorus' || name === 'drop' ? 4 : 2;
    for (let b = 0; b < nb; b++) {
      const ph = Math.floor(b / 4), pb = b % 4;
      let prog;
      if (name === 'chorus' || name === 'drop' || name === 'break' || name === 'build') prog = raag.progC[ph % 2];
      else if (name === 'intro') prog = [raag.progV[0][0], raag.progV[0][0], raag.progV[0][1], raag.progV[0][3]];
      else prog = raag.progV[ph % 2];
      const chord = prog[pb];
      const nextChord = pb < 3 ? prog[pb + 1] : (raag.progV[0][0]);
      let mel = [];
      if (name === 'verse' || name === 'outro') {
        if (name === 'outro' && b === nb - 1) mel = [{ s: 0, d: steps * 2, deg: 0, orn: 'meend' }];
        else if (pb === 3) mel = cadence(r, steps, prev, lo, hi, ph % 2 ? 'sa' : 'pa');
        else {
          const m = pb === 2 ? (ph % 2 ? mB2 : mB) : mA;
          mel = realize(m, chord, prev, lo, 7, steps, spb);
        }
      } else if (name === 'chorus' || name === 'drop' || name === 'build') {
        if (name === 'build') {
          mel = realize(h1, chord, prev, lo, hi, steps, spb).map((n) => ({ ...n, deg: n.deg + b * 2 }));
        } else if (pb === 3 && ph % 2 === 1) {
          mel = cadence(r, steps, prev, lo, hi, 'sa');
        } else {
          mel = realize(pb % 2 === 0 ? h1 : h2, chord, prev, 0, hi, steps, spb);
        }
      } else if (name === 'break') {
        mel = b === nb - 1 ? tihai(steps, [4, 3, 2, 1]) : taanBar(r, steps, b, lo, hi);
      }
      if (mel.length) prev = mel[mel.length - 1].deg;
      bars.push({ chord, nextChord, mel, pb });
    }
    if (name === 'intro') {
      const al = alaap(r, raag, nb, steps);
      for (const bar of bars) bar.mel = [];
      for (const n of al) {
        const bi = Math.min(nb - 1, Math.floor(n.s / steps));
        bars[bi].mel.push({ ...n, s: n.s - bi * steps });
      }
    }
    sectionCache[key] = bars;
    return bars;
  }

  const out = [];
  let si = 0;
  for (const [name, phrases] of form) {
    const sbars = composeSection(name, phrases);
    const instName = name === 'intro' ? def.inst.alaap
      : name === 'verse' ? def.inst.verse
        : name === 'chorus' ? def.inst.hook
          : name === 'break' ? def.inst.taan
            : name === 'drop' || name === 'build' ? (def.inst.drop || def.inst.hook)
              : def.inst.hook;
    for (let b = 0; b < sbars.length; b++) {
      const sb = sbars[b];
      const mel = sb.mel.map((n) => ({ ...n, inst: instName }));
      // ornaments: meend / kan / gamak (deterministic per song)
      for (let i = 0; i < mel.length; i++) {
        const n = mel[i];
        if (n.orn) continue;
        const h = ((n.s * 7 + n.deg * 13 + b * 5 + si * 3) % 17) / 17;
        if (n.d >= 2 && h < 0.18 + verseOrn * 0.15) n.orn = 'meend';
        else if (n.d >= 2 && h > 0.86) n.orn = 'kan';
        else if (n.d >= 6 && h > 0.6 && instName === 'shehnai') n.orn = 'gamak';
      }
      let ans = [];
      if ((name === 'verse' || name === 'chorus') && (sb.pb === 1 || sb.pb === 3) && def.inst.answer) {
        ans = answerFill(sb.mel, sb.chord, sb.nextChord, steps, spb, 0, 9).map((n) => ({ ...n, inst: def.inst.answer }));
      }
      out.push({
        sec: name, si, bis: b, len: sbars.length, chord: sb.chord, nextChord: sb.nextChord,
        mel, ans, pb: sb.pb, first: b === 0, last: b === sbars.length - 1,
      });
    }
    si++;
  }
  // next-bar chord continuity for bass approach notes
  for (let i = 0; i < out.length; i++) out[i].nextChord = i + 1 < out.length ? out[i + 1].chord : 0;

  // legato ties for mono leads (next note of the same instrument starts where this ends)
  let prevNote = null, prevAbs = 0;
  for (let i = 0; i < out.length; i++) {
    for (const n of out[i].mel) {
      const abs = i * steps + n.s;
      if (prevNote && prevNote.inst === n.inst && Math.abs(prevAbs + prevNote.d - abs) < 0.01) {
        prevNote.tieNext = true; n.legato = true;
      }
      n.prevDeg = prevNote && prevNote.inst === n.inst ? prevNote.deg : null;
      prevNote = n; prevAbs = abs;
    }
  }

  const totalSec = out.length * barDur;
  return { def, raag, taal, barDur, stepDur, steps, bars: out, totalSec, form };
}
