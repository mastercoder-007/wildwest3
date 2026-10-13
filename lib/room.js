'use strict';
// One Room = one duel. Each Wi-Fi network gets its own Room.
// The room is the referee: it owns the game state and decides who won.
//
// State machine:  lobby -> steady -> draw -> result -> (next round | over)

const crypto = require('crypto');

const NAMES = ['Dusty Pete', 'Calamity Kate'];
const TIME_SCALE = process.env.DUEL_FAST ? 0.1 : 1; // only the automated tests use this
const FIRE_WINDOW_MS = 200; // after the first shot, wait this long for the other player's shot

function cleanName(name, fallback) {
  const n = String(name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  return n || fallback;
}

class Room {
  // ctx = { settings: () => settings object, stats, onEmpty: (room) => void, urls: () => [..] }
  constructor(code, net, ctx) {
    this.code = code;
    this.net = net;
    this.ctx = ctx;
    this.clients = new Set(); // players + laptop screens + spectators
    this.players = [null, null]; // { name, score, ready, client }
    this.timers = [];
    this.match = null;
    this.state = 'lobby';
    this.round = 0;
    this.result = null;
    this.champion = null;
    this.winScore = ctx.settings().winScore;
    this.drawAt = 0;
    this.fires = [];
  }

  // ---------------------------------------------------------------- joining and leaving
  join(c, role, name) {
    c.room = this;
    this.clients.add(c);

    if (role === 'arena') {
      c.role = 'arena';
      c.send({ t: 'info', urls: this.ctx.urls(), code: this.code });
      c.send(this.publicState());
      return;
    }

    const slot = this.players.findIndex((p) => !p);
    if (slot < 0) {
      c.role = 'spectator';
      c.send({ t: 'full' });
      c.send(this.publicState());
      return;
    }

    let nm = cleanName(name, NAMES[slot]);
    const other = this.players[1 - slot];
    if (other && other.name.toLowerCase() === nm.toLowerCase()) nm = nm.slice(0, 12) + ' 2'; // no twins
    c.role = 'player';
    c.slot = slot;
    this.players[slot] = { name: nm, score: 0, ready: false, client: c };
    c.send({ t: 'hello', slot, name: nm, code: this.code });
    this.ctx.stats.log('join', { dev: c.meta.dev, cc: c.meta.cc, v: c.meta.v });
    if (this.state !== 'lobby') this.abandonAndReset(); // someone new walked in mid-match
    this.broadcast();
  }

  leave(c) {
    if (!this.clients.delete(c)) return;
    if (c.role === 'player' && this.players[c.slot] && this.players[c.slot].client === c) {
      this.finishMatch('abandoned'); // log it while both names are still known
      this.players[c.slot] = null;
      this.abandonAndReset();
      this.broadcast();
    }
    if (this.clients.size === 0) this.ctx.onEmpty(this);
  }

  dispose() {
    this.clearTimers();
  }

  // ---------------------------------------------------------------- messages from clients
  handle(c, m) {
    if (c.role !== 'player') return;
    if (m.t === 'ready') this.handleReady(c);
    else if (m.t === 'fire') this.handleFire(c, m.rt);
  }

  handleReady(c) {
    if (this.state !== 'lobby' && this.state !== 'over') return;
    this.players[c.slot].ready = true;
    const [a, b] = this.players;
    if (a && b && a.ready && b.ready) {
      if (this.state === 'over') {
        this.champion = null;
        this.round = 0;
        for (const p of this.players) p.score = 0;
      }
      this.startRound();
    } else {
      this.broadcast();
    }
  }

  handleFire(c, rt) {
    if (this.state === 'steady') {
      return this.endRound({ winner: 1 - c.slot, reason: 'foul', foul: c.slot }); // fired too early
    }
    if (this.state !== 'draw') return;
    if (this.fires.some((f) => f.slot === c.slot)) return;

    // The phone measures its own reaction time (so Wi-Fi delay is not counted against you).
    // We only trust it if it is believable compared with our own clock.
    const serverMs = Date.now() - this.drawAt;
    let ms = serverMs;
    if (typeof rt === 'number' && Number.isFinite(rt) && rt >= 0 && rt <= serverMs + 5 && serverMs - rt <= 500) {
      ms = Math.round(rt);
    }
    this.fires.push({ slot: c.slot, ms });
    if (this.fires.length === 1) this.timers.push(setTimeout(() => this.resolveDraw(), FIRE_WINDOW_MS));
    else this.resolveDraw();
  }

  // ---------------------------------------------------------------- the game itself
  later(ms, fn) {
    this.timers.push(setTimeout(fn, ms * TIME_SCALE));
  }

  clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  resetToLobby() {
    this.clearTimers();
    this.state = 'lobby';
    this.round = 0;
    this.result = null;
    this.champion = null;
    this.fires = [];
    this.match = null;
    for (const p of this.players) if (p) { p.score = 0; p.ready = false; }
  }

  abandonAndReset() {
    this.finishMatch('abandoned');
    this.resetToLobby();
  }

  startRound() {
    this.clearTimers();
    const s = this.ctx.settings();
    if (this.round === 0) {
      this.winScore = s.winScore;
      this.match = { startedAt: Date.now(), wins: [], rounds: 0, done: false };
      this.ctx.stats.log('match_start', { a: this.players[0].name, b: this.players[1].name });
    }
    this.round += 1;
    this.match.rounds = this.round;
    this.state = 'steady';
    this.result = null;
    this.fires = [];
    this.broadcast();
    const wait = s.minWaitMs + Math.random() * (s.maxWaitMs - s.minWaitMs);
    this.later(wait, () => {
      this.state = 'draw';
      this.drawAt = Date.now();
      this.broadcast();
      this.later(5000, () => this.endRound({ winner: null, reason: 'timeout' }));
    });
  }

  resolveDraw() {
    if (this.state !== 'draw' || this.fires.length === 0) return;
    const best = this.fires.reduce((a, b) => (b.ms < a.ms ? b : a)); // smallest time wins
    this.endRound({ winner: best.slot, reason: 'faster' });
  }

  endRound({ winner, reason, foul = null }) {
    if (this.state !== 'steady' && this.state !== 'draw') return;
    this.clearTimers();
    const times = [null, null];
    for (const f of this.fires) times[f.slot] = f.ms;
    if (winner !== null) this.players[winner].score += 1;
    if (reason === 'faster' && this.match) this.match.wins.push(times[winner]);
    this.state = 'result';
    this.result = { winner, reason, foul, times };
    const champ = winner !== null && this.players[winner].score >= this.winScore ? winner : null;
    this.broadcast();
    this.later(4500, () => {
      if (champ !== null) {
        this.state = 'over';
        this.champion = champ;
        for (const p of this.players) if (p) p.ready = false;
        this.finishMatch('complete');
        this.broadcast();
      } else {
        this.startRound();
      }
    });
  }

  // write one match_end line to the statistics (only once per match)
  finishMatch(reason) {
    const m = this.match;
    if (!m || m.done) return;
    m.done = true;
    const [a, b] = this.players;
    this.ctx.stats.log('match_end', {
      a: a ? a.name : '?',
      b: b ? b.name : '?',
      sa: a ? a.score : 0,
      sb: b ? b.score : 0,
      winner: reason === 'complete' ? this.champion : null,
      reason,
      rounds: m.rounds,
      dur: Date.now() - m.startedAt,
      wins: m.wins,
    });
  }

  // ---------------------------------------------------------------- telling everyone
  publicState() {
    return {
      t: 'state',
      state: this.state,
      round: this.round,
      winScore: this.winScore,
      banner: this.ctx.settings().banner,
      players: this.players.map((p, i) => (p ? { slot: i, name: p.name, score: p.score, ready: p.ready } : null)),
      result: this.result,
      champion: this.champion,
    };
  }

  broadcast() {
    const msg = JSON.stringify(this.publicState());
    for (const c of this.clients) c.send(msg);
  }

  summary() {
    return {
      code: this.code,
      state: this.state,
      round: this.round,
      players: this.players.map((p) => (p ? { name: p.name, score: p.score } : null)),
      screens: [...this.clients].filter((c) => c.role === 'arena').length,
    };
  }
}

function newCode(taken) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += letters[crypto.randomInt(letters.length)];
    if (!taken.has(code)) return code;
  }
}

module.exports = { Room, newCode };
