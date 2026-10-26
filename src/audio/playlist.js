// "My Playlist": the player's own audio files (picked from their computer) played via
// object URLs -> <audio> -> MediaElementSource -> music bus. Nothing is uploaded or
// fetched from other hosts. Two alternating <audio> elements allow crossfades.
// Titles come from ID3v2 (TIT2/TPE1), ID3v1, or the filename ("Artist - Title.mp3").

const AUDIO_EXT = /\.(mp3|m4a|aac|mp4|ogg|oga|opus|wav|flac|webm|weba)$/i;

function cleanName(name) {
  let base = name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  base = base.replace(/^\d{1,3}\s*[-.)]\s*/, ''); // "01 - " track numbers
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: '', title: base || name };
}

function decodeText(bytes, enc) {
  try {
    let label = 'latin1';
    if (enc === 1) label = 'utf-16';
    else if (enc === 2) label = 'utf-16be';
    else if (enc === 3) label = 'utf-8';
    return new TextDecoder(label).decode(bytes).replace(/\u0000+$/g, '').replace(/\u0000/g, ' ').trim();
  } catch (e) { return ''; }
}

/** Cheap ID3 reader: only the first ~256 KB (+ last 128 bytes for ID3v1). */
export async function readTags(file) {
  const out = {};
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head.length === 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      const ver = head[3];
      const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
      const len = Math.min(size, 256 * 1024);
      const b = new Uint8Array(await file.slice(10, 10 + len).arrayBuffer());
      let p = 0;
      if (head[5] & 0x40 && ver >= 3) { // extended header
        const ext = ver === 4
          ? ((b[0] & 0x7f) << 21) | ((b[1] & 0x7f) << 14) | ((b[2] & 0x7f) << 7) | (b[3] & 0x7f)
          : ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) + 4;
        p = ext;
      }
      const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
      while (p + hdr < b.length) {
        const id = String.fromCharCode(...b.subarray(p, p + idLen));
        if (!/^[A-Z0-9]+$/.test(id)) break;
        let fs;
        if (ver === 2) fs = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5];
        else if (ver === 4) fs = ((b[p + 4] & 0x7f) << 21) | ((b[p + 5] & 0x7f) << 14) | ((b[p + 6] & 0x7f) << 7) | (b[p + 7] & 0x7f);
        else fs = ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]) >>> 0;
        if (fs <= 0 || p + hdr + fs > b.length) break;
        const body = b.subarray(p + hdr, p + hdr + fs);
        if (id === 'TIT2' || id === 'TT2') out.title = decodeText(body.subarray(1), body[0]);
        else if (id === 'TPE1' || id === 'TP1') out.artist = decodeText(body.subarray(1), body[0]);
        if (out.title && out.artist) break;
        p += hdr + fs;
      }
    }
    if ((!out.title || !out.artist) && file.size > 128) {
      const t = new Uint8Array(await file.slice(file.size - 128).arrayBuffer());
      if (t[0] === 0x54 && t[1] === 0x41 && t[2] === 0x47) {
        if (!out.title) out.title = decodeText(t.subarray(3, 33), 0);
        if (!out.artist) out.artist = decodeText(t.subarray(33, 63), 0);
      }
    }
  } catch (e) { /* tags are optional */ }
  return out;
}

export class UserPlaylist {
  constructor(ctx, out) {
    this.ctx = ctx; this.out = out;
    this.tracks = [];      // { url, name, title, artist, file }
    this.order = [];
    this.pos = -1;
    this.active = false;
    this.onTrackChange = null;
    this.els = null;
    this.cur = 0;          // which element is current
    this.fails = 0;
    this.shuffle = true;
  }

  get size() { return this.tracks.length; }

  _ensureEls() {
    if (this.els) return true;
    if (typeof Audio === 'undefined' || !this.ctx.createMediaElementSource) return false;
    this.els = [0, 1].map(() => {
      const el = new Audio();
      el.preload = 'auto';
      const src = this.ctx.createMediaElementSource(el);
      const g = this.ctx.createGain(); g.gain.value = 0;
      src.connect(g); g.connect(this.out);
      const slot = { el, src, g };
      el.addEventListener('ended', () => { if (this.active && this.els[this.cur] === slot) this.next(); });
      el.addEventListener('error', () => {
        if (!this.active || this.els[this.cur] !== slot) return;
        this.fails++;
        if (this.fails < Math.max(3, this.tracks.length)) this.next(); else this.stop();
      });
      el.addEventListener('playing', () => { this.fails = 0; });
      return slot;
    });
    return true;
  }

