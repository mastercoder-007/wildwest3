'use strict';
// The owner's admin area: password login, live numbers, settings, data export.

const crypto = require('crypto');
const net = require('./net');

const SESSION_MS = 12 * 3600 * 1000;

function sha(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function readBody(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) { reject(new Error('too big')); req.destroy(); return; }
      parts.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function createAdmin({ password, stats, settings, live, netCfg, salt, onSettingsChanged }) {
  const sessions = new Map(); // token -> expiry time
  const attempts = new Map(); // network -> { n, resetAt }  (stops password guessing)

  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const tokenOf = (req) => {
    const m = /(?:^|;\s*)duel_admin=([a-f0-9]{48})/.exec(req.headers.cookie || '');
    return m ? m[1] : null;
  };

  const authed = (req) => {
    const t = tokenOf(req);
    const exp = t && sessions.get(t);
    if (!exp) return false;
    if (exp < Date.now()) { sessions.delete(t); return false; }
    return true;
  };

  const isHttps = (req) => !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';

  async function handle(req, res, url) {
    const p = url.pathname;

    if (p === '/admin/login' && req.method === 'POST') {
      const id = net.networkOf(req, netCfg, salt).id;
      const a = attempts.get(id) || { n: 0, resetAt: Date.now() + 600000 };
      if (a.resetAt < Date.now()) { a.n = 0; a.resetAt = Date.now() + 600000; }
      if (a.n >= 5) return send(res, 429, { error: 'Too many tries. Wait 10 minutes.' });
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad request' }); }
      const ok = typeof body.password === 'string' && crypto.timingSafeEqual(sha(body.password), sha(password));
      if (!ok) {
        a.n++;
        attempts.set(id, a);
        return send(res, 401, { error: 'Wrong password' });
      }
      attempts.delete(id);
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, Date.now() + SESSION_MS);
      const cookie = `duel_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` + (isHttps(req) ? '; Secure' : '');
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': cookie });
    }

    if (p === '/admin/logout' && req.method === 'POST') {
      const t = tokenOf(req);
      if (t) sessions.delete(t);
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': 'duel_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    if (!authed(req)) return send(res, 401, { error: 'login required' });

    if (p === '/admin/api/stats' && req.method === 'GET') {
      return send(res, 200, { ...stats.summary(url.searchParams.get('tz')), live: live(), settings: settings.get(), uptimeSec: Math.round(process.uptime()) });
    }

    if (p === '/admin/api/settings' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad request' }); }
      const s = settings.update(body);
      onSettingsChanged();
      return send(res, 200, s);
    }

    if (p === '/admin/api/netcheck' && req.method === 'GET') {
      // Lets the owner confirm the server sees the real visitor address behind the host's proxy.
      const { ip, source } = net.clientIp(req, netCfg);
      const seen = {};
      for (const h of ['cf-connecting-ip', 'true-client-ip', 'fly-client-ip', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-proto', 'cf-ipcountry']) {
        if (req.headers[h]) seen[h] = net.maskText(String(req.headers[h]).slice(0, 200));
      }
      return send(res, 200, {
        detected: net.maskIp(ip),
        source,
        isPrivate: net.isPrivate(ip),
        seen,
        ipHeaderSetting: netCfg.ipHeader || '(automatic)',
        hops: netCfg.hops,
      });
    }

    if (p === '/admin/export/events.json') {
      return send(res, 200, JSON.stringify(stats.events), 'application/json; charset=utf-8', { 'Content-Disposition': 'attachment; filename="duel-events.json"' });
    }
    if (p === '/admin/export/matches.csv') {
      return send(res, 200, stats.matchesCsv(), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="duel-matches.csv"' });
    }

    return send(res, 404, { error: 'not found' });
  }

  return { handle };
}

module.exports = { createAdmin, readBody };
