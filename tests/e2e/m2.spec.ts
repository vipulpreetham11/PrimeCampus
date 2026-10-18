import { expect, test, type Browser, type Locator, type Page, type Request } from '@playwright/test';
import { ApiSession, operatorSession, setKnownPassword } from './helpers/api';

// M2 (timetable, lessons, attendance, diary, homework) against the LIVE backend, Demo School
// (code `demo`) only; every login is `demo.*`. Everything the brief asks for happens through the
// UI; the API helper only gives demo logins a known password for this run, looks up dates/ids,
// and makes the direct FORBIDDEN calls. Passwords exist only in memory and are never printed.
//
// Dates are computed from the school's "today" (Asia/Kolkata):
//   PAST  = the latest student working day on or before today (attendance can't be future-dated)
//   START = the Monday of PAST's week — the date each run's Class 1 A timetable starts
//   FUT   = the first working day after today (the timetable change of test 6 starts there)
// Class 1 A's plan is the same in every run: every weekday Period 1 Mathematics (Meera Rao) and
// Period 2 English (Ravi Kumar). Class 1 B's active timetable (created once) has Meera Rao in
// Monday Period 3 — the deliberate clash of test 1.
//
// Attendance mode: Demo School has no mode row, so every date is day-wise. Period marking (test 2,
// and "the substitute marks it" in test 4) needs a period-mode date on or before today; those
// steps are skipped with a reason when there is none (see the M2 report).

const OPERATOR = process.env.E2E_OPERATOR_USERNAME ?? '';
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? '';
const SCREENS = 'docs/reports/m2-screens';
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 900 };
const SECTION_A = 'Class 1 A';
const SECTION_B = 'Class 1 B';
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.skip(!OPERATOR || !OPERATOR_PASSWORD, 'E2E_OPERATOR_USERNAME / E2E_OPERATOR_PASSWORD not set');

// ------------------------------------------------------------------ dates (school-local strings)
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const TODAY = fmt.format(new Date());
function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10); // date-only UTC arithmetic on a date string (no zone involved)
}
function isoWeekday(iso: string) {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

// ------------------------------------------------------------------ shared state (memory only)
const pw: Record<string, string> = {};
let op: ApiSession;
const D = { past: '', start: '', fut: '', periodDate: null as string | null };
const ids: Record<string, string> = {};
const lessons: Record<string, number> = {};

interface Seen {
  url: string;
  body: string | null;
}
const seen: Seen[] = [];
function watch(page: Page) {
  page.on('request', (r: Request) => {
    if (r.url().includes('.supabase.co')) seen.push({ url: r.url(), body: r.postData() });
  });
}

test.beforeAll(async () => {
  op = await operatorSession();
  await op.enterDemo();
  pw.admin = await setKnownPassword(op, 'demo.admin');
  pw.teacher = await setKnownPassword(op, 'demo.teacher');
  pw.parent = await setKnownPassword(op, 'demo.parent');

  // working days from the student calendar of the current year
  const ctx = await op.rpc<{ current_year: { id: string } }>('get_context');
  const cal = await op.school<{ resolved: { date: string; weight: number }[] }>('get_calendar', {
    p_academic_year_id: ctx.current_year.id,
    p_audience: 'student',
    p_from: addDays(TODAY, -14),
    p_to: addDays(TODAY, 14),
  });
  const working = cal.resolved.filter((d) => d.weight > 0).map((d) => d.date);
  D.past = working.filter((d) => d <= TODAY).at(-1)!;
  D.fut = working.find((d) => d > TODAY)!;
  D.start = addDays(D.past, 1 - isoWeekday(D.past));
  // a period-mode working day on or before today, if the school has one
  const snap = await op.school<{ attendance_modes: { mode: string; effective_from: string }[] }>(
    'get_setup_snapshot',
  );
  const modeOn = (d: string) =>
    [...snap.attendance_modes]
      .filter((m) => m.effective_from <= d)
      .sort((a, b) => a.effective_from.localeCompare(b.effective_from))
      .at(-1)?.mode ?? 'daily';
  D.periodDate = working.filter((d) => d <= TODAY && modeOn(d) === 'period').at(-1) ?? null;
  if (modeOn(D.past) !== 'daily') throw new Error(`test 3 needs a day-wise date; ${D.past} is not`);

  const sections = await op.school<{
    sections: { id: string; class_id: string; name: string }[];
    classes: { id: string; name: string }[];
  }>('get_setup_snapshot');
  const cls = new Map(sections.classes.map((c) => [c.id, c.name]));
  for (const s of sections.sections) ids[`${cls.get(s.class_id)} ${s.name}`] = s.id;
  const students = await op.school<{ items: { student_id: string; name: string }[] }>('list_students', {
    p_search: 'Anaya Sharma',
  });
  ids.anaya = students.items.find((s) => s.name === 'Anaya Sharma')!.student_id;
});
test.afterAll(async () => {
  await op?.signOut();
});

// ------------------------------------------------------------------ UI helpers
async function asUser(browser: Browser, username: string, password: string, viewport = DESKTOP) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  watch(page);
  await page.goto('/sign-in');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  return { context, page };
}

