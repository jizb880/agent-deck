import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { CLAUDE_PROJECTS_DIR, RESUME_LIST_LIMIT } from './config.js';

const JSONL = '.jsonl';

// A transcript file is named <uuid>.jsonl, and `claude --resume` takes that
// uuid. Anything else in the directory (lock files, per-session subdirs) is
// not resumable, so this doubles as the validator for an id coming from a
// client — see normalizeSessionId.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Trim and validate a client-supplied session id, returning the canonical
 * form or null. Callers must use the RETURNED value, never the input: an id
 * pasted with a trailing newline is accepted here but would be passed through
 * to the CLI verbatim if the raw string were used, and `claude` then rejects
 * it as unknown — a spawn-and-instantly-die with no visible cause.
 */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return SESSION_ID_RE.test(id) ? id : null;
}

/**
 * Claude Code stores a project's transcripts in a directory named after its
 * cwd with every non-alphanumeric character replaced by a dash. That mapping
 * is lossy — `/a/b_c`, `/a/b-c` and `/a/b.c` all land in `-a-b-c`, and a CJK
 * path collapses to a run of dashes — so the directory name alone can't prove
 * a transcript belongs to the cwd we were asked about. We use it to *find*
 * candidates and then confirm each one against the `cwd` recorded inside the
 * transcript.
 */
function encodeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Canonical form for comparing two paths that may differ only by symlinks.
 * Claude Code records the *resolved* cwd, while the dashboard is handed
 * whatever the user typed — on macOS `/tmp/x` and `/private/tmp/x` are the
 * same directory, so a plain path.resolve comparison would reject every
 * transcript and show an empty picker.
 */
async function canonicalPath(p) {
  const abs = path.resolve(p);
  try {
    return await fsp.realpath(abs);
  } catch {
    return abs; // not on disk (yet) — normalized form is the best we have
  }
}

// Cap how much of a transcript we read. MAX_LINES alone is not a bound: a
// single JSONL entry holding a large tool result can be hundreds of KB, and a
// transcript whose opening lines are all slash-command wrappers would
// otherwise pull megabytes looking for a preview that never comes.
const MAX_SCAN_BYTES = 256 * 1024;
const MAX_SCAN_LINES = 400;
// Entries this large never contain the two short fields we want, so skip the
// parse rather than materializing the object.
const MAX_PARSE_BYTES = 64 * 1024;

/**
 * Read just enough of a transcript to describe it in a picker: the cwd it ran
 * in, and the first thing the user actually typed. Stops at the first entry
 * that supplies both, or at the scan budget above — never reads the whole
 * file (they routinely reach tens of MB).
 */
async function readTranscriptMeta(file) {
  // A small highWaterMark matters here: what we need is almost always in the
  // first ~2 KB, and the default 64 KB chunk would be read and utf8-decoded
  // in full for every transcript on every request.
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 8192 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = null;
  let preview = null;
  let lines = 0;
  let bytes = 0;
  try {
    for await (const line of rl) {
      bytes += line.length;
      if (++lines > MAX_SCAN_LINES || bytes > MAX_SCAN_BYTES) break;
      if (!line || line.length > MAX_PARSE_BYTES) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a partially-flushed last line is normal for a live session
      }
      if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;
      if (!preview) {
        const text = userText(entry);
        if (text) preview = text;
      }
      if (cwd && preview) break;
    }
  } catch {
    // Unreadable or truncated (permissions, mid-write). Fall through with
    // whatever we got; the caller treats a missing preview as "no summary".
  } finally {
    rl.close();
    stream.destroy();
  }
  return { cwd, preview };
}

// Wrappers Claude Code puts around things the user did not literally type:
// slash-command plumbing and pasted-file/caveat expansions. These make
// useless previews, so we skip the entry and look at the next user message.
// Matched by name rather than "starts with '<'" so a real prompt like
// "<div> is not rendering" is still shown.
const WRAPPER_TAG_RE = /^<(command-name|command-message|command-args|local-command-[a-z-]+|user-prompt-submit-hook|system-reminder)\b/;

