import { expect, test, type Browser, type Page, type Request } from '@playwright/test';

// Live backend, Demo School (code `demo`) only. Never touches any other school.
// Secrets: operator credentials from env; temporary/new passwords exist only in memory here.

const OPERATOR = process.env.E2E_OPERATOR_USERNAME ?? '';
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? '';
const DEMO_ADMIN = 'demo.admin';
const GENERIC = 'The username or password is incorrect.';
const SCREENS = 'docs/reports/m0-screens';

test.describe.configure({ mode: 'serial' });
test.skip(!OPERATOR || !OPERATOR_PASSWORD, 'E2E_OPERATOR_USERNAME / E2E_OPERATOR_PASSWORD not set');

// ------------------------------------------------------------------ network audit (every test)
interface Seen {
  url: string;
  method: string;
  body: string | null;
}
const seen: Seen[] = [];
function watch(page: Page) {
  page.on('request', (r: Request) => {
    if (r.url().includes('.supabase.co')) seen.push({ url: r.url(), method: r.method(), body: r.postData() });
  });
}

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function newPage(browser: Browser, viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  watch(page);
  return { context, page };
}

async function operatorIntoDemoSchool(page: Page) {
  await signIn(page, OPERATOR, OPERATOR_PASSWORD);
  await expect(page).toHaveURL(/\/choose$/);
  await page.getByTestId('operator-school-demo').click();
  await expect(page.getByTestId('dashboard-operator')).toBeVisible();
}

let tempPassword = '';

test('1. Operator creates Demo School if missing, provisions demo.admin, sees the temp password once', async ({
  browser,
}) => {
  const { context, page } = await newPage(browser);
  await signIn(page, OPERATOR, OPERATOR_PASSWORD);
  await expect(page).toHaveURL(/\/choose$/);
  await expect(page.getByRole('heading', { name: 'Choose where to continue' })).toBeVisible();

  await page.getByTestId('operator-console').click();
  await expect(page.getByRole('heading', { name: 'School onboarding' })).toBeVisible();
  // wait for the list to settle (table or empty state)
  await expect(page.getByRole('table').or(page.getByText('No schools yet'))).toBeVisible();

  if (!(await page.getByTestId('school-row-demo').isVisible())) {
    await page.getByLabel('Organization name').fill('Demo Organization');
    await page.getByLabel('Organization code').fill('demo');
    await page.getByLabel('School name').fill('Demo School');
    await page.getByLabel('School code').fill('demo');
    await page.getByRole('button', { name: 'Create school' }).click();
  }
  await expect(page.getByTestId('school-row-demo')).toContainText('Demo School');

  await page.getByRole('combobox', { name: 'School' }).click();
  await page.getByRole('option', { name: 'Demo School (demo)' }).click();
  await page.getByLabel('Username').fill(DEMO_ADMIN);
  await page.getByLabel('Full name').fill('Demo Admin');
  await page.getByRole('button', { name: 'Create Admin login' }).click();

  const secret = page.getByTestId('one-time-secret');
  const reissue = page.getByRole('button', { name: 'Issue a new temporary password' });
  await expect(secret.or(reissue)).toBeVisible();
  if (await reissue.isVisible()) {
    // demo.admin exists from an earlier run → op_find_account + Edge reset_password
    await reissue.click();
  }
  await expect(secret).toBeVisible();
  tempPassword = (await secret.textContent())?.trim() ?? '';
  expect(tempPassword).toMatch(/^[A-Za-z0-9]{14}$/);

  // Shown once: closing removes it and it is not stored anywhere in the browser.
  await page.getByRole('button', { name: /I have noted it/ }).click();
  await expect(secret).toBeHidden();
  expect(await page.content()).not.toContain(tempPassword);
  const stored = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
  );
  expect(stored).not.toContain(tempPassword);
  expect(page.url()).not.toContain(tempPassword);
  await context.close();
});

test('2. demo.admin signs in with the temp password, is forced to change it, lands on the Admin shell', async ({
  browser,
}) => {
  expect(tempPassword, 'test 1 must provide a temporary password').not.toBe('');
  const { context, page } = await newPage(browser, { width: 375, height: 812 });
  await signIn(page, DEMO_ADMIN, tempPassword);
  await expect(page).toHaveURL(/\/change-password$/);
  await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible();

  // Nothing else is reachable while must_change_password is set.
  for (const path of ['/dashboard', '/choose', '/operator/onboarding']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/change-password$/);
  }

  const newPassword = `Demo-${crypto.randomUUID().slice(0, 12)}`;
  await page.getByLabel('Temporary password').fill(tempPassword);
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Save new password' }).click();

  await expect(page.getByTestId('dashboard-admin')).toBeVisible();
  const summary = page.getByTestId('context-summary');
  await expect(summary).toContainText('Demo School');
  await expect(summary).toContainText('Admin');
  await expect(page.getByText('Coming in module M4')).toBeVisible();
  await page.screenshot({ path: `${SCREENS}/375-admin-shell.png`, fullPage: true });

  // Old temp password no longer works; reload keeps the session and the context.
  await page.reload();
  await expect(page.getByTestId('dashboard-admin')).toBeVisible();
  await context.close();
});

