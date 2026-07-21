import { HOME_DIR, CLI_KINDS } from './config.js';

// POSIX single-quote a value so persona-provided strings can never break out
// of the argument and inject shell syntax. Empty string -> ''.
export function shellQuote(value) {
  const s = String(value);
  if (s === '') return "''";
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Env vars that let a non-interactive `bash -lc` execute attacker-controlled
// code *before* our `exec` runs (BASH_ENV/ENV are sourced as files; exported
// bash functions run via BASH_FUNC_*). A persona is operator-supplied, but the
// dashboard's whole safety story is "you can only launch a CLI", so we refuse
// to let persona env smuggle in shell execution. Drop these defensively.
const DANGEROUS_ENV = /^(BASH_ENV|ENV|BASH_FUNC_|LD_PRELOAD|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|PROMPT_COMMAND$)/;

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

/**
 * Turn a persona (+ per-launch overrides) into an executable plan for a PTY.
 *
 * Returns { kind, file, args, cwd, env, commandLine } where the PTY is spawned
 * as `bash -lc "exec <cli> <quoted flags>"`. Using a login shell ensures the
 * user's PATH is loaded; `exec` replaces the shell so signals / resize / Ctrl-C
 * flow straight to the CLI and the PTY dies exactly when the CLI does.
 */
export function buildLaunch(persona, overrides = {}) {
  const kind = overrides.kind || persona.kind;
  const spec = CLI_KINDS[kind];
  if (!spec) throw new Error(`Unknown CLI kind: ${kind}`);

  const cwd = overrides.cwd || persona.cwd || HOME_DIR;
  const model = overrides.model || persona.model;
  const agent = overrides.agent || persona.agent;
  const systemPrompt = overrides.appendSystemPrompt ?? persona.appendSystemPrompt;
  const addDirs = asArray(overrides.addDirs ?? persona.addDirs);
  const extraArgs = asArray(persona.extraArgs); // trusted, from persona config

  const parts = [spec.bin];

  if (kind === 'claude') {
    if (model) parts.push('--model', shellQuote(model));
    if (agent) parts.push('--agent', shellQuote(agent));
    if (systemPrompt) parts.push('--append-system-prompt', shellQuote(systemPrompt));
    for (const d of addDirs) parts.push('--add-dir', shellQuote(d));
  } else if (kind === 'opencode') {
    // opencode uses cwd for the project; model/agent are flags.
    if (model) parts.push('--model', shellQuote(model));
    if (agent) parts.push('--agent', shellQuote(agent));
  }

  // extraArgs are raw tokens supplied by the operator in the persona config.
  for (const a of extraArgs) parts.push(shellQuote(a));

  const commandLine = 'exec ' + parts.join(' ');

  const env = safeEnvMerge(persona.env, overrides.env, {
    // Help CLIs render rich TUIs inside the PTY.
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
  });

  return {
    kind,
    file: '/bin/bash',
    args: ['-lc', commandLine],
    cwd,
    env,
    commandLine,
    label: persona.name || spec.label,
  };
}
