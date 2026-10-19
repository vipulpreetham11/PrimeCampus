// Recovery from a stale deploy (M2X). After a new deploy the old hashed chunks are gone; Cloudflare's
// static assets serve index.html for them (SPA fallback answers every unknown path), so a lazy route
// or a preloaded dependency of an old page fails to load. The cure is a fresh page load, done once:
//  - `vite:preloadError` (a preload of a dynamic import's dependencies failed) and a failed lazy
//    route import (RouteError) call `reloadForNewDeploy()`;
//  - the reload carries a `__pc_reload=<time>` marker in the URL, removed from the address bar as
//    soon as the new page starts (`consumeReloadMarker`). No browser storage is used.
//  - a failure within RELOAD_GUARD_MS of such a reload does not reload again (no loop): the error page
//    with its own Reload button is shown instead.

export const RELOAD_MARKER = '__pc_reload';
export const RELOAD_GUARD_MS = 60_000;

const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|is not a valid JavaScript MIME type/i;

/** A failed lazy chunk / preload (Chrome, Firefox and Safari wording, and Vite's preload error). */
export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_ERROR.test(error.message);
}

export interface PageEnv {
  location: { href: string; replace: (url: string) => void };
  history: {
    replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
    state: unknown;
  };
  now: () => number;
}

const browserEnv = (): PageEnv => ({ location: window.location, history: window.history, now: Date.now });
let currentEnv: () => PageEnv = browserEnv;

/** When this page was loaded by a recovery reload (ms since epoch), or null. */
let reloadedAt: number | null = null;

/**
 * Call once before the router reads the URL: remembers a recovery reload's time and removes the
 * marker from the address bar (other query parameters and the hash are kept).
 */
export function consumeReloadMarker(env: PageEnv = currentEnv()): void {
  const url = new URL(env.location.href);
  const raw = url.searchParams.get(RELOAD_MARKER);
  if (raw === null) return;
  const at = Number(raw);
  reloadedAt = Number.isFinite(at) ? at : env.now();
  url.searchParams.delete(RELOAD_MARKER);
  env.history.replaceState(env.history.state, '', url.toString());
}

/** Whether a recovery reload is allowed now (false within a minute of the previous one). Pure. */
export function canReloadForNewDeploy(env: PageEnv = currentEnv()): boolean {
  return reloadedAt === null || env.now() - reloadedAt >= RELOAD_GUARD_MS;
}

/**
 * Reload the page to pick up a new deploy — unless this page itself came from such a reload in the
 * last minute. Returns true when the page is reloading.
 */
export function reloadForNewDeploy(env: PageEnv = currentEnv()): boolean {
  if (!canReloadForNewDeploy(env)) return false;
  const now = env.now();
  const url = new URL(env.location.href);
  url.searchParams.set(RELOAD_MARKER, String(now));
  env.location.replace(url.toString());
  return true;
}

/** Listen for Vite's preload failures (call once at startup). */
export function installStaleDeployRecovery(target: Pick<Window, 'addEventListener'> = window): void {
  target.addEventListener('vite:preloadError', (event) => {
    // handled: no error is thrown to the page. Not handled (guard hit): the import fails as usual
    // and the route error page offers a Reload button.
    if (reloadForNewDeploy()) event.preventDefault();
  });
}

/** Test only: use a fake page (jsdom can't navigate) and forget a remembered recovery reload. */
export function setPageEnvForTests(env: PageEnv | null): void {
  currentEnv = env ? () => env : browserEnv;
  reloadedAt = null;
}
