// Thin REST client for personas + sessions. Same-origin (Vite proxies in dev).
async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  // Reports the server's platform and home dir so the UI can show path
  // examples that match the machine the CLIs actually run on.
  health: () => req('GET', '/api/health'),

  cliKinds: () => req('GET', '/api/cli-kinds'),

  listPersonas: () => req('GET', '/api/personas'),
  createPersona: (p) => req('POST', '/api/personas', p),
  updatePersona: (id, p) => req('PUT', `/api/personas/${id}`, p),
  deletePersona: (id) => req('DELETE', `/api/personas/${id}`),

  // Resumable Claude Code conversations recorded for a working directory.
  listClaudeSessions: (cwd) =>
    req('GET', `/api/claude-sessions?cwd=${encodeURIComponent(cwd || '')}`),

  listSessions: () => req('GET', '/api/sessions'),
  createSession: (s) => req('POST', '/api/sessions', s),
  renameSession: (id, title) => req('PATCH', `/api/sessions/${id}`, { title }),
  killSession: (id, signal) => req('POST', `/api/sessions/${id}/kill`, { signal }),
  removeSession: (id) => req('DELETE', `/api/sessions/${id}`),

  // Persisted session history (survives backend restarts). Reopen returns
  // { session, resumed } — resumed:false means the stored conversation was
  // gone and a fresh session was started instead.
  listSessionHistory: () => req('GET', '/api/session-history'),
  removeSessionHistory: (id) => req('DELETE', `/api/session-history/${id}`),
  reopenSessionHistory: (id) => req('POST', `/api/session-history/${id}/reopen`),
};
