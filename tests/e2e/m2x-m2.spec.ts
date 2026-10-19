import { expect, test, type Browser, type Page } from '@playwright/test';
import { ApiSession, operatorSession, setKnownPassword } from './helpers/api';
import {
  addDays,
  auditNetwork,
  choose,
  DESKTOP,
  expectDemoSchool,
  isoWeekday,
  modal,
  newPage,
  PHONE,
  signIn,
  TODAY,
  type Seen,
} from './helpers/ui';

// M2X close-out of M2, LIVE backend, Demo School only (every login `demo.*`). Everything through the
// UI; the API helper only gives demo logins a known password, looks up ids and dates, and counts rows.
//
// Attendance mode: Demo School is set to period-wise FROM TODAY (the first run: 19 Oct 2026) and back
// to day-wise FROM TOMORROW (20 Oct 2026), through Setup → Attendance mode. Both rows are permanent;
// later runs find them and check the server's DUPLICATE under the "Starts on" field instead.
// Period marking with mark-remaining-present + 2 exceptions and the two-tab conflict run in
// m2.spec.ts test 2 (it uses the latest period-wise day, i.e. that day).

const OPERATOR = process.env.E2E_OPERATOR_USERNAME ?? '';
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? '';
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const PERIOD_FROM = '2026-10-19';
const DAILY_FROM = '2026-10-20';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.skip(!OPERATOR || !OPERATOR_PASSWORD, 'E2E_OPERATOR_USERNAME / E2E_OPERATOR_PASSWORD not set');

const seen: Seen[] = [];
const pw: Record<string, string> = {};
const ids: Record<string, string> = {};
let op: ApiSession;

