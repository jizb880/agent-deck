import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { HOST, PORT, WEB_DIST, SESSION_HISTORY_FILE } from './config.js';
import { registerRoutes } from './httpRoutes.js';
import { attachWebSocket } from './wsBridge.js';
import { sessionHistory } from './sessionHistory.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

// Read the persisted session history before anything can touch it, so every
// client (even two tabs reconnecting in the same millisecond) sees the full
// list, and log what was found: a Recent list that comes up empty should be
// explainable from the log, not a mystery.
sessionHistory.on('warn', (msg, err) => app.log.warn({ err }, msg));
app.log.info(
  `session history: ${await sessionHistory.load()} entries loaded from ${SESSION_HISTORY_FILE}`
);

registerRoutes(app);

// Serve the built frontend if present. In dev, Vite serves the UI on :5173
// and proxies /api + /ws here, so this block is a no-op until `npm run build`.
if (fs.existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST });
  // SPA fallback: any non-API GET returns index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.method === 'GET' && !req.url.startsWith('/api')) {
      return reply.sendFile('index.html');
    }
    reply.code(404).send({ error: 'Not found' });
  });
}

// Defensive: a stray exception should not tear down every live PTY session.
// Log and keep serving (the known crash vectors are guarded at their source).
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaughtException (kept alive)');
});
process.on('unhandledRejection', (err) => {
  app.log.error({ err }, 'unhandledRejection (kept alive)');
});

// The session history debounces writes; on a normal exit the last 'exit'/'exit
// timer' won't have fired, so flush synchronously. A bare signal never emits
// 'exit', so intercept and exit cleanly after flushing. SIGHUP is what a
// closing terminal window sends. (flushSync is a no-op when nothing changed,
// so a process that never got as far as serving cannot clobber the file.)
process.on('exit', () => sessionHistory.flushSync());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    sessionHistory.flushSync();
    process.exit(0);
  });
}

try {
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  if (err && err.code === 'EADDRINUSE') {
    app.log.error(
      `Port ${PORT} is already in use. Stop the other process ` +
        `(lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill) or start on another port: PORT=4200 npm start`
    );
  } else {
    app.log.error({ err }, 'failed to start');
  }
  process.exit(1);
}

// Attach the WS server to Fastify's underlying HTTP server.
attachWebSocket(app.server);

app.log.info(`control_app dashboard ready at http://${HOST}:${PORT}`);
if (!fs.existsSync(WEB_DIST)) {
  app.log.info('Frontend not built yet — run `npm run dev` (web) or `npm run build`.');
}
