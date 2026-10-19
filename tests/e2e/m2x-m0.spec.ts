import { expect, test, type Page } from '@playwright/test';
import { ApiSession, newPassword, operatorSession, setKnownPassword } from './helpers/api';
import { auditNetwork, expectDemoSchool, newPage, PHONE, signIn, type Seen } from './helpers/ui';

// M2X close-out of M0, LIVE backend, Demo School only (every login is `demo.*`). Items not verified
// live in M0: the multi-role chooser and switching with a second tab following, and the
// must_change_password re-sign-in fallback. (Headers + SPA fallback: m2x-headers.spec.ts.)
// Passwords exist only in memory and are never printed.

const OPERATOR = process.env.E2E_OPERATOR_USERNAME ?? '';
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? '';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.skip(!OPERATOR || !OPERATOR_PASSWORD, 'E2E_OPERATOR_USERNAME / E2E_OPERATOR_PASSWORD not set');

const seen: Seen[] = [];
const pw: Record<string, string> = {};
let op: ApiSession;

test.beforeAll(async () => {
  op = await operatorSession();
  await op.enterDemo();
  pw.teachparent = await setKnownPassword(op, 'demo.teachparent');
});
test.afterAll(async () => {
  await op?.signOut();
});

const revisionOf = (page: Page) => page.evaluate(() => window.__pcE2E!.revision());
const cachedRevisions = (page: Page) =>
  page.evaluate(() =>
    window
      .__pcE2E!.cachedQueryKeys()
      .filter((k) => k[0] === 'ctx')
      .map((k) => k[2] as number),
  );

test('M0-1. demo.teachparent: chooser, Teacher ↔ Parent; a second tab follows and drops the old data', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page: tabA } = await newPage(browser, seen);
  await signIn(tabA, 'demo.teachparent', pw.teachparent!);
  await expect(tabA).toHaveURL(/\/choose$/, { timeout: 30_000 });
  // the chooser offers both roles: Teacher and the Parent role's child
  await expect(tabA.getByTestId('context-teacher')).toBeVisible();
  await expect(tabA.getByRole('button', { name: /Kabir Rao/ })).toBeVisible();

  await tabA.getByTestId('context-teacher').click();
  await expect(tabA.getByTestId('dashboard-teacher')).toBeVisible({ timeout: 30_000 });
  await expectDemoSchool(tabA);
  await expect(tabA.getByTestId('context-summary').first()).toContainText('Teacher');

  // tab B: same login, a Teacher-only screen with Teacher data in its cache
  const tabB = await context.newPage();
  tabB.on('request', (r) => {
    if (r.url().includes('.supabase.co')) seen.push({ url: r.url(), body: r.postData() });
  });
  await tabB.goto('/setup/calendar');
  await expect(tabB.getByTestId('calendar-totals')).toBeVisible({ timeout: 30_000 });
  const revTeacher = await revisionOf(tabB);
  expect(await cachedRevisions(tabB)).toContain(revTeacher);

  // tab A switches to the Parent role
  await tabA.bringToFront();
  await tabA.getByTestId('switch-context').first().click();
  await expect(tabA).toHaveURL(/\/choose$/);
  await expect(tabA.getByTestId('context-teacher')).toContainText('Current');
  await tabA.getByRole('button', { name: /Kabir Rao/ }).click();
  await expect(tabA.getByTestId('dashboard-parent')).toBeVisible({ timeout: 30_000 });
  const revParent = await revisionOf(tabA);
  expect(revParent).not.toBe(revTeacher);

  // tab B follows: it now shows the Parent context, told why, and holds no Teacher data
  await tabB.bringToFront();
  await expect(tabB.getByTestId('context-summary').first()).toContainText('Kabir Rao', { timeout: 15_000 });
  await expect(tabB.getByTestId('context-summary').first()).toContainText('Parent');
  await expect(tabB.getByTestId('context-notice')).toContainText(/changed/i);
  await expect.poll(() => revisionOf(tabB)).toBe(revParent);
  // The Teacher screen was still open while the new context loaded; its re-queries under the old
  // revision are refused by the server (STALE_CONTEXT), so they may sit in the cache — but empty.
  const leftovers = await tabB.evaluate(
    (rev) => window.__pcE2E!.cachedQueries().filter((q) => q.key[0] === 'ctx' && q.key[2] === rev),
    revTeacher,
  );
  expect(
    leftovers.filter((q) => q.hasData),
    'no Teacher data left in tab B',
  ).toEqual([]);
  // the Teacher-only screen is closed to the Parent role
  await tabB.goto('/setup/calendar');
  await expect(tabB.getByText("You don't have access to this page")).toBeVisible();

  // and back: switching in tab B to Teacher makes tab A follow
  await tabB.getByTestId('switch-context').first().click();
  await tabB.getByTestId('context-teacher').click();
  await expect(tabB.getByTestId('dashboard-teacher')).toBeVisible({ timeout: 30_000 });
  await tabA.bringToFront();
  await expect(tabA.getByTestId('context-summary').first()).toContainText('Teacher', { timeout: 15_000 });
  await expect(tabA.getByTestId('context-summary').first()).not.toContainText('Kabir Rao');
  await context.close();
});