/** Next Monday after today (future lessons for the lesson actions). */
const NEXT_MONDAY = addDays(TODAY, 8 - isoWeekday(TODAY));
const fmtLong = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T12:00:00Z`));

test.beforeAll(async () => {
  op = await operatorSession();
  await op.enterDemo();
  pw.admin = await setKnownPassword(op, 'demo.admin');
  pw.teacher = await setKnownPassword(op, 'demo.teacher');
  pw.parent = await setKnownPassword(op, 'demo.parent');
  const snap = await op.school<{
    sections: { id: string; class_id: string; name: string }[];
    classes: { id: string; name: string }[];
  }>('get_setup_snapshot');
  const cls = new Map(snap.classes.map((c) => [c.id, c.name]));
  for (const s of snap.sections) ids[`${cls.get(s.class_id)} ${s.name}`] = s.id;
});
test.afterAll(async () => {
  await op?.signOut();
});

async function as(
  browser: Browser,
  username: string,
  password: string,
  dashboard: string,
  viewport = DESKTOP,
) {
  const s = await newPage(browser, seen, viewport);
  await signIn(s.page, username, password);
  await expect(s.page.getByTestId(dashboard)).toBeVisible({ timeout: 30_000 });
  await expectDemoSchool(s.page);
  return s;
}
const asAdmin = (b: Browser, v = DESKTOP) => as(b, 'demo.admin', pw.admin!, 'dashboard-admin', v);
const asTeacher = (b: Browser, v = DESKTOP) => as(b, 'demo.teacher', pw.teacher!, 'dashboard-teacher', v);

async function dayCard(page: Page, date: string, section: string, period: string) {
  await page.goto(`/schedule?date=${date}&section=${ids[section]}`);
  const card = page.getByTestId('lesson-card').filter({ hasText: period }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

async function lessonMenu(page: Page, card: ReturnType<Page['getByTestId']>, item: string) {
  await card.getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

// ------------------------------------------------------------------ 1. attendance mode
test('M2-1. Attendance mode: period-wise from 19 Oct 2026, day-wise again from 20 Oct (Setup → Attendance mode)', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await asAdmin(browser);
  for (const [mode, from] of [
    ['Period-wise attendance', PERIOD_FROM],
    ['Daily attendance', DAILY_FROM],
  ] as const) {
    await page.goto('/setup/attendance-mode');
    await expect(page.getByTestId('mode-today')).toBeVisible({ timeout: 30_000 });
    const snap = await op.school<{ attendance_modes: { mode: string; effective_from: string }[] }>(
      'get_setup_snapshot',
    );
    const exists = snap.attendance_modes.some((m) => m.effective_from === from);
    if (!exists && from < TODAY) continue; // can't be created in the past (a later day's run)
    await choose(page, 'Mode', mode);
    const starts = page.getByLabel('Starts on');
    await starts.fill(from < TODAY ? TODAY : from);
    await page.getByRole('button', { name: 'Save change' }).click();
    if (!exists) {
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: `${mode} from` })).toBeVisible();
    } else if (from >= TODAY) {
      // a re-run: the server's DUPLICATE (2310) is shown under "Starts on"
      await expect(page.getByText('A mode change already starts on this date')).toBeVisible();
      await expect(starts).toHaveAttribute('aria-invalid', 'true');
    }
  }
  const snap = await op.school<{ attendance_modes: { mode: string; effective_from: string }[] }>(
    'get_setup_snapshot',
  );
  expect(snap.attendance_modes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ mode: 'period', effective_from: PERIOD_FROM }),
      expect.objectContaining({ mode: 'daily', effective_from: DAILY_FROM }),
    ]),
  );
  await page.goto('/setup/attendance-mode');
  if (TODAY === PERIOD_FROM) {
    await expect(page.getByTestId('mode-today')).toContainText('Period-wise attendance');
    await expect(page.getByText(`from ${fmtLong(DAILY_FROM)}`)).toBeVisible();
  }

  await context.close();
});

// ------------------------------------------------------------------ 2. substitute marks a period lesson
test('M2-2. Period-wise day: Meera Rao absent → Ravi Kumar substitutes her Period 1 → he marks that lesson', async ({
  browser,
}) => {
  test.setTimeout(400_000);
  // on the period-wise day (19 Oct 2026); marking a past day is allowed, so later runs repeat it
  const admin = await asAdmin(browser);
  const page = admin.page;
  // staff attendance today: Meera Rao absent, everyone else present
  await page.goto(`/staff-attendance?date=${PERIOD_FROM}`);
  await expect(page.getByTestId('staff-roster')).toBeVisible({ timeout: 30_000 });
  const fill = page.getByRole('button', { name: /^(Mark (all|remaining \d+) present|Everyone is marked)$/ });
  if (await fill.isEnabled()) await fill.click();
  const meera = page.getByTestId('staff-row').filter({ hasText: 'Meera Rao' });
  await meera.getByRole('radio', { name: 'Absent' }).click();
  const save = page.getByRole('button', { name: /Save staff attendance/ });
  if (await save.isEnabled()) {
    await save.click();
    await expect(page.getByTestId('roster-save-bar').getByText('Saved.', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  }
  // her Period 1 lesson in Class 1 A is flagged; Ravi Kumar is assigned (once)
  const p1 = await dayCard(page, PERIOD_FROM, 'Class 1 A', 'Period 1');
  await expect(
    p1.getByTestId('badge-planned-absent').or(p1.getByTestId('badge-substitute')).first(),
  ).toBeVisible();
  if (!(await p1.getByTestId('badge-substitute').isVisible())) {
    await lessonMenu(page, p1, 'Find a substitute');
    const d = modal(page);
    const ravi = d.getByRole('listitem').filter({ hasText: 'Ravi Kumar' });
    await ravi.getByRole('radio').check();
    await d.getByRole('button', { name: /^Assign (substitute|anyway)$/ }).click();
    await expect(d).toBeHidden({ timeout: 30_000 });
  }
  await expect(p1.getByTestId('badge-substitute')).toBeVisible({ timeout: 30_000 });
  await admin.context.close();

  // the substitute marks the period register of that lesson
  const t = await asTeacher(browser, PHONE);
  await t.page.goto(`/dashboard?date=${PERIOD_FROM}`);
  const sub = t.page
    .getByTestId('today-lesson')
    .filter({ hasText: 'Mathematics' })
    .filter({ hasText: 'Substitution' });
  await expect(sub).toBeVisible({ timeout: 30_000 });
  await sub.getByRole('link', { name: 'Attendance' }).click();
  await expect(t.page.getByTestId('marking-roster')).toBeVisible({ timeout: 30_000 });
  await expect(t.page.getByTestId('roster-blocked')).toHaveCount(0);
  const mark = t.page.getByRole('button', {
    name: /^(Mark (all|remaining \d+) present|Everyone is marked)$/,
  });
  if (await mark.isEnabled()) await mark.click();
  // one real change every run: the first student alternates Present / Late
  const first = t.page.getByTestId('roster-row').nth(0);
  const late = (await first.getByRole('radio', { name: 'Late' }).getAttribute('aria-checked')) === 'true';
  await first.getByRole('radio', { name: late ? 'Present' : 'Late' }).click();
  await t.page.getByRole('button', { name: /Save attendance/ }).click();
  await expect(t.page.getByTestId('roster-save-bar').getByText('Saved.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const summary = await t.page.getByTestId('roster-summary').textContent();
  expect(summary).toMatch(/^(\d+) of \1 marked$/);
  await t.context.close();
});

// ------------------------------------------------------------------ 3. parent sees real data of the day
test("M2-3. Parent (demo.parent) sees real data for Aarav on the period-wise day: attendance, a diary note and checked homework; not the other child's", async ({
  browser,
}) => {
  test.setTimeout(400_000);
  // the data of the period-wise day (19 Oct 2026: "today" on the first run)
  const note = `Read pages 10–12 aloud (E2E ${RUN})`;
  const hwText = `Learn the five new words — ${RUN}`;
  // the teacher writes today's diary for his English lesson, sets homework and checks Aarav's
  const t = await asTeacher(browser);
  await t.page.goto(`/dashboard?date=${PERIOD_FROM}`);
  const english = t.page
    .getByTestId('today-lesson')
    .filter({ hasText: 'English' })
    .filter({ hasNotText: 'Substitution' })
    .first();
  await english.getByRole('link', { name: 'Diary & homework' }).click();
  await expect(t.page.getByTestId('lesson-page')).toBeVisible({ timeout: 30_000 });
  await t.page.getByLabel('What was covered').fill(note);
  await t.page.getByRole('button', { name: /^(Save diary|Save changes)$/ }).click();
  await expect(t.page.getByTestId('diary-meta')).toContainText('Lesson on', { timeout: 30_000 });
  await t.page.getByRole('button', { name: 'Set homework' }).click();
  const d = modal(t.page);
  await d.getByLabel('Homework').fill(hwText);
  await d.getByRole('button', { name: 'Set homework' }).click();
  await expect(d).toBeHidden({ timeout: 30_000 });
  const hw = t.page.getByTestId('lesson-homework').filter({ hasText: RUN });
  await hw.getByRole('link', { name: 'Check homework' }).click();
  await expect(t.page.getByTestId('homework-roster')).toBeVisible({ timeout: 30_000 });
  const aarav = t.page.getByTestId('check-row').filter({ hasText: 'Aarav Sharma' });
  await aarav.getByRole('radio', { name: 'Completed', exact: true }).click();
  await t.page.getByRole('button', { name: /Save checks/ }).click();
  await expect(t.page.getByTestId('roster-save-bar').getByText('Saved.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await t.context.close();

  // the parent, Aarav selected
  const { context, page } = await newPage(browser, seen, PHONE);
  await signIn(page, 'demo.parent', pw.parent!);
  await expect(page).toHaveURL(/\/choose$/, { timeout: 30_000 });
  await page.getByRole('button', { name: /Aarav Sharma/ }).click();
  await expect(page.getByTestId('dashboard-parent')).toBeVisible({ timeout: 30_000 });
  await expectDemoSchool(page);
  const day = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${PERIOD_FROM}T12:00:00Z`),
  );
  await page.goto('/child/attendance');
  const record = page.getByTestId('attendance-record').filter({ hasText: day }).first();
  await expect(record).toBeVisible({ timeout: 30_000 });
  await expect(record).toContainText('Mathematics');
  await expect(record).not.toContainText('No lessons recorded');
  await page.goto('/child/diary');
  await expect(page.getByTestId('child-diary-note').filter({ hasText: note })).toBeVisible({
    timeout: 30_000,
  });
  await page.goto('/child/homework');
  const item = page.getByTestId('child-homework').filter({ hasText: hwText });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await expect(item).toContainText('Completed');
  // the other child: no route takes a child id; staff routes are closed
  const anaya = await op.school<{ items: { student_id: string; name: string }[] }>('list_students', {
    p_search: 'Anaya Sharma',
  });
  await page.goto(`/students/${anaya.items.find((s) => s.name === 'Anaya Sharma')!.student_id}`);
  await expect(page.getByText("You don't have access to this page")).toBeVisible();
  await context.close();
});

