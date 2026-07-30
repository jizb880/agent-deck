import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir } from './platform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo root is two levels up from server/src
export const ROOT_DIR = path.resolve(__dirname, '..', '..');
export const DATA_DIR = process.env.CONTROL_APP_DATA || path.join(ROOT_DIR, 'data');
export const PERSONAS_FILE = path.join(DATA_DIR, 'personas.json');
export const WEB_DIST = path.join(ROOT_DIR, 'web', 'dist');

export const HOST = process.env.HOST || '127.0.0.1';
export const PORT = Number(process.env.PORT || 4173);

// Per-session scrollback kept in memory so a reattaching browser can redraw
// full history. 1 MiB per session is plenty for a long CLI session.
export const SCROLLBACK_BYTES = Number(process.env.SCROLLBACK_BYTES || 1024 * 1024);

// Milliseconds of output silence after which a session flips busy -> idle.
export const IDLE_AFTER_MS = Number(process.env.IDLE_AFTER_MS || 900);

// How long an exited session lingers (for final-output reattach) before it is
// auto-removed and its scrollback freed. 5 minutes by default.
export const REAP_EXITED_AFTER_MS = Number(
  process.env.REAP_EXITED_AFTER_MS || 5 * 60 * 1000
);

// Grace period after a kill signal before escalating to SIGKILL. Interactive
// login shells (the `terminal` kind) ignore SIGTERM, so without escalation a
// "stop" request would leave the session running forever.
export const KILL_ESCALATE_MS = Number(process.env.KILL_ESCALATE_MS || 1500);

// Re-exported so callers don't each import platform.js. A function, not a
// constant: os.homedir() reads USERPROFILE/HOME, which a test may fake.
export { homeDir };

// Where Claude Code keeps per-project conversation transcripts, one dir per
// working directory and one <session-id>.jsonl per session. Read-only for us:
// it's the source for the "resume a previous session" picker. The same
// ~/.claude layout is used on macOS, Linux and Windows (%USERPROFILE%\.claude);
// CLAUDE_CONFIG_DIR relocates the whole config dir if the user set one.
export const claudeProjectsDir = () =>
  process.env.CLAUDE_PROJECTS_DIR ||
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude'), 'projects');

// How many recent transcripts the resume picker offers. Each one costs a
// bounded read to extract its preview, and a picker longer than this is not
// useful to scroll anyway.
export const RESUME_LIST_LIMIT = Number(process.env.RESUME_LIST_LIMIT || 30);

/**
 * CLIs this dashboard knows how to launch.
 *
 * Each entry is data, not code: the launcher reads these fields rather than
 * branching per kind, so supporting another agent CLI is a matter of adding an
 * entry here. Fields:
 *
 *   label      Display name in the UI.
 *   bin        Executable to look for on PATH. On POSIX it is resolved by the
 *              login shell; on Windows the launcher resolves it against
 *              PATH/PATHEXT itself (npm installs these as `<name>.cmd`).
 *              null means "not a real CLI" — see `terminal` below.
 *   subcommand Argv prefix needed to reach an interactive session, if the CLI
 *              needs one (`openclaw chat`, `hermes chat`). Empty for CLIs whose
 *              bare invocation is already interactive.
 *   modelFlag  How to pass a model override, or null if unsupported. Spelling
 *              differs per CLI (`--model` vs `-m`), which is exactly why this
 *              is data.
 *   agentFlag  How to pass an agent/persona override, or null.
 *   promptFlag How to append a system prompt, or null.
 *   addDirFlag How to grant an extra directory, repeated per path, or null.
 *   resume     Whether the dashboard can restore a stored conversation. Only
 *              Claude Code is wired up (see claudeSessions.js); the others keep
 *              their own history in formats we don't read, so offering resume
 *              would be a promise we can't keep.
 *
 * `terminal` is special-cased in the launcher: it spawns the user's own shell.
 */
export const CLI_KINDS = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    subcommand: [],
    modelFlag: '--model',
    agentFlag: '--agent',
    promptFlag: '--append-system-prompt',
    addDirFlag: '--add-dir',
    resume: true,
  },
  opencode: {
    label: 'OpenCode',
    bin: 'opencode',
    subcommand: [],
    // opencode takes the project from cwd; model/agent are flags.
    modelFlag: '--model',
    agentFlag: '--agent',
    promptFlag: null,
    addDirFlag: null,
    resume: false,
  },
  openclaw: {
    label: 'OpenClaw',
    bin: 'openclaw',
    // `chat` is the local terminal UI (an alias for `tui --local`); the bare
    // command only prints help. --local keeps it on the embedded runtime so a
    // session works without a configured gateway.
    subcommand: ['chat', '--local'],
    modelFlag: null, // model is chosen by openclaw's own config/session
    agentFlag: null,
    promptFlag: null,
    addDirFlag: null,
    resume: false,
  },
  hermes: {
    label: 'Hermes',
    bin: 'hermes',
    subcommand: ['chat'],
    modelFlag: '-m', // hermes spells it -m/--model, not --model
    agentFlag: null,
    promptFlag: null,
    addDirFlag: null,
    resume: false,
  },
  terminal: {
    label: 'Terminal',
    bin: null,
    subcommand: [],
    modelFlag: null,
    agentFlag: null,
    promptFlag: null,
    addDirFlag: null,
    resume: false,
  },
};
