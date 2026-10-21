import { execFile } from 'node:child_process';
import { CLI_KINDS } from './config.js';
import { findExecutable, posixLoginShell } from './platform.js';

/**
 * Whether the *installed* CLI advertises a given command-line flag.
 *
 * Some flags are the only way to fix a behaviour the dashboard depends on, but
 * passing one a CLI version doesn't know is not a no-op — it is a usage error
 * and an immediate exit. The clap-based CLIs here confirm that: an unknown
 * argument prints "error: unexpected argument ... found" and exits 2. For a
 * dashboard session that means the tab spawns and dies with nothing on screen,
 * which is the hardest kind of failure to diagnose. So a flag that only some
 * versions have is probed for rather than assumed.
 *
 * `--help` is the right question to ask, not a version comparison: it is the
 * CLI's own statement about what it parses, so a backport or a rename is still
 * answered correctly. It is also cheap (measured at ~0.12s for codex) and the
 * answer is cached for the life of the process, so it costs one spawn per CLI
 * rather than one per launch.
 *
 * Every failure mode resolves to `false` (flag not supported), which keeps the
 * pre-existing behaviour: a CLI that cannot be probed is launched exactly as it
 * was before this module existed.
 */

// A pathological install (a wrapper that blocks on the network, a first run
// that wants to download) must not hang the create request.
//
// The direct exec is the normal path and only has to cover the CLI's own
// startup (~0.17s for codex). The login-shell fallback pays the cost of
// sourcing the user's profile on top of that — measured at ~2.8s for a bare
// `bash -lc true` and ~4.6s for `codex --help` on macOS — so it gets a much
// larger budget. A 3s limit across both was what silently disabled the codex
// fix on every launch: the probe timed out, reported "unsupported", and every
// codex tab was spawned on the alternate screen with no scrollback.
// Separate knobs on purpose: the direct probe is a bare binary exec, while the
// fallback pays for the user's profile. Sharing one value would put the direct
// budget on the shell path and re-create the original bug.
const PROBE_TIMEOUT_MS = Number(process.env.CLI_PROBE_TIMEOUT_MS || 3000);
const LOGIN_SHELL_PROBE_TIMEOUT_MS = Number(
  process.env.CLI_PROBE_LOGIN_TIMEOUT_MS || 15000
);

const cache = new Map();

/** Word-boundary test, so `--no-alt` cannot match `--no-alt-screen`. */
function advertises(text, flag) {
  if (!text) return false;
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(text);
}

/**
 * Ask one path for `flag`. Resolves { supported, timedOut } so the caller can
 * tell "the binary said no" (cacheable) from "we never got an answer"
 * (not cacheable — the next launch should try again).
 */
function ask(exe, args, timeout, flag, env) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, env }, (err, stdout, stderr) => {
      // clap writes --help to stdout, but some versions use stderr; consult
      // both rather than guessing. A non-zero exit still carries usable text.
      const text = `${stdout || ''}\n${stderr || ''}`;
      if (text.trim()) {
        resolve({ supported: advertises(text, flag), timedOut: false });
        return;
      }
      // No output at all: the spawn failed or was killed. A timeout is the
      // common case (a slow login shell) and must NOT become a cached "no".
      resolve({ supported: false, timedOut: Boolean(err && (err.killed || err.signal)) });
    });
  });
}

async function probe(kind, flag) {
  const spec = CLI_KINDS[kind];
  if (!spec || !spec.bin) return { supported: false, timedOut: false };

  // Prefer the launcher's own resolution against THIS process's PATH: the
  // dashboard inherits the user's shell environment (npm run / a terminal
  // launch), so the binary is usually visible directly, and skipping the
  // login shell turns a multi-second probe into a ~0.17s one that cannot
  // time out on a profile loaded with nvm/conda/oh-my-zsh.
  const bin = findExecutable(spec.bin, process.env);
  if (bin) {
    const direct = await ask(bin, ['--help'], PROBE_TIMEOUT_MS, flag, process.env);
    if (!direct.timedOut) return direct;
    // Timed out even without the shell: fall through to the shell path, which
    // is also what a GUI-launched server with a minimal PATH needs.
  }

  // The launcher itself goes through a login shell on POSIX, so that is where
  // the CLI must be found when this process's PATH can't see it (a dashboard
  // started from a GUI app with a minimal environment).
  const shell = spec.shell !== undefined ? spec.shell : posixLoginShell(process.env);
  const viaShell = await ask(
    shell,
    ['-lc', `${spec.bin} --help`],
    LOGIN_SHELL_PROBE_TIMEOUT_MS,
    flag,
    process.env
  );
  return viaShell;
}

/**
 * Promise<boolean> — does the installed CLI of this kind advertise `flag`?
 *
 * The promise itself is cached, so concurrent launches share one probe and a
 * rejection can never be observed twice.
 *
 * Except on a timeout. A probe that never got an answer is not evidence that
 * the CLI lacks the flag — it is evidence that this machine was slow at that
 * moment. Caching the resulting `false` for the life of the process is how
 * the codex fix silently turned itself off: one slow login shell at the first
 * codex launch, and every codex tab after it ran on the alternate screen with
 * no scrollback. A timeout is therefore reported as false to this caller but
 * evicted, so the next launch probes again.
 */
export function supportsFlag(kind, flag) {
  if (!flag) return Promise.resolve(false);
  const key = `${kind} ${flag}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const promise = probe(kind, flag)
    .catch(() => ({ supported: false, timedOut: false }))
    .then((result) => {
      if (result.timedOut) cache.delete(key);
      return result.supported === true;
    });
  cache.set(key, promise);
  return promise;
}

/**
 * The flag that takes codex out of the alternate screen (see config.js), or
 * false when this codex build does not have it.
 */
export function codexSupportsNoAltScreen() {
  const spec = CLI_KINDS.codex;
  return supportsFlag('codex', spec && spec.noAltScreenFlag);
}

/** Drop cached probe results so the next call re-probes. Used by tests. */
export function resetCliCapabilitiesCache() {
  cache.clear();
}
