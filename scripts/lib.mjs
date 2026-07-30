// Shared helpers for the cross-platform npm scripts.
//
// These replace what setup.sh / dev.sh / start.sh used to shell out to. The
// bash versions could not run on Windows at all (`bash` is absent from cmd and
// PowerShell), and several of the tools they relied on — lsof, ps -o, setsid,
// fractional sleep, negative-PID kill — are either missing or differently
// spelled across macOS, Linux distros and busybox. Doing it in Node keeps one
// implementation that behaves the same everywhere.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const IS_WINDOWS = process.platform === 'win32';

/**
 * Run a command, inheriting stdio, and resolve with its exit code.
 *
 * `shell: true` on Windows is required for npm itself: npm is a `npm.cmd`
 * shim there, and CreateProcess cannot execute a .cmd directly. It is
 * deliberately NOT used for anything taking untrusted input — these commands
 * are all fixed strings from this file.
 */
export function run(cmd, args, opts = {}) {
  const { onSpawn, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: IS_WINDOWS,
      ...spawnOpts,
    });
    // Hand the caller the handle so a long-running foreground child can still
    // be torn down on signal. Without this a programmatic SIGTERM (a
    // supervisor, an editor's stop button) kills only the script and orphans
    // the child; interactive Ctrl-C hides the bug because the TTY signals the
    // whole foreground group.
    onSpawn?.(child);
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

/** Run a command and fail the script if it does not exit 0. */
export async function runOrDie(cmd, args, opts) {
  const code = await run(cmd, args, opts);
  if (code !== 0) {
    console.error(`\n!! ${cmd} ${args.join(' ')} failed with exit code ${code}`);
    process.exit(code);
  }
}

/** npm, spelled the way the current platform can execute it. */
export const NPM = IS_WINDOWS ? 'npm.cmd' : 'npm';

/**
 * Is something already listening on this TCP port?
 *
 * Replaces `lsof -ti tcp:PORT`, which is absent on Windows and not installed
 * by default on Debian slim / Alpine / most containers — where the old script
 * silently treated "lsof missing" as "port free" and then died on EADDRINUSE,
 * the exact case its preflight existed to prevent.
 */
export function isPortBusy(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(700);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/** Wait until `port` stops accepting connections, or the deadline passes. */
export async function waitForPortFree(port, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortBusy(port))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !(await isPortBusy(port));
}

/**
 * Terminate a child and everything it spawned.
 *
 * The bash version tried `kill -- -$PID` to signal the process group, but a
 * background job in a non-interactive script is not a group leader, so that
 * failed and only the npm wrapper died — leaving `node --watch` and its PTY
 * children holding the port. Here: taskkill /T walks the tree on Windows, and
 * on POSIX we spawn the child with detached:true so it *is* a group leader and
 * the negative-PID signal genuinely reaches the whole group.
 */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (IS_WINDOWS) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      shell: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
