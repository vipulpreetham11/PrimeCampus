import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { ApiSession, operatorSession, setKnownPassword } from './helpers/api';
import {
  addDays,
  auditNetwork,
  choose,
  DESKTOP,
  expectDemoSchool,
  modal,
  newPage,
  noHorizontalScroll,
  PHONE,
  shot,
  signIn,
  TODAY,
  type Seen,
} from './helpers/ui';

// M4 live checks — salary, reports, lessons on a date, dashboards, operator console. LIVE backend,
// Demo School only: every login is `demo.*` and "Demo School" is asserted before any action. All
// actions go through the UI; the API helper only gives demo logins a known password, looks up ids and
// reads numbers for the cross-checks.
//
// Repeatable: step 1 flips Lata Iyer's mark on one day of the salary month at its end, so the next run
// always has something new to save; the paid leave moves to another day each run. The extra lesson on
// 19 Oct is made once and found again ("Already added") on later runs.

const OPERATOR = process.env.E2E_OPERATOR_USERNAME ?? '';
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? '';
const SHOTS = 'docs/reports/m4-screens';
/** The period-wise day and the first day-wise day of Demo School (M2X). */
const PERIOD_DAY = '2026-10-19';
const DAILY_DAY = '2026-10-20';
const REGISTER_MONTH = '2026-10';

const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
/** The salary month the page opens by default: the previous month. */
const SALARY_MONTH = monthStart(addDays(monthStart(TODAY), -1));
const SALARY_PARAM = SALARY_MONTH.slice(0, 7);

const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const inr = (p: number) => INR.format(Number(`${Math.trunc(p / 100)}.${String(p % 100).padStart(2, '0')}`));

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.skip(!OPERATOR || !OPERATOR_PASSWORD, 'E2E_OPERATOR_USERNAME / E2E_OPERATOR_PASSWORD not set');

const seen: Seen[] = [];
const pw: Record<string, string> = {};
const ids: Record<string, string> = {};
let op: ApiSession;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  op = await operatorSession();
  await op.enterDemo();
  for (const u of ['admin', 'owner', 'teacher', 'teachparent', 'principal', 'accountant'])
    pw[u] = await setKnownPassword(op, `demo.${u}`);
  const snap = await op.school<{
    classes: { id: string; name: string }[];
    sections: { id: string; name: string; class_id: string; status: string }[];
  }>('get_setup_snapshot');
  const class1 = snap.classes.find((c) => c.name === 'Class 1')!;
  ids.sectionA = snap.sections.find(
    (s) => s.class_id === class1.id && s.name === 'A' && s.status === 'active',
  )!.id;
  const staff = await op.school<{ staff_id: string; name: string; staff_group_id: string }[]>(
    'list_staff',
    {},
  );
  const lata = staff.find((s) => s.name === 'Lata Iyer')!;
  ids.lata = lata.staff_id;
  ids.lataGroup = lata.staff_group_id;
  ids.ravi = staff.find((s) => s.name === 'Ravi Kumar')!.staff_id;
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
const asOwner = (b: Browser, v = DESKTOP) => as(b, 'demo.owner', pw.owner!, 'dashboard-owner', v);
const asPrincipal = (b: Browser, v = DESKTOP) =>
  as(b, 'demo.principal', pw.principal!, 'dashboard-principal', v);
const asAccountant = (b: Browser, v = DESKTOP) =>
  as(b, 'demo.accountant', pw.accountant!, 'dashboard-accountant', v);
const asTeacher = (b: Browser, v = DESKTOP) => as(b, 'demo.teacher', pw.teacher!, 'dashboard-teacher', v);
/** demo.teachparent (Meera Rao) in her Teacher role — not the class teacher of Class 1 A. */
async function asOtherTeacher(browser: Browser) {
  const s = await newPage(browser, seen, DESKTOP);
  await signIn(s.page, 'demo.teachparent', pw.teachparent!);
  await expect(s.page).toHaveURL(/\/choose$/, { timeout: 30_000 });
  await s.page.getByTestId('context-teacher').click();
  await expect(s.page.getByTestId('dashboard-teacher')).toBeVisible({ timeout: 30_000 });
  await expectDemoSchool(s.page);
  return s;
}

const num = (text: string | null) => Number((text ?? '').replace(/[^\d.-]/g, ''));

/** Lata Iyer's working days in the salary month (the staff register's own day type). */
async function lataWorkingDays(): Promise<string[]> {
  const days: string[] = [];
  const last = addDays(monthStart(addDays(SALARY_MONTH, 32)), -1);
  for (let d = SALARY_MONTH; d <= last; d = addDays(d, 1)) {
    const r = await op.school<{ staff: { staff_id: string; day: { weight: number | null } | null }[] }>(
      'get_staff_attendance',
      { p_date: d, p_staff_group_id: ids.lataGroup },
    );
    const row = r.staff.find((s) => s.staff_id === ids.lata);
    if ((row?.day?.weight ?? 0) > 0) days.push(d);
  }
  return days;
}