/** Safety guard before acting: the header must show the Demo School. */
async function expectDemoSchool(page: Page) {
  await expect(page.getByTestId('context-summary').filter({ visible: true }).first()).toContainText(
    'Demo School',
    { timeout: 30_000 },
  );
}

async function asAdmin(browser: Browser, viewport = DESKTOP) {
  const s = await asUser(browser, 'demo.admin', pw.admin!, viewport);
  await expect(s.page.getByTestId('dashboard-admin')).toBeVisible({ timeout: 30_000 });
  await expectDemoSchool(s.page);
  return s;
}

async function asTeacher(browser: Browser, viewport = DESKTOP) {
  const s = await asUser(browser, 'demo.teacher', pw.teacher!, viewport);
  await expect(s.page.getByTestId('dashboard-teacher')).toBeVisible({ timeout: 30_000 });
  await expectDemoSchool(s.page);
  return s;
}

const modal = (page: Page) => page.locator('[role="dialog"], [role="alertdialog"]').last();

async function choose(scope: Page | Locator, label: string | RegExp, option: string) {
  const page = 'page' in scope ? scope.page() : scope;
  await scope.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** Open the timetable versions of a section and start a blank draft (start date, bell schedule). */
async function newBlankDraft(page: Page, section: string, start: string) {
  await page.goto('/timetable');
  await choose(page, 'Section', section);
  await page.getByRole('button', { name: 'New draft' }).click();
  const d = modal(page);
  await d.getByLabel('Starts on').fill(start);
  const blank = d.getByRole('radio', { name: 'A blank timetable' });
  if (await blank.isVisible()) await blank.check();
  await choose(d, 'Bell schedule', 'Regular day');
  await d.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/timetable\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('timetable-grid')).toBeVisible();
}

async function setCell(page: Page, weekday: string, period: string, subject: string, teacher: string | null) {
  await page
    .getByTestId('timetable-grid')
    .getByRole('button', { name: new RegExp(`^${weekday}, ${period}:`) })
    .click();
  const d = modal(page);
  await choose(d, 'Subject', subject);
  await choose(d, 'Teacher', teacher ?? 'Unassigned');
  await d.getByRole('button', { name: 'Apply' }).click();
  await expect(d).toBeHidden();
}

async function saveDraft(page: Page) {
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('All changes saved.')).toBeVisible({ timeout: 30_000 });
}

async function activateAndUpdateLessons(page: Page, from: string, to: string) {
  await page.getByRole('button', { name: 'Activate' }).click();
  const d = modal(page);
  await expect(d.getByText('Update lessons for the coming weeks')).toBeVisible({ timeout: 30_000 });
  await d.getByLabel('From').fill(from);
  await d.getByLabel('To').fill(to);
  await d.getByRole('button', { name: 'Update lessons' }).click();
  const result = d.getByTestId('lesson-refresh-result');
  await expect(result).toBeVisible({ timeout: 60_000 });
  return { dialog: d, result };
}