test('M0-2. must_change_password: the forced change, then the re-sign-in fallback when the session is gone', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // demo.teachparent gets a temporary password (Edge reset_password) → must change it at sign-in
  const found = await op.rpc<{ account_id: string }>('op_find_account', { p_username: 'demo.teachparent' });
  const { temporary_password: temp } = await op.edge<{ temporary_password: string }>('reset_password', {
    account_id: found.account_id,
  });

  const { context, page } = await newPage(browser, seen, PHONE);
  await signIn(page, 'demo.teachparent', temp);
  await expect(page).toHaveURL(/\/change-password$/, { timeout: 30_000 });
  for (const path of ['/dashboard', '/choose']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/change-password$/);
  }

  // Force the fallback: after change_password, the next bootstrap_account answers as if Auth had
  // revoked the session (401 "JWT expired" → UNAUTHENTICATED). The app must sign in again with the
  // new password and carry on, without asking the user.
  let armed = false;
  let forced = 0;
  let signInAfterChange = 0;
  page.on('request', (r) => {
    if (r.url().includes('/functions/v1/accounts') && (r.postData() ?? '').includes('change_password'))
      armed = true;
    if (armed && forced > 0 && r.url().includes('/auth/v1/token?grant_type=password')) signInAfterChange += 1;
  });
  await page.route('**/rest/v1/rpc/bootstrap_account', async (route) => {
    if (armed && forced === 0) {
      forced += 1;
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'PGRST301', message: 'JWT expired', details: null, hint: null }),
      });
    }
    return route.continue();
  });

  const next = newPassword();
  await page.getByLabel('Temporary password').fill(temp);
  await page.getByLabel('New password', { exact: true }).fill(next);
  await page.getByLabel('Confirm new password').fill(next);
  await page.getByRole('button', { name: 'Save new password' }).click();

  // multi-role login → the chooser, signed in with the NEW password by the fallback
  await expect(page).toHaveURL(/\/choose$/, { timeout: 30_000 });
  expect(forced, 'the first bootstrap after the change was answered with 401').toBe(1);
  expect(signInAfterChange, 'the app signed in again with the new password').toBe(1);
  await page.getByTestId('context-teacher').click();
  await expect(page.getByTestId('dashboard-teacher')).toBeVisible({ timeout: 30_000 });
  await expectDemoSchool(page);
  pw.teachparent = next;
  await context.close();

  // the new password works on its own; the temporary one no longer does
  const again = await ApiSession.signIn('demo.teachparent', next);
  await again.signOut();
  await expect(ApiSession.signIn('demo.teachparent', temp)).rejects.toThrow(/sign-in failed/);
});

test('M0-3. Network audit of these tests', () => {
  expect(seen.length).toBeGreaterThan(10);
  auditNetwork(seen);
});
