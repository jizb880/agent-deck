// After a backend restart an open tab reconnects transparently — and keeps
// running whatever bundle it loaded, even if `npm run build` shipped a new one
// in between. Such a tab silently ignores any protocol frame it predates (the
// persisted-history frame, for one) and makes a shipped fix look "still
// broken". So on every reconnect, compare the assets the served index.html
// points at with the ones this page loaded, and reload once if they differ.

// One rule for both sides, so the two lists cannot drift: every src/href that
// points into Vite's hashed /assets/ (entry script, stylesheet, modulepreload
// links, …), as a sorted, joined key.
function assetsIn(doc) {
  return [...doc.querySelectorAll('[src], [href]')]
    .map((el) => el.getAttribute('src') || el.getAttribute('href'))
    .filter((v) => v && v.includes('/assets/'))
    .map((v) => new URL(v, location.href).pathname)
    .sort()
    .join('\n');
}

// What this page loaded — read once, before React touches the DOM.
const LOADED = assetsIn(document);

/**
 * The served asset key if it differs from what this page runs, else null.
 * Never throws; a build in progress (index.html missing) reads as "no change".
 */
export async function bundleChanged() {
  // Vite's dev server has HMR for this; there are no hashed assets to compare.
  if (import.meta.env?.DEV || !LOADED) return null;
  let html;
  try {
    const res = await fetch('/index.html', { cache: 'no-store' });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }
  const served = assetsIn(new DOMParser().parseFromString(html, 'text/html'));
  return served && served !== LOADED ? served : null;
}

/**
 * Reload for a new bundle — once per target, so a served index.html whose
 * assets don't load (a build in progress) can't spin the tab. Returns false
 * when this target was already reloaded for; the caller should tell the user.
 */
export function reloadForBundle(key) {
  const storageKey = 'agentDeck.reloadedFor';
  try {
    if (sessionStorage.getItem(storageKey) === key) return false;
    sessionStorage.setItem(storageKey, key);
  } catch {
    /* storage unavailable — still worth one reload */
  }
  location.reload();
  return true;
}
