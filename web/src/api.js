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
  cliKinds: () => req('GET', '/api/cli-kinds'),

  listPersonas: () => req('GET', '/api/personas'),
  createPersona: (p) => req('POST', '/api/personas', p),
  updatePersona: (id, p) => req('PUT', `/api/personas/${id}`, p),
  deletePersona: (id) => req('DELETE', `/api/personas/${id}`),

  listSessions: () => req('GET', '/api/sessions'),
  createSession: (s) => req('POST', '/api/sessions', s),
  killSession: (id, signal) => req('POST', `/api/sessions/${id}/kill`, { signal }),
  removeSession: (id) => req('DELETE', `/api/sessions/${id}`),
};
