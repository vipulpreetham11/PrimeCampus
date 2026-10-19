import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { operatorSession, setKnownPassword, type ApiSession } from './helpers/api';
import { expectDemoSchool, newPage, signIn, type Seen } from './helpers/ui';

// M2X §3 M0: security headers and the SPA fallback as Cloudflare serves them. Builds the production
// `dist` (no E2E hooks) and serves it with `npx wrangler dev` locally (nothing is deployed), then:
//  - every header of public/_headers on `/` and on a reload of a nested route
//  - what a missing /assets/x.js returns (static-assets-only SPA fallback: index.html — see report)
//  - a real asset: immutable caching + the same headers
//  - no CSP violation while a signed-in Admin uses the app (Demo School only)

const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const OPERATOR = process.env.E2E_OPERATOR_USERNAME ?? '';
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? '';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

/** `public/_headers` → { pattern: { header-name (lower case): value } } */
function parseHeadersFile(): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | null = null;
  for (const raw of readFileSync('public/_headers', 'utf8').split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = rules[raw.trim()] = {};
    } else if (current) {
      const i = raw.indexOf(':');
      current[raw.slice(0, i).trim().toLowerCase()] = raw.slice(i + 1).trim();
    }
  }
  return rules;
}
const RULES = parseHeadersFile();
const ALL = RULES['/*']!;

let wrangler: ChildProcess | null = null;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  expect(Object.keys(ALL).length, '_headers has a /* block').toBeGreaterThanOrEqual(5);
  // production build: no window.__pcE2E
  const env = { ...process.env };
  delete env.VITE_E2E_HOOKS;
  execSync('npx vite build', { stdio: 'ignore', env });
  wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], {
    shell: true,
    stdio: 'ignore',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  });
  for (let i = 0; i < 120; i += 1) {
    const ok = await fetch(`${BASE}/`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('wrangler dev did not start');
});

test.afterAll(() => {
  if (!wrangler?.pid) return;
  // the shell's children (wrangler, workerd) go with it
  if (process.platform === 'win32') execSync(`taskkill /pid ${wrangler.pid} /T /F`, { stdio: 'ignore' });
  else wrangler.kill('SIGTERM');
});

function expectRuleHeaders(headers: Record<string, string>, where: string) {
  for (const [name, value] of Object.entries(ALL)) {
    expect(headers[name], `${where}: ${name}`).toBe(value);
  }
}

test('H-1. `/` carries every header of the /* rule; the SPA entry is never cached stale', async ({
  request,
}) => {
  const res = await request.get(`${BASE}/`, { headers: { 'Sec-Fetch-Mode': 'navigate' } });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/html');
  expectRuleHeaders(res.headers(), '/');
  // The `/index.html` rule (no-cache) only ever meets the redirect /index.html → /, not `/` itself;
  // `/` gets Cloudflare's own HTML default, which also revalidates on every load.
  expect(res.headers()['cache-control']).toBe('public, max-age=0, must-revalidate');
  const ix = await request.get(`${BASE}/index.html`, { maxRedirects: 0 });
  expect(ix.status()).toBe(307);
  expect(ix.headers()['location']).toBe('/');
  expect(ix.headers()['cache-control']).toBe(RULES['/index.html']!['cache-control']);
});

test('H-2. Reloading a nested route serves the app (SPA fallback) with every header', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const res = await page.goto(`${BASE}/students/0b0b0b0b-0000-4000-8000-000000000000`);
  expect(res!.status()).toBe(200);
  expect(res!.headers()['content-type']).toContain('text/html');
  expectRuleHeaders(res!.headers(), 'nested route');
  // the app boots and routes (not signed in → sign-in page)
  await expect(page).toHaveURL(/\/sign-in$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await context.close();
});

test('H-3. A real asset is immutable; a missing /assets/x.js gets index.html (not a 404) and is never run', async ({
  browser,
  request,
}) => {
  const js = readdirSync('dist/assets').find((f) => /^index-.*\.js$/.test(f))!;
  const real = await request.get(`${BASE}/assets/${js}`);
  expect(real.status()).toBe(200);
  expect(real.headers()['content-type']).toContain('javascript');
  expect(real.headers()['cache-control']).toBe(RULES['/assets/*']!['cache-control']);
  expectRuleHeaders(real.headers(), 'asset');

  // ❌ in the M2X report: static assets only (no Worker) → the SPA fallback answers every unknown
  // path, also script requests. What protects the app: nosniff + strict MIME checking refuse to run
  // it, and lib/stale-deploy.ts reloads once to fetch the current assets.
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.goto(`${BASE}/sign-in`);
  const seen = await page.evaluate(async () => {
    const r = await fetch('/assets/x.js');
    const ran = await new Promise<string>((resolve) => {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = '/assets/x-missing.js';
      s.onload = () => resolve('ran');
      s.onerror = () => resolve('refused');
      document.head.appendChild(s);
    });
    return { status: r.status, type: r.headers.get('content-type'), ran };
  });
  expect(seen.status).toBe(200);
  expect(seen.type).toContain('text/html');
  expect(seen.ran).toBe('refused');
  expect(consoleErrors.join('\n')).toMatch(/MIME type/);
  await context.close();
});

test('H-4. No CSP violation while a signed-in Admin uses the app (Demo School)', async ({ browser }) => {
  test.skip(!OPERATOR || !OPERATOR_PASSWORD, 'E2E_OPERATOR_USERNAME / E2E_OPERATOR_PASSWORD not set');
  test.setTimeout(300_000);
  let op: ApiSession | null = null;
  const seenRequests: Seen[] = [];
  try {
    op = await operatorSession();
    await op.enterDemo();
    const password = await setKnownPassword(op, 'demo.admin');
    const { context, page } = await newPage(browser, seenRequests, undefined, { baseURL: BASE });
    await page.addInitScript(() => {
      const w = window as unknown as { __csp: string[] };
      w.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        w.__csp.push(`${e.violatedDirective} ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`);
      });
    });
    const consoleCsp: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to (load|connect|apply|execute)/i.test(m.text()))
        consoleCsp.push(m.text());
    });
    await signIn(page, 'demo.admin', password);
    await expect(page.getByTestId('dashboard-admin')).toBeVisible({ timeout: 30_000 });
    await expectDemoSchool(page);
    const violations: string[] = [];
    for (const path of [
      '/dashboard',
      '/students',
      '/admissions',
      '/staff',
      '/staff/groups',
      '/setup/profile',
      '/setup/calendar',
      '/timetable',
      '/schedule',
      '/attendance',
      '/staff-attendance',
      '/homework',
      '/diary',
      '/imports',
      '/users',
    ]) {
      await page.goto(path);
      await expect(page.locator('main').first()).toBeVisible({ timeout: 30_000 });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      violations.push(...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)));
    }
    expect(violations, 'securitypolicyviolation events').toEqual([]);
    expect(consoleCsp, 'CSP messages in the console').toEqual([]);
    // every request went to the allowed origins only (connect-src 'self' + the Supabase project)
    for (const s of seenRequests) expect(new URL(s.url).host).toBe('ctzjkhmannaoxigirsxu.supabase.co');
    await context.close();
  } finally {
    await op?.signOut();
  }
});
