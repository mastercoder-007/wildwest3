'use strict';
// Wild West Duel server. Only Node.js is needed, no npm packages.
//
// Two ways to run it:
//   * at home:   double-click start.bat  -> https on your laptop (phones need https for the motion sensor)
//   * online:    a host such as Render sets PORT and provides https itself -> plain http here
//
// Rooms: visitors on the same Wi-Fi share a public address, so each Wi-Fi gets its own duel room.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ws = require('./lib/websocket');
const net = require('./lib/net');
const { Stats } = require('./lib/stats');
const { Settings } = require('./lib/settings');
const { Room, newCode } = require('./lib/room');
const { createAdmin, readBody } = require('./lib/admin');

// ---------------------------------------------------------------- configuration
const HOSTED = !!process.env.PORT; // hosting platforms always set PORT
const PORT = Number(process.env.PORT || process.env.LOCAL_PORT) || 8443;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'cert');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const ALLOW_CODES = process.env.ALLOW_ROOM_CODES !== '0'; // the "Wi-Fi not detected" fallback
const netCfg = {
  ipHeader: (process.env.IP_HEADER || '').toLowerCase(), // empty = try the usual headers automatically
  hops: Math.max(1, Number(process.env.TRUST_PROXY_HOPS) || 1),
};
const MAX_CONNECTIONS = 2000;
const MAX_PER_NETWORK = 60;

fs.mkdirSync(DATA_DIR, { recursive: true });

// A secret "salt" so scrambled addresses cannot be reversed. Created once, then reused.
let SALT;
try {
  SALT = fs.readFileSync(path.join(DATA_DIR, 'salt.txt'), 'utf8').trim();
} catch (e) { /* first run */ }
if (!SALT) {
  SALT = crypto.randomBytes(16).toString('hex');
  try { fs.writeFileSync(path.join(DATA_DIR, 'salt.txt'), SALT); } catch (e) { /* read-only disk: fine */ }
}

let adminPassword = process.env.ADMIN_PASSWORD;
let passwordWasGenerated = false;
if (!adminPassword) {
  adminPassword = crypto.randomBytes(9).toString('base64url');
  passwordWasGenerated = true;
}

const stats = new Stats(DATA_DIR);
const settings = new Settings(DATA_DIR);

// ---------------------------------------------------------------- rooms
const roomsByNet = new Map();
const roomsByCode = new Map();
let connections = 0;
const perNetwork = new Map();

function lanUrls() {
  if (HOSTED) return [];
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) found.push(i.address);
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  found.sort((a, b) => rank(a) - rank(b));
  return found.map((ip) => `https://${ip}:${PORT}`);
}

const roomCtx = {
  settings: () => settings.get(),
  stats,
  urls: lanUrls,
  onEmpty(room) {
    room.dispose();
    if (roomsByNet.get(room.net) === room) roomsByNet.delete(room.net);
    roomsByCode.delete(room.code);
  },
};

function roomFor(netId) {
  let room = roomsByNet.get(netId);
  if (!room) {
    room = new Room(newCode(roomsByCode), netId, roomCtx);
    roomsByNet.set(netId, room);
    roomsByCode.set(room.code, room);
  }
  return room;
}

function live() {
  const rooms = [...roomsByCode.values()].map((r) => r.summary());
  return {
    connections,
    rooms: rooms.length,
    playersOnline: rooms.reduce((n, r) => n + r.players.filter(Boolean).length, 0),
    activeMatches: rooms.filter((r) => r.state !== 'lobby' && r.players[0] && r.players[1]),
    waiting: rooms.filter((r) => r.state === 'lobby').length,
  };
}

// ---------------------------------------------------------------- helpers
function originAllowed(origin, host) {
  if (!origin) return true; // not a browser page (or same-origin GET)
  if (ALLOWED_ORIGINS.includes('*')) return true;
  try {
    if (new URL(origin).host === host) return true;
  } catch (e) { return false; }
  return ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ''));
}

const visitLimit = new Map(); // network -> { n, resetAt }
function visitAllowed(netId) {
  const now = Date.now();
  const v = visitLimit.get(netId) || { n: 0, resetAt: now + 60000 };
  if (v.resetAt < now) { v.n = 0; v.resetAt = now + 60000; }
  v.n++;
  visitLimit.set(netId, v);
  return v.n <= 30;
}
setInterval(() => { // tidy old entries
  const now = Date.now();
  for (const [k, v] of visitLimit) if (v.resetAt < now) visitLimit.delete(k);
}, 120000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};
const PAGES = { '/': 'phone.html', '/arena': 'arena.html', '/admin': 'admin.html' };

function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || decodeURIComponent(pathname);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || path.basename(file).startsWith('.')) {
    res.writeHead(403);
    return res.end('Nope');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(file);
    const isImage = ['.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isImage ? 'public, max-age=86400' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      ...(pathname === '/admin' ? { 'X-Frame-Options': 'DENY' } : {}),
    });
    res.end(data);
  });
}

