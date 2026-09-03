// transcriptExists() decides whether a Recent-list reopen can --resume or has
// to start fresh. Exercised against a throwaway projects root so it never
// touches ~/.claude.
//
// Run with: node --test server/test/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ID = '92d24c92-b5c5-4329-aedf-d51633d1cd6e';

async function withProjectsRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlapp-proj-'));
  const saved = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = root;
  try {
    // Imported inside so the env override is in place before config reads it
    // (claudeProjectsDir() reads it per call anyway; this keeps intent clear).
    const m = await import('../src/claudeSessions.js');
    return await fn(m.transcriptExists, root);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = saved;
  }
}

test('finds the transcript via the encoded directory name', async () => {
  await withProjectsRoot(async (transcriptExists, root) => {
    const cwd = path.join(os.tmpdir(), 'proj-a');
    const enc = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
    fs.mkdirSync(path.join(root, enc), { recursive: true });
    fs.writeFileSync(path.join(root, enc, `${ID}.jsonl`), '{}\n');
    assert.equal(await transcriptExists(cwd, ID), true);
  });
});

test('falls back to a blind scan when the encoding guess misses', async () => {
  await withProjectsRoot(async (transcriptExists, root) => {
    // Simulate a directory spelled differently from our guess (Windows).
    fs.mkdirSync(path.join(root, 'some-other-encoding'), { recursive: true });
    fs.writeFileSync(path.join(root, 'some-other-encoding', `${ID}.jsonl`), '{}\n');
    assert.equal(await transcriptExists('C:\\Users\\x\\proj', ID), true);
  });
});

test('reports false when no project dir holds the transcript', async () => {
  await withProjectsRoot(async (transcriptExists, root) => {
    fs.mkdirSync(path.join(root, 'unrelated'), { recursive: true });
    assert.equal(await transcriptExists('/tmp/whatever', ID), false);
  });
});

test('reports null only when the projects root is unreadable', async () => {
  await withProjectsRoot(async (transcriptExists, root) => {
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(await transcriptExists('/tmp/whatever', ID), null);
  });
});

test('a malformed id is never "resumable"', async () => {
  await withProjectsRoot(async (transcriptExists) => {
    assert.equal(await transcriptExists('/tmp/x', 'nope'), false);
  });
});
