// Cross-platform launcher checks.
//
// The Windows and Linux branches cannot be exercised on a developer Mac, so
// instead of shipping them unverified we fake process.platform and PATH and
// assert on the produced spawn plan. This is what catches the failure modes
// that are otherwise invisible until someone actually runs the dashboard on
// Windows: spawning a nonexistent /bin/bash, and handing a POSIX-quoted shell
// string to a platform that needs an argv array.
//
// Run with: node --test server/test/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as launcher from '../src/launcher.js';

const realPlatform = process.platform;

function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

/**
 * Run `fn` with process.platform and process.env faked, then restore both.
 *
 * No module cache-busting is needed: platform.js reads process.platform at
 * call time (deliberately — see the comment there), so a single imported copy
 * behaves correctly under every faked platform.
 */
function withPlatform({ platform, env }, fn) {
  const savedEnv = process.env;
  setPlatform(platform);
  process.env = { ...env };
  try {
    return fn();
  } finally {
    process.env = savedEnv;
    setPlatform(realPlatform);
  }
}

// A throwaway dir holding fake claude.cmd / bash executables so PATH lookups
// resolve against something real (findExecutable stats the filesystem).
function fakeBinDir(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlapp-bin-'));
  for (const n of names) {
    fs.writeFileSync(path.join(dir, n), '');
    fs.chmodSync(path.join(dir, n), 0o755);
  }
  return dir;
}

const WIN_ENV = (bin) => ({
  PATH: bin,
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  USERPROFILE: os.tmpdir(),
  COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
});

test('windows: spawns the CLI directly, never through a POSIX shell', () => {
  const bin = fakeBinDir(['claude.cmd']);
  const plan = withPlatform({ platform: 'win32', env: WIN_ENV(bin) }, () =>
    launcher.buildLaunch({ kind: 'claude' }, { cwd: os.tmpdir() })
  );

  // The old code produced file='/bin/bash', which does not exist on Windows —
  // every launch failed at spawn.
  assert.equal(plan.file, path.join(bin, 'claude.cmd'));
  assert.ok(!plan.file.includes('bash'), 'must not route through a POSIX shell');
  assert.deepEqual(plan.args, [], 'argv array, not a -lc command string');
  assert.ok(!plan.args.includes('-lc'));
});

test('windows: resolves the .cmd shim npm actually installs', () => {
  // A bare `claude` does not exist on Windows; only PATHEXT resolution finds
  // it, and nothing in the chain does that for us now there is no shell.
  const bin = fakeBinDir(['claude.cmd']);
  const plan = withPlatform({ platform: 'win32', env: WIN_ENV(bin) }, () =>
    launcher.buildLaunch({ kind: 'claude' }, { cwd: os.tmpdir() })
  );
  assert.match(plan.file, /claude\.cmd$/);
});

test('windows: flags are separate argv entries, never POSIX-quoted', () => {
  const bin = fakeBinDir(['claude.cmd']);
  const plan = withPlatform({ platform: 'win32', env: WIN_ENV(bin) }, () =>
    launcher.buildLaunch(
      { kind: 'claude' },
      {
        cwd: os.tmpdir(),
        model: 'claude-opus-5',
        resumeSessionId: '92d24c92-b5c5-4329-aedf-d51633d1cd6e',
      }
    )
  );

  assert.deepEqual(plan.args, [
    '--resume',
    '92d24c92-b5c5-4329-aedf-d51633d1cd6e',
    '--fork-session',
    '--model',
    'claude-opus-5',
  ]);
  assert.ok(
    !plan.args.some((a) => a.startsWith("'")),
    'POSIX single quotes would be taken literally by a Windows program'
  );
});

test('windows: shell metacharacters stay inside ONE argv entry', () => {
  const bin = fakeBinDir(['claude.cmd']);
  // On cmd.exe `&` chains commands. Because we never build a command line,
  // this cannot split off a second command — the POSIX quoting that used to be
  // the only defense is a no-op on Windows.
  const evil = 'hello & calc.exe';
  const plan = withPlatform({ platform: 'win32', env: WIN_ENV(bin) }, () =>
    launcher.buildLaunch({ kind: 'claude', appendSystemPrompt: evil }, { cwd: os.tmpdir() })
  );

  const i = plan.args.indexOf('--append-system-prompt');
  assert.ok(i >= 0);
  assert.equal(plan.args[i + 1], evil, 'metacharacters stay in a single argument');
  assert.equal(plan.args.length, 2, 'no extra argv entries were introduced');
});

