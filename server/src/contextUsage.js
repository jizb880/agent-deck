import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { claudeProjectsDir } from './config.js';

/**
 * How full a Claude Code session's context window is.
 *
 * The CLI computes this for its own status line, but only inside the TUI: it
 * never writes the figure to the transcript, and the number on screen is
 * repainted constantly, so there is nothing stable to scrape. What the
 * transcript *does* record, on every assistant turn, is the token accounting
 * the API returned for that call — and the sum of the input side of that is
 * exactly what occupies the context window:
 *
 *   input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *
 * `input_tokens` alone is misleading: with prompt caching almost the whole
 * conversation arrives as `cache_read`, so a nearly-full window can report
 * `input_tokens: 4`. All three together are the size of the prompt that was
 * sent, which is the quantity the CLI shows a percentage of.
 */

// Context windows by model, in tokens. Read from the transcript's model field;
// an unrecognized model falls back to DEFAULT_WINDOW rather than showing a
// percentage that could be off by a factor of several.
const WINDOW_BY_MODEL = [
  [/\[1m\]/i, 1_000_000],
  [/1000000/i, 1_000_000],
  [/haiku/i, 200_000],
  [/sonnet/i, 200_000],
  [/opus/i, 200_000],
  [/fable|mythos/i, 200_000],
];
const DEFAULT_WINDOW = 200_000;

/** Context window size in tokens for a model id, or the default. */
export function contextWindowFor(model) {
  if (typeof model !== 'string') return DEFAULT_WINDOW;
  for (const [re, size] of WINDOW_BY_MODEL) {
    if (re.test(model)) return size;
  }
  return DEFAULT_WINDOW;
}

// How much of the transcript tail to read. Usage lives on every assistant
// entry, so the last few hundred KB always contains one; this bounds the read
// for a transcript that has grown to hundreds of MB.
const TAIL_BYTES = 256 * 1024;

/** Read the last `maxBytes` of a file as UTF-8, discarding a partial first line. */
async function readTail(file, maxBytes = TAIL_BYTES) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const { size } = await handle.stat();
    if (size === 0) return '';
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    await handle.read(buf, 0, length, start);
    const text = buf.toString('utf8');
    // A non-zero start almost certainly cuts a line in half; drop everything
    // before the first newline so the caller never sees a broken record.
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1);
  } catch {
    return null;
  } finally {
    try {
      await handle?.close();
    } catch {
      /* nothing to close */
    }
  }
}

/**
 * Scan a transcript tail for the most recent token accounting.
 * Returns { tokens, model } or null when the tail holds no usage record.
 */
export function latestUsageFromText(text) {
  if (!text) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // A sidechain entry is a sub-agent's own conversation with its own separate
    // context window, so it must not be mistaken for the main one's occupancy.
    if (entry.isSidechain) continue;
    const usage = entry?.message?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const tokens =
      (Number(usage.input_tokens) || 0) +
      (Number(usage.cache_creation_input_tokens) || 0) +
      (Number(usage.cache_read_input_tokens) || 0);
    if (tokens <= 0) continue;
    return { tokens, model: entry?.message?.model || null };
  }
  return null;
}

/**
 * Locate a Claude Code transcript by session id.
 *
 * The directory is named after the session's cwd with every non-alphanumeric
 * character replaced by a dash (see claudeSessions.encodeProjectDir), so the
 * guess is tried first and a scan of the project dirs backstops it for the
 * cases that encoding does not round-trip — a Windows path, or one that
 * collapsed to a run of dashes.
 */
async function findTranscript(cwd, sessionId) {
  const root = claudeProjectsDir();
  const file = `${sessionId}.jsonl`;
  const isFile = async (p) => {
    try {
      return (await fsp.stat(p)).isFile();
    } catch {
      return false;
    }
  };

  if (cwd) {
    const abs = path.resolve(cwd);
    for (const name of new Set([abs, abs.replace(/\\/g, '/')].map((p) => p.replace(/[^a-zA-Z0-9]/g, '-')))) {
      const candidate = path.join(root, name, file);
      if (await isFile(candidate)) return candidate;
    }
  }

  let dirs;
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(root, d.name, file);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Context occupancy for one session, or null when it cannot be determined
 * (no transcript yet, non-Claude session, unreadable file).
 *
 * Returns { tokens, window, percent, model }.
 */
export async function contextUsageFor({ cwd, sessionId }) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const file = await findTranscript(cwd, sessionId);
  if (!file) return null;
  const text = await readTail(file);
  if (text === null) return null;
  const usage = latestUsageFromText(text);
  if (!usage) return null;

  const window = contextWindowFor(usage.model);
  const percent = Math.max(0, Math.min(100, Math.round((usage.tokens / window) * 100)));
  return { tokens: usage.tokens, window, percent, model: usage.model };
}

/** Synchronous variant used at shutdown/teardown paths. */
export function contextUsageForSync({ cwd, sessionId }) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const root = claudeProjectsDir();
  const file = `${sessionId}.jsonl`;
  const candidates = [];
  if (cwd) {
    const abs = path.resolve(cwd);
    for (const name of new Set([abs, abs.replace(/\\/g, '/')].map((p) => p.replace(/[^a-zA-Z0-9]/g, '-')))) {
      candidates.push(path.join(root, name, file));
    }
  }
  let resolved = null;
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) {
        resolved = c;
        break;
      }
    } catch {
      /* try the next */
    }
  }
  if (!resolved) return null;

  let text = null;
  try {
    const { size } = fs.statSync(resolved);
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(resolved, 'r');
    try {
      const buf = Buffer.allocUnsafe(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const t = buf.toString('utf8');
      text = start === 0 ? t : t.slice(Math.max(0, t.indexOf('\n') + 1));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const usage = latestUsageFromText(text);
  if (!usage) return null;
  const window = contextWindowFor(usage.model);
  const percent = Math.max(0, Math.min(100, Math.round((usage.tokens / window) * 100)));
  return { tokens: usage.tokens, window, percent, model: usage.model };
}
