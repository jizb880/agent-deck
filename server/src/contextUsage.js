import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { claudeProjectsDir } from './config.js';
import { codexRolloutPath } from './codexSessions.js';

/**
 * How full a session's context window is.
 *
 * The CLIs compute this for their own status lines, but only inside the TUI:
 * neither writes the figure anywhere convenient, and the number on screen is
 * repainted constantly, so there is nothing stable to scrape. What both *do*
 * record is the token accounting the API returned for each call, which is
 * exactly what occupies the window.
 *
 * Claude Code:  input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * Codex:        input_tokens (its `cached_input_tokens` is a subset of it)
 *
 * `input_tokens` alone is misleading for Claude: with prompt caching almost the
 * whole conversation arrives as `cache_read`, so a nearly-full window can
 * report `input_tokens: 4`. Summing the three gives the size of the prompt that
 * was sent, which is the quantity a percentage is taken of.
 */

// Context windows by model, in tokens. Read from the transcript's model field;
// an unrecognized model falls back to DEFAULT_WINDOW rather than showing a
// percentage that could be off by a factor of several.
//
// Order matters: the newest generation of each family carries a 1M window, so
// its patterns have to sit above the family's older, 200K entries. A `[1m]`
// suffix anywhere always wins, since that is the explicit opt-in spelling.
const WINDOW_BY_MODEL = [
  [/\[1m\]/i, 1_000_000],
  [/1000000/i, 1_000_000],
  // Current-generation models: 1M. Measured transcripts of fable-5-1 reach
  // 926K tokens and opus-5 reaches 294K, both impossible under a 200K window;
  // treating them as 200K pinned every large session at 100%.
  [/fable|mythos/i, 1_000_000],
  [/\bopus-5/i, 1_000_000],
  [/\bsonnet-5/i, 1_000_000],
  [/haiku-5/i, 1_000_000],
  // Older generations keep the 200K window.
  [/haiku/i, 200_000],
  [/sonnet/i, 200_000],
  [/opus/i, 200_000],
];
const DEFAULT_WINDOW = 200_000;
// Buckets a window may be promoted to when the transcript shows more tokens
// than the model-based guess allows. A prompt cannot exceed its own window, so
// an overrun means the guess was wrong, not the measurement.
const WINDOW_BUCKETS = [200_000, 1_000_000];

/** Context window size in tokens for a model id, or the default. */
export function contextWindowFor(model) {
  if (typeof model !== 'string') return DEFAULT_WINDOW;
  for (const [re, size] of WINDOW_BY_MODEL) {
    if (re.test(model)) return size;
  }
  return DEFAULT_WINDOW;
}

/**
 * The smallest standard window that can hold `tokens`.
 *
 * A model the table does not know about (or an entry that predates the model
 * string we recognize) would otherwise read as permanently 100% once the
 * conversation outgrows the assumed window — exactly the stale figure that made
 * /compact look like it had done nothing.
 */
export function windowFitting(tokens, assumed) {
  const floor = Number(assumed) > 0 ? Number(assumed) : DEFAULT_WINDOW;
  // When the assumed window already holds the token count (codex records its
  // own window; a caller passes a known figure), trust it rather than
  // rounding up to a bigger bucket — a session with a 258K window should not
  // show the same occupancy as one with a 1M window.
  if (floor >= tokens) return floor;
  // The assumed figure is stale: tokens exceed the window. Promote to the
  // smallest standard bucket that fits.
  for (const size of WINDOW_BUCKETS) {
    if (size >= tokens) return size;
  }
  return Math.max(floor, ...WINDOW_BUCKETS);
}

/** Percent of the window occupied, clamped to 0..100. */
function percentOf(tokens, window) {
  if (!(window > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((tokens / window) * 100)));
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
 * Returns { tokens, model, window? } or null when the tail holds no usage
 * record. `window` is set only when the entry pins it itself (a compaction
 * boundary), in which case it wins over the model's table entry.
 */
export function latestUsageFromText(text) {
  if (!text) return null;
  const lines = text.split('\n');
  // Occupancy recorded by the newest compact_boundary, held until a model id
  // turns up. The boundary itself carries no model, and without one the window
  // would fall back to 200K — which reads a freshly compacted 1M-window
  // session as several times fuller than it is.
  let boundary = null;
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
    // This has to come first: sub-agents compact too, and their boundaries
    // would otherwise be read as the main conversation's.
    if (entry.isSidechain) continue;
    // A compact_boundary entry records postTokens — the token count immediately
    // after /compact ran. It lands at the tail and must win over any older
    // assistant turn, but the model id has to be borrowed from that older turn,
    // so keep scanning after finding it instead of returning straight away.
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      if (!boundary) {
        const postTokens = Number(entry?.compactMetadata?.postTokens);
        const preTokens = Number(entry?.compactMetadata?.preTokens);
        if (postTokens > 0) {
          boundary = { tokens: postTokens, window: null };
        } else if (preTokens > 0) {
          // Auto-compaction writes the boundary before the post-compact turn
          // exists and records only preTokens. Reporting it is still progress:
          // the pre-compact figure is not a *stale* reading, and the first
          // assistant turn written after the boundary lowers it.
          boundary = { tokens: preTokens, window: windowFitting(preTokens, DEFAULT_WINDOW) };
        }
      }
      continue;
    }
    const usage = entry?.message?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const tokens =
      (Number(usage.input_tokens) || 0) +
      (Number(usage.cache_creation_input_tokens) || 0) +
      (Number(usage.cache_read_input_tokens) || 0);
    if (tokens <= 0) continue;
    const model = entry?.message?.model || null;
    if (boundary) {
      // The window inferred from preTokens is only a guess; a real model id
      // supersedes it.
      return { tokens: boundary.tokens, model, window: model ? null : boundary.window };
    }
    return { tokens, model };
  }
  return boundary ? { tokens: boundary.tokens, model: null, window: boundary.window } : null;
}

