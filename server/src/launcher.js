import { CLI_KINDS } from './config.js';
import {
  defaultShell,
  findExecutable,
  homeDir,
  isWindows,
  loginShellArgs,
  posixLoginShell,
} from './platform.js';
import { normalizeSessionId } from './claudeSessions.js';

// POSIX single-quote a value so persona-provided strings can never break out
// of the argument and inject shell syntax. Empty string -> ''.
//
// Only ever used to build a POSIX `sh -c` command line. On Windows we don't
// construct a command line at all — we hand node-pty an argv array and it
// applies the Win32 CommandLineToArgvW escaping rules — because these POSIX
// rules are not just wrong for cmd.exe/PowerShell, they'd be a no-op there
// and would silently turn this quoting into an injection vector.
export function shellQuote(value) {
  const s = String(value);
  if (s === '') return "''";
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Env vars that let a shell in the spawn chain execute attacker-controlled code
// *before* our command runs: BASH_ENV/ENV are sourced as files, exported bash
// functions run via BASH_FUNC_*, the loader vars preload libraries, and on
// Windows COMSPEC/PATHEXT/PSModulePath redirect what actually gets executed.
// A persona is operator-supplied, but the dashboard's whole safety story is
// "you can only launch a CLI", so we refuse to let persona env smuggle in
// execution. Matched case-insensitively: Windows env names are case-insensitive
// (so `Bash_Env` would otherwise sail past a case-sensitive check) and a
// case-only variant is never a legitimate value here on any platform.
const DANGEROUS_ENV =
  /^(BASH_ENV|ENV|BASH_FUNC_|LD_PRELOAD|LD_AUDIT|LD_LIBRARY_PATH|LD_ASSUME_KERNEL|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|DYLD_FRAMEWORK_PATH|PROMPT_COMMAND$|COMSPEC$|PATHEXT$|PSModulePath$|_NT_SYMBOL_PATH$)/i;

function safeEnvMerge(...sources) {
  const out = { ...process.env };
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (DANGEROUS_ENV.test(k)) continue;
      if (v == null) continue;
      out[k] = String(v);
    }
  }
  return out;
}

// True when ANTHROPIC_BASE_URL points somewhere other than Anthropic's own
// API — i.e. a relay/proxy that may not accept beta request fields. An
// unparseable URL is treated as a relay (safe side: the request would 429
// there, while the official endpoint is never reached via a broken URL).
function usesThirdPartyRelay(baseUrl) {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname;
    return host !== 'anthropic.com' && !host.endsWith('.anthropic.com');
  } catch {
    return true;
  }
}

/**
 * Build the CLI's argument vector (without the executable itself).
 *
 * Kept separate from the spawn mechanics because the two platforms consume it
 * differently: Windows passes it through as argv, POSIX quotes each element
 * into a `-lc` command string.
 */
function buildCliArgs(spec, { model, agent, systemPrompt, addDirs, extraArgs, resumeSessionId }) {
  // Subcommand first: `openclaw chat --local` / `hermes chat` must precede any
  // flags, and a CLI that is already interactive contributes nothing here.
  const args = [...(spec.subcommand || [])];

  if (resumeSessionId && spec.resume) {
    // Emit the normalized id, not the raw one: a trailing newline from a paste
    // would otherwise pass validation and reach the CLI, which `claude`
    // rejects as an unknown session — the tab would spawn and die with no
    // visible reason. --fork-session keeps the original transcript intact so
    // the same history can be opened in several tabs.
    const id = normalizeSessionId(resumeSessionId);
    if (!id) throw new Error(`Invalid resume session id: ${resumeSessionId}`);
    args.push('--resume', id, '--fork-session');
  }

  // Flag spellings come from the spec because they genuinely differ per CLI
  // (hermes uses -m, not --model). A null flag means the CLI has no such
  // option, so the value is dropped rather than guessed at — passing an
  // unknown flag makes the CLI exit immediately with a usage error, which
  // surfaces as a tab that dies on spawn.
  if (model && spec.modelFlag) args.push(spec.modelFlag, model);
  if (agent && spec.agentFlag) args.push(spec.agentFlag, agent);
  if (systemPrompt && spec.promptFlag) args.push(spec.promptFlag, systemPrompt);
  if (spec.addDirFlag) for (const d of addDirs) args.push(spec.addDirFlag, d);

  // extraArgs are raw tokens supplied by the operator in the persona config —
  // the escape hatch for any flag this table doesn't model.
  for (const a of extraArgs) args.push(a);
  return args;
}

