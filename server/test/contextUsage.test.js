// Context occupancy is derived from a Claude transcript's token accounting:
// the CLI shows the figure only on its own status line, so the recorded API
// usage is the only durable source.
//
// Exercised against a throwaway projects root so it never reads ~/.claude.
//
// Run with: node --test server/test/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const SESSION_ID = '92d24c92-b5c5-4329-aedf-d51633d1cd6e';

/** Import contextUsage.js with CLAUDE_PROJECTS_DIR pointed at `root`. */
async function withProjectsRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlapp-ctx-'));
  const saved = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = root;
  try {
    const m = await import('../src/contextUsage.js');
    return await fn(m, root);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = saved;
  }
}

/** The directory Claude Code would use for `cwd`. */
const dirFor = (root, cwd) =>
  path.join(root, path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));

/** One assistant turn carrying an API usage block. */
function turn({ input = 0, cacheCreate = 0, cacheRead = 0, model = 'claude-sonnet-5', sidechain = false } = {}) {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: sidechain,
    message: {
      model,
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
        output_tokens: 10,
      },
    },
  });
}

function writeTranscript(root, cwd, lines) {
  const dir = dirFor(root, cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('the window size follows the model', async () => {
  await withProjectsRoot(async (m) => {
    assert.equal(m.contextWindowFor('claude-sonnet-5'), 200_000);
    assert.equal(m.contextWindowFor('claude-opus-5'), 200_000);
    assert.equal(m.contextWindowFor('claude-haiku-4-5-20251001'), 200_000);
    assert.equal(m.contextWindowFor('claude-sonnet-5[1m]'), 1_000_000);
    // Unknown models must fall back rather than produce a nonsense percentage.
    assert.equal(m.contextWindowFor('some-future-model'), 200_000);
    assert.equal(m.contextWindowFor(null), 200_000);
  });
});

test('the newest usage record wins', async () => {
  await withProjectsRoot(async (m) => {
    const root = process.env.CLAUDE_PROJECTS_DIR;
    const cwd = path.join(os.tmpdir(), 'proj-newest');
    writeTranscript(root, cwd, [
      turn({ input: 100, cacheRead: 1_000 }),
      turn({ input: 4, cacheCreate: 50_000, cacheRead: 100_000 }),
    ]);
    const usage = await m.contextUsageFor({ cwd, sessionId: SESSION_ID });
    assert.ok(usage, 'usage found');
    // 4 + 50_000 + 100_000, not the earlier turn's smaller figure.
    assert.equal(usage.tokens, 150_004);
    assert.equal(usage.percent, 75);
  });
});

test('cached prompt tokens count toward occupancy', async () => {
  await withProjectsRoot(async (m) => {
    const root = process.env.CLAUDE_PROJECTS_DIR;
    const cwd = path.join(os.tmpdir(), 'proj-cache');
    // The shape a long conversation actually has: a tiny input_tokens with
    // almost everything arriving as a cache read. Counting input_tokens alone
    // would report ~0% for a nearly full window.
    writeTranscript(root, cwd, [turn({ input: 4, cacheCreate: 0, cacheRead: 100_000 })]);
    const usage = await m.contextUsageFor({ cwd, sessionId: SESSION_ID });
    assert.equal(usage.tokens, 100_004);
    assert.equal(usage.percent, 50);
  });
});

test('a subagent turn does not stand in for the main conversation', async () => {
  await withProjectsRoot(async (m) => {
    const root = process.env.CLAUDE_PROJECTS_DIR;
    const cwd = path.join(os.tmpdir(), 'proj-sidechain');
    writeTranscript(root, cwd, [
      turn({ input: 1_000 }),
      // Written last, so a naive "last usage wins" would report the subagent's
      // own separate window as the session's occupancy.
      turn({ input: 90_000, sidechain: true }),
    ]);
    const usage = await m.contextUsageFor({ cwd, sessionId: SESSION_ID });
    assert.equal(usage.tokens, 1_000);
  });
});

test('a long transcript is read from its tail', async () => {
  await withProjectsRoot(async (m) => {
    const root = process.env.CLAUDE_PROJECTS_DIR;
    const cwd = path.join(os.tmpdir(), 'proj-long');
    const filler = Array.from({ length: 4000 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { content: `line ${i} ${'x'.repeat(200)}` } })
    );
    // The usage record sits past any reasonable single read.
    writeTranscript(root, cwd, [...filler, turn({ input: 7, cacheRead: 60_000 })]);
    const usage = await m.contextUsageFor({ cwd, sessionId: SESSION_ID });
    assert.equal(usage.tokens, 60_007);
  });
});

test('a session with no transcript yet reports nothing', async () => {
  await withProjectsRoot(async (m) => {
    const usage = await m.contextUsageFor({
      cwd: path.join(os.tmpdir(), 'proj-missing'),
      sessionId: SESSION_ID,
    });
    assert.equal(usage, null, 'no transcript means no figure, not a zeroed one');
  });
});

test('a transcript with no usage yet reports nothing', async () => {
  await withProjectsRoot(async (m) => {
    const root = process.env.CLAUDE_PROJECTS_DIR;
    const cwd = path.join(os.tmpdir(), 'proj-nousage');
    writeTranscript(root, cwd, [JSON.stringify({ type: 'user', message: { content: 'hi' } })]);
    assert.equal(await m.contextUsageFor({ cwd, sessionId: SESSION_ID }), null);
  });
});

test('a malformed transcript does not throw', async () => {
  await withProjectsRoot(async (m) => {
    const root = process.env.CLAUDE_PROJECTS_DIR;
    const cwd = path.join(os.tmpdir(), 'proj-broken');
    writeTranscript(root, cwd, ['{ not json', 'also not json', turn({ input: 20_000 })]);
    const usage = await m.contextUsageFor({ cwd, sessionId: SESSION_ID });
    assert.equal(usage.tokens, 20_000, 'the good record is still found');
  });
});

// ---- codex ----

test('codex occupancy is read from its rollout usage record', async () => {
  await withProjectsRoot(async (m) => {
    // Codex marks the figures explicitly: a token_usage_record carries the
    // usage block and a separate event_msg carries the window size.
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'x', cwd: '/tmp/p' } }),
      JSON.stringify({
        type: 'token_usage_record',
        payload: {
          usage: { input_tokens: 16_200, cached_input_tokens: 12_288, output_tokens: 115, total_tokens: 16_315 },
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { model_context_window: 258_400 } }),
    ];
    const usage = m.latestCodexUsageFromText(lines.join('\n'));
    assert.ok(usage, 'usage found');
    // input_tokens is the whole prompt; cached_input_tokens is a subset of it,
    // so it must NOT be added on top the way Claude's separate fields are.
    assert.equal(usage.tokens, 16_200);
    assert.equal(usage.window, 258_400);
  });
});

