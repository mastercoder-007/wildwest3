// Shared helpers for the phone page and the arena page: sound effects + a self-reconnecting socket.
(function () {
  let actx = null;

  function tone(freq, start, dur, type, peak) {
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g);
    g.connect(actx.destination);
    o.start(start);
    o.stop(start + dur + 0.05);
  }

  window.Sound = {
    // must be called from a tap/click so the browser allows audio
    unlock() {
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        if (actx.state === 'suspended') actx.resume();
      } catch (e) { /* no audio, fine */ }
    },

    shot() {
      if (!actx) return;
      const t = actx.currentTime;
      const len = Math.floor(0.4 * actx.sampleRate);
      const buf = actx.createBuffer(1, len, actx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      const src = actx.createBufferSource();
      src.buffer = buf;
      const lp = actx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(6000, t);
      lp.frequency.exponentialRampToValueAtTime(250, t + 0.35);
      src.connect(lp);
      lp.connect(actx.destination);
      src.start(t);
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.frequency.setValueAtTime(160, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.2);
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      o.connect(g);
      g.connect(actx.destination);
      o.start(t);
      o.stop(t + 0.3);
    },

    bell() {
      if (!actx) return;
      const t = actx.currentTime;
      tone(880, t, 1.2, 'sine', 0.5);
      tone(1320, t, 1.0, 'sine', 0.3);
      tone(1760, t, 0.8, 'sine', 0.15);
    },

    buzz() {
      if (!actx) return;
      tone(110, actx.currentTime, 0.35, 'sawtooth', 0.4);
    },
  };

  // Where the game server lives (see config.js). Empty = this same website.
  function serverBase() {
    return (window.DUEL_SERVER || location.origin).replace(/\/$/, '');
  }

  // Tell the server a page was opened (so the owner's dashboard can count visits).
  window.reportVisit = function (page) {
    try {
      fetch(serverBase() + '/api/visit', {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        keepalive: true,
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ page }),
      }).catch(() => {});
    } catch (e) { /* counting is optional */ }
  };

  // WebSocket that reconnects by itself and re-joins every time it connects.
  // extra = optional { name, code } sent along with the join message.
  window.openSocket = function (role, onMessage, onStatus, extra) {
    let ws;
    let retry = 500;
    let stopped = false;
    function open() {
      ws = new WebSocket(serverBase().replace(/^http/, 'ws') + '/ws');
      ws.onopen = () => {
        retry = 500;
        ws.send(JSON.stringify(Object.assign({ t: 'join', role }, extra || {})));
        onStatus('open');
      };
      ws.onmessage = (e) => {
        try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); }
      };
      ws.onclose = () => {
        if (stopped) return;
        onStatus('closed');
        setTimeout(open, retry);
        retry = Math.min(retry * 1.6, 4000);
      };
      ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
    }
    open();
    return {
      send(obj) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
      },
      close() {
        stopped = true;
        try { ws.close(); } catch (e) { /* ignore */ }
      },
    };
  };
})();