test('windows: a missing CLI gives an actionable error, not a raw spawn failure', () => {
  const bin = fakeBinDir([]); // nothing on PATH
  assert.throws(
    () =>
      withPlatform({ platform: 'win32', env: WIN_ENV(bin) }, () =>
        launcher.buildLaunch({ kind: 'claude' }, { cwd: os.tmpdir() })
      ),
    /not found on PATH/
  );
});

// The launch dialog's working-dir field is free text, and the string it yields
// becomes the spawn cwd verbatim — no shell in the chain normalizes it the way
// `cd` would. Windows accepts every spelling of a directory, so the CLI starts
// in the right place under a different NAME, and agent CLIs key per-project
// state on that name: launched as `d:\proj`, Claude Code treats an already
// trusted `D:\proj` as a new folder and opens on the trust prompt, where no
// file reference can resolve. Launching `claude` by hand works, because the
// shell canonicalized the drive letter first — which is exactly the "works in
// the terminal, not in the dashboard" report.
test('cwd is canonicalized to its real on-disk spelling', () => {
  const bin = fakeBinDir(['claude.cmd']);
  // realpath needs a directory that exists; build a nested one so casing and
  // separators have something real to be folded against.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ctlapp-cwd-')));
  const nested = path.join(root, 'Proj');
  fs.mkdirSync(nested);

  const variants = [
    nested + path.sep, // trailing separator
    path.join(root, '.', 'Proj'), // redundant segment
  ];
  if (process.platform === 'win32') {
    // Only meaningful on a case-insensitive filesystem: on Linux these name
    // genuinely different directories.
    variants.push(nested.toLowerCase(), nested.toUpperCase());
    variants.push(nested.replace(/\\/g, '/')); // pasted with forward slashes
    // Lowercased drive letter — the spelling that actually triggered the bug.
    variants.push(nested[0].toLowerCase() + nested.slice(1));
  }

  for (const cwd of variants) {
    const plan = withPlatform({ platform: 'win32', env: WIN_ENV(bin) }, () =>
      launcher.buildLaunch({ kind: 'claude' }, { cwd })
    );
    assert.equal(plan.cwd, nested, `every spelling must canonicalize: ${cwd}`);
  }
});

test('a cwd that does not exist is passed through, not silently rewritten', () => {
  const bin = fakeBinDir(['claude.cmd']);
  // Validity is checked at the API boundary, which reports a friendly error.
  // Normalization must not invent a different path or throw here.
  const missing = path.join(os.tmpdir(), 'ctlapp-does-not-exist-xyz');
  const plan = withPlatform({ platform: 'win32', env: WIN_ENV(bin) }, () =>
    launcher.buildLaunch({ kind: 'claude' }, { cwd: missing })
  );
  assert.equal(plan.cwd, path.resolve(missing));
});

test('windows: terminal kind uses a Windows shell, never /bin/zsh', () => {
  const bin = fakeBinDir(['powershell.exe']);
  const plan = withPlatform({ platform: 'win32', env: WIN_ENV(bin) }, () =>
    launcher.buildLaunch({ kind: 'terminal' }, { cwd: os.tmpdir() })
  );
  assert.match(plan.file, /powershell\.exe$/);
  assert.ok(!plan.args.includes('-l'), 'POSIX -l is not a PowerShell flag');
});