// Pull display text out of a user entry, or null if this entry is not a real
// typed prompt. Content arrives either as a plain string or as content blocks
// (always blocks once a message carries an attachment), so handle both —
// string-only would leave those sessions with a blank preview.
function userText(entry) {
  if (entry?.type !== 'user') return null;
  const content = entry?.message?.content;
  let raw = '';
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ');
  }
  const text = raw.trim();
  if (!text || WRAPPER_TAG_RE.test(text)) return null;
  // Collapse whitespace so a multi-line prompt stays one line in a <select>.
  return text.replace(/\s+/g, ' ').slice(0, 120);
}

// Run an async mapper over items with bounded concurrency, preserving order.
// Transcript reads are latency-bound (each is an independent open+read), so
// serializing them multiplies wall time on slow or network-backed volumes;
// unbounded fan-out would instead burst a file descriptor per candidate.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * List resumable Claude Code sessions for a working directory, newest first.
 * Returns [{ sessionId, mtime, preview }].
 *
 * A missing project directory yields [] — that's the normal "no history for
 * this cwd yet" answer. A missing *projects root* is different: it means the
 * configured path is wrong or Claude Code changed where it stores
 * transcripts, which would otherwise present as "you have no history
 * anywhere, forever" with nothing in the log. That case is reported through
 * `logger` so it is diagnosable.
 */
export async function listResumableSessions(cwd, logger = null) {
  if (!cwd) return [];

  const target = await canonicalPath(cwd);
  // Try the encoded name for both the canonical and the as-given path: the
  // transcripts were named after whichever form Claude Code saw.
  const names = [...new Set([target, path.resolve(cwd)].map(encodeProjectDir))];

  let entries = null;
  let dir = null;
  for (const name of names) {
    const candidate = path.join(CLAUDE_PROJECTS_DIR, name);
    try {
      entries = await fsp.readdir(candidate);
      dir = candidate;
      break;
    } catch {
      /* try the next spelling */
    }
  }
  if (!entries) {
    try {
      await fsp.access(CLAUDE_PROJECTS_DIR);
    } catch {
      logger?.warn?.(
        { dir: CLAUDE_PROJECTS_DIR },
        'Claude projects dir not found — resume picker will always be empty (set CLAUDE_PROJECTS_DIR?)'
      );
    }
    return [];
  }

  const stats = await mapLimit(
    entries.filter((n) => path.extname(n) === JSONL),
    16,
    async (name) => {
      const file = path.join(dir, name);
      try {
        const st = await fsp.stat(file);
        if (!st.isFile() || st.size === 0) return null;
        return { sessionId: path.basename(name, JSONL), file, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    }
  );

  const candidates = stats
    .filter((c) => c && SESSION_ID_RE.test(c.sessionId))
    .sort((a, b) => b.mtime - a.mtime);

  // Read in newest-first batches and stop once enough transcripts have passed
  // the cwd check. Capping *before* the check would let foreign transcripts
  // from a dashed-name collision consume the budget and hide this directory's
  // real history behind an empty picker.
  const out = [];
  const BATCH = Math.max(RESUME_LIST_LIMIT, 8);
  for (let i = 0; i < candidates.length && out.length < RESUME_LIST_LIMIT; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const metas = await mapLimit(batch, 8, (c) => readTranscriptMeta(c.file));
    for (let j = 0; j < batch.length && out.length < RESUME_LIST_LIMIT; j++) {
      const meta = metas[j];
      // A transcript with no recorded cwd is kept: more likely an old/short
      // session than a foreign one, and dropping it would silently hide
      // resumable history.
      if (meta.cwd && (await canonicalPath(meta.cwd)) !== target) continue;
      out.push({
        sessionId: batch[j].sessionId,
        mtime: new Date(batch[j].mtime).toISOString(),
        preview: meta.preview || '',
      });
    }
  }
  return out;
}
