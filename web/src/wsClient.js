// Single shared WebSocket to the backend. Handles auto-reconnect and fans out
// frames to subscribers keyed by sessionId, plus a roster subscription.
//
// A TerminalView attaches to a session; on (re)connect we automatically
// re-send `attach` for every session that still has listeners, so a dropped
// socket or backend blip transparently recovers and replays scrollback.

class WsClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.backoff = 500;
    // sessionId -> Set<handler(frame)>
    this.sessionSubs = new Map();
    // desired cols/rows per attached session, replayed on reconnect
    this.attachDims = new Map();
    this.rosterSubs = new Set();
    this.statusSubs = new Set(); // connection status listeners
    this.errorSubs = new Set(); // protocol-error listeners
    this._connect();
  }

  _url() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  _connect() {
    const ws = new WebSocket(this._url());
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.backoff = 500;
      this._emitStatus();
      // Re-attach every session that still has subscribers.
      for (const sessionId of this.sessionSubs.keys()) {
        const dims = this.attachDims.get(sessionId) || {};
        this._send({ type: 'attach', sessionId, cols: dims.cols, rows: dims.rows });
      }
      this._send({ type: 'list' });
    };

    ws.onmessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (frame.type === 'sessions') {
        for (const fn of this.rosterSubs) fn(frame.sessions);
        return;
      }
      if (frame.type === 'error') {
        // Error frames may or may not carry a sessionId; always surface globally
        // and, if keyed, also deliver to that session's subscribers.
        for (const fn of this.errorSubs) fn(frame);
        if (frame.sessionId && this.sessionSubs.has(frame.sessionId)) {
          for (const fn of this.sessionSubs.get(frame.sessionId)) fn(frame);
        }
        return;
      }
      const sid = frame.sessionId;
      if (sid && this.sessionSubs.has(sid)) {
        for (const fn of this.sessionSubs.get(sid)) fn(frame);
      }
    };

    ws.onclose = () => {
      this.connected = false;
      this._emitStatus();
      setTimeout(() => this._connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _emitStatus() {
    for (const fn of this.statusSubs) fn(this.connected);
  }

  onConnectionChange(fn) {
    this.statusSubs.add(fn);
    fn(this.connected);
    return () => this.statusSubs.delete(fn);
  }

  onRoster(fn) {
    this.rosterSubs.add(fn);
    return () => this.rosterSubs.delete(fn);
  }

  onError(fn) {
    this.errorSubs.add(fn);
    return () => this.errorSubs.delete(fn);
  }

  requestList() {
    this._send({ type: 'list' });
  }

  // Subscribe to a session's frames. Sends attach now (if connected) and on
  // every future reconnect. Returns an unsubscribe fn that detaches when the
  // last listener for that session goes away.
  attach(sessionId, handler, cols, rows) {
    if (!this.sessionSubs.has(sessionId)) this.sessionSubs.set(sessionId, new Set());
    this.sessionSubs.get(sessionId).add(handler);
    if (cols && rows) this.attachDims.set(sessionId, { cols, rows });
    this._send({ type: 'attach', sessionId, cols, rows });

    return () => {
      const set = this.sessionSubs.get(sessionId);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) {
        this.sessionSubs.delete(sessionId);
        this.attachDims.delete(sessionId);
        this._send({ type: 'detach', sessionId });
      }
    };
  }

  input(sessionId, data) {
    this._send({ type: 'input', sessionId, data });
  }

  resize(sessionId, cols, rows) {
    this.attachDims.set(sessionId, { cols, rows });
    this._send({ type: 'resize', sessionId, cols, rows });
  }
}

export const wsClient = new WsClient();