/** Lesson id of a section's lesson on a date at a period, via the schedule day view. */
async function lessonIdOn(page: Page, date: string, section: string, period: string): Promise<number> {
  await page.goto(`/schedule?date=${date}&section=${ids[section]}`);
  const card = page.getByTestId('lesson-card').filter({ hasText: period }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  return Number(await card.getAttribute('data-lesson-id'));
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page
    .locator('[data-sonner-toaster]')
    .evaluateAll((els) => els.forEach((e) => ((e as HTMLElement).style.display = 'none')));
  await page.screenshot({ path: `${SCREENS}/${name}.png`, fullPage: true });
}

// ------------------------------------------------------------------ 1. timetable
test('1. Admin builds a timetable with a teacher clash (shown, fixed), activates it and generates lessons', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const { context, page } = await asAdmin(browser);

  // Class 1 B: one active timetable with Meera Rao in Monday Period 3 (created once, reused)
  await page.goto(`/timetable?section=${ids[SECTION_B]}`);
  const versions = page.getByRole('list', { name: 'Timetable versions' });
  await expect(versions.or(page.getByText('No timetable yet'))).toBeVisible({ timeout: 30_000 });
  const hasActiveB = await versions
    .getByText('Active', { exact: true })
    .isVisible()
    .catch(() => false);
  if (!hasActiveB) {
    await newBlankDraft(page, SECTION_B, D.start);
    await setCell(page, 'Monday', 'Period 3', 'Science', 'Meera Rao');
    await saveDraft(page);
    await page.getByRole('button', { name: 'Activate' }).click();
    await expect(modal(page).getByText('Update lessons for the coming weeks')).toBeVisible({
      timeout: 30_000,
    });
    await modal(page).getByRole('button', { name: 'Close' }).last().click();
  }

  // Class 1 A: a blank draft from START with the run's plan
  await newBlankDraft(page, SECTION_A, D.start);
  for (const wd of WEEKDAYS.slice(0, 6)) {
    await setCell(page, wd, 'Period 1', 'Mathematics', 'Meera Rao');
    await setCell(page, wd, 'Period 2', 'English', 'Ravi Kumar');
  }
  // the deliberate clash: Meera Rao in Monday Period 3, where she teaches Class 1 B
  await setCell(page, 'Monday', 'Period 3', 'Science', 'Meera Rao');
  await saveDraft(page);
  const clashCell = page
    .getByTestId('timetable-grid')
    .getByRole('button', { name: /^Monday, Period 3:.*teacher clash/ });
  await expect(clashCell.getByTestId('cell-clash')).toContainText(
    `Clash: Meera Rao also teaches ${SECTION_B} then`,
  );
  await expect(page.getByTestId('conflict-count')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Activate' })).toBeDisabled();
  await expect(page.getByText(/Activation is blocked: 1 teacher clash/)).toBeVisible();

  // fix it: Ravi Kumar takes Monday Period 3
  await setCell(page, 'Monday', 'Period 3', 'Science', 'Ravi Kumar');
  await saveDraft(page);
  await expect(page.getByTestId('cell-clash')).toHaveCount(0);
  await expect(page.getByTestId('conflict-count')).toHaveText('0');

  // activate, then lessons from START (past days for marking) to two weeks ahead
  const { dialog, result } = await activateAndUpdateLessons(page, D.start, addDays(TODAY, 13));
  await expect(result.getByTestId('result-created')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();

  // the 375px grid scrolls horizontally inside its frame, the page does not
  await page.setViewportSize(PHONE);
  await page.reload();
  await expect(page.getByTestId('timetable-grid')).toBeVisible();
  await noHorizontalScroll(page);
  const gridScrolls = await page
    .getByTestId('timetable-grid')
    .evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(gridScrolls).toBe(true);
  await shot(page, '375-timetable-grid');

  // the lessons exist: PAST has Period 1 and Period 2 for Class 1 A
  await page.setViewportSize(DESKTOP);
  lessons.pastP1 = await lessonIdOn(page, D.past, SECTION_A, 'Period 1');
  lessons.pastP2 = await lessonIdOn(page, D.past, SECTION_A, 'Period 2');
  expect(lessons.pastP1).toBeGreaterThan(0);
  await context.close();
});

// ------------------------------------------------------------------ 2. period attendance
test('2. Teacher "Today": period attendance (mark all present + 2 exceptions); a second tab gets a conflict', async ({
  browser,
}) => {
  test.skip(
    D.periodDate === null,
    'No period-mode working day on or before today in Demo School (it is day-wise on every date).',
  );
  test.setTimeout(240_000);
  const date = D.periodDate!;
  const { context, page } = await asTeacher(browser);
  await page.goto(`/dashboard?date=${date}`);
  const lesson = page.getByTestId('today-lesson').filter({ hasText: 'English' }).first();
  await lesson.getByRole('link', { name: 'Attendance' }).click();
  await expect(page.getByTestId('marking-roster')).toBeVisible();
  const tabB = await context.newPage();
  watch(tabB);
  await tabB.goto(page.url());
  await expect(tabB.getByTestId('marking-roster')).toBeVisible();

  const fill = page.getByRole('button', { name: /^Mark (all|remaining \d+) present$/ });
  if (await fill.isEnabled()) await fill.click();
  const rows = page.getByTestId('roster-row');
  await rows.nth(0).getByRole('radio', { name: 'Absent' }).click();
  await rows.nth(1).getByRole('radio', { name: 'Late' }).click();
  await page.getByRole('button', { name: /Save attendance/ }).click();
  await expect(page.getByText(/^Saved/)).toBeVisible({ timeout: 30_000 });

  // tab B still shows the old roster: changing the first student conflicts
  const firstB = tabB.getByTestId('roster-row').nth(0);
  await firstB.getByRole('radio', { name: 'Present' }).click();
  await tabB.getByRole('button', { name: /Save attendance/ }).click();
  await expect(firstB.getByTestId('row-conflict')).toContainText('Someone else saved Absent');
  await firstB.getByRole('button', { name: /Keep theirs/ }).click();
  await expect(firstB).toHaveAttribute('data-state', 'marked');
  await context.close();
});

// ------------------------------------------------------------------ 3. daily attendance
test('3. Day-wise date: the class teacher marks the day register, including a half day', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await asTeacher(browser, PHONE);
  await page.goto(`/dashboard?date=${D.past}`);
  await expect(page.getByTestId('teacher-today')).toBeVisible();
  await expect(
    page.getByText('Day-wise attendance: class teachers mark one register for the day.'),
  ).toBeVisible();
  // the teacher's lessons of the day are listed (Period 2 English is Ravi Kumar's)
  await expect(page.getByTestId('today-lesson').filter({ hasText: 'English' }).first()).toBeVisible();
  await noHorizontalScroll(page);
  await shot(page, '375-teacher-today');

  const ct = page.getByTestId('ct-section').filter({ hasText: SECTION_A });
  await ct.getByRole('link', { name: 'Day attendance' }).click();
  await expect(page.getByTestId('marking-roster')).toBeVisible();
  const fill = page.getByRole('button', { name: /^Mark (all|remaining \d+) present$/ });
  if (await fill.isEnabled()) await fill.click();
  // two students get a half day and an absence every run (alternating, so each run really saves)
  const first = page.getByTestId('roster-row').nth(0);
  const second = page.getByTestId('roster-row').nth(1);
  const firstHalf =
    (await first.getByRole('radio', { name: 'Half day' }).getAttribute('aria-checked')) === 'true';
  await first.getByRole('radio', { name: firstHalf ? 'Absent' : 'Half day' }).click();
  await second.getByRole('radio', { name: firstHalf ? 'Half day' : 'Absent' }).click();
  await noHorizontalScroll(page);
  await shot(page, '375-marking-roster');
  await page.getByRole('button', { name: /Save attendance/ }).click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByTestId('roster-row').filter({ has: page.locator('[data-state="changed"]') }),
  ).toHaveCount(0);
  const summary = await page.getByTestId('roster-summary').textContent();
  expect(summary).toMatch(/^(\d+) of \1 marked$/);
  await context.close();
});