// ------------------------------------------------------------------ 4. lesson actions
test('M2-4. Lesson cancel / restore / change subject · substitute with a clash (override reason) · remove the substitute', async ({
  browser,
}) => {
  test.setTimeout(400_000);
  const { context, page } = await asAdmin(browser);
  // Period 1 of next Monday (Class 1 A, Mathematics): cancel with a reason, restore, change subject and back
  let p1 = await dayCard(page, NEXT_MONDAY, 'Class 1 A', 'Period 1');
  if (await p1.getByTestId('badge-cancelled').isVisible()) {
    await lessonMenu(page, p1, 'Restore lesson'); // a run that stopped half-way
    await modal(page).getByRole('button', { name: 'Restore lesson' }).click();
  }
  await lessonMenu(page, p1, 'Cancel lesson');
  let d = modal(page);
  await d.getByLabel('Reason (required)').fill(`E2E ${RUN}: school event`);
  await d.getByRole('button', { name: 'Cancel lesson' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Lesson cancelled.' })).toBeVisible();
  p1 = await dayCard(page, NEXT_MONDAY, 'Class 1 A', 'Period 1');
  await expect(p1.getByTestId('badge-cancelled')).toBeVisible();
  await expect(p1).toContainText(`E2E ${RUN}: school event`);
  await lessonMenu(page, p1, 'Restore lesson');
  await modal(page).getByRole('button', { name: 'Restore lesson' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Lesson restored.' })).toBeVisible();
  await expect(p1.getByTestId('badge-cancelled')).toHaveCount(0);
  const subject = (await p1.textContent())?.includes('Mathematics') ? 'Science' : 'Mathematics';
  await lessonMenu(page, p1, 'Change subject');
  d = modal(page);
  await choose(d, 'New subject', subject);
  await d.getByRole('button', { name: 'Change subject' }).click();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Subject changed.' }).first(),
  ).toBeVisible();
  await expect(p1).toContainText(subject, { timeout: 30_000 });
  await lessonMenu(page, p1, 'Change subject'); // back, so later runs see the plan
  d = modal(page);
  await choose(d, 'New subject', 'Mathematics');
  await d.getByRole('button', { name: 'Change subject' }).click();
  await expect(p1).toContainText('Mathematics', { timeout: 30_000 });

  // Period 3 (Science, Ravi Kumar): Meera Rao teaches Class 1 B then → the clash needs a reason
  // (Class 1 B's lessons for that day come from its active timetable: generate them first)
  await page.goto('/timetable/lessons');
  await choose(page, 'Section', 'Class 1 B');
  await page.getByLabel('From').fill(NEXT_MONDAY);
  await page.getByLabel('To').fill(NEXT_MONDAY);
  await page.getByRole('button', { name: 'Update lessons' }).click();
  await expect(page.getByTestId('lesson-refresh-result')).toBeVisible({ timeout: 60_000 });
  const b3 = await dayCard(page, NEXT_MONDAY, 'Class 1 B', 'Period 3');
  await expect(b3).toContainText('Meera Rao');
  const p3 = await dayCard(page, NEXT_MONDAY, 'Class 1 A', 'Period 3');
  if (await p3.getByTestId('badge-substitute').isVisible()) {
    await lessonMenu(page, p3, 'Remove substitute');
    await modal(page).getByRole('button', { name: 'Remove substitute' }).click();
    await expect(p3.getByTestId('badge-substitute')).toHaveCount(0);
  }
  await lessonMenu(page, p3, 'Find a substitute');
  d = modal(page);
  const meera = d.getByRole('listitem').filter({ hasText: 'Meera Rao' });
  await expect(meera).toContainText('Has another lesson then');
  await meera.getByRole('radio').check();
  await d.getByRole('button', { name: 'Assign substitute' }).click();
  await expect(d.getByLabel('Reason to assign anyway')).toBeVisible({ timeout: 30_000 });
  await d.getByLabel('Reason to assign anyway').fill(`E2E ${RUN}: combined class`);
  await d.getByRole('button', { name: 'Assign anyway' }).click();
  await expect(d).toBeHidden({ timeout: 30_000 });
  await expect(p3.getByTestId('badge-substitute')).toBeVisible({ timeout: 30_000 });
  await expect(p3).toContainText('Meera Rao');
  // remove the substitute again
  await lessonMenu(page, p3, 'Remove substitute');
  await modal(page).getByRole('button', { name: 'Remove substitute' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Substitute removed.' })).toBeVisible();
  await expect(p3.getByTestId('badge-substitute')).toHaveCount(0);
  await context.close();
});

// ------------------------------------------------------------------ 5. overview, diary list, homework edit/cancel
test('M2-5. Attendance overview · diary list incl. "Missing diary only" · homework edit and cancel', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAdmin(browser);
  await page.goto(`/attendance?date=${PERIOD_FROM}`);
  const row = page.getByTestId('overview-row').filter({ hasText: 'Class 1 A' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).not.toContainText('No lessons');

  await page.goto('/diary');
  const items = page.getByTestId('diary-item');
  await expect(items.first()).toBeVisible({ timeout: 30_000 });
  const all = await items.count();
  await page.getByLabel('Missing diary only').click();
  await expect.poll(() => items.count(), { timeout: 30_000 }).toBeLessThanOrEqual(all);
  const missing = await items.count();
  if (missing > 0)
    await expect(items.filter({ has: page.getByTestId('diary-missing') })).toHaveCount(missing);

  // homework: a run-unique one on next Monday's Period 2, then edited and cancelled from the list
  const p2 = await dayCard(page, NEXT_MONDAY, 'Class 1 A', 'Period 2');
  await p2.getByRole('link').first().click();
  await expect(page.getByTestId('lesson-page')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Set homework' }).click();
  let d = modal(page);
  await d.getByLabel('Homework').fill(`Edit me — ${RUN}`);
  await d.getByRole('button', { name: 'Set homework' }).click();
  await expect(d).toBeHidden({ timeout: 30_000 });
  await page.goto(`/homework`);
  await page.getByLabel('Set from').fill(NEXT_MONDAY);
  await page.getByLabel('to', { exact: true }).fill(NEXT_MONDAY);
  const item = page.getByTestId('homework-item').filter({ hasText: RUN });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await item.getByRole('button', { name: 'Edit' }).click();
  d = modal(page);
  await d.getByLabel('Homework').fill(`Edited — ${RUN}`);
  await d.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Homework updated.' })).toBeVisible();
  await expect(item).toContainText(`Edited — ${RUN}`);
  await item.getByRole('button', { name: 'Edit' }).click();
  await modal(page).getByRole('button', { name: 'Cancel this homework' }).click();
  await modal(page).getByRole('button', { name: 'Cancel homework' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Homework cancelled.' })).toBeVisible();
  await expect(page.getByTestId('homework-item').filter({ hasText: RUN })).toHaveCount(0);
  await context.close();
});

// ------------------------------------------------------------------ 6. timetable copy / DUPLICATE / discard
test('M2-6. Copy the active timetable to another section → the same copy again is DUPLICATE ("Open it") → discard the draft', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAdmin(browser);
  const start = addDays(TODAY, 30 + (Math.floor(Date.now() / 60_000) % 100));
  await page.goto(`/timetable?section=${ids['Class 1 A']}`);
  const versions = page.getByRole('list', { name: 'Timetable versions' });
  await expect(versions).toBeVisible({ timeout: 30_000 });
  await versions
    .getByRole('listitem')
    .filter({ hasText: 'Active' })
    .first()
    .getByRole('link')
    .first()
    .click();
  await expect(page.getByTestId('timetable-grid')).toBeVisible({ timeout: 30_000 });
  const source = page.url();

  const copy = async () => {
    await page.getByRole('button', { name: /Copy to another section/ }).click();
    const d = modal(page);
    await d.getByRole('combobox', { name: 'Copy to' }).click();
    await page.getByRole('option', { name: 'Class 2 B', exact: true }).click();
    await d.getByLabel('Starts on').fill(start);
    await d.getByRole('button', { name: 'Copy' }).click();
    return d;
  };
  await copy();
  await expect(page).toHaveURL(/\/timetable\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect.poll(() => page.url()).not.toBe(source);
  const draft = page.url();
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();

  // the same copy again: DUPLICATE with the draft's id → "Open it" opens that draft
  await page.goto(source);
  await expect(page.getByTestId('timetable-grid')).toBeVisible({ timeout: 30_000 });
  const d = await copy();
  const notice = d.getByTestId('existing-draft');
  await expect(notice).toContainText(`This section already has a draft starting on ${fmtLong(start)}`);
  await notice.getByRole('button', { name: 'Open it' }).click();
  await expect(page).toHaveURL(draft);

  // discard it
  await page.getByRole('button', { name: /Discard draft/ }).click();
  await modal(page).getByRole('button', { name: 'Discard draft' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Draft discarded.' })).toBeVisible();
  await expect(page).toHaveURL(/\/timetable\?section=/);
  await context.close();
});

// ------------------------------------------------------------------ 7. leave with unsaved marks
test('M2-7. Leaving a register with unsaved marks asks first (Stay keeps them; Leave without saving drops them)', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await asTeacher(browser);
  await page.goto(`/attendance/daily/${ids['Class 1 A']}/${DAILY_FROM <= TODAY ? TODAY : '2026-10-17'}`);
  await expect(page.getByTestId('marking-roster')).toBeVisible({ timeout: 30_000 });
  const first = page.getByTestId('roster-row').nth(0);
  const late = (await first.getByRole('radio', { name: 'Late' }).getAttribute('aria-checked')) === 'true';
  await first.getByRole('radio', { name: late ? 'Present' : 'Late' }).click();
  await expect(first).toHaveAttribute('data-state', 'changed');
  await page.getByRole('link', { name: 'Homework' }).first().click();
  const leave = modal(page);
  await expect(leave).toContainText('Leave without saving?');
  await leave.getByRole('button', { name: 'Stay' }).click();
  await expect(first).toHaveAttribute('data-state', 'changed');
  await page.getByRole('link', { name: 'Homework' }).first().click();
  await modal(page).getByRole('button', { name: 'Leave without saving' }).click();
  await expect(page).toHaveURL(/\/homework/);
  await context.close();
});

test('M2-8. "Load more" on homework and diary lists only appears past 50 rows (counted)', async () => {
  // Recorded for the report: Demo School has fewer than 50 of each, so there is no second page.
  const hw = await op.school<{ items: unknown[]; next_cursor: unknown }>('list_homework', {
    p_from: '2026-04-01',
    p_to: '2027-03-31',
    p_limit: 50,
  });
  const diary = await op.school<{ items: unknown[]; next_cursor: unknown }>('list_diary_entries', {
    p_from: addDays(TODAY, -62),
    p_to: TODAY,
    p_limit: 50,
  });
  test.info().annotations.push({
    type: 'counts',
    description: `homework rows: ${hw.items.length}${hw.next_cursor ? '+' : ''}; diary rows (63 days): ${diary.items.length}${diary.next_cursor ? '+' : ''}`,
  });
  expect(hw.items.length).toBeGreaterThan(0);
});

test('M2-10. Principal: attendance overview, staff register and homework checks are read-only; writes are FORBIDDEN', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const password = await setKnownPassword(op, 'demo.principal');
  const { context, page } = await newPage(browser, seen);
  await signIn(page, 'demo.principal', password);
  await expect(page.getByTestId('context-summary').first()).toContainText('Principal', { timeout: 30_000 });
  await expectDemoSchool(page);
  await page.goto(`/attendance?date=${PERIOD_FROM}`);
  await expect(page.getByTestId('overview-row').filter({ hasText: 'Class 1 A' })).toBeVisible({
    timeout: 30_000,
  });
  await page.goto(`/staff-attendance?date=${PERIOD_FROM}`);
  await expect(page.getByTestId('staff-roster')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Save staff attendance/ })).toHaveCount(0);
  await page.goto('/homework');
  await page.getByLabel('Set from').fill('2026-10-01');
  const item = page.getByTestId('homework-item').first();
  await expect(item).toBeVisible({ timeout: 30_000 });
  await item.getByRole('link', { name: 'See checks' }).click();
  await expect(page.getByTestId('homework-roster')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('You can see the checks but not change them.')).toBeVisible();
  await context.close();

  const aarav = (
    await op.school<{ items: { student_id: string; name: string }[] }>('list_students', {
      p_search: 'Aarav Sharma',
    })
  ).items.find((x) => x.name === 'Aarav Sharma')!.student_id;
  const api = await ApiSession.signIn('demo.principal', password);
  try {
    await api.enterDemo('principal');
    await expect(
      api.school('mark_staff_attendance', {
        p_operation_id: crypto.randomUUID(),
        p_date: PERIOD_FROM,
        p_marks: [],
      }),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      api.school('mark_student_attendance', {
        p_operation_id: crypto.randomUUID(),
        p_kind: 'daily',
        p_section_id: ids['Class 1 A'],
        p_date: '2026-10-17',
        p_marks: [{ student_id: aarav, status: 'present', expected_version: null }],
      }),
    ).rejects.toThrow(/FORBIDDEN/);
  } finally {
    await api.signOut();
  }
});

test('M2-9. Network audit of these tests', () => {
  expect(seen.length).toBeGreaterThan(10);
  auditNetwork(seen);
});
