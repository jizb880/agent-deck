// Platform-derived UI hints.
//
// The backend runs the CLIs, so IT decides what a valid path looks like — the
// browser could be on a different OS entirely (this dashboard is reachable over
// the network). Hardcoded `/Users/you/...` placeholders were nonsense on both
// Windows and Linux; these are filled in from /api/health instead.
import { useEffect, useState } from 'react';
import { api } from './api.js';

const DEFAULTS = {
  platform: null,
  home: '',
};

/**
 * Server platform info, fetched once. Returns { platform, home, examplePath,
 * homeLabel } — the derived fields degrade to sensible POSIX-ish text until the
 * request lands, so nothing renders blank.
 */
export function useServerPlatform() {
  const [info, setInfo] = useState(DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((h) => {
        if (!cancelled && h) setInfo({ platform: h.platform || null, home: h.home || '' });
      })
      .catch(() => {
        /* hints only — a failed probe just leaves the generic wording */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isWin = info.platform === 'win32';
  const sep = isWin ? '\\' : '/';
  // Build the example from the server's real home dir when we have it, so the
  // hint shows a path shape that actually exists on that machine.
  const base = info.home || (isWin ? 'C:\\Users\\you' : '/home/you');
  return {
    ...info,
    isWindows: isWin,
    // e.g. C:\Users\you\projects\my-app  or  /Users/you/projects/my-app
    examplePath: `${base}${sep}projects${sep}my-app`,
    examplePathA: `${base}${sep}projects${sep}a`,
    examplePathB: `${base}${sep}projects${sep}b`,
    // %USERPROFILE% is the Windows spelling; $HOME means nothing there.
    homeLabel: isWin ? '%USERPROFILE%' : '$HOME',
  };
}
