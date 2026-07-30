import { execFile } from 'node:child_process';
import { CLI_KINDS } from './config.js';
import { findExecutable, isWindows, posixLoginShell } from './platform.js';

/**
 * Which agent CLIs are actually installed on this machine.
 *
 * The UI uses this to offer a launch button only for CLIs that exist, so a
 * machine without OpenCode doesn't advertise a button that could only fail at
 * spawn time with "not found on PATH".
 *
 * The subtlety is *which* PATH to search. On POSIX the launcher runs the CLI
 * through `bash -lc`, so the effective PATH is the login shell's — which is
 * routinely wider than this server's own (a dashboard started from a GUI app,
 * launchd, or systemd inherits a minimal PATH, while the CLIs live in
 * ~/.npm-global/bin or a version-manager shim dir). Probing process.env.PATH
 * alone would report "not installed" for a CLI that launches perfectly well.
 * So we ask the login shell for its PATH once and search that.
 */

// Cache the login shell's PATH: it costs a process spawn and does not change
// while the dashboard runs.
let loginPathPromise = null;

function readLoginShellPath() {
  if (loginPathPromise) return loginPathPromise;
  loginPathPromise = new Promise((resolve) => {
    if (isWindows()) {
      // No login-shell step on Windows — the launcher resolves against this
      // process's PATH/PATHEXT, so that is the honest thing to search.
      resolve(null);
      return;
    }
    const shell = posixLoginShell(process.env);
    // Printing $PATH from a login shell reproduces exactly the lookup the
    // launcher will do. A 3s cap keeps a pathological rc file (one that blocks
    // on network or prompts) from hanging the first /api/cli-kinds request.
    execFile(shell, ['-lc', 'printf %s "$PATH"'], { timeout: 3000 }, (err, stdout) => {
      const value = typeof stdout === 'string' ? stdout.trim() : '';
      resolve(err || !value ? null : value);
    });
  });
  return loginPathPromise;
}

// Detection results are cached briefly: the list is requested on every page
// load (and per launch dialog), but a user who installs a CLI while the
// dashboard is open should see its button appear without a restart.
const TTL_MS = 30_000;
let cache = { at: 0, value: null };

/**
 * Resolve every known CLI kind, newest detection at most TTL_MS old.
 *
 * Returns [{ id, label, available, path, resume }]. `terminal` has no binary —
 * it spawns the user's own shell — so it is always available.
 */
export async function detectCliKinds({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < TTL_MS) return cache.value;

  const loginPath = await readLoginShellPath();
  // Search the login PATH when we have one, falling back to our own. Both are
  // consulted so a CLI visible to only one of them is still found.
  const env = loginPath
    ? { ...process.env, PATH: [loginPath, process.env.PATH].filter(Boolean).join(':') }
    : process.env;

  const value = Object.entries(CLI_KINDS).map(([id, spec]) => {
    if (!spec.bin) {
      return { id, label: spec.label, available: true, path: null, resume: !!spec.resume };
    }
    const resolved = findExecutable(spec.bin, env);
    return {
      id,
      label: spec.label,
      available: !!resolved,
      path: resolved,
      resume: !!spec.resume,
    };
  });

  cache = { at: now, value };
  return value;
}

/** Drop the cache, so the next detect re-probes. Used by tests. */
export function resetCliDetectCache() {
  cache = { at: 0, value: null };
  loginPathPromise = null;
}