test('windows: falls back to COMSPEC when no PowerShell is installed', () => {
  const bin = fakeBinDir([]);
  const plan = withPlatform({ platform: 'win32', env: WIN_ENV(bin) }, () =>
    launcher.buildLaunch({ kind: 'terminal' }, { cwd: os.tmpdir() })
  );
  assert.equal(plan.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(plan.args, []);
});

test('linux: resolves bash from PATH rather than hardcoding /bin/bash', () => {
  // Alpine has no bash at /bin/bash and NixOS puts it elsewhere; hardcoding
  // the path made every launch fail there.
  const bin = fakeBinDir(['bash', 'claude']);
  const plan = withPlatform(
    { platform: 'linux', env: { PATH: bin, HOME: os.tmpdir() } },
    () => launcher.buildLaunch({ kind: 'claude' }, { cwd: os.tmpdir() })
  );
  assert.equal(plan.file, path.join(bin, 'bash'));
  assert.equal(plan.args[0], '-lc');
  assert.match(plan.args[1], /^exec claude/);
});

test('linux: terminal kind honors $SHELL and does not assume zsh exists', () => {
  const bin = fakeBinDir(['bash', 'fish']);
  const plan = withPlatform(
    {
      platform: 'linux',
      env: { PATH: bin, HOME: os.tmpdir(), SHELL: path.join(bin, 'fish') },
    },
    () => launcher.buildLaunch({ kind: 'terminal' }, { cwd: os.tmpdir() })
  );
  assert.equal(plan.file, path.join(bin, 'fish'));
});

test('linux: unset $SHELL falls back to a shell that exists, not /bin/zsh', () => {
  // $SHELL is routinely unset under systemd/Docker/`su`, which is exactly
  // where the old '/bin/zsh' default broke.
  const bin = fakeBinDir(['bash']);
  const plan = withPlatform(
    { platform: 'linux', env: { PATH: bin, HOME: os.tmpdir() } },
    () => launcher.buildLaunch({ kind: 'terminal' }, { cwd: os.tmpdir() })
  );
  assert.ok(fs.existsSync(plan.file), `fallback shell ${plan.file} must exist`);
});

test('posix: metacharacters remain quoted inside the -lc command', () => {
  const bin = fakeBinDir(['bash', 'claude']);
  const plan = withPlatform(
    { platform: 'linux', env: { PATH: bin, HOME: os.tmpdir() } },
    () =>
      launcher.buildLaunch(
        { kind: 'claude', appendSystemPrompt: "; rm -rf /; echo pwned" },
        { cwd: os.tmpdir() }
      )
  );
  assert.match(plan.args[1], /'--append-system-prompt' '; rm -rf \//);
  assert.ok(!/^exec claude ; rm/.test(plan.args[1]), 'must not break out of the quoting');
});

test('windows: codex resolves its .cmd shim and keeps flags as argv entries', () => {
  const bin = fakeBinDir(['codex.cmd']);
  const plan = withPlatform({ platform: 'win32', env: WIN_ENV(bin) }, () =>
    launcher.buildLaunch({ kind: 'codex', model: 'gpt-5-codex' }, { cwd: os.tmpdir() })
  );
  assert.equal(plan.file, path.join(bin, 'codex.cmd'));
  assert.deepEqual(plan.args, ['--model', 'gpt-5-codex']);
});

test('codex: bare invocation, and only the flags it actually supports', () => {
  // `codex` is interactive with no subcommand, and has no --agent or
  // --append-system-prompt. Those persona fields must be dropped rather than
  // guessed at: an unknown flag makes the CLI exit with a usage error, which
  // surfaces as a tab that dies on spawn with no visible cause.
  const bin = fakeBinDir(['bash', 'codex']);
  const plan = withPlatform(
    { platform: 'linux', env: { PATH: bin, HOME: os.tmpdir() } },
    () =>
      launcher.buildLaunch(
        {
          kind: 'codex',
          model: 'gpt-5-codex',
          agent: 'reviewer',
          appendSystemPrompt: 'be terse',
          addDirs: ['/srv/extra'],
        },
        { cwd: os.tmpdir() }
      )
  );

  assert.equal(plan.args[1], "exec codex '--model' 'gpt-5-codex' '--add-dir' '/srv/extra'");
  assert.ok(!plan.args[1].includes('--agent'), 'codex has no --agent flag');
  assert.ok(
    !plan.args[1].includes('be terse'),
    'codex has no --append-system-prompt; the value must not leak in as a positional prompt'
  );
});

// The launch dialog's yolo checkbox is one boolean, but it reaches the CLI
// through two unrelated code paths — a POSIX -lc command string and a Windows
// argv array — so "it works on my Mac" says nothing about the other two.
test('codex yolo: the flag reaches the CLI intact on every platform', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const bin = fakeBinDir(['bash', 'codex', 'codex.cmd']);
    const env = platform === 'win32' ? WIN_ENV(bin) : { PATH: bin, HOME: os.tmpdir() };
    const plan = withPlatform({ platform, env }, () =>
      launcher.buildLaunch({ kind: 'codex' }, { cwd: os.tmpdir(), autoMode: true })
    );

    if (platform === 'win32') {
      // A bare argv entry: quoting it the POSIX way would make the CLI see
      // the literal characters '--yolo' and exit with a usage error.
      assert.deepEqual(plan.args, ['--yolo'], 'win32 argv must carry a bare --yolo');
    } else {
      assert.equal(plan.args[1], "exec codex '--yolo'", `${platform} -lc string`);
    }
  }
});