  /** Adds files; returns the number of playable files added. */
  add(fileList) {
    const files = Array.from(fileList || []);
    let added = 0;
    for (const f of files) {
      if (!f || !(f.type && f.type.startsWith('audio/')) && !AUDIO_EXT.test(f.name || '')) continue;
      let url;
      try { url = URL.createObjectURL(f); } catch (e) { continue; }
      const nm = cleanName(f.name || 'Track');
      const tr = { url, name: f.name, title: nm.title, artist: nm.artist, file: f };
      this.tracks.push(tr);
      added++;
      readTags(f).then((tags) => {
        if (tags.title) tr.title = tags.title;
        if (tags.artist) tr.artist = tags.artist;
        if (this.active && this.order[this.pos] === this.tracks.indexOf(tr)) this._announce();
      });
    }
    if (added) this._reshuffle(true);
    return added;
  }

  clear() {
    this.stop();
    for (const t of this.tracks) { try { URL.revokeObjectURL(t.url); } catch (e) { /* */ } }
    this.tracks = []; this.order = []; this.pos = -1;
  }

  _reshuffle(keepCurrent) {
    const cur = this.pos >= 0 ? this.order[this.pos] : -1;
    const n = this.tracks.length;
    this.order = [...Array(n).keys()];
    if (this.shuffle) {
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this.order[i], this.order[j]] = [this.order[j], this.order[i]]; }
    }
    if (keepCurrent && cur >= 0) {
      const k = this.order.indexOf(cur);
      if (k > 0) { this.order.splice(k, 1); this.order.unshift(cur); }
      this.pos = 0;
    } else this.pos = -1;
  }

  info() {
    const tr = this.tracks[this.order[this.pos]];
    if (!tr) return { title: 'My Playlist is empty', artist: 'Load your own songs in Settings', station: 'my-playlist' };
    return { title: tr.title, artist: tr.artist || 'My Playlist', station: 'my-playlist' };
  }

  _announce() { if (this.onTrackChange) { try { this.onTrackChange(this.info()); } catch (e) { /* */ } } }

  play() {
    this.active = true;
    if (!this.tracks.length) { this._announce(); return; }
    if (this.pos < 0) this.pos = 0;
    this._load(this.order[this.pos], 0.3);
  }

  next() {
    if (!this.tracks.length) { this._announce(); return; }
    this.pos++;
    if (this.pos >= this.order.length) { this._reshuffle(false); this.pos = 0; }
    this._load(this.order[this.pos], 1.0);
  }

  prev() {
    if (!this.tracks.length) { this._announce(); return; }
    const slot = this.els && this.els[this.cur];
    if (slot && slot.el.currentTime > 5) { try { slot.el.currentTime = 0; } catch (e) { /* */ } return; }
    this.pos = (this.pos - 1 + this.order.length) % this.order.length;
    this._load(this.order[this.pos], 0.8);
  }

  _load(idx, fade) {
    const tr = this.tracks[idx];
    if (!tr || !this._ensureEls()) return;
    const t = this.ctx.currentTime;
    const old = this.els[this.cur];
    this.cur = 1 - this.cur;
    const slot = this.els[this.cur];
    // fade out the old element, then pause it
    try {
      old.g.gain.cancelScheduledValues(t);
      old.g.gain.setValueAtTime(old.g.gain.value, t);
      old.g.gain.setTargetAtTime(0, t, fade / 3);
    } catch (e) { /* */ }
    const oldEl = old.el;
    setTimeout(() => { if (this.els[this.cur] !== old) { try { oldEl.pause(); } catch (e) { /* */ } } }, fade * 1000 + 300);
    try {
      slot.el.src = tr.url;
      slot.el.currentTime = 0;
      slot.g.gain.cancelScheduledValues(t);
      slot.g.gain.setValueAtTime(0, t);
      slot.g.gain.setTargetAtTime(1, t + 0.05, fade / 4);
      const p = slot.el.play();
      if (p && p.catch) p.catch(() => { /* blocked or unsupported -> error handler / user retry */ });
    } catch (e) { /* */ }
    this._announce();
  }

  stop(fade = 0.8) {
    this.active = false;
    if (!this.els) return;
    const t = this.ctx.currentTime;
    for (const s of this.els) {
      try { s.g.gain.cancelScheduledValues(t); s.g.gain.setValueAtTime(s.g.gain.value, t); s.g.gain.setTargetAtTime(0, t, fade / 3); } catch (e) { /* */ }
    }
    const els = this.els;
    setTimeout(() => { if (!this.active) for (const s of els) { try { s.el.pause(); } catch (e) { /* */ } } }, fade * 1000 + 300);
  }
}
