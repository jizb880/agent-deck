import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Single source of truth for "which OS are we on". Everything platform-specific
// in the backend routes through here so the branches are greppable.
//
// These are functions rather than module-level constants deliberately: a
// constant is frozen at first import, which makes the Windows and Linux paths
// impossible to exercise from a test on a developer Mac. Reading
// process.platform at call time costs nothing and keeps every branch reachable.
export const isWindows = () => process.platform === 'win32';
export const isMac = () => process.platform === 'darwin';

// Windows and macOS default to case-insensitive filesystems; Linux is
// case-sensitive. This decides whether two paths that differ only in case name
// the same directory — get it wrong and path comparisons silently fail.
export const fsCaseInsensitive = () => isWindows() || isMac();

/**
 * Canonical key for comparing two paths for equality.
 *
 * Resolves symlinks where possible (Claude Code records a resolved cwd while
 * the dashboard is handed whatever the user typed — on macOS `/tmp/x` and
 * `/private/tmp/x` are the same directory), then folds case on filesystems
 * where case doesn't distinguish paths. Trailing separators are dropped so
 * `C:\a\b\` and `C:\a\b` match.
 */
export async function pathKey(p) {
  if (!p) return '';
  let resolved = path.resolve(p);
  try {
    // realpath also normalizes the on-disk spelling of each component, which
    // is what makes a wrong-case input match on Windows/macOS.
    resolved = await fsp.realpath(resolved);
  } catch {
    /* not on disk (yet) — the normalized form is the best we have */
  }
  let key = resolved;
  if (key.length > 1) key = key.replace(/[\\/]+$/, '');
  return fsCaseInsensitive() ? key.toLowerCase() : key;
}

/**
 * Executable-name candidates for a bare command, in resolution order.
 *
 * On Windows an npm-installed CLI is a `claude.cmd` shim, not `claude`, and
 * only a shell consults %PATHEXT% — we spawn without one, so the extension
 * has to be resolved explicitly or the spawn fails with "File not found".
 */
function execCandidates(bin) {
  if (!isWindows()) return [bin];
  if (path.extname(bin)) return [bin]; // caller was explicit
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  // .cmd/.bat first: that's what npm generates, and it's the common case.
  const preferred = ['.CMD', '.BAT', '.EXE', '.COM'];
  const ordered = [
    ...preferred.filter((e) => exts.some((x) => x.toUpperCase() === e)),
    ...exts.filter((e) => !preferred.includes(e.toUpperCase())),
  ];
  return ordered.map((e) => bin + e.toLowerCase());
}

/**
 * Find an executable on PATH, returning an absolute path, or null.
 *
 * We resolve rather than handing a bare name to the PTY because we no longer
 * go through a shell on Windows: nothing else would search PATH or apply
 * PATHEXT for us. Returning null lets the caller produce an actionable error
 * ("claude not found on PATH") instead of a raw spawn failure.
 */
export function findExecutable(bin, env = process.env) {
  if (!bin) return null;
  // An explicit path is used as given — just confirm it's there.
  if (bin.includes('/') || bin.includes('\\')) {
    return fs.existsSync(bin) ? path.resolve(bin) : null;
  }
  const pathVar = env.PATH || env.Path || '';
  const dirs = pathVar.split(isWindows() ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const name of execCandidates(bin)) {
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        // On POSIX also require the execute bit; on Windows the extension is
        // what makes a file executable and there is no such bit to check.
        if (!isWindows() && !(st.mode & 0o111)) continue;
        return full;
      } catch {
        /* next candidate */
      }
    }
  }
  return null;
}

/**
 * The user's interactive shell, for the plain `terminal` session kind.
 *
 * $SHELL is a POSIX convention that Windows never sets and that is frequently
 * absent on Linux under systemd/Docker/`su`, so it can only be a hint. The
 * fallbacks are ordered by how likely they are to actually exist: hardcoding
 * a single path (the old `/bin/zsh`) fails outright on a default Debian box.
 */
export function defaultShell(env = process.env) {
  if (isWindows()) {
    // PowerShell where available (far better interactive editing), else the
    // classic console. COMSPEC is set by Windows itself and points at cmd.exe.
    return (
      findExecutable('pwsh.exe', env) ||
      findExecutable('powershell.exe', env) ||
      env.COMSPEC ||
      'cmd.exe'
    );
  }
  const fromEnv = env.SHELL;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '/bin/sh'; // guaranteed by POSIX
}

/** Args that start `shell` as an interactive login shell. */
export function loginShellArgs(shell) {
  if (isWindows()) {
    // -NoLogo keeps the banner out of the terminal; cmd.exe needs nothing.
    return /pwsh|powershell/i.test(shell) ? ['-NoLogo'] : [];
  }
  return ['-l'];
}

/**
 * The POSIX shell used to run a CLI with the user's full environment.
 *
 * `bash -lc` is the mechanism that loads a login PATH so a CLI installed to
 * e.g. ~/.npm-global/bin is findable. bash is not guaranteed to exist on
 * Linux (Alpine ships busybox ash, NixOS puts bash elsewhere), so resolve it
 * instead of hardcoding /bin/bash.
 */
export function posixLoginShell(env = process.env) {
  return (
    findExecutable('bash', env) ||
    (fs.existsSync('/bin/bash') ? '/bin/bash' : null) ||
    findExecutable('sh', env) ||
    '/bin/sh'
  );
}

/**
 * Home directory. os.homedir() already handles %USERPROFILE% on Windows.
 * A function, not a constant, for the same reason as the platform predicates:
 * a frozen value can't be faked in a test.
 */
export const homeDir = () => os.homedir();