// ------------------------------------------------------------------ 4 + 8. staff attendance, substitute
test('4. Admin marks a teacher absent → the day view flags it → substitute assigned → the substitute sees it in Today', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const admin = await asAdmin(browser);
  const page = admin.page;
  // 8 (admin part): staff attendance for PAST — Meera Rao absent, everyone else present
  await page.goto(`/staff-attendance?date=${D.past}`);
  await expect(page.getByTestId('staff-roster')).toBeVisible({ timeout: 30_000 });
  const fill = page.getByRole('button', { name: /^Mark (all|remaining \d+) present$/ });
  if (await fill.isEnabled()) await fill.click();
  const meera = page.getByTestId('staff-row').filter({ hasText: 'Meera Rao' });
  await meera.getByRole('radio', { name: 'Absent' }).click();
  const save = page.getByRole('button', { name: /Save staff attendance/ });
  if (await save.isEnabled()) {
    await save.click();
    await expect(page.getByText('Saved.')).toBeVisible({ timeout: 30_000 });
  }
  await expect(meera).toHaveAttribute('data-state', 'marked');
  await expect(meera.getByRole('radio', { name: 'Absent' })).toHaveAttribute('aria-checked', 'true');

  // the day view flags Meera's Period 1 lesson
  await page.goto(`/schedule?date=${D.past}&section=${ids[SECTION_A]}`);
  const p1 = page.getByTestId('lesson-card').filter({ hasText: 'Period 1' }).first();
  await expect(p1.getByTestId('badge-planned-absent')).toBeVisible({ timeout: 30_000 });

  // assign Ravi Kumar (free in Period 1)
  await p1.getByRole('button', { name: /^Actions for Period 1/ }).click();
  await page.getByRole('menuitem', { name: 'Find a substitute' }).click();
  const d = modal(page);
  const ravi = d.getByRole('listitem').filter({ hasText: 'Ravi Kumar' });
  await expect(ravi).toContainText('Free then');
  await ravi.getByRole('radio').check();
  await d.getByLabel('Note (optional)').fill(`E2E ${RUN}: Meera absent`);
  await d.getByRole('button', { name: 'Assign substitute' }).click();
  await expect(d).toBeHidden({ timeout: 30_000 });
  await expect(p1.getByTestId('badge-substitute')).toBeVisible({ timeout: 30_000 });
  await expect(p1).toContainText('Ravi Kumar');
  await expect(p1).toContainText('planned: Meera Rao');
  await page.goto('/schedule/substitutions');
  await expect(page.getByRole('list', { name: 'Substitutions' })).toContainText(`E2E ${RUN}: Meera absent`);
  await admin.context.close();

  // the substitute (demo.teacher = Ravi Kumar) sees the lesson in Today
  const t = await asTeacher(browser);
  await t.page.goto(`/dashboard?date=${D.past}`);
  const sub = t.page
    .getByTestId('today-lesson')
    .filter({ hasText: 'Mathematics' })
    .filter({ hasText: 'Substitution' });
  await expect(sub).toBeVisible({ timeout: 30_000 });
  await sub.getByRole('link', { name: 'Diary & homework' }).click();
  await t.page.getByRole('link', { name: 'Attendance register' }).click();
  await expect(t.page.getByTestId('marking-roster')).toBeVisible();
  // day-wise date: the period register explains that the class teacher marks the day instead
  await expect(t.page.getByTestId('roster-blocked')).toContainText('day-wise attendance');
  await t.context.close();
});

