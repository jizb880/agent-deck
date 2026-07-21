import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { HOST, PORT, WEB_DIST } from './config.js';
import { registerRoutes } from './httpRoutes.js';
import { attachWebSocket } from './wsBridge.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

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

try {
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  if (err && err.code === 'EADDRINUSE') {
    app.log.error(
      `Port ${PORT} is already in use. Stop the other process ` +
        `(lsof -ti tcp:${PORT} | xargs kill) or start on another port: PORT=4200 npm start`
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
