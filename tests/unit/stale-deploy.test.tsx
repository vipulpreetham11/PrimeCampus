import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteError } from '@/app/RouteError';
import {
  consumeReloadMarker,
  installStaleDeployRecovery,
  isChunkLoadError,
  RELOAD_MARKER,
  reloadForNewDeploy,
  setPageEnvForTests,
  type PageEnv,
} from '@/lib/stale-deploy';

// M2X: after a new deploy the old chunks are gone (Cloudflare serves index.html for them); the app
// reloads once to fetch the new ones, and never loops.

function fakePage(href: string, start = 1_000_000) {
  let now = start;
  const replaced: string[] = [];
  const env: PageEnv & { href: string } = {
    href,
    location: {
      get href() {
        return env.href;
      },
      replace: (url: string) => {
        replaced.push(url);
      },
    },
    history: {
      state: null,
      replaceState: (_d, _u, url) => {
        env.href = String(url);
      },
    },
    now: () => now,
  };
  return {
    env,
    replaced,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => setPageEnvForTests(null));

describe('stale deploy recovery', () => {
  it('recognises a failed lazy chunk in Chrome, Firefox and Safari wording, and Vite preload errors', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: https://x/assets/ClassesPage-abc.js',
      'error loading dynamically imported module: https://x/assets/a.js',
      'Importing a module script failed.',
      'Unable to preload CSS for /assets/index-old.css',
    ]) {
      expect(isChunkLoadError(new Error(message)), message).toBe(true);
    }
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });

  it('reloads once with a marker; the new page drops it from the URL (other params and hash kept)', () => {
    const page = fakePage('https://app.test/students?section=abc#top');
    setPageEnvForTests(page.env);
    expect(reloadForNewDeploy()).toBe(true);
    expect(page.replaced).toHaveLength(1);
    const target = new URL(page.replaced[0]!);
    expect(target.pathname).toBe('/students');
    expect(target.searchParams.get('section')).toBe('abc');
    expect(target.searchParams.get(RELOAD_MARKER)).toBe('1000000');
    expect(target.hash).toBe('#top');

    // the reloaded page starts: marker remembered and removed from the address bar
    const next = fakePage(page.replaced[0]!, 1_002_000);
    setPageEnvForTests(next.env);
    consumeReloadMarker();
    expect(next.env.href).toBe('https://app.test/students?section=abc#top');
  });

  it('no loop: a failure within a minute of a recovery reload does not reload again; later it may', () => {
    const page = fakePage(`https://app.test/setup?${RELOAD_MARKER}=1000000`, 1_005_000);
    setPageEnvForTests(page.env);
    consumeReloadMarker();
    expect(reloadForNewDeploy()).toBe(false);
    expect(page.replaced).toHaveLength(0);
    page.advance(60_000); // a later deploy, minutes after the recovery
    expect(reloadForNewDeploy()).toBe(true);
    expect(page.replaced).toHaveLength(1);
  });

  it('vite:preloadError: reloads and marks the event handled; not handled when the guard stops it', () => {
    const target = new EventTarget();
    installStaleDeployRecovery(target as unknown as Window);
    const page = fakePage('https://app.test/homework');
    setPageEnvForTests(page.env);
    const first = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(page.replaced).toHaveLength(1);

    const reloaded = fakePage(page.replaced[0]!, 1_001_000);
    setPageEnvForTests(reloaded.env);
    consumeReloadMarker();
    const second = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false); // the error reaches the route error page
    expect(reloaded.replaced).toHaveLength(0);
  });

  function renderFailingLazyRoute() {
    const router = createMemoryRouter(
      [
        {
          path: '/',
          errorElement: <RouteError />,
          lazy: () =>
            Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/Old-1a2b.js')),
        },
      ],
      { initialEntries: ['/'] },
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  it('a failed lazy route import reloads the page once', async () => {
    const page = fakePage('https://app.test/');
    setPageEnvForTests(page.env);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderFailingLazyRoute();
    expect(await screen.findByText(/loading the latest version/)).toBeInTheDocument();
    // the navigation itself runs in an effect, just after that render
    await waitFor(() => expect(page.replaced).toHaveLength(1));
  });

  it('…and if it fails again right after that reload, shows the update page with a Reload button instead', async () => {
    const page = fakePage(`https://app.test/?${RELOAD_MARKER}=1000000`, 1_003_000);
    setPageEnvForTests(page.env);
    consumeReloadMarker();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderFailingLazyRoute();
    expect(await screen.findByRole('heading', { name: 'PrimeCampus was updated' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(page.replaced).toHaveLength(0);
  });
});