test('8. Staff attendance: Teacher has no access (UI) and gets FORBIDDEN from the server', async ({
  browser,
}) => {
  const t = await asTeacher(browser);
  await expect(t.page.getByRole('link', { name: 'Staff attendance' })).toHaveCount(0);
  await t.page.goto(`/staff-attendance?date=${D.past}`);
  await expect(t.page.getByText("You don't have access to this page")).toBeVisible();
  await t.context.close();
  const api = await ApiSession.signIn('demo.teacher', pw.teacher!);
  await api.enterDemo('teacher');
  await expect(api.school('get_staff_attendance', { p_date: D.past })).rejects.toThrow(/FORBIDDEN/);
  await expect(
    api.school('mark_staff_attendance', {
      p_operation_id: crypto.randomUUID(),
      p_date: D.past,
      p_marks: [],
    }),
  ).rejects.toThrow(/FORBIDDEN/);
  await api.signOut();
});

// ------------------------------------------------------------------ 5. diary + homework
test('5. Teacher writes the diary and sets homework from the lesson; checks homework for 3 students', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asTeacher(browser, PHONE);
  await page.goto(`/dashboard?date=${D.past}`);
  const lesson = page
    .getByTestId('today-lesson')
    .filter({ hasText: 'English' })
    .filter({ hasNotText: 'Substitution' })
    .first();
  await lesson.getByRole('link', { name: 'Diary & homework' }).click();
  await expect(page.getByTestId('lesson-page')).toBeVisible();

  const body = page.getByLabel('What was covered');
  await body.fill(`Chapter 4 reading and new words (E2E ${RUN})`);
  await page.getByRole('button', { name: /^(Save diary|Save changes)$/ }).click();
  await expect(page.getByTestId('diary-meta')).toContainText('Lesson on', { timeout: 30_000 });
  await expect(body).toHaveValue(`Chapter 4 reading and new words (E2E ${RUN})`);

  await page.getByRole('button', { name: 'Set homework' }).click();
  const d = modal(page);
  await d.getByLabel('Homework').fill(`Write 5 sentences with the new words — ${RUN}`);
  await d.getByLabel('Due on').fill(addDays(D.past, 2));
  await d.getByRole('button', { name: 'Set homework' }).click();
  await expect(d).toBeHidden({ timeout: 30_000 });
  const hw = page.getByTestId('lesson-homework').filter({ hasText: RUN });
  await expect(hw).toBeVisible({ timeout: 30_000 });
  await hw.getByRole('link', { name: 'Check homework' }).click();
  await expect(page.getByTestId('homework-roster')).toBeVisible();

  const rows = page.getByTestId('check-row');
  const first = rows.nth(0);
  await expect(first).toHaveAttribute('data-state', 'unmarked');
  await expect(first.getByText('Unchecked').first()).toBeVisible();
  await first.getByRole('radio', { name: 'Completed', exact: true }).click();
  await first.getByRole('radio', { name: 'Correction required' }).click();
  await rows.nth(1).getByRole('radio', { name: 'Completed', exact: true }).click();
  await rows.nth(2).getByRole('radio', { name: 'Not completed' }).click();
  await noHorizontalScroll(page);
  await shot(page, '375-homework-roster');
  await page.getByRole('button', { name: /Save checks/ }).click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 30_000 });
  await expect(first).toHaveAttribute('data-state', 'marked');
  await expect(first).toContainText('Completed, correction required');
  // everyone else stays Unchecked — never "not completed"
  const unchecked = await rows.evaluateAll(
    (els) => els.filter((e) => e.getAttribute('data-state') === 'unmarked').length,
  );
  const total = await rows.count();
  expect(unchecked).toBe(total - 3);
  await expect(page.getByTestId('check-summary')).toContainText(`3 of ${total} checked`);
  await context.close();
});