// The pages call this once when they open, so we can count visits.
async function handleVisit(req, res) {
  const origin = req.headers.origin;
  const cors = origin && originAllowed(origin, req.headers.host) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if (req.method !== 'POST' || !originAllowed(origin, req.headers.host)) {
    res.writeHead(403, cors);
    return res.end();
  }
  let page = '';
  try { page = JSON.parse(await readBody(req, 512)).page; } catch (e) { /* ignore */ }
  const ua = String(req.headers['user-agent'] || '');
  const n = net.networkOf(req, netCfg, SALT);
  if ((page === 'phone' || page === 'arena') && !net.isBot(ua) && visitAllowed(n.id)) {
    stats.log('visit', { page, dev: net.deviceOf(ua), cc: net.countryOf(req), v: net.visitorHash(n.ip, ua, SALT) });
  }
  res.writeHead(204, cors);
  res.end();
}

const admin = createAdmin({
  password: adminPassword,
  stats,
  settings,
  live,
  netCfg,
  salt: SALT,
  onSettingsChanged: () => { for (const r of roomsByCode.values()) r.broadcast(); },
});

async function handleHttp(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const p = url.pathname;
    if (p === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (p === '/api/visit') return await handleVisit(req, res);
    if (p.startsWith('/admin/')) return await admin.handle(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    return serveStatic(req, res, p);
  } catch (e) {
    console.error('request error:', e.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}

// ---------------------------------------------------------------- start the server
let tls = null;
if (!HOSTED && process.env.NO_TLS !== '1') {
  try {
    tls = { key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')), cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')) };
  } catch (e) {
    console.error('Could not read cert/key.pem and cert/cert.pem (needed for phones to use the motion sensor at home).');
    console.error('See README.md. Starting without https; use NO_TLS=1 to hide this message.');
  }
}
const server = tls ? https.createServer(tls, handleHttp) : http.createServer(handleHttp);

// ---------------------------------------------------------------- WebSockets
server.on('upgrade', (req, socket, head) => {
  const reject = (code) => { socket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  let pathname = '';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch (e) { /* bad url */ }
  if (pathname !== '/ws') return reject('404 Not Found');
  if (!originAllowed(req.headers.origin, req.headers.host)) return reject('403 Forbidden');
  if (connections >= MAX_CONNECTIONS) return reject('503 Service Unavailable');

  const n = net.networkOf(req, netCfg, SALT);
  const count = perNetwork.get(n.id) || 0;
  if (n.id !== 'lan' && count >= MAX_PER_NETWORK) return reject('429 Too Many Requests');

  const c = ws.accept(req, socket, head);
  if (!c) return reject('400 Bad Request');
  connections++;
  perNetwork.set(n.id, count + 1);
  const ua = String(req.headers['user-agent'] || '');
  c.net = n.id;
  c.meta = { dev: net.deviceOf(ua), cc: net.countryOf(req), v: net.visitorHash(n.ip, ua, SALT) };

  const joinTimer = setTimeout(() => { if (!c.room) c.destroy(); }, 15000); // must say hello quickly
  c.onclose = () => {
    clearTimeout(joinTimer);
    connections--;
    const left = (perNetwork.get(n.id) || 1) - 1;
    if (left <= 0) perNetwork.delete(n.id);
    else perNetwork.set(n.id, left);
    if (c.room) c.room.leave(c);
  };

  c.onmessage = (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') return handleJoin(c, m);
    if (c.room) c.room.handle(c, m);
  };
});

function handleJoin(c, m) {
  if (c.room) {
    if (c.role !== 'spectator') return; // already playing
    c.room.leave(c); // a spectator ("duel is full") may try again
    c.room = null;
    c.role = null;
  }
  const role = m.role === 'arena' ? 'arena' : 'player';
  if (role === 'player' && settings.get().paused) return c.send({ t: 'paused' });
  let room;
  if (m.code) { // fallback: join the laptop's room by its 4-letter code
    room = ALLOW_CODES ? roomsByCode.get(String(m.code).toUpperCase().slice(0, 4)) : null;
    if (!room) return c.send({ t: 'badcode' });
  } else {
    room = roomFor(c.net);
  }
  room.join(c, role, m.name);
}

// drop phones that went to sleep without saying goodbye
setInterval(() => {
  for (const room of roomsByCode.values()) {
    for (const c of [...room.clients]) {
      if (!c.alive) c.destroy();
      else { c.alive = false; c.ping(); }
    }
  }
}, 15000).unref();

server.listen(PORT, '0.0.0.0', () => {
  const urls = lanUrls();
  console.log('\n  WILD WEST DUEL is open for business\n');
  if (HOSTED) {
    console.log(`  Online mode, listening on port ${PORT}.`);
  } else {
    console.log(`  1) On the laptop, open:   ${tls ? 'https' : 'http'}://localhost:${PORT}/arena`);
    console.log('  2) On each phone, open:');
    if (urls.length) urls.forEach((u) => console.log(`        ${u}`));
    else console.log('        (no Wi-Fi address found, connect the laptop to Wi-Fi or a phone hotspot)');
    console.log('\n  Browsers will warn about the certificate. Choose Advanced > Proceed. That is expected.');
  }
  console.log(`\n  Admin page: /admin   Password: ${passwordWasGenerated ? adminPassword + '   (temporary; set ADMIN_PASSWORD to choose your own)' : '(from ADMIN_PASSWORD)'}\n`);
});