/**
 * Turn a persona (+ per-launch overrides) into an executable plan for a PTY.
 *
 * Returns { kind, file, args, cwd, env, commandLine, label }.
 *
 * POSIX: spawned as `bash -lc "exec <cli> <quoted flags>"`. The login shell
 * loads the user's PATH (a CLI installed to ~/.npm-global/bin is otherwise
 * invisible), and `exec` replaces the shell so signals / resize / Ctrl-C flow
 * straight to the CLI and the PTY dies exactly when the CLI does.
 *
 * Windows: the CLI is spawned directly with an argv array — no shell in the
 * chain. There is no login-shell equivalent to load PATH, so the executable is
 * resolved against PATH/PATHEXT here (npm installs `claude.cmd`), and letting
 * node-pty do the Win32 escaping avoids inventing a cmd.exe/PowerShell quoting
 * scheme, which is the classic source of command injection on that platform.
 */
export function buildLaunch(persona, overrides = {}) {
  const kind = overrides.kind || persona.kind;
  const spec = CLI_KINDS[kind];
  if (!spec) throw new Error(`Unknown CLI kind: ${kind}`);

  const cwd = overrides.cwd || persona.cwd || homeDir();

  const env = safeEnvMerge(persona.env, overrides.env, {
    // Help CLIs render rich TUIs inside the PTY. TERM/COLORFGBG are POSIX
    // terminfo conventions that Windows console apps ignore, but they are
    // harmless there and correct everywhere else.
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    // The web terminal renders on a white background, but a PTY gives TUIs no
    // way to discover that — Claude Code etc. assume a dark theme and paint
    // select-menu highlights in colors that vanish on white. COLORFGBG is the
    // standard hint: "0;15" = black-on-white (light background).
    COLORFGBG: '0;15',
  });

  // Third-party relays (ANTHROPIC_BASE_URL proxies) reject beta request fields
  // like `context_management` with "429 ... Extra inputs are not permitted",
  // so disable experimental betas when one is in use. Scoped to relays only:
  // on the official endpoint context management *saves* tokens (it clears
  // stale tool results from context), so it stays enabled there. An explicit
  // value from the shell, persona, or overrides always wins.
  if (
    kind === 'claude' &&
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS == null &&
    usesThirdPartyRelay(env.ANTHROPIC_BASE_URL)
  ) {
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  }

  // Resume is per-launch only: it names one specific past conversation, which
  // is never a property of a reusable persona. Rejected rather than ignored
  // for kinds that can't resume, so a caller asking to resume never gets a 201
  // and a silently-empty new conversation. Checked before the `terminal`
  // early return so that kind can't slip past.
  const resumeSessionId = overrides.resumeSessionId;
  if (resumeSessionId && !spec.resume) {
    throw new Error(`Resuming a session is not supported for CLI kind: ${kind}`);
  }

  // Plain terminal: spawn the user's own shell interactively — no CLI, no
  // persona flags. The PTY dies when the shell exits.
  if (kind === 'terminal') {
    const shell = defaultShell(env);
    const args = loginShellArgs(shell);
    return {
      kind,
      file: shell,
      args,
      cwd,
      env,
      commandLine: [shell, ...args].join(' '),
      label: persona.name || spec.label,
    };
  }

  const cliArgs = buildCliArgs(spec, {
    model: overrides.model || persona.model,
    agent: overrides.agent || persona.agent,
    systemPrompt: overrides.appendSystemPrompt ?? persona.appendSystemPrompt,
    addDirs: asArray(overrides.addDirs ?? persona.addDirs),
    extraArgs: asArray(persona.extraArgs), // trusted, from persona config
    resumeSessionId,
  });

  if (isWindows()) {
    // No shell: resolve the real executable ourselves, since nothing else in
    // the chain would search PATH or apply PATHEXT.
    const file = findExecutable(spec.bin, env);
    if (!file) {
      throw new Error(
        `${spec.label} executable "${spec.bin}" was not found on PATH. ` +
          `Install it, or add its install directory to PATH and restart the dashboard.`
      );
    }
    return {
      kind,
      file,
      args: cliArgs,
      cwd,
      env,
      // Display only — node-pty performs the real Win32 escaping from `args`.
      commandLine: [spec.bin, ...cliArgs].join(' '),
      label: persona.name || spec.label,
    };
  }

  const shell = posixLoginShell(env);
  const commandLine = 'exec ' + [spec.bin, ...cliArgs.map(shellQuote)].join(' ');
  return {
    kind,
    file: shell,
    args: ['-lc', commandLine],
    cwd,
    env,
    commandLine,
    label: persona.name || spec.label,
  };
}