// ------------------------------------------------------------------ 6. timetable change for future dates
test('6. Changing the timetable for future dates: unused lessons follow it, the lesson with homework is kept', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const { context, page } = await asAdmin(browser);
  const futWeekday = WEEKDAYS[isoWeekday(D.fut) - 1]!;
  // homework on FUT's Period 2 lesson (set by Admin on the teacher's lesson)
  lessons.futP2 = await lessonIdOn(page, D.fut, SECTION_A, 'Period 2');
  await page.goto(`/lessons/${lessons.futP2}`);
  await page.getByRole('button', { name: 'Set homework' }).click();
  const d = modal(page);
  await d.getByLabel('Homework').fill(`Bring the reading log — ${RUN}`);
  await d.getByRole('button', { name: 'Set homework' }).click();
  await expect(d).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('lesson-homework').filter({ hasText: RUN })).toBeVisible({ timeout: 30_000 });

  // a new version from FUT: Period 2 on FUT's weekday becomes Science (same teacher)
  await page.goto(`/timetable?section=${ids[SECTION_A]}`);
  await page.getByRole('button', { name: 'New draft' }).click();
  const nd = modal(page);
  await nd.getByLabel('Starts on').fill(D.fut);
  await nd.getByRole('radio', { name: /A copy of the active timetable/ }).check();
  await nd.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByTestId('timetable-grid')).toBeVisible({ timeout: 30_000 });
  await setCell(page, futWeekday, 'Period 2', 'Science', 'Ravi Kumar');
  await saveDraft(page);
  const { result } = await activateAndUpdateLessons(page, D.fut, addDays(D.fut, 13));
  // the next week's same lesson had nothing recorded: it follows the new plan
  await expect(result.getByTestId('result-updated')).not.toHaveText('0');
  // the lesson with homework is listed as kept
  const kept = result.getByTestId('kept-lessons');
  await expect(kept).toBeVisible();
  const href = `/schedule?date=${D.fut}&section=${ids[SECTION_A]}`;
  await expect(kept.locator(`a[href="${href}"]`).first()).toBeVisible();
  await modal(page).getByRole('button', { name: 'Close' }).last().click();

  // check on the day views: FUT keeps English (homework); a week later it is Science
  await page.goto(`/schedule?date=${D.fut}&section=${ids[SECTION_A]}`);
  await expect(page.locator(`[data-lesson-id="${lessons.futP2}"]`)).toContainText('English');
  await page.goto(`/schedule?date=${addDays(D.fut, 7)}&section=${ids[SECTION_A]}`);
  const later = page.getByTestId('lesson-card').filter({ hasText: 'Period 2' }).first();
  await expect(later).toContainText('Science', { timeout: 30_000 });
  await context.close();
});

