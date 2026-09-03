import { WebSocketServer } from 'ws';
import { sessionManager } from './SessionManager.js';
import { sessionHistory } from './sessionHistory.js';

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
 *    { type:'history',  entries:[...] }                 persisted session tail
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

  // Structural history changes (create / reopen / rename / remove) are rare,
  // so broadcast without throttle. Touch-only updates deliberately don't emit.
  const onHistory = (entries) => {
    const frame = JSON.stringify({ type: 'history', entries });
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }
  };
  sessionHistory.on('change', onHistory);

  wss.on('connection', (ws) => {
    // Per-connection map: sessionId -> unsubscribe fn.
    const subs = new Map();
    // Bumped per attach so an attach that was superseded while it awaited its
    // snapshot can tell, and take its own listeners down instead of leaking.
    const attachGen = new Map();

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

    const attach = async (sessionId, cols, rows) => {
      const session = sessionManager.get(sessionId);
      if (!session) {
        send({ type: 'error', sessionId, message: `No such session: ${sessionId}` });
        return;
      }
      // Re-attach is idempotent: drop any prior subscription first.
      unsubscribe(sessionId);
      const gen = (attachGen.get(sessionId) || 0) + 1;
      attachGen.set(sessionId, gen);

      if (cols && rows) session.resize(cols, rows);
      // Switching to a session counts as using it, so "recent sessions" ranks
      // it even if the agent has nothing to say yet.
      session.touch();

      // Subscribe *before* taking the snapshot. The snapshot is exact as of
      // the moment it resolves and includes every chunk emitted until then,
      // so output seen while it was being produced is dropped, not queued —
      // forwarding it too would paint it twice. Status/exit frames from that
      // window are held and delivered after 'attached', in order.
      let snapshotPending = true;
      const held = [];
      const onData = (data) => {
        if (snapshotPending) return;
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
      const sendOrHold = (frame) => (snapshotPending ? held.push(frame) : send(frame));
      const onStatus = (status) =>
        sendOrHold({
          type: 'status',
          sessionId,
          status,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
        });
      const onExit = ({ exitCode, signal }) =>
        sendOrHold({ type: 'exit', sessionId, exitCode, exitSignal: signal ?? null });

      session.on('data', onData);
      session.on('status', onStatus);
      session.on('exit', onExit);

      const off = () => {
        session.off('data', onData);
        session.off('status', onStatus);
        session.off('exit', onExit);
      };
      subs.set(sessionId, off);

      // The rendered history (scrollback + screen + cursor + modes), which a
      // fresh client terminal replays after a reset. Being the emulator's own
      // buffer rather than raw bytes, it holds no terminal queries for xterm.js
      // to answer — the replies used to reach the CLI as stray keystrokes.
      let snapshot;
      try {
        snapshot = await session.getSnapshot();
      } catch (err) {
        if (subs.get(sessionId) === off) unsubscribe(sessionId);
        send({ type: 'error', sessionId, message: `Could not snapshot session: ${err.message}` });
        return;
      }
      // Superseded by a newer attach (or detached) while awaiting: that one
      // owns the subscription now.
      if (attachGen.get(sessionId) !== gen || subs.get(sessionId) !== off) {
        off();
        return;
      }
      send({ type: 'attached', sessionId, snapshot, session: session.toJSON() });
      snapshotPending = false;
      for (const frame of held) send(frame);
    };

    // Send the current roster + persisted history immediately on connect.
    send({ type: 'sessions', sessions: sessionManager.list() });
    sessionHistory.list().then((entries) => {
      if (ws.readyState === ws.OPEN) send({ type: 'history', entries });
    });

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
          attach(sessionId, msg.cols, msg.rows).catch((err) =>
            send({ type: 'error', sessionId, message: `Attach failed: ${err.message}` })
          );
          break;
        case 'detach':
          unsubscribe(sessionId);
          break;
        case 'input': {
          const s = sessionManager.get(sessionId);
          if (s) {
            s.touch();
            s.write(msg.data);
          }
          break;
        }
        case 'resize': {
          const s = sessionManager.get(sessionId);
          if (s) {
            s.touch();
            s.resize(msg.cols, msg.rows);
          }
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

    // Tear down through unsubscribe() so any backpressure pause this socket
    // still holds is released immediately, not left to the drain poller — a
    // paused PTY blocks the CLI's stdout and stalls its event loop.
    const teardown = () => {
      for (const sessionId of [...subs.keys()]) unsubscribe(sessionId);
    };
    ws.on('close', teardown);
    ws.on('error', teardown);
  });

  return wss;
}