test('codex falls back to a default window when none is recorded', async () => {
  await withProjectsRoot(async (m) => {
    const text = JSON.stringify({
      type: 'token_usage_record',
      payload: { usage: { input_tokens: 50_000, cached_input_tokens: 0, total_tokens: 50_100 } },
    });
    const usage = m.latestCodexUsageFromText(text);
    assert.equal(usage.tokens, 50_000);
    assert.equal(usage.window, 200_000, 'unknown window falls back rather than dividing by zero');
  });
});

test('the newest codex usage wins, even across record types', async () => {
  await withProjectsRoot(async (m) => {
    const text = [
      JSON.stringify({ type: 'token_usage_record', payload: { usage: { input_tokens: 1_000 } } }),
      JSON.stringify({ type: 'event_msg', payload: { model_context_window: 258_400 } }),
      JSON.stringify({ type: 'token_usage_record', payload: { usage: { input_tokens: 90_000 } } }),
    ].join('\n');
    const usage = m.latestCodexUsageFromText(text);
    assert.equal(usage.tokens, 90_000);
  });
});

test('a codex rollout with no turns yet reports nothing', async () => {
  await withProjectsRoot(async (m) => {
    const text = JSON.stringify({ type: 'session_meta', payload: { session_id: 'x' } });
    assert.equal(m.latestCodexUsageFromText(text), null);
  });
});