test('codex yolo: unchecked means no flag, and it never leaks to other CLIs', () => {
  const bin = fakeBinDir(['bash', 'codex', 'claude']);
  const env = { PATH: bin, HOME: os.tmpdir() };

  // Unchecked is the default and must stay a plain sandboxed launch.
  const off = withPlatform({ platform: 'linux', env }, () =>
    launcher.buildLaunch({ kind: 'codex' }, { cwd: os.tmpdir(), autoMode: false })
  );
  assert.equal(off.args[1], 'exec codex', 'unchecked must not bypass the sandbox');

  // The dialog only shows the checkbox for codex, but the API accepts any
  // body: --yolo is not a claude flag, so an unknown-flag usage error would
  // kill the tab at spawn.
  const claude = withPlatform({ platform: 'linux', env }, () =>
    launcher.buildLaunch({ kind: 'claude' }, { cwd: os.tmpdir(), autoMode: true })
  );
  assert.ok(!claude.args[1].includes('--yolo'), 'claude has no --yolo flag');
});

test('resume is rejected for kinds that cannot resume, on every platform', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const bin = fakeBinDir([
      'bash',
      'opencode',
      'opencode.cmd',
      'codex',
      'codex.cmd',
      'powershell.exe',
    ]);
    const env =
      platform === 'win32' ? WIN_ENV(bin) : { PATH: bin, HOME: os.tmpdir() };
    // codex *can* resume, but only via its own `codex resume` subcommand
    // reading ~/.codex — not the --resume/--fork-session pair emitted here.
    for (const kind of ['opencode', 'codex', 'terminal']) {
      assert.throws(
        () =>
          withPlatform({ platform, env }, () =>
            launcher.buildLaunch(
              { kind },
              { cwd: os.tmpdir(), resumeSessionId: '92d24c92-b5c5-4329-aedf-d51633d1cd6e' }
            )
          ),
        /not supported for CLI kind/,
        `${kind} resume should be rejected on ${platform}`
      );
    }
  }
});

test('a malformed resume id is rejected on every platform', () => {
  for (const platform of ['win32', 'linux']) {
    const bin = fakeBinDir(['bash', 'claude', 'claude.cmd']);
    const env =
      platform === 'win32' ? WIN_ENV(bin) : { PATH: bin, HOME: os.tmpdir() };
    assert.throws(
      () =>
        withPlatform({ platform, env }, () =>
          launcher.buildLaunch({ kind: 'claude' }, { cwd: os.tmpdir(), resumeSessionId: '; rm -rf /' })
        ),
      /Invalid resume session id/,
      `bad id should be rejected on ${platform}`
    );
  }
});

test('a resume id with stray whitespace is normalized, not passed through', () => {
  // Validated-trimmed but emitted-raw would hand the CLI an id containing a
  // newline; `claude` rejects it and the tab dies with no visible cause.
  const bin = fakeBinDir(['claude.cmd']);
  const plan = withPlatform({ platform: 'win32', env: WIN_ENV(bin) }, () =>
    launcher.buildLaunch(
      { kind: 'claude' },
      { cwd: os.tmpdir(), resumeSessionId: '  92d24c92-b5c5-4329-aedf-d51633d1cd6e\n' }
    )
  );
  assert.deepEqual(plan.args, [
    '--resume',
    '92d24c92-b5c5-4329-aedf-d51633d1cd6e',
    '--fork-session',
  ]);
});

test('dangerous env vars are dropped case-insensitively', () => {
  // Windows env names are case-insensitive, so a case-sensitive denylist let
  // `Bash_Env` through — a bypass of the "you can only launch a CLI" guarantee.
  const bin = fakeBinDir(['bash', 'claude']);
  const plan = withPlatform(
    { platform: 'linux', env: { PATH: bin, HOME: os.tmpdir() } },
    () =>
      launcher.buildLaunch(
        {
          kind: 'claude',
          env: { BASH_ENV: '/tmp/a', Bash_Env: '/tmp/b', bash_env: '/tmp/c', KEEP_ME: 'yes' },
        },
        { cwd: os.tmpdir() }
      )
  );

  for (const k of Object.keys(plan.env)) {
    assert.ok(!/^bash_env$/i.test(k), `BASH_ENV variant leaked through as ${k}`);
  }
  assert.equal(plan.env.KEEP_ME, 'yes');
});
