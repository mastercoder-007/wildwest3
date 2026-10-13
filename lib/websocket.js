'use strict';
// A tiny WebSocket (RFC 6455) implementation, so the game needs no npm packages.
// A WebSocket is a phone line that stays open: either side can speak at any time.

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 4096; // game messages are tiny, anything bigger is rejected

class Client {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.alive = true;
    this.closed = false;
    this.fragOp = 0;
    this.frags = [];
    this.fragLen = 0;
    this.tokens = 40; // flood protection: a "bucket" of messages that refills over time
    this.lastRefill = Date.now();
    this.onmessage = () => {};
    this.onclose = () => {};
    // The game server fills these in:
    this.net = null; // which Wi-Fi group this connection belongs to
    this.meta = {}; // device type, country, daily visitor hash (for stats)
    this.room = null;
    this.role = null; // 'player' | 'arena' | 'spectator'
    this.slot = null;
  }

  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80);
      const op = b[0] & 0x0f;
      const masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        len = big > BigInt(MAX_PAYLOAD) ? MAX_PAYLOAD + 1 : Number(big);
        off = 10;
      }
      if (!masked || len > MAX_PAYLOAD) return this.destroy(); // browsers always mask
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this.frame(fin, op, payload);
      if (this.closed) return;
    }
  }

  frame(fin, op, payload) {
    this.alive = true;
    if (op === 0x8) { // close
      this.writeFrame(0x8, payload.subarray(0, 2));
      return this.destroy();
    }
    if (op === 0x9) return this.writeFrame(0xa, payload); // ping -> pong
    if (op === 0xa) return; // pong
    if (op !== 0x1 && op !== 0x2 && op !== 0x0) return;

    // rate limit: 20 messages per second, bursts up to 40
    const now = Date.now();
    this.tokens = Math.min(40, this.tokens + ((now - this.lastRefill) / 1000) * 20);
    this.lastRefill = now;
    if (op !== 0x0 && --this.tokens < 0) return this.destroy();

    if (op === 0x1 || op === 0x2) {
      this.fragOp = op;
      this.frags = [payload];
      this.fragLen = payload.length;
    } else {
      this.frags.push(payload);
      this.fragLen += payload.length;
      if (this.fragLen > MAX_PAYLOAD) return this.destroy();
    }
    if (fin) {
      const msg = Buffer.concat(this.frags);
      this.frags = [];
      this.fragLen = 0;
      if (this.fragOp === 0x1) this.onmessage(msg.toString('utf8'));
    }
  }

  writeFrame(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(obj) {
    this.writeFrame(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)));
  }

  ping() {
    this.writeFrame(0x9, Buffer.alloc(0));
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch (e) { /* already gone */ }
    this.onclose();
  }
}

// Turn an HTTP "upgrade" request into a WebSocket. Returns a Client, or null if it isn't one.
function accept(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') return null;
  const answer = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${answer}\r\n\r\n`
  );
  socket.setNoDelay(true);
  const c = new Client(socket);
  socket.on('data', (d) => c.feed(d));
  socket.on('close', () => c.destroy());
  socket.on('error', () => c.destroy());
  if (head && head.length) c.feed(head);
  return c;
}

module.exports = { accept, Client };
