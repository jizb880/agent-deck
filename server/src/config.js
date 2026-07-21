import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export const HOME_DIR = os.homedir();

// CLIs this dashboard knows how to launch. `bin` is resolved via a login
// shell so the user's PATH (e.g. ~/.npm-global/bin) is honored. `terminal`
// is special-cased in the launcher: it spawns the user's own login shell.
export const CLI_KINDS = {
  claude: { label: 'Claude Code', bin: 'claude' },
  opencode: { label: 'OpenCode', bin: 'opencode' },
  terminal: { label: 'Terminal', bin: null },
};