test('3. Wrong password shows a generic error that does not reveal whether the user exists', async ({
  browser,
}) => {
  const { context, page } = await newPage(browser, { width: 375, height: 812 });
  await page.goto('/sign-in');
  await page.screenshot({ path: `${SCREENS}/375-sign-in.png`, fullPage: true });

  await signIn(page, DEMO_ADMIN, 'definitely-not-the-password');
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText(GENERIC);
  const existing = await alert.textContent();

  await signIn(page, 'demo.no-such-user-e2e', 'definitely-not-the-password');
  await expect(alert).toHaveText(GENERIC);
  expect(await alert.textContent()).toBe(existing);
  await expect(page.getByText(/not found|does not exist|no such|unknown user/i)).toHaveCount(0);
  await expect(page).toHaveURL(/\/sign-in$/);
  // The internal email alias is never shown.
  expect(await page.content()).not.toContain('@login.');
  await context.close();
});

test('4. Logout in tab A logs out tab B', async ({ browser }) => {
  const { context, page: tabA } = await newPage(browser);
  await operatorIntoDemoSchool(tabA);

  const tabB = await context.newPage();
  watch(tabB);
  await tabB.goto('/dashboard');
  await expect(tabB.getByTestId('dashboard-operator')).toBeVisible();

  await tabA.getByTestId('user-menu').click();
  await tabA.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(tabA).toHaveURL(/\/sign-in$/);

  await expect(tabB).toHaveURL(/\/sign-in$/, { timeout: 10_000 });
  await expect(tabB.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  // and B cannot get back in without signing in
  await tabB.goto('/dashboard');
  await expect(tabB).toHaveURL(/\/sign-in$/);
  await context.close();
});

test('5. A forced stale context revision shows the "role/school changed" message and recovers', async ({
  browser,
}) => {
  const { context, page } = await newPage(browser, { width: 375, height: 812 });
  await signIn(page, OPERATOR, OPERATOR_PASSWORD);
  await expect(page).toHaveURL(/\/choose$/);
  await expect(page.getByTestId('operator-school-demo')).toBeVisible();
  await page.screenshot({ path: `${SCREENS}/375-chooser-operator.png`, fullPage: true });
  await page.getByTestId('operator-school-demo').click();
  await expect(page.getByTestId('dashboard-operator')).toBeVisible();
  await page.screenshot({ path: `${SCREENS}/375-operator-shell.png`, fullPage: true });

  const before = await page.evaluate(() => window.__pcE2E!.revision());
  expect(before).not.toBeNull();

  // Client now holds an out-of-date revision; the server must reject the next school RPC.
  await page.evaluate(() => window.__pcE2E!.forceStaleRevision());
  const probe = page.waitForRequest((r) => r.url().endsWith('/rest/v1/rpc/get_setup_snapshot'));
  expect(await page.evaluate(() => window.__pcE2E!.probeSchoolRpc())).toBe('STALE_CONTEXT');
  expect(JSON.parse((await probe).postData() ?? '{}')).toMatchObject({ p_ctx_rev: before! - 1 });

  const notice = page.getByTestId('context-notice');
  await expect(notice).toContainText('Your role/school changed');
  await expect(notice).toContainText('Operator — Demo School');
  await page.screenshot({ path: `${SCREENS}/375-stale-context-notice.png`, fullPage: true });

  // Recovered: the client adopted the server's revision and school RPCs succeed again.
  await expect.poll(() => page.evaluate(() => window.__pcE2E!.revision())).toBe(before);
  expect(await page.evaluate(() => window.__pcE2E!.probeSchoolRpc())).toBe('ok');
  await expect(page.getByTestId('dashboard-operator')).toBeVisible();
  await context.close();
});

test('6. Network audit: RPC only, and p_ctx_rev on every school RPC', async () => {
  expect(seen.length).toBeGreaterThan(10);
  const rest = seen.filter((s) => s.url.includes('/rest/v1/'));
  // Never a direct table read: every Data API call is /rest/v1/rpc/<function>.
  for (const s of rest) expect(s.url, `${s.method} ${s.url}`).toMatch(/\/rest\/v1\/rpc\/[a-z_0-9]+(\?|$)/);
  const contextFree = new Set([
    'bootstrap_account',
    'select_context',
    'end_app_session',
    'get_context',
    'record_telemetry',
  ]);
  const schoolCalls = rest.filter((s) => {
    const fn = /\/rpc\/([a-z_0-9]+)/.exec(s.url)![1]!;
    return !contextFree.has(fn) && !fn.startsWith('op_');
  });
  expect(schoolCalls.length).toBeGreaterThan(0);
  for (const s of schoolCalls) expect(JSON.parse(s.body ?? '{}'), s.url).toHaveProperty('p_ctx_rev');
  // Only Auth, RPC and the accounts Edge Function are contacted.
  for (const s of seen) expect(s.url).toMatch(/\/(auth\/v1|rest\/v1\/rpc|functions\/v1\/accounts)\b/);
});
