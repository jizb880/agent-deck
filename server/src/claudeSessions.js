import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { claudeProjectsDir, RESUME_LIST_LIMIT } from './config.js';
import { pathKey } from './platform.js';

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
 * Candidate directory names for a cwd, best guess first.
 *
 * The encoding is only a fast path. It is inferred from observed macOS
 * behavior and is not a documented contract, so on Windows (where a path
 * starts `C:\`) and on any future change to the scheme it may simply miss —
 * which is why listResumableSessions falls back to scanning.
 */
function dirNameCandidates(cwd) {
  const abs = path.resolve(cwd);
  const names = [abs, abs.replace(/\\/g, '/')];
  return [...new Set(names.map(encodeProjectDir))];
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

/** Collect the resumable transcripts in one project directory. */
async function scanProjectDir(dir, target, limit) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null; // not a directory we can read
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
  const BATCH = Math.max(limit, 8);
  for (let i = 0; i < candidates.length && out.length < limit; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const metas = await mapLimit(batch, 8, (c) => readTranscriptMeta(c.file));
    for (let j = 0; j < batch.length && out.length < limit; j++) {
      const meta = metas[j];
      // A transcript with no recorded cwd is kept only when the directory name
      // itself vouched for it (the fast path). During a blind scan we have no
      // evidence at all, so an unlabelled transcript is skipped rather than
      // attributed to a directory it may not belong to.
      if (!meta.cwd) {
        if (target === null) continue;
        out.push({
          sessionId: batch[j].sessionId,
          mtime: new Date(batch[j].mtime).toISOString(),
          preview: meta.preview || '',
        });
        continue;
      }
      if ((await pathKey(meta.cwd)) !== target) continue;
      out.push({
        sessionId: batch[j].sessionId,
        mtime: new Date(batch[j].mtime).toISOString(),
        preview: meta.preview || '',
      });
    }
  }
  return out;
}

/**
 * List resumable Claude Code sessions for a working directory, newest first.
 * Returns [{ sessionId, mtime, preview }].
 *
 * Two-stage lookup, because the directory-name encoding is an undocumented
 * implementation detail of another tool rather than a contract we can rely on:
 *
 *  1. Fast path — guess the encoded directory name and read just that one.
 *     This is what hits on macOS/Linux, and costs a single readdir.
 *  2. Fallback — if no guess resolves, scan the project dirs and match on the
 *     `cwd` field recorded *inside* the transcripts. Slower, but it is correct
 *     regardless of how the tool spells its directory names, which is what
 *     makes the picker work on Windows (where a path begins `C:\`) and keeps
 *     working if the scheme ever changes.
 *
 * A missing projects root is reported through `logger`: it means the path is
 * wrong or the storage layout moved, which would otherwise look identical to
 * "you simply have no history" and stay broken silently.
 */
export async function listResumableSessions(cwd, logger = null) {
  if (!cwd) return [];

  const root = claudeProjectsDir();
  const target = await pathKey(cwd);

  // Stage 1: the encoded-name guess.
  for (const name of dirNameCandidates(cwd)) {
    const found = await scanProjectDir(path.join(root, name), target, RESUME_LIST_LIMIT);
    if (found && found.length) return found;
  }

  // Stage 2: blind scan. Only the recorded cwd decides membership here, so
  // pass target through and let unlabelled transcripts be skipped.
  let dirs;
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    logger?.warn?.(
      { dir: root },
      'Claude projects dir not readable — the resume picker will always be empty ' +
        '(set CLAUDE_PROJECTS_DIR or CLAUDE_CONFIG_DIR if transcripts live elsewhere)'
    );
    return [];
  }

  // Cheap pre-filter: a directory whose name shares no alphanumeric run with
  // the target cannot hold its transcripts, whatever the encoding. This keeps
  // the scan from reading every project on the machine.
  const tokens = target.split(/[^a-z0-9]+/i).filter((t) => t.length > 2);
  const ranked = dirs
    .filter((d) => d.isDirectory())
    .map((d) => {
      const lower = d.name.toLowerCase();
      const score = tokens.reduce((n, t) => (lower.includes(t.toLowerCase()) ? n + 1 : n), 0);
      return { name: d.name, score };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const d of ranked) {
    const found = await scanProjectDir(path.join(root, d.name), target, RESUME_LIST_LIMIT);
    if (found && found.length) return found;
  }
  return [];
}
