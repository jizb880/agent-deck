import fs from 'node:fs';
import { personaStore } from './personaStore.js';
import { sessionManager } from './SessionManager.js';
import { CLI_KINDS, homeDir } from './config.js';
import { listResumableSessions } from './claudeSessions.js';

export function registerRoutes(app) {
  app.get('/api/health', async () => ({ ok: true, home: homeDir(), platform: process.platform }));

  app.get('/api/cli-kinds', async () =>
    Object.entries(CLI_KINDS).map(([id, v]) => ({ id, label: v.label }))
  );

  // Resumable Claude Code conversations for a working directory, newest first.
  // Powers the launch dialog's resume picker; `cwd` defaults to $HOME to match
  // what the launcher would use when the dialog leaves the field blank.
  app.get('/api/claude-sessions', async (req) => {
    // A repeated ?cwd= makes Fastify hand us an array; take the last value
    // rather than silently falling back to $HOME and listing the wrong
    // directory's history.
    const raw = req.query?.cwd;
    const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    const cwd = typeof value === 'string' && value ? value : homeDir();
    return listResumableSessions(cwd, app.log);
  });

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
  // The signal name is advisory: it is honored on POSIX and ignored on Windows,
  // where node-pty has no signal support and the pseudoconsole is closed
  // instead. Distinguishes "no such session" from "could not be stopped" so a
  // failure isn't reported as success.
  app.post('/api/sessions/:id/kill', async (req, reply) => {
    const signal = (req.body && req.body.signal) || 'SIGTERM';
    if (!sessionManager.get(req.params.id)) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    if (!sessionManager.kill(req.params.id, signal)) {
      return reply.code(500).send({ error: 'Session could not be stopped' });
    }
    return { ok: true };
  });

  // Remove from roster (force-kills if still running).
  app.delete('/api/sessions/:id', async (req, reply) => {
    if (!sessionManager.get(req.params.id)) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    if (!sessionManager.remove(req.params.id)) {
      // Still running and unkillable — keep it in the roster so the UI still
      // shows it (and can retry) rather than orphaning an invisible process.
      return reply.code(500).send({ error: 'Session is still running and could not be killed' });
    }
    return { ok: true };
  });
}
