'use strict';
// Visitor and match statistics.
// Every interesting thing that happens is one line in data/events.jsonl (an "event log").
// The dashboard is computed from that list, so nothing can get out of sync.
// Privacy: we store NO IP addresses, only a scrambled daily visitor id.

const fs = require('fs');
const path = require('path');

const DAY = 86400000;
const MAX_EVENTS = 200000; // oldest events fall out of memory (and the dashboard) past this

class Stats {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'events.jsonl');
    this.events = [];
    this.cache = new Map();
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue;
        try { this.events.push(JSON.parse(line)); } catch (e) { /* skip a broken line */ }
      }
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    } catch (e) { /* no file yet */ }
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.stream.on('error', (e) => console.error('stats write error:', e.message));
  }

  log(type, data) {
    const ev = { ts: Date.now(), type, ...data };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS * 1.1) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.stream.write(JSON.stringify(ev) + '\n');
    this.cache.clear();
  }

  // tz = the browser's getTimezoneOffset() in minutes, so days/hours match the owner's clock
  summary(tz) {
    tz = Math.max(-840, Math.min(840, Math.round(Number(tz) || 0)));
    const hit = this.cache.get(tz);
    if (hit && Date.now() - hit.at < 5000) return hit.data;

    const off = tz * 60000;
    const dayOf = (ts) => Math.floor((ts - off) / DAY);
    const hourOf = (ts) => Math.floor((((ts - off) % DAY) + DAY) % DAY / 3600000);
    const today = dayOf(Date.now());

    const days = new Map();
    for (let d = today - 29; d <= today; d++) {
      days.set(d, { date: new Date(d * DAY).toISOString().slice(0, 10), visits: 0, uniq: new Set(), joins: 0, matches: 0 });
    }
    const hours = Array(24).fill(0);
    const devices = new Map();
    const countries = new Map();
    const totals = { visits: 0, joins: 0, started: 0, completed: 0, abandoned: 0 };
    const durations = [];
    const wins = [];
    const recent = [];

    for (const e of this.events) {
      const d = days.get(dayOf(e.ts));
      if (e.type === 'visit') {
        totals.visits++;
        if (d) { d.visits++; if (e.v) d.uniq.add(e.v); }
        devices.set(e.dev || 'Other', (devices.get(e.dev || 'Other') || 0) + 1);
        countries.set(e.cc || '??', (countries.get(e.cc || '??') || 0) + 1);
      } else if (e.type === 'join') {
        totals.joins++;
        if (d) d.joins++;
      } else if (e.type === 'match_start') {
        totals.started++;
        if (d) { d.matches++; hours[hourOf(e.ts)]++; }
      } else if (e.type === 'match_end') {
        if (e.reason === 'complete') {
          totals.completed++;
          if (e.dur) durations.push(e.dur);
        } else totals.abandoned++;
        for (const w of e.wins || []) wins.push(w);
        recent.push(e);
      }
    }

    const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
    const list = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, n: v }));
    const series = [...days.values()].map((d) => ({ date: d.date, visits: d.visits, uniques: d.uniq.size, joins: d.joins, matches: d.matches }));
    const t = series[series.length - 1];
    const y = series[series.length - 2];

    const data = {
      totals,
      today: t,
      yesterday: y,
      days: series,
      hours,
      devices: list(devices, 6),
      countries: list(countries, 8),
      avgDurationSec: durations.length ? Math.round(avg(durations) / 1000) : null,
      avgWinMs: avg(wins),
      fastestMs: wins.length ? Math.min(...wins) : null,
      recent: recent.slice(-25).reverse().map((e) => ({
        ts: e.ts, a: e.a, b: e.b, sa: e.sa, sb: e.sb, winner: e.winner, reason: e.reason, dur: e.dur, rounds: e.rounds,
      })),
      eventCount: this.events.length,
    };
    this.cache.set(tz, { at: Date.now(), data });
    return data;
  }

  // CSV of finished matches, safe to open in Excel (names can't start a formula)
  matchesCsv() {
    const q = (v) => {
      let s = String(v == null ? '' : v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const rows = ['time_utc,player_a,player_b,score_a,score_b,winner,result,duration_seconds,rounds'];
    for (const e of this.events) {
      if (e.type !== 'match_end') continue;
      const winner = e.winner === 0 ? e.a : e.winner === 1 ? e.b : '';
      rows.push([new Date(e.ts).toISOString(), e.a, e.b, e.sa, e.sb, winner, e.reason, e.dur ? Math.round(e.dur / 1000) : '', e.rounds].map(q).join(','));
    }
    return rows.join('\n') + '\n';
  }
}

module.exports = { Stats };