/**
 * Scan a Codex rollout tail for its token accounting.
 *
 * Codex writes one line per event and marks the token figures explicitly:
 * `token_usage_record` carries the usage block and an `event_msg` carries
 * `model_context_window`. Only input tokens occupy the window, and codex counts
 * `cached_input_tokens` as a subset of `input_tokens` (unlike Claude, where the
 * cached counts are separate fields), so the input figure is taken as-is.
 *
 * Returns { tokens, window, model } or null when the tail holds no usage.
 */
export function latestCodexUsageFromText(text) {
  if (!text) return null;
  const lines = text.split('\n');
  let tokens = null;
  let window = null;
  // Walk backwards so the newest of each field wins, without needing the two to
  // sit on the same line -- codex writes them in different records.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry?.payload;
    if (!payload || typeof payload !== 'object') continue;
    if (tokens === null && entry.type === 'token_usage_record') {
      const n = Number(payload?.usage?.input_tokens);
      if (Number.isFinite(n) && n > 0) tokens = n;
    }
    // A thread with no turn recorded yet — the live turn only updates
    // `token_count` until it finishes — still carries the running total of the
    // conversation so far. That figure is the occupancy of the *current* prompt:
    // total_tokens is a cumulative bill across the thread, while its
    // input_tokens accumulates every turn's prompt, which would climb past the
    // real occupancy. last_token_usage.input_tokens is this turn's prompt.
    if (tokens === null && entry.type === 'token_count') {
      const n = Number(payload?.info?.last_token_usage?.input_tokens);
      if (Number.isFinite(n) && n > 0) tokens = n;
    }
    if (window === null) {
      // Newer records (event_msg) carry model_context_window at payload top-level;
      // older token_count records tuck it inside payload.info instead.
      const raw = payload.model_context_window ?? payload?.info?.model_context_window;
      const w = Number(raw);
      if (Number.isFinite(w) && w > 0) window = w;
    }
    if (tokens !== null && window !== null) break;
  }
  if (tokens === null) return null;
  // Codex usually records its own window; when it has not (or an older build
  // omits it) fall back to the same default the Claude path uses. Even a
  // recorded window is promoted when the token count exceeds it: exceeding a
  // window is evidence the figure is stale, and a stale window reads as a
  // permanent 100%.
  const assumed = window || DEFAULT_WINDOW;
  return { tokens, window: windowFitting(tokens, assumed), model: null };
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
export async function contextUsageFor({ cwd, sessionId, kind }) {
  if (!sessionId || typeof sessionId !== 'string') return null;

  if (kind === 'codex') {
    const rolloutPath = await codexRolloutPath(sessionId);
    if (!rolloutPath) return null;
    const text = await readTail(rolloutPath);
    if (text === null) return null;
    const usage = latestCodexUsageFromText(text);
    if (!usage) return null;
    const percent = percentOf(usage.tokens, usage.window);
    return { tokens: usage.tokens, window: usage.window, percent, model: usage.model };
  }

  const file = await findTranscript(cwd, sessionId);
  if (!file) return null;
  const text = await readTail(file);
  if (text === null) return null;
  const usage = latestUsageFromText(text);
  if (!usage) return null;

  // A boundary entry pins its own window (see latestUsageFromText); otherwise
  // the model names it, with windowFitting covering the case where the model is
  // unknown or the conversation has outgrown the size the table assumes.
  const window = usage.window || windowFitting(usage.tokens, contextWindowFor(usage.model));
  const percent = percentOf(usage.tokens, window);
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
  const window = usage.window || windowFitting(usage.tokens, contextWindowFor(usage.model));
  const percent = percentOf(usage.tokens, window);
  return { tokens: usage.tokens, window, percent, model: usage.model };
}