// ------------------------------------------------------------------ 7. parent
test("7. Parent sees the child's week timetable, attendance, diary note and homework state; not the other child", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await asUser(browser, 'demo.parent', pw.parent!, PHONE);
  await expect(page).toHaveURL(/\/choose$/, { timeout: 30_000 });
  await page.getByRole('button', { name: /Aarav Sharma/ }).click();
  await expect(page.getByTestId('dashboard-parent')).toBeVisible({ timeout: 30_000 });
  await expectDemoSchool(page);
  await expect(page.getByTestId('context-summary').filter({ visible: true }).first()).toContainText(
    'Aarav Sharma',
  );
  const home = page.getByTestId('child-home');
  // Aarav (like every demo student admitted in M1) joined on 18 Oct 2026, a Sunday: no school day
  // with him enrolled has happened yet, so attendance and diary are correctly empty (not "0%").
  await expect(home.getByText('No attendance was expected yet this year.')).toBeVisible({ timeout: 30_000 });
  await expect(home.getByText('No diary notes in this period')).toBeVisible();
  // homework set in test 6 on FUT's lesson: shown as "Not checked yet" (never "not completed")
  const hw = home.getByTestId('child-homework').filter({ hasText: `Bring the reading log — ${RUN}` });
  await expect(hw).toBeVisible();
  await expect(hw).toContainText('Not checked yet');
  await expect(hw).toContainText('Ravi Kumar');
  await noHorizontalScroll(page);
  await shot(page, '375-parent-child-home');

  // the week timetable of the week FUT is in (server-scoped to the child's section)
  await page.goto('/child/timetable');
  await page.getByRole('button', { name: 'Next week' }).click();
  const week = page.getByTestId('week-view');
  await expect(week.getByTestId('lesson-card').first()).toBeVisible({ timeout: 30_000 });
  await expect(week).toContainText('Mathematics');
  await expect(week).toContainText('English');
  await page.goto('/child/attendance');
  await expect(page.getByText('No attendance was expected yet this year.')).toBeVisible({ timeout: 30_000 });

  // the other child's data: no route takes a child id, staff routes are closed, the server refuses
  await page.goto(`/students/${ids.anaya}`);
  await expect(page.getByText("You don't have access to this page")).toBeVisible();
  await context.close();
  const api = await ApiSession.signIn('demo.parent', pw.parent!);
  const b = await api.rpc<{
    contexts: { membership_id: string; children?: { student_id: string; name: string }[] }[];
  }>('bootstrap_account', { p_device_class: 'desktop', p_user_agent: 'playwright-helper' });
  const c = b.contexts.find((x) => x.children?.some((ch) => ch.name === 'Aarav Sharma'))!;
  const aaravId = c.children!.find((ch) => ch.name === 'Aarav Sharma')!.student_id;
  const sel = await api.rpc<{ context_revision: number }>('select_context', {
    p_membership_id: c.membership_id,
    p_student_id: aaravId,
  });
  api.rev = sel.context_revision;
  expect((await api.rpc<{ school_name: string }>('get_context')).school_name).toBe('Demo School');
  for (const fn of ['get_student_homework', 'get_student_diary', 'get_student_attendance_records']) {
    await expect(
      api.school(fn, { p_student_id: ids.anaya, p_from: addDays(TODAY, -30), p_to: TODAY }),
    ).rejects.toThrow(/FORBIDDEN/);
  }
  await api.signOut();
});

