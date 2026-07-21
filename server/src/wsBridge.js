import { WebSocketServer } from 'ws';
import { sessionManager } from './SessionManager.js';

/**
 * WebSocket protocol (JSON text frames, all keyed by sessionId where relevant):
 *
 *  client -> server
 *    { type:'attach',  sessionId, cols, rows }   subscribe + replay scrollback
 *    { type:'detach',  sessionId }               unsubscribe (child keeps running)
 *    { type:'input',   sessionId, data }         keystrokes -> pty
 *    { type:'resize',  sessionId, cols, rows }   pty resize (last writer wins)
 *    { type:'list' }                             request session roster
 *    { type:'ping' }
 *
 *  server -> client
 *    { type:'attached', sessionId, snapshot, session }  scrollback + metadata
 *    { type:'output',   sessionId, data }
 *    { type:'status',   sessionId, status, exitCode?, exitSignal? }
 *    { type:'exit',     sessionId, exitCode, exitSignal }
 *    { type:'sessions', sessions:[...] }                full roster
 *    { type:'error',    message }
 *    { type:'pong' }
 */
export function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Broadcast roster changes to every connected client.
  const onSessions = (sessions) => {
    const frame = JSON.stringify({ type: 'sessions', sessions });
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }
  };
  sessionManager.on('sessions', onSessions);

  wss.on('connection', (ws) => {
    // Per-connection map: sessionId -> unsubscribe fn.
    const subs = new Map();

    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    // Sessions this socket has asked to pause (so we can resume on close).
    const paused = new Set();
    // Above this many bytes queued in the socket, pause the PTY(s) feeding it.
    const HIGH_WATER = 4 * 1024 * 1024;
    const LOW_WATER = 1 * 1024 * 1024;

    const unsubscribe = (sessionId) => {
      const off = subs.get(sessionId);
      if (off) {
        off();
        subs.delete(sessionId);
      }
      // Release any backpressure pause this socket held on the session.
      if (paused.delete(sessionId)) {
        const s = sessionManager.get(sessionId);
        if (s) s.resume();
      }
    };

    const attach = (sessionId, cols, rows) => {
      const session = sessionManager.get(sessionId);
      if (!session) {
        send({ type: 'error', sessionId, message: `No such session: ${sessionId}` });
        return;
      }
      // Re-attach is idempotent: drop any prior subscription first.
      unsubscribe(sessionId);

      if (cols && rows) session.resize(cols, rows);

      // Replay history so the client can redraw the full terminal.
      send({
        type: 'attached',
        sessionId,
        snapshot: session.getScrollback(),
        session: session.toJSON(),
      });

      const onData = (data) => {
        send({ type: 'output', sessionId, data });
        // Backpressure: if the client can't keep up, pause the PTY until the
        // socket's buffered data drains, instead of buffering unboundedly.
        if (ws.bufferedAmount > HIGH_WATER && !paused.has(sessionId)) {
          paused.add(sessionId);
          session.pause();
          const drain = setInterval(() => {
            if (ws.readyState !== ws.OPEN || ws.bufferedAmount <= LOW_WATER) {
              clearInterval(drain);
              if (paused.delete(sessionId)) session.resume();
            }
          }, 50);
          if (drain.unref) drain.unref();
        }
      };
      const onStatus = (status) =>
        send({
          type: 'status',
          sessionId,
          status,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
        });
      const onExit = ({ exitCode, signal }) =>
        send({ type: 'exit', sessionId, exitCode, exitSignal: signal ?? null });

      session.on('data', onData);
      session.on('status', onStatus);
      session.on('exit', onExit);

      subs.set(sessionId, () => {
        session.off('data', onData);
        session.off('status', onStatus);
        session.off('exit', onExit);
      });
    };

    // Send the current roster immediately on connect.
    send({ type: 'sessions', sessions: sessionManager.list() });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ type: 'error', message: 'Invalid JSON' });
        return;
      }
      // JSON.parse can legally return null / a primitive / an array; guard so a
      // malformed frame like literal `null` can't crash the destructure below
      // (which would kill this connection and, on an uncaught throw, the server).
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
        send({ type: 'error', message: 'Expected a JSON object frame' });
        return;
      }
      const { type, sessionId } = msg;
      switch (type) {
        case 'attach':
          attach(sessionId, msg.cols, msg.rows);
          break;
        case 'detach':
          unsubscribe(sessionId);
          break;
        case 'input': {
          const s = sessionManager.get(sessionId);
          if (s) s.write(msg.data);
          break;
        }
        case 'resize': {
          const s = sessionManager.get(sessionId);
          if (s) s.resize(msg.cols, msg.rows);
          break;
        }
        case 'list':
          send({ type: 'sessions', sessions: sessionManager.list() });
          break;
        case 'ping':
          send({ type: 'pong' });
          break;
        default:
          send({ type: 'error', message: `Unknown type: ${type}` });
      }
    });

    ws.on('close', () => {
      for (const off of subs.values()) off();
      subs.clear();
    });

    ws.on('error', () => {
      for (const off of subs.values()) off();
      subs.clear();
    });
  });

  return wss;
}
