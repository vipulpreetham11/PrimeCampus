import { expect, test, type Page } from '@playwright/test';
import { operatorSession, setKnownPassword, type ApiSession } from './helpers/api';
import { auditNetwork, expectDemoSchool, newPage, type Seen } from './helpers/ui';

// M2X: keyboard-only walkthroughs (no mouse at all), LIVE backend, Demo School only. Screen readers
// are not covered (see the M2X report).

const OPERATOR = process.env.E2E_OPERATOR_USERNAME ?? '';
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? '';
const DAY_WISE = '2026-10-17'; // a day-wise school day (Saturday) with a Class 1 A register

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.skip(!OPERATOR || !OPERATOR_PASSWORD, 'E2E_OPERATOR_USERNAME / E2E_OPERATOR_PASSWORD not set');

const seen: Seen[] = [];
const pw: Record<string, string> = {};
let op: ApiSession;

test.beforeAll(async () => {
  op = await operatorSession();
  await op.enterDemo();
  pw.admin = await setKnownPassword(op, 'demo.admin');
  pw.teacher = await setKnownPassword(op, 'demo.teacher');
});
test.afterAll(async () => {
  await op?.signOut();
});

/** Text / accessible name of the focused element. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el ? (el.getAttribute('aria-label') ?? el.innerText ?? el.textContent ?? '').trim() : '';
  });

/** Press Tab until the focused element's name matches (fails after `max` presses). */
async function tabTo(page: Page, name: RegExp, max = 60) {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    if (name.test(await focused(page))) return;
  }
  throw new Error(`Tab never reached ${name}`);
}

/** Keyboard-only sign-in: type, Tab, type, Enter. */
async function keyboardSignIn(page: Page, username: string, password: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Username').focus();
  await page.keyboard.type(username);
  await page.keyboard.press('Tab');
  await page.keyboard.type(password);
  await page.keyboard.press('Enter');
}

test('K-1. Sign in and move between screens with the keyboard only; the focused link is visible', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await newPage(browser, seen);
  await keyboardSignIn(page, 'demo.admin', pw.admin!);
  await expect(page.getByTestId('dashboard-admin')).toBeVisible({ timeout: 30_000 });
  await expectDemoSchool(page);
  await tabTo(page, /^Students$/);
  // the focused element is on screen and has a visible focus style
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      onScreen: r.width > 0 && r.height > 0,
      indicator: cs.outlineStyle !== 'none' || cs.boxShadow !== 'none' || el.matches(':focus-visible'),
    };
  });
  expect(ring).toEqual({ onScreen: true, indicator: true });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/students$/);
  await expect(page.getByRole('list', { name: 'Students' }).first()).toBeVisible({ timeout: 30_000 });
  await context.close();
});

test('K-2. A dialog opens with Enter, takes the focus, closes with Escape and gives the focus back', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await newPage(browser, seen);
  await keyboardSignIn(page, 'demo.admin', pw.admin!);
  await expect(page.getByTestId('dashboard-admin')).toBeVisible({ timeout: 30_000 });
  await page.goto('/setup/classes');
  await expect(page.getByTestId('class-card-Class 1')).toBeVisible({ timeout: 30_000 });
  await tabTo(page, /^New class$/);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // the focus is inside the dialog (and stays there: Tab cycles within it)
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  for (let i = 0; i < 8; i += 1) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await focused(page)).toBe('New class');

  // a row's action menu: Enter opens, arrows move, Escape closes
  await page.goto('/users');
  await expect(page.getByTestId('user-demo.teacher')).toBeVisible({ timeout: 30_000 });
  await tabTo(page, /^Actions for demo\.teacher$/, 120);
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('menuitem');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(await focused(page)).toBe('Actions for demo.teacher');
  await context.close();
});

test('K-3. A day register marked with the keyboard only: ↓ moves, letters mark and move on, Enter saves', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await newPage(browser, seen);
  await keyboardSignIn(page, 'demo.teacher', pw.teacher!);
  await expect(page.getByTestId('dashboard-teacher')).toBeVisible({ timeout: 30_000 });
  const snap = await op.school<{
    sections: { id: string; class_id: string; name: string }[];
    classes: { id: string; name: string }[];
  }>('get_setup_snapshot');
  const class1 = snap.classes.find((c) => c.name === 'Class 1')!.id;
  const sectionA = snap.sections.find((s) => s.class_id === class1 && s.name === 'A')!.id;
  await page.goto(`/attendance/daily/${sectionA}/${DAY_WISE}`);
  await expect(page.getByTestId('marking-roster')).toBeVisible({ timeout: 30_000 });
  const rows = page.getByTestId('roster-row');
  await expect(rows.first()).toBeVisible();

  // into the list: focus the first row, then ↓ to the second
  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  expect(await rows.nth(1).evaluate((el) => el === document.activeElement)).toBe(true);
  // the second student alternates Late / Present every run (a real change)
  const late =
    (await rows.nth(1).getByRole('radio', { name: 'Late' }).getAttribute('aria-checked')) === 'true';
  await page.keyboard.press(late ? 'p' : 'l');
  await expect(rows.nth(1).getByRole('radio', { name: late ? 'Present' : 'Late' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(rows.nth(1)).toHaveAttribute('data-state', 'changed');
  // marking moved the focus on to the next student, like ticking down a paper register
  expect(await rows.nth(2).evaluate((el) => el === document.activeElement)).toBe(true);
  // ↑ goes back; Home / End jump
  await page.keyboard.press('ArrowUp');
  expect(await rows.nth(1).evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press('End');
  expect(await rows.last().evaluate((el) => el === document.activeElement)).toBe(true);

  // to the Save button and Enter
  await tabTo(page, /^Save attendance/, 200);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('roster-save-bar').getByText('Saved.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(rows.nth(1)).toHaveAttribute('data-state', 'marked');
  await context.close();
});

test('K-4. Network audit of these tests', () => {
  expect(seen.length).toBeGreaterThan(10);
  auditNetwork(seen);
});
