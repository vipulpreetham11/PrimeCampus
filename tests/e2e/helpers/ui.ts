import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';

// Shared UI helpers for the M2X live specs (Demo School only). Passwords are passed in from memory
// and never printed: assertions compare secrets as booleans only.

export const PHONE = { width: 375, height: 812 };
export const DESKTOP = { width: 1280, height: 900 };

export interface Seen {
  url: string;
  body: string | null;
}

/** Records every Supabase request of a page (for the network audits). */
export function watch(page: Page, seen: Seen[]) {
  page.on('request', (r: Request) => {
    if (r.url().includes('.supabase.co')) seen.push({ url: r.url(), body: r.postData() });
  });
}

export async function signIn(page: Page, username: string, password: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function newPage(
  browser: Browser,
  seen: Seen[],
  viewport = DESKTOP,
  options: { baseURL?: string } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, ...options });
  const page = await context.newPage();
  watch(page, seen);
  return { context, page };
}

/** Safety guard before acting: the header must show the Demo School. */
export async function expectDemoSchool(page: Page) {
  await expect(page.getByTestId('context-summary').filter({ visible: true }).first()).toContainText(
    'Demo School',
    { timeout: 30_000 },
  );
}

export const modal = (page: Page) => page.locator('[role="dialog"], [role="alertdialog"]').last();

export async function choose(scope: Page | Locator, label: string | RegExp, option: string | RegExp) {
  const page = 'page' in scope ? scope.page() : scope;
  await scope.getByRole('combobox', { name: label }).click();
  await page
    .getByRole('option', typeof option === 'string' ? { name: option, exact: true } : { name: option })
    .first()
    .click();
}

/** Wait until a list has rendered either its first item or its empty state. */
export async function settled(...locators: Locator[]) {
  let l = locators[0]!;
  for (const o of locators.slice(1)) l = l.or(o);
  await expect(l.first()).toBeVisible({ timeout: 30_000 });
}

export async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

export async function shot(page: Page, path: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page
    .locator('[data-sonner-toaster]')
    .evaluateAll((els) => els.forEach((e) => ((e as HTMLElement).style.display = 'none')));
  await page.screenshot({ path, fullPage: true });
}

// ------------------------------------------------------------------ school-local dates
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export const TODAY = fmt.format(new Date());
export function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  // date-only UTC arithmetic on a date string (no zone involved)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function isoWeekday(iso: string) {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** Network audit shared by the specs: RPC only, p_ctx_rev on every school RPC, nothing else contacted. */
export function auditNetwork(seen: Seen[]) {
  const CONTEXT_FREE = new Set([
    'bootstrap_account',
    'select_context',
    'end_app_session',
    'get_context',
    'record_telemetry',
  ]);
  for (const s of seen) {
    const u = new URL(s.url);
    expect(u.pathname).toMatch(/^\/(rest\/v1\/rpc\/[a-z_0-9]+|auth\/v1\/.+|functions\/v1\/accounts)$/);
    const rpc = /^\/rest\/v1\/rpc\/([a-z_0-9]+)$/.exec(u.pathname)?.[1];
    if (rpc && !CONTEXT_FREE.has(rpc) && !rpc.startsWith('op_')) {
      expect(JSON.parse(s.body ?? '{}'), `${rpc} carries p_ctx_rev`).toHaveProperty('p_ctx_rev');
    }
  }
}
