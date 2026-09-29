import { execFile } from 'node:child_process';
import { CLI_KINDS } from './config.js';
import { findExecutable, isWindows, posixLoginShell } from './platform.js';

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
// that wants to download) must not hang the create request. 3s matches the
// login-PATH probe in cliDetect.js.
const PROBE_TIMEOUT_MS = 3000;

const cache = new Map();

/** Word-boundary test, so `--no-alt` cannot match `--no-alt-screen`. */
function advertises(text, flag) {
  if (!text) return false;
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(text);
}

function probe(kind, flag) {
  const spec = CLI_KINDS[kind];
  if (!spec || !spec.bin) return Promise.resolve(false);

  return new Promise((resolve) => {
    const done = (err, stdout, stderr) => {
      // clap writes --help to stdout, but some versions use stderr; consult
      // both rather than guessing. A non-zero exit still carries usable text.
      resolve(advertises(`${stdout || ''}\n${stderr || ''}`, flag));
    };
    if (isWindows()) {
      // No shell in the chain on Windows (see launcher.js), so resolve the
      // executable the same way the launcher will and invoke it directly.
      const bin = findExecutable(spec.bin, process.env);
      if (!bin) return resolve(false);
      execFile(bin, ['--help'], { timeout: PROBE_TIMEOUT_MS }, done);
      return;
    }
    // Run through the login shell so the probe searches the same PATH the
    // launch will — a CLI in ~/.npm-global/bin is otherwise invisible when the
    // dashboard was started from a GUI app with a minimal environment.
    const shell = posixLoginShell(process.env);
    execFile(
      shell,
      ['-lc', `${spec.bin} --help`],
      { timeout: PROBE_TIMEOUT_MS, env: process.env },
      done
    );
  });
}

/**
 * Promise<boolean> — does the installed CLI of this kind advertise `flag`?
 *
 * The promise itself is cached, so concurrent launches share one probe and a
 * rejection can never be observed twice.
 */
export function supportsFlag(kind, flag) {
  if (!flag) return Promise.resolve(false);
  const key = `${kind} ${flag}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const promise = probe(kind, flag).catch(() => false);
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
