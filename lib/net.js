'use strict';
// Works out "which Wi-Fi is this visitor on?".
// Every device on one home Wi-Fi reaches the internet through the same public address,
// so the server uses that address as the key for a room. We never store the address:
// only a scrambled (salted + hashed) version of it.

const crypto = require('crypto');

// Headers that hosting platforms use to pass along the visitor's real address.
// First match wins. Set IP_HEADER to force one (see README).
const AUTO_HEADERS = ['cf-connecting-ip', 'true-client-ip', 'fly-client-ip', 'x-real-ip', 'x-forwarded-for'];

function normalize(ip) {
  if (!ip) return '';
  ip = String(ip).trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7); // IPv4 written inside IPv6
  return ip;
}

function isPrivate(ip) {
  if (!ip) return true;
  if (ip.includes(':')) return ip === '::1' || ip === '::' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return true;
  return (
    p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
  );
}

// Devices on one IPv6 Wi-Fi share the first 64 bits, the rest changes per device.
function v6Prefix(ip) {
  const halves = ip.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const full = halves.length > 1 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return full.slice(0, 4).map((x) => x.padStart(4, '0')).join(':');
}

// Returns { ip, source } where source says which header (or the raw connection) we trusted.
function clientIp(req, cfg) {
  const names = cfg.ipHeader ? [cfg.ipHeader] : AUTO_HEADERS;
  for (const h of names) {
    const v = req.headers[h];
    if (!v) continue;
    const parts = String(v).split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    const pick = h === 'x-forwarded-for' ? parts[Math.max(0, parts.length - cfg.hops)] : parts[0];
    return { ip: normalize(pick), source: h };
  }
  return { ip: normalize(req.socket.remoteAddress), source: 'connection' };
}

function networkOf(req, cfg, salt) {
  const { ip, source } = clientIp(req, cfg);
  // Local (private) addresses all count as one network: that is the "play at home" case.
  if (isPrivate(ip)) return { id: 'lan', ip, source };
  const key = ip.includes(':') ? v6Prefix(ip) : ip;
  return { id: crypto.createHash('sha256').update(salt + key).digest('hex').slice(0, 10), ip, source };
}

function visitorHash(ip, ua, salt) {
  const day = new Date().toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`${salt}|${ip}|${ua}|${day}`).digest('hex').slice(0, 10);
}

function maskIp(ip) {
  if (!ip) return '?';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…';
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.x` : '?';
}

// hides the last part of any address inside a piece of text (used by the admin network check)
function maskText(s) {
  return s
    .replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\b/g, '$1.x')
    .replace(/\b([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{0,4})(?::[0-9a-f]{0,4}){1,5}\b/gi, '$1:…');
}

function isBot(ua) {
  return /bot|crawl|spider|slurp|preview|monitor|uptime|curl|wget|python-requests|headless/i.test(ua || '');
}

function deviceOf(ua) {
  ua = ua || '';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iPhone / iPad';
  if (/android/i.test(ua)) return 'Android';
  if (/windows|macintosh|linux|cros/i.test(ua)) return 'Desktop';
  return 'Other';
}

function countryOf(req) {
  const c = req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country-code'] || '';
  return /^[A-Za-z]{2}$/.test(String(c)) ? String(c).toUpperCase() : '??';
}

module.exports = { networkOf, clientIp, visitorHash, maskIp, maskText, isBot, deviceOf, countryOf, isPrivate };