type Totals = {
  monthly_salary_paise: number | null;
  working_days: number;
  attended_days: number;
  paid_leave_days: number;
  payable_paise: number | null;
};
const sameTotals = (a: Totals, b: Totals) =>
  a.monthly_salary_paise === b.monthly_salary_paise &&
  a.working_days === b.working_days &&
  a.attended_days === b.attended_days &&
  a.paid_leave_days === b.paid_leave_days &&
  a.payable_paise === b.payable_paise;

/** Flip Lata Iyer's staff mark on `day` (Present ↔ Absent) through the staff register. */
async function flipLata(page: Page, day: string) {
  await page.goto(`/staff-attendance?date=${day}`);
  await expect(page.getByTestId('staff-roster')).toBeVisible({ timeout: 30_000 });
  const lata = page.getByTestId('staff-row').filter({ hasText: 'Lata Iyer' });
  const present =
    (await lata.getByRole('radio', { name: 'Present' }).getAttribute('aria-checked')) === 'true';
  await lata.getByRole('radio', { name: present ? 'Absent' : 'Present' }).click();
  await page.getByRole('button', { name: /Save staff attendance/ }).click();
  await expect(page.getByTestId('roster-save-bar').getByText('Saved.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

async function salaryRow() {
  const m = await op.school<{
    rows: {
      staff_id: string;
      status: string;
      saved: (Totals & { version_no: number; payable_paise: number }) | null;
      live: Totals | null;
    }[];
    totals: { saved: number; saved_payable_paise: number };
  }>('get_salary_month', { p_month: SALARY_MONTH });
  return { row: m.rows.find((r) => r.staff_id === ids.lata)!, totals: m.totals };
}

// ============================================================================ 1. salary
test('1. Salary: paid leave, preview, save, "Already saved", "Changed since saved"; Owner read-only; Teacher has no access', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const working = await lataWorkingDays();
  expect(working.length).toBeGreaterThan(5);
  const flipDay = working[0]!; // its mark alternates Present / Absent at the end of every run
  const leaves = await op.school<{ id: string; leave_date: string; status: string }[]>('list_paid_leave', {
    p_staff_id: ids.lata,
    p_from: SALARY_MONTH,
    p_to: working[working.length - 1]!,
  });
  const activeDays = leaves.filter((l) => l.status === 'active').map((l) => l.leave_date);
  const leaveDay = working.slice(1).find((d) => !activeDays.includes(d))!;

  const admin = await asAdmin(browser);
  const page = admin.page;
  await page.goto(`/salary?month=${SALARY_PARAM}`);
  const table = page.getByTestId('salary-table');
  const lataRow = table.getByTestId('salary-row').filter({ hasText: 'Lata Iyer' });
  await expect(lataRow).toBeVisible({ timeout: 60_000 });
  await lataRow.getByRole('link', { name: 'Lata Iyer' }).click();
  await expect(page.getByRole('heading', { name: 'Salary — Lata Iyer' })).toBeVisible();
  await expect(page.getByTestId('salary-formula')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('marked-days')).toContainText('Marked: present');

  // paid leave: an earlier run's leave is cancelled, a new one is added on another working day
  const paid = page.getByTestId('paid-leave').or(page.getByText('No paid leave recorded'));
  await expect(paid.first()).toBeVisible();
  if (activeDays.length > 0) {
    const row = page.getByTestId('paid-leave').locator('li').first();
    await row.getByRole('button', { name: 'Cancel' }).click();
    await modal(page).getByRole('button', { name: 'Cancel paid leave' }).click();
    await expect(page.getByText('Paid leave cancelled.')).toBeVisible();
  }
  await page.getByRole('button', { name: 'Add paid leave' }).click();
  const d = modal(page);
  await d.getByLabel('Date').fill(leaveDay);
  await d.getByLabel('Reason (optional)').fill(`M4 live ${Date.now().toString(36)}`);
  await d.getByRole('button', { name: 'Add paid leave' }).click();
  await expect(page.getByText(/^Paid leave recorded\./)).toBeVisible({ timeout: 30_000 });

  // Moving the leave between two unmarked days keeps the totals; if nothing differs from the saved
  // version, the mark of flipDay is flipped first so this run has a new version to save.
  const pre = (await salaryRow()).row;
  if (pre.saved && pre.live && sameTotals(pre.saved, pre.live)) {
    test.info().annotations.push({
      type: 'status-before-save',
      description: `${pre.status} with the same totals as v${pre.saved.version_no}`,
    });
    await flipLata(page, flipDay);
    await page.goto(`/salary/${ids.lata}?month=${SALARY_PARAM}`);
  }
  // preview (the calculator refreshes after the leave) and save
  await expect(page.getByTestId('salary-formula')).toContainText(' / ', { timeout: 60_000 });
  const before = (await salaryRow()).row.saved?.version_no ?? 0;
  const save = page.getByRole('button', { name: 'Save calculation' });
  // Save is enabled only once the refreshed calculation is on screen
  await expect(save).toBeEnabled({ timeout: 30_000 });
  const formula = (await page.getByTestId('salary-formula').textContent()) ?? '';
  await save.click();
  await expect(page.getByTestId('salary-save-result')).toHaveText(`Saved as version ${before + 1}.`, {
    timeout: 30_000,
  });
  const saved = (await salaryRow()).row;
  expect(saved.saved!.version_no).toBe(before + 1);
  expect(saved.status).toBe('saved'); // 2420: the server agrees right after the save
  expect(formula).toContain(inr(saved.saved!.payable_paise));
  // never the old "Changed since saved" after a save: on this page and in the month view
  await expect(page.getByTestId('salary-status')).toHaveText(`Saved v${before + 1}`);
  await page.goto(`/salary?month=${SALARY_PARAM}`);
  await expect(lataRow.getByTestId('salary-status')).toHaveText(`Saved v${before + 1}`, { timeout: 60_000 });
  await lataRow.getByRole('link', { name: 'Lata Iyer' }).click();
  await expect(page.getByTestId('salary-formula')).toBeVisible({ timeout: 60_000 });
  // the same again: nothing new
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await expect(page.getByTestId('salary-save-result')).toHaveText(
    `Already saved — no new version (version ${before + 1} is unchanged).`,
  );
  expect((await salaryRow()).row.saved!.version_no).toBe(before + 1);
  await expect(page.getByTestId('salary-status')).toHaveText(`Saved v${before + 1}`);
  await shot(page, `${SHOTS}/desktop-salary-calculator.png`);
  // after the replay the month view still says "Saved vN"
  await page.goto(`/salary?month=${SALARY_PARAM}`);
  await expect(lataRow.getByTestId('salary-status')).toHaveText(`Saved v${before + 1}`, { timeout: 60_000 });
  expect((await salaryRow()).row.status).toBe('saved');

  // an attendance change afterwards: flip Lata's mark on flipDay (Present ↔ Absent)
  await flipLata(page, flipDay);
  await page.goto(`/salary?month=${SALARY_PARAM}`);
  await expect(lataRow.getByTestId('salary-status')).toHaveText('Changed since saved', { timeout: 60_000 });
  await admin.context.close();

  // Owner: the saved result and the status, no buttons
  const owner = await asOwner(browser);
  await owner.page.goto(`/salary?month=${SALARY_PARAM}`);
  const oRow = owner.page
    .getByTestId('salary-table')
    .getByTestId('salary-row')
    .filter({ hasText: 'Lata Iyer' });
  await expect(oRow.getByTestId('salary-status')).toHaveText('Changed since saved', { timeout: 60_000 });
  await expect(oRow).toContainText(inr(saved.saved!.payable_paise));
  await expect(owner.page.getByRole('columnheader', { name: 'Payable now' })).toHaveCount(0);
  await oRow.getByRole('link', { name: 'Lata Iyer' }).click();
  await expect(owner.page.getByTestId('saved-result')).toContainText(inr(saved.saved!.payable_paise));
  await expect(owner.page.getByRole('button', { name: 'Save calculation' })).toHaveCount(0);
  await expect(owner.page.getByRole('button', { name: 'Add paid leave' })).toHaveCount(0);
  await owner.context.close();

  // Teacher: no Salary in the navigation, no access by URL; the server refuses too
  const teacher = await asTeacher(browser);
  await expect(
    teacher.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Salary' }),
  ).toHaveCount(0);
  await teacher.page.goto(`/salary/${ids.lata}?month=${SALARY_PARAM}`);
  await expect(teacher.page.getByText("You don't have access to this page")).toBeVisible();
  await teacher.context.close();
  const t = await ApiSession.signIn('demo.teacher', pw.teacher!);
  await t.enterDemo('teacher');
  await expect(t.school('get_salary_month', { p_month: SALARY_MONTH })).rejects.toThrow(/FORBIDDEN/);
  await t.signOut();
});

// ============================================================================ 2. register
test('2. Register Class 1 A, Oct 2026: period cells on 19 Oct, day cells on 20 Oct, unmarked blank; class teacher yes, other teacher no', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const reg = await op.school<{
    students: {
      name: string;
      cells: Record<string, { s?: string | null; held?: number; attended?: number }>;
    }[];
  }>('get_attendance_register', { p_section_id: ids.sectionA, p_month: `${REGISTER_MONTH}-01` });

  const principal = await asPrincipal(browser);
  const page = principal.page;
  await page.goto(`/attendance/register?section=${ids.sectionA}&month=${REGISTER_MONTH}`);
  const grid = page.getByTestId('register-grid');
  await expect(grid).toBeVisible({ timeout: 60_000 });
  const cells = (date: string) => grid.locator(`[data-testid="register-cell"][data-date="${date}"]`);
  // 19 Oct: period-wise "attended/held"
  await expect(cells(PERIOD_DAY).first()).toBeVisible();
  const periodStates = await cells(PERIOD_DAY).evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-state')),
  );
  expect(periodStates.filter((s) => s === 'period').length).toBeGreaterThan(0);
  const firstWithPeriod = reg.students.find((s) => s.cells[PERIOD_DAY]?.held !== undefined)!;
  const row = grid.getByTestId('register-row').filter({ hasText: firstWithPeriod.name }).first();
  const c19 = firstWithPeriod.cells[PERIOD_DAY]!;
  await expect(row.locator(`[data-date="${PERIOD_DAY}"]`)).toContainText(`${c19.attended}/${c19.held}`);
  // 20 Oct: day-wise letters
  const dailyStates = await cells(DAILY_DAY).evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-state')),
  );
  expect(dailyStates.every((s) => ['P', 'L', 'H', 'A', 'unmarked', 'not_enrolled'].includes(s ?? ''))).toBe(
    true,
  );
  // an unmarked day-wise cell is blank (not "A")
  const unmarked = grid.locator('[data-testid="register-cell"][data-state="unmarked"]').first();
  if ((await unmarked.count()) > 0) {
    await expect(unmarked.locator('[aria-hidden="true"]')).toHaveText('');
    await expect(unmarked).toContainText('Not marked');
  } else {
    test
      .info()
      .annotations.push({ type: 'note', description: 'no unmarked day-wise cell in Oct for Class 1 A' });
  }
  await expect(page.getByTestId('register-legend')).toContainText('blank = not marked');
  await principal.context.close();

  // phone layout (375px): one card per student, no sideways page scroll
  const phone = await asPrincipal(browser, PHONE);
  await phone.page.goto(`/attendance/register?section=${ids.sectionA}&month=${REGISTER_MONTH}`);
  const cards = phone.page.getByTestId('register-phone').getByTestId('register-student');
  await expect(cards.first()).toBeVisible({ timeout: 60_000 });
  await expect(phone.page.getByTestId('register-grid')).toBeHidden();
  await cards.first().locator('summary').click();
  await expect(cards.first()).toContainText('Show each day');
  await noHorizontalScroll(phone.page);
  // a viewport capture: Class 1 A has many (imported) students, a full-page image is unreadable
  await phone.page.evaluate(() => window.scrollTo(0, 0));
  await phone.page.screenshot({ path: `${SHOTS}/375-register.png` });
  await phone.context.close();

  // the class teacher (Ravi Kumar) can open it from Today; another teacher gets no access
  const teacher = await asTeacher(browser);
  await teacher.page.goto(`/attendance/register?section=${ids.sectionA}&month=${REGISTER_MONTH}`);
  await expect(teacher.page.getByTestId('register-grid')).toBeVisible({ timeout: 60_000 });
  await teacher.context.close();
  const other = await asOtherTeacher(browser);
  await other.page.goto(`/attendance/register?section=${ids.sectionA}&month=${REGISTER_MONTH}`);
  await expect(other.page.getByText("You don't have access to this")).toBeVisible({ timeout: 60_000 });
  await expect(
    other.page.getByText('Only the class teacher, Principal or Admin can see this register'),
  ).toBeVisible();
  await expect(other.page.getByTestId('register-grid')).toHaveCount(0);
  await other.context.close();
});