// ------------------------------------------------------------------ 9. network audit
test('9. Network audit: RPC only, p_ctx_rev on every school RPC, nothing else contacted', async () => {
  const CONTEXT_FREE = new Set([
    'bootstrap_account',
    'select_context',
    'end_app_session',
    'get_context',
    'record_telemetry',
  ]);
  expect(seen.length).toBeGreaterThan(50);
  for (const s of seen) {
    const u = new URL(s.url);
    expect(u.pathname).toMatch(/^\/(rest\/v1\/rpc\/[a-z_0-9]+|auth\/v1\/.+|functions\/v1\/accounts)$/);
    const rpc = /^\/rest\/v1\/rpc\/([a-z_0-9]+)$/.exec(u.pathname)?.[1];
    if (rpc && !CONTEXT_FREE.has(rpc) && !rpc.startsWith('op_')) {
      expect(JSON.parse(s.body ?? '{}'), `${rpc} carries p_ctx_rev`).toHaveProperty('p_ctx_rev');
    }
  }
  const fns = new Set(seen.map((s) => /\/rpc\/([a-z_0-9]+)$/.exec(s.url)?.[1]).filter(Boolean));
  for (const fn of [
    'list_timetable_versions',
    'get_timetable_version',
    'save_timetable_draft',
    'activate_timetable',
    'generate_lesson_sessions',
    'get_date_schedule',
    'get_teacher_today',
    'get_marking_roster',
    'mark_student_attendance',
    'get_staff_attendance',
    'mark_staff_attendance',
    'suggest_substitutes',
    'assign_substitute',
    'list_substitutions',
    'get_diary_entry',
    'save_diary_entry',
    'save_homework',
    'list_homework',
    'get_homework_roster',
    'mark_homework_checks',
    'get_schedule_range',
    'get_student_attendance_summary',
    'get_student_attendance_records',
    'get_student_diary',
    'get_student_homework',
  ]) {
    expect(fns.has(fn), `${fn} was exercised`).toBe(true);
  }
});
