import fs from 'node:fs';
import { personaStore } from './personaStore.js';
import { sessionManager } from './SessionManager.js';
import { CLI_KINDS, HOME_DIR } from './config.js';

export function registerRoutes(app) {
  app.get('/api/health', async () => ({ ok: true, home: HOME_DIR }));

  app.get('/api/cli-kinds', async () =>
    Object.entries(CLI_KINDS).map(([id, v]) => ({ id, label: v.label }))
  );

  // ---- Personas ----
  app.get('/api/personas', async () => personaStore.list());

  app.post('/api/personas', async (req, reply) => {
    const persona = await personaStore.create(req.body || {});
    reply.code(201);
    return persona;
  });

  app.put('/api/personas/:id', async (req, reply) => {
    const updated = await personaStore.update(req.params.id, req.body || {});
    if (!updated) return reply.code(404).send({ error: 'Persona not found' });
    return updated;
  });

  app.delete('/api/personas/:id', async (req, reply) => {
    const ok = await personaStore.remove(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'Persona not found' });
    return { ok: true };
  });

  // ---- Sessions ----
  app.get('/api/sessions', async () => sessionManager.list());

  app.post('/api/sessions', async (req, reply) => {
    const body = req.body || {};
    // Validate cwd early with a friendly error instead of a raw spawn failure.
    const cwd = body.cwd;
    if (cwd && !(fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())) {
      return reply.code(400).send({ error: `Working dir does not exist: ${cwd}` });
    }
    try {
      const session = await sessionManager.create(body);
      reply.code(201);
      return session.toJSON();
    } catch (err) {
      return reply.code(400).send({ error: String(err.message || err) });
    }
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const s = sessionManager.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'Session not found' });
    return s.toJSON();
  });

  // Rename a session (title shows in the sidebar and tab headers).
  app.patch('/api/sessions/:id', async (req, reply) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) return reply.code(400).send({ error: 'title must be a non-empty string' });
    const s = sessionManager.rename(req.params.id, title.slice(0, 80));
    if (!s) return reply.code(404).send({ error: 'Session not found' });
    return s.toJSON();
  });

  // Send a signal (default SIGTERM) to the CLI without removing the session.
  app.post('/api/sessions/:id/kill', async (req, reply) => {
    const signal = (req.body && req.body.signal) || 'SIGTERM';
    const ok = sessionManager.kill(req.params.id, signal);
    if (!ok) return reply.code(404).send({ error: 'Session not found' });
    return { ok: true };
  });

  // Remove from roster (force-kills if still running).
  app.delete('/api/sessions/:id', async (req, reply) => {
    const ok = sessionManager.remove(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'Session not found' });
    return { ok: true };
  });
}
