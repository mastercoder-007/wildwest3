'use strict';
// Game settings the owner can change from the admin page. Saved in data/settings.json.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  winScore: 2, // rounds needed to win a match
  minWaitMs: 2500, // shortest "Steady..." wait
  maxWaitMs: 7000, // longest "Steady..." wait
  paused: false, // true = nobody new can join
  banner: '', // a short message shown on the phones
};

function clamp(n, lo, hi, fallback) {
  n = Math.round(Number(n));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function clean(input, base) {
  const s = { ...base };
  if ('winScore' in input) s.winScore = clamp(input.winScore, 1, 5, base.winScore);
  if ('minWaitMs' in input) s.minWaitMs = clamp(input.minWaitMs, 1000, 10000, base.minWaitMs);
  if ('maxWaitMs' in input) s.maxWaitMs = clamp(input.maxWaitMs, 1000, 15000, base.maxWaitMs);
  if (s.maxWaitMs < s.minWaitMs) s.maxWaitMs = s.minWaitMs;
  if ('paused' in input) s.paused = input.paused === true;
  if ('banner' in input) s.banner = String(input.banner || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 140);
  return s;
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.value = { ...DEFAULTS };
    try {
      this.value = clean(JSON.parse(fs.readFileSync(this.file, 'utf8')), DEFAULTS);
    } catch (e) { /* first run: use defaults */ }
  }

  get() {
    return this.value;
  }

  update(input) {
    this.value = clean(input || {}, this.value);
    try { fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2)); } catch (e) { console.error('could not save settings:', e.message); }
    return this.value;
  }
}

module.exports = { Settings };
