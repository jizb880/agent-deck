// End-to-end attach/re-attach over the WebSocket against a real backend and a
// real shell session: the re-attach snapshot must hold what was printed
// before, exactly once, and nothing printed before the snapshot may be
// forwarded again as live output after it.
//
// Skipped on Windows (spawns a POSIX login shell) and when the port probe
// fails. Uses its own port and data dir; never touches a running dashboard.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = process.platform === 'win32';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');

test('re-attach replays the rendered history once, and forwards only newer output', { skip, timeout: 60000 }, async () => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlapp-ws-'));
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CONTROL_APP_DATA: dataDir, LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;

  try {
    await waitFor(
      () => fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false),
      20000,
      `backend on ${port}\n${log}`
    );
    // A bare shell rather than the user's login shell keeps the output tame.
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'terminal', title: 'ws-probe' }),
    });
    assert.equal(res.status, 201);
    const { id } = await res.json();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames = [];
    ws.onmessage = (e) => frames.push(JSON.parse(e.data));
    await new Promise((r) => (ws.onopen = r));
    const attach = () => ws.send(JSON.stringify({ type: 'attach', sessionId: id, cols: 100, rows: 30 }));
    const attachedFrames = () => frames.filter((f) => f.type === 'attached');
    const outputSince = (i) => frames.slice(i).filter((f) => f.type === 'output').map((f) => f.data).join('');

    attach();
    await waitFor(() => attachedFrames().length === 1, 5000, 'first attached frame');

    // Print a marker the shell echoes and executes; both copies must survive.
    ws.send(JSON.stringify({ type: 'input', sessionId: id, data: "printf 'marker-%s\\n' one two three\r" }));
    await waitFor(() => plain(outputSince(0)).includes('marker-three'), 10000, `the marker output\n${plain(outputSince(0))}`);
    await sleep(300);

    const before = frames.length;
    attach();
    await waitFor(() => attachedFrames().length === 2, 5000, 'second attached frame');
    const snap = plain(attachedFrames()[1].snapshot);
    assert.ok(snap.includes('marker-one') && snap.includes('marker-three'), `snapshot has the history:\n${snap}`);
    // The echoed command line says marker-%s; only printf's output line matches.
    assert.equal((snap.match(/marker-three/g) || []).length, 1, `no duplication in snapshot:\n${snap}`);

    await sleep(500);
    assert.ok(
      !plain(outputSince(before)).includes('marker-three'),
      `output printed before the snapshot must not be re-sent as live output:\n${plain(outputSince(before))}`
    );

    // Live output still flows after the re-attach.
    ws.send(JSON.stringify({ type: 'input', sessionId: id, data: 'echo after-reattach\r' }));
    await waitFor(() => plain(outputSince(before)).includes('after-reattach'), 5000, 'live output after re-attach');
    ws.close();
  } finally {
    if (server.exitCode === null && !server.signalCode) {
      server.kill('SIGTERM');
      await Promise.race([new Promise((r) => server.on('exit', r)), sleep(5000)]);
      if (server.exitCode === null && !server.signalCode) server.kill('SIGKILL');
    }
    server.stdout.destroy();
    server.stderr.destroy();
  }
});