// ============================================================================ 3. attendance changes
test('3. A corrected mark appears in Attendance changes with old → new and the actor', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const admin = await asAdmin(browser);
  const page = admin.page;
  await page.goto(`/attendance/daily/${ids.sectionA}/${DAILY_DAY}`);
  const rows = page.getByTestId('roster-row');
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  // a row that already has a mark (a first mark is not a correction)
  let target: Locator | null = null;
  let oldWord = '';
  for (let i = 0; i < (await rows.count()); i++) {
    const r = rows.nth(i);
    if ((await r.getAttribute('data-state')) !== 'marked') continue;
    for (const w of ['Present', 'Late', 'Half day', 'Absent']) {
      if ((await r.getByRole('radio', { name: w }).getAttribute('aria-checked')) === 'true') oldWord = w;
    }
    if (oldWord) {
      target = r;
      break;
    }
  }
  expect(target, 'a marked student on 20 Oct').not.toBeNull();
  const newWord = oldWord === 'Absent' ? 'Late' : 'Absent';
  const name = (await target!.getAttribute('data-student')) ?? '';
  await target!.getByRole('radio', { name: newWord }).click();
  await page.getByRole('button', { name: /Save attendance/ }).click();
  await expect(page.getByTestId('roster-save-bar').getByText('Saved.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await page.goto(`/attendance/changes?from=${DAILY_DAY}&to=${DAILY_DAY}&section=${ids.sectionA}`);
  const first = page.getByTestId('attendance-change').first();
  await expect(first).toBeVisible({ timeout: 30_000 });
  await expect(first).toContainText(name);
  await expect(first.getByTestId('change-statuses')).toContainText(`${oldWord} → changed to ${newWord}`);
  await expect(first.getByTestId('change-actor')).toContainText('Changed by Demo Admin (Admin)');
  await admin.context.close();
});

// ============================================================================ 4. lessons on a date
test('4. Change a future lesson’s time (overlap refused first); extra lesson; its teacher marks its attendance', async ({
  browser,
}) => {
  test.setTimeout(360_000);
  type L = {
    lesson_session_id: number;
    slot_ordinal: number;
    slot_label: string;
    start_time: string;
    end_time: string;
    source: string;
    status: string;
    subject: string;
  };
  // a future school day with Class 1 A lessons, 10+ days ahead (clear of the M2 specs' days)
  let fut = addDays(TODAY, 10);
  let lessons: L[] = [];
  for (let i = 0; i < 14 && lessons.length === 0; i++, fut = addDays(fut, 1)) {
    lessons = (await op.school<L[]>('get_date_schedule', { p_date: fut, p_section_id: ids.sectionA })).filter(
      (l) => l.status === 'scheduled' && l.source !== 'extra',
    );
    if (lessons.length === 0) {
      await op
        .school('generate_lesson_sessions', { p_from: fut, p_to: fut, p_section_id: ids.sectionA })
        .catch(() => null);
      lessons = (
        await op.school<L[]>('get_date_schedule', { p_date: fut, p_section_id: ids.sectionA })
      ).filter((l) => l.status === 'scheduled' && l.source !== 'extra');
    }
    if (lessons.length > 0) break;
  }
  expect(lessons.length, 'a future day with lessons').toBeGreaterThan(1);
  lessons.sort((a, b) => a.start_time.localeCompare(b.start_time));
  const lesson = lessons[lessons.length - 1]!;
  const prev = lessons[lessons.length - 2]!;
  const hm = (t: string) => t.slice(0, 5);
  const shift = (t: string, mins: number) => {
    const [h, m] = hm(t).split(':').map(Number) as [number, number];
    const total = h * 60 + m + mins;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };
  // the end time toggles −5 / +5 minutes every run (always inside its own slot)
  const newEnd =
    Number(hm(lesson.end_time).slice(-1)) === 5 ? shift(lesson.end_time, 5) : shift(lesson.end_time, -5);

  const admin = await asAdmin(browser);
  const page = admin.page;
  await page.goto(`/schedule?date=${addDays(fut, -1)}&section=${ids.sectionA}`);
  await page.getByRole('button', { name: 'Next day' }).click();
  const card = page
    .getByTestId('lesson-card')
    .and(page.locator(`[data-lesson-id="${lesson.lesson_session_id}"]`));
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('menuitem', { name: 'Change time' }).click();
  let d = modal(page);
  // overlap first: the previous lesson's own time
  await d.getByLabel('Starts at').fill(hm(prev.start_time));
  await d.getByLabel('Ends at').fill(hm(prev.end_time));
  await d.getByRole('button', { name: 'Change time' }).click();
  await expect(d.getByRole('alert')).toContainText('That time overlaps');
  // then a time that fits
  await d.getByLabel('Starts at').fill(hm(lesson.start_time));
  await d.getByLabel('Ends at').fill(newEnd);
  await d.getByRole('button', { name: 'Change time' }).click();
  await expect(page.getByText(/^Time changed to /)).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('badge-changed')).toBeVisible();
  const after = (await op.school<L[]>('get_date_schedule', { p_date: fut, p_section_id: ids.sectionA })).find(
    (l) => l.lesson_session_id === lesson.lesson_session_id,
  )!;
  expect(hm(after.end_time)).toBe(newEnd);
  expect(after.source).toBe('override');

  // extra lesson on the period-wise day (19 Oct), after the last lesson, English with Ravi Kumar
  const day19 = await op.school<L[]>('get_date_schedule', { p_date: PERIOD_DAY, p_section_id: ids.sectionA });
  const lastEnd = day19
    .filter((l) => l.status === 'scheduled' && l.source !== 'extra')
    .map((l) => hm(l.end_time))
    .sort()
    .pop()!;
  const xStart = shift(lastEnd, 30);
  const xEnd = shift(lastEnd, 70);
  await page.goto(`/schedule?date=${PERIOD_DAY}&section=${ids.sectionA}`);
  await page.getByRole('button', { name: 'Add extra lesson' }).click();
  d = modal(page);
  await d.getByLabel('Starts at').fill(xStart);
  await d.getByLabel('Ends at').fill(xEnd);
  await choose(d, 'Subject', 'English');
  await choose(d, 'Teacher (optional)', 'Ravi Kumar');
  await d.getByLabel('Reason (optional)').fill('M4 live extra lesson');
  await d.getByRole('button', { name: 'Add extra lesson' }).click();
  // first run: added; later runs: the same extra lesson already exists → "Already added" + Open it
  const added = page.getByText('Extra lesson added.');
  const exists = d.getByTestId('extra-exists');
  await expect(added.or(exists)).toBeVisible({ timeout: 30_000 });
  const wasNew = await added.isVisible();
  if (!wasNew) await expect(exists).toContainText('Already added');
  test
    .info()
    .annotations.push({ type: 'extra-lesson', description: wasNew ? 'added' : 'already added (DUPLICATE)' });
  const extra = (
    await op.school<L[]>('get_date_schedule', { p_date: PERIOD_DAY, p_section_id: ids.sectionA })
  ).find(
    (l) =>
      l.source === 'extra' &&
      l.status === 'scheduled' &&
      hm(l.start_time) === xStart &&
      l.subject === 'English',
  )!;
  expect(extra).toBeTruthy();
  if (!wasNew) {
    await expect(exists.getByRole('link', { name: 'Open it' })).toHaveAttribute(
      'href',
      `/lessons/${extra.lesson_session_id}`,
    );
    await d.getByRole('button', { name: 'Cancel' }).click();
  }
  await page.goto(`/schedule?date=${PERIOD_DAY}&section=${ids.sectionA}`);
  const xCard = page.locator(`[data-testid="lesson-card"][data-lesson-id="${extra.lesson_session_id}"]`);
  await expect(xCard.getByTestId('badge-extra')).toBeVisible({ timeout: 30_000 });
  await admin.context.close();

  // its teacher marks its attendance (period-wise day)
  const teacher = await asTeacher(browser);
  await teacher.page.goto(`/today?date=${PERIOD_DAY}`);
  const todayCard = teacher.page.locator(
    `[data-testid="today-lesson"][data-lesson-id="${extra.lesson_session_id}"]`,
  );
  await expect(todayCard).toBeVisible({ timeout: 30_000 });
  await expect(todayCard.getByTestId('badge-extra')).toBeVisible();
  await teacher.page.goto(`/attendance/lesson/${extra.lesson_session_id}`);
  await expect(teacher.page.getByTestId('marking-roster')).toBeVisible({ timeout: 30_000 });
  const rows = teacher.page.getByTestId('roster-row');
  await expect(rows.first()).toBeVisible();
  const fill = teacher.page.getByRole('button', {
    name: /^(Mark (all|remaining \d+) present|Everyone is marked)$/,
  });
  if (await fill.isEnabled()) await fill.click();
  // one real change each run: the first student alternates Present / Late
  const late =
    (await rows.first().getByRole('radio', { name: 'Late' }).getAttribute('aria-checked')) === 'true';
  await rows
    .first()
    .getByRole('radio', { name: late ? 'Present' : 'Late' })
    .click();
  await teacher.page.getByRole('button', { name: /Save attendance/ }).click();
  await expect(teacher.page.getByTestId('roster-save-bar').getByText('Saved.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await teacher.context.close();
  const roster = await op.school<{ students: { status: string | null }[] }>('get_marking_roster', {
    p_kind: 'period',
    p_lesson_session_id: extra.lesson_session_id,
  });
  const marks = roster.students.filter((r) => r.status !== null);
  expect(marks.length).toBeGreaterThan(0);
});

// ============================================================================ 5. coverage + fee heads
test('5. Academic coverage and fee-head totals match their underlying pages', async ({ browser }) => {
  test.setTimeout(240_000);
  const principal = await asPrincipal(browser);
  let page = principal.page;
  await page.goto(`/reports/coverage?from=${PERIOD_DAY}&to=${DAILY_DAY}&section=${ids.sectionA}`);
  const covRow = page
    .getByTestId('coverage-table')
    .getByTestId('coverage-row')
    .filter({ hasText: 'English' })
    .filter({ hasText: 'Ravi Kumar' })
    .first();
  await expect(covRow).toBeVisible({ timeout: 60_000 });
  const diaryCell = (await covRow.locator('td').nth(4).textContent()) ?? '';
  // "2 / 3" (+ a screen-reader "(1 missing)")
  const m = /(\d+)\s*\/\s*(\d+)/.exec(diaryCell)!;
  const [written, lessons] = [Number(m[1]), Number(m[2])];

  // the diary page with the same range, section and teacher lists the same English lessons
  await page.goto(`/diary?from=${PERIOD_DAY}&to=${DAILY_DAY}`);
  await choose(page, 'Section', 'Class 1 A');
  await choose(page, 'Teacher', 'Ravi Kumar');
  const items = page
    .getByTestId('diary-item')
    .filter({ hasText: 'English' })
    .filter({ hasText: 'Ravi Kumar' });
  await expect(page.getByTestId('diary-item').first()).toBeVisible({ timeout: 30_000 });
  expect(await items.count()).toBe(lessons);
  expect(await items.filter({ has: page.getByText('Written', { exact: true }) }).count()).toBe(written);
  await principal.context.close();

  // fee-head totals: the balance equals the Dues page's total for the current year
  const acc = await asAccountant(browser);
  page = acc.page;
  await page.goto('/fees/reports/heads');
  const balance = page.getByTestId('heads-balance');
  await expect(balance).toBeVisible({ timeout: 60_000 });
  const headsBalance = (await balance.textContent())?.trim();
  await expect(page.getByText(/collections are shown in total only/)).toBeVisible();
  await page.goto('/fees/dues');
  const totals = page.getByTestId('dues-totals');
  await expect(totals).toBeVisible({ timeout: 60_000 });
  expect((await totals.locator('td').nth(4).textContent())?.trim()).toBe(headsBalance);
  await acc.context.close();
});

// ============================================================================ 6. dashboards
const BLOCK_IDS = ['attendance', 'staff', 'academic', 'admissions', 'fees', 'salary'];
async function shownBlocks(page: Page) {
  const out: string[] = [];
  for (const b of BLOCK_IDS) if (await page.getByTestId(`block-${b}`).isVisible()) out.push(b);
  return out;
}
async function loadAll(page: Page) {
  const more = page.getByRole('button', { name: 'Load more' });
  while (await more.isVisible()) {
    await more.click();
    await page.waitForTimeout(500);
  }
}

test('6. Dashboards: each role sees only its blocks; one number per block matches its page', async ({
  browser,
}) => {
  test.setTimeout(480_000);
  // Admin
  const admin = await asAdmin(browser);
  let page = admin.page;
  await expect(page.getByTestId('block-attendance')).toBeVisible({ timeout: 60_000 });
  expect(await shownBlocks(page)).toEqual([
    'attendance',
    'staff',
    'academic',
    'admissions',
    'fees',
    'salary',
  ]);
  const read = async (id: string) => num(await page.getByTestId(id).textContent());

  const complete = await read('num-sections-complete');
  await page.getByTestId('num-sections-complete').click();
  await expect(page.getByTestId('overview-row').first()).toBeVisible({ timeout: 30_000 });
  expect(await page.getByTestId('overview-row').filter({ hasText: '(complete)' }).count()).toBe(complete);

  await page.goto('/dashboard');
  const absent = await (async () => {
    await expect(page.getByTestId('num-staff-absent')).toBeVisible({ timeout: 60_000 });
    return read('num-staff-absent');
  })();
  await page.getByTestId('num-staff-absent').click();
  await expect(page.getByTestId('staff-roster')).toBeVisible({ timeout: 30_000 });
  expect(
    await page
      .locator('[data-testid="staff-row"] [role="radio"][aria-label="Absent"][aria-checked="true"]')
      .count(),
  ).toBe(absent);

  await page.goto('/dashboard');
  await expect(page.getByTestId('num-diary-missing')).toBeVisible({ timeout: 60_000 });
  const missing = await read('num-diary-missing');
  await page.getByTestId('num-diary-missing').click();
  await expect(
    page.getByTestId('diary-item').or(page.getByText('No lessons without a diary')).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await loadAll(page);
  expect(await page.getByTestId('diary-item').count()).toBe(missing);

  await page.goto('/dashboard');
  await expect(page.getByTestId('num-followups-overdue')).toBeVisible({ timeout: 60_000 });
  const overdue = await read('num-followups-overdue');
  await page.getByTestId('num-followups-overdue').click();
  await expect(page.getByTestId('followups-due').or(page.getByText('No follow-ups due')).first()).toBeVisible(
    {
      timeout: 30_000,
    },
  );
  expect(await page.getByTestId('followups-due').getByText('Overdue', { exact: true }).count()).toBe(overdue);

  await page.goto('/dashboard');
  await expect(page.getByTestId('num-dues')).toBeVisible({ timeout: 60_000 });
  const dues = (await page.getByTestId('num-dues').textContent())?.trim();
  await page.getByTestId('num-dues').click();
  await expect(page.getByTestId('dues-totals')).toBeVisible({ timeout: 60_000 });
  expect((await page.getByTestId('dues-totals').locator('td').nth(4).textContent())?.trim()).toBe(dues);

  await page.goto('/dashboard');
  await expect(page.getByTestId('num-salary-saved')).toBeVisible({ timeout: 60_000 });
  const savedCount = await read('num-salary-saved');
  await page.getByTestId('num-salary-saved').click();
  await expect(page.getByTestId('total-saved')).toBeVisible({ timeout: 60_000 });
  expect(num(await page.getByTestId('total-saved').textContent())).toBe(savedCount);
  await admin.context.close();

  // Admin dashboard at 375px
  const adminPhone = await asAdmin(browser, PHONE);
  await expect(adminPhone.page.getByTestId('block-attendance')).toBeVisible({ timeout: 60_000 });
  await noHorizontalScroll(adminPhone.page);
  await shot(adminPhone.page, `${SHOTS}/375-admin-dashboard.png`);
  await adminPhone.context.close();

  // Principal: attendance, staff, academic — lessons with an absent teacher = the "not covered" day view
  const principal = await asPrincipal(browser);
  page = principal.page;
  await expect(page.getByTestId('block-attendance')).toBeVisible({ timeout: 60_000 });
  expect(await shownBlocks(page)).toEqual(['attendance', 'staff', 'academic']);
  const uncovered = await read('num-uncovered');
  await page.getByTestId('num-uncovered').click();
  await expect(page.getByTestId('day-view')).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByTestId('lesson-card').or(page.getByText('No lessons with an absent teacher')).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  expect(await page.getByTestId('lesson-card').count()).toBe(uncovered);
  await principal.context.close();

  // Accountant: fees only — collected today = the day book's received total for today
  const acc = await asAccountant(browser);
  page = acc.page;
  await expect(page.getByTestId('block-fees')).toBeVisible({ timeout: 60_000 });
  expect(await shownBlocks(page)).toEqual(['fees']);
  const collected = (await page.getByTestId('num-collected').textContent())?.trim();
  await page.getByTestId('num-collected').click();
  const dbTotals = page.getByTestId('day-book-totals');
  await expect(dbTotals).toBeVisible({ timeout: 60_000 });
  await expect(dbTotals.locator('dd').nth(1)).toHaveText(collected!);
  await acc.context.close();

  // Owner: fees, salary, attendance — saved payable = the salary month total
  const owner = await asOwner(browser);
  page = owner.page;
  await expect(page.getByTestId('block-salary')).toBeVisible({ timeout: 60_000 });
  expect(await shownBlocks(page)).toEqual(['attendance', 'fees', 'salary']);
  const payable = (await page.getByTestId('num-salary-payable').textContent())?.trim();
  await page.getByTestId('num-salary-payable').click();
  await expect(page.getByTestId('total-saved-payable')).toHaveText(payable!, { timeout: 60_000 });
  await owner.context.close();
});

// ============================================================================ 7. operator
test('7. Operator: the activity log shows step 1’s salary save with its actor; usage and maintenance; Run now records a run', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const s = await newPage(browser, seen, DESKTOP);
  const page = s.page;
  await signIn(page, OPERATOR, OPERATOR_PASSWORD);
  await expect(page).toHaveURL(/\/choose$/, { timeout: 30_000 });
  await page.goto('/operator/activity');
  await expect(page.getByRole('heading', { name: 'Activity log' })).toBeVisible({ timeout: 30_000 });
  await choose(page, 'School', /^Demo School/);
  await page.getByLabel('Who (username)').fill('demo.admin');
  await page.getByLabel('Action starts with').fill('salary.calculation');
  await page.getByLabel('From', { exact: true }).fill(TODAY);
  await page.getByLabel('To', { exact: true }).fill(TODAY);
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  const ev = page.getByTestId('audit-event').first();
  await expect(ev).toBeVisible({ timeout: 30_000 });
  await expect(ev).toContainText('salary.calculation.saved');
  await expect(ev.getByTestId('audit-actor')).toContainText('(demo.admin)');
  await expect(ev.getByTestId('audit-actor')).toContainText('Admin · Demo School');
  await ev.getByRole('button', { name: 'Show details' }).click();
  await expect(ev.locator('pre')).toContainText(ids.lata!);
  await shot(page, `${SHOTS}/desktop-operator-log.png`);

  await page.getByRole('link', { name: 'Sign-ins & sessions' }).click();
  await expect(
    page.getByTestId('auth-events').or(page.getByText('No account events in this range')).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('link', { name: 'Usage' }).click();
  await expect(page.getByTestId('usage')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('usage-logins')).toBeVisible();

  await page.getByRole('link', { name: 'Maintenance' }).click();
  await expect(page.getByTestId('maintenance')).toBeVisible({ timeout: 30_000 });
  const runsBefore = await page
    .getByTestId('maintenance-runs')
    .locator('li')
    .count()
    .catch(() => 0);
  await page.getByRole('button', { name: 'Run now' }).click();
  await modal(page).getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByTestId('cleanup-result')).toContainText('Done:', { timeout: 30_000 });
  await expect(page.getByTestId('maintenance-runs').locator('li').first()).toContainText(
    'Run by an Operator',
  );
  expect(await page.getByTestId('maintenance-runs').locator('li').count()).toBeGreaterThanOrEqual(
    Math.min(runsBefore + 1, 30),
  );
  await s.context.close();

  // the operator log at 375px
  const p = await newPage(browser, seen, PHONE);
  await signIn(p.page, OPERATOR, OPERATOR_PASSWORD);
  await expect(p.page).toHaveURL(/\/choose$/, { timeout: 30_000 });
  await p.page.goto('/operator/activity');
  await expect(p.page.getByTestId('audit-event').first()).toBeVisible({ timeout: 30_000 });
  await noHorizontalScroll(p.page);
  await shot(p.page, `${SHOTS}/375-operator-log.png`);
  await p.context.close();
});

// ============================================================================ 8. phone screens + network
test('8. 375px salary screens; RPC-only network with p_ctx_rev on every school call', async ({ browser }) => {
  test.setTimeout(180_000);
  const admin = await asAdmin(browser, PHONE);
  const page = admin.page;
  await page.goto(`/salary?month=${SALARY_PARAM}`);
  await expect(page.getByTestId('salary-card').first()).toBeVisible({ timeout: 60_000 });
  await noHorizontalScroll(page);
  await shot(page, `${SHOTS}/375-salary-month.png`);
  await page.goto(`/salary/${ids.lata}?month=${SALARY_PARAM}`);
  await expect(page.getByTestId('salary-formula')).toBeVisible({ timeout: 60_000 });
  await noHorizontalScroll(page);
  await shot(page, `${SHOTS}/375-salary-calculator.png`);
  await admin.context.close();

  auditNetwork(seen);
  const rpcs = new Set(
    seen.map((s) => /\/rest\/v1\/rpc\/([a-z_0-9]+)$/.exec(new URL(s.url).pathname)?.[1]).filter(Boolean),
  );
  for (const fn of [
    'get_salary_month',
    'preview_salary',
    'save_salary_calculation',
    'get_salary_calculations',
    'list_paid_leave',
    'record_paid_leave',
    'get_attendance_register',
    'list_attendance_changes',
    'get_academic_coverage',
    'get_fee_head_report',
    'update_lesson_session',
    'add_extra_lesson',
    'get_dashboard',
    'op_get_audit_events',
    'op_get_auth_events',
    'op_get_usage',
    'op_get_maintenance',
    'op_run_retention_cleanup',
  ])
    expect(rpcs.has(fn), fn).toBe(true);
});
