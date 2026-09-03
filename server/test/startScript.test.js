// `npm start` lifecycle: stopping the wrapper must stop the backend it spawned
// and must not disturb a persisted session history the backend never touched.
//
// Runs the real scripts/start.mjs on a free port with its own data dir. Skipped
// when the frontend is not built (start.mjs would build it first — minutes,
// not seconds) and on Windows, where process groups don't exist and taskkill
// does the tree walk instead.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = path.join(ROOT, 'web', 'dist', 'index.html');
const skip = process.platform === 'win32' || !fs.existsSync(DIST_INDEX);

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

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(500);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test(
  'SIGTERM to start.mjs stops the backend and keeps an untouched history file',
  { skip, timeout: 60000 },
  async () => {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlapp-start-'));
    const historyFile = path.join(dataDir, 'session-history.json');
    const seeded = JSON.stringify([
      { id: 'seed', kind: 'terminal', title: 'seed', cwd: os.homedir(), createdAt: 1, lastActivity: 1 },
    ]);
    fs.writeFileSync(historyFile, seeded);

    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        CONTROL_APP_DATA: dataDir,
        LOG_LEVEL: 'info', // the assertion below reads an info-level line
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

    try {
      await waitFor(() => portOpen(port), 20000, `the backend to listen on ${port}\n${output}`);
      // The backend read the seeded file at startup, and only that.
      await waitFor(() => /session history: 1 entries loaded/.test(output), 5000, 'the startup log line');

      child.kill('SIGTERM');
      const { code } = await Promise.race([exited, sleep(8000).then(() => ({ code: 'timeout' }))]);
      assert.notEqual(code, 'timeout', `start.mjs did not exit after SIGTERM\n${output}`);
      assert.equal(code, 0);

      assert.ok(!(await portOpen(port)), `port ${port} still open after the wrapper exited (backend orphaned?)`);
      assert.equal(fs.readFileSync(historyFile, 'utf8'), seeded, 'nothing changed, so nothing was written');
      assert.ok(!fs.existsSync(historyFile + '.tmp'));
      assert.ok(!fs.existsSync(historyFile + '.flush.tmp'));
    } finally {
      // On a failure, stop politely first so start.mjs can take its (detached)
      // backend down with it; SIGKILL alone would orphan the backend, and the
      // pipes it inherited would then keep this test process alive forever.
      if (child.exitCode === null && !child.signalCode) {
        child.kill('SIGTERM');
        await Promise.race([exited, sleep(6000)]);
        if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
      }
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
);
