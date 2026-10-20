import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { ApiSession, endAppSessionWithToken, operatorSession, setKnownPassword } from './helpers/api';
import { choose, DESKTOP, expectDemoSchool, modal, newPage, signIn, TODAY, type Seen } from './helpers/ui';

// M4 review (live, Demo School only): salary month timing, overrides + reason, a "needs manual
// resolution" staff member, the staff tab of Attendance changes, every M4 CSV (contents checked against
// the RPCs), and pages left open after the server ended the session. Actions through the UI; the API
// helper only resets demo passwords, looks up ids and reads the numbers to compare with.

const OPERATOR = process.env.E2E_OPERATOR_USERNAME ?? '';
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? '';
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const MONTH = '2026-10-01';
const MONTH_PARAM = '2026-10';
const NO_RATE_GROUP = 'M4 review — no default salary';
const NO_RATE_STAFF = 'M4 Review No Rate';
const NO_RATE_EMP = 'M4R-NORATE';
/** Paise → CSV rupees with 2 decimals, by string math (as the app writes them). */
const rupees = (p: number) => `${Math.trunc(p / 100)}.${String(Math.abs(p % 100)).padStart(2, '0')}`;

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.skip(!OPERATOR || !OPERATOR_PASSWORD, 'E2E_OPERATOR_USERNAME / E2E_OPERATOR_PASSWORD not set');

const seen: Seen[] = [];
const pw: Record<string, string> = {};
const ids: Record<string, string> = {};
let op: ApiSession;

test.beforeAll(async () => {
  op = await operatorSession();
  await op.enterDemo();
  for (const u of ['admin', 'principal', 'accountant', 'teacher'])
    pw[u] = await setKnownPassword(op, `demo.${u}`);
  const staff = await op.school<{ staff_id: string; name: string; staff_group_id: string }[]>(
    'list_staff',
    {},
  );
  const lata = staff.find((s) => s.name === 'Lata Iyer')!;
  ids.lata = lata.staff_id;
  ids.lataGroup = lata.staff_group_id;
  const snap = await op.school<{
    classes: { id: string; name: string }[];
    sections: { id: string; name: string; class_id: string; status: string }[];
  }>('get_setup_snapshot');
  const class1 = snap.classes.find((c) => c.name === 'Class 1')!;
  ids.sectionA = snap.sections.find(
    (s) => s.class_id === class1.id && s.name === 'A' && s.status === 'active',
  )!.id;
});
test.afterAll(async () => {
  await op?.signOut();
});

async function as(browser: Browser, username: string, password: string, dashboard: string) {
  const s = await newPage(browser, seen, DESKTOP);
  await signIn(s.page, username, password);
  await expect(s.page.getByTestId(dashboard)).toBeVisible({ timeout: 30_000 });
  await expectDemoSchool(s.page);
  return s;
}
const asAdmin = (b: Browser) => as(b, 'demo.admin', pw.admin!, 'dashboard-admin');
const asPrincipal = (b: Browser) => as(b, 'demo.principal', pw.principal!, 'dashboard-principal');
const asAccountant = (b: Browser) => as(b, 'demo.accountant', pw.accountant!, 'dashboard-accountant');

/** One CSV line → cells (quoted cells may hold commas and doubled quotes). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function download(page: Page, button: Locator): Promise<{ name: string; lines: string[] }> {
  const [dl] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const text = await readFile((await dl.path())!, 'utf8');
  return { name: dl.suggestedFilename(), lines: text.split('\r\n').filter((l) => l !== '') };
}

type MonthRow = {
  staff_id: string;
  name: string;
  status: string;
  saved: { version_no: number; payable_paise: number } | null;
  live: { needs_manual_resolution: boolean; resolution_reason: string | null } | null;
};
async function salaryMonth(month = MONTH) {
  return op.school<{
    rows: MonthRow[];
    totals: { saved: number; staff: number; saved_payable_paise: number };
  }>('get_salary_month', { p_month: month });
}

// ============================================================================ R1. timing (2420)
test('R1. get_salary_month timing for Demo School, Oct 2026 (one set-based pass since 2420)', async () => {
  const ms: number[] = [];
  let staff = 0;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const m = await salaryMonth();
    ms.push(Math.round(performance.now() - t0));
    staff = m.rows.length;
  }
  ms.sort((a, b) => a - b);
  const line = `get_salary_month Oct 2026: ${staff} staff · round trip min ${ms[0]} ms, median ${ms[2]} ms, max ${ms[4]} ms (5 calls)`;
  console.log(line);
  test.info().annotations.push({ type: 'timing', description: line });
  expect(ms[4]).toBeLessThan(8_000);
});

// ============================================================================ R2. overrides + reason
test('R2. Salary overrides with a reason (preview → save); a missing reason is refused under the field (client and server)', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const admin = await asAdmin(browser);
  const page = admin.page;
  await page.goto(`/salary/${ids.lata}?month=${MONTH_PARAM}`);
  await expect(page.getByTestId('salary-formula')).toBeVisible({ timeout: 60_000 });
  const overrideBtn = page.getByRole('button', { name: 'Override values' });
  if (await overrideBtn.isVisible()) await overrideBtn.click();
  const attended = page.getByLabel('Attended days (0–31, steps of 0.5)');
  const reason = page.getByLabel('Reason for the overrides');
  await attended.fill('5.5');
  await reason.fill('');
  await page.getByRole('button', { name: 'Preview with these values' }).click();
  await expect(page.getByText('Overrides need a reason')).toBeVisible();
  await expect(reason).toHaveAttribute('aria-invalid', 'true');
  // the server refuses the same with the field named (what the form shows under "Reason")
  await expect(
    op.school('save_salary_calculation', {
      p_staff_id: ids.lata,
      p_month: MONTH,
      p_overrides: { attended_days: 5.5 },
    }),
  ).rejects.toThrow(/VALIDATION_ERROR Overrides need a reason/);

  const before = (await salaryMonth()).rows.find((r) => r.staff_id === ids.lata)!.saved?.version_no ?? 0;
  await reason.fill(`Late register, approved by the Principal (${RUN})`);
  await page.getByRole('button', { name: 'Preview with these values' }).click();
  await expect(page.getByTestId('salary-formula')).toContainText('(5.5 + ');
  await expect(page.getByText('(override)')).toBeVisible();
  const save = page.getByRole('button', { name: 'Save calculation' });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await expect(page.getByTestId('salary-save-result')).toHaveText(`Saved as version ${before + 1}.`, {
    timeout: 30_000,
  });
  const hist = await op.school<
    { version_no: number; overrides: Record<string, number>; override_reason: string | null }[]
  >('get_salary_calculations', { p_staff_id: ids.lata, p_month: MONTH });
  const v = hist.find((h) => h.version_no === before + 1)!;
  expect(v.overrides).toEqual({ attended_days: 5.5 });
  expect(v.override_reason).toContain(RUN);
  await expect(page.getByTestId('salary-version').first()).toContainText(RUN);
  await admin.context.close();
});

// ============================================================================ R3. needs manual resolution
test('R3. A staff member with no salary rate in a group with no default: "needs manual resolution" → salary override → saved', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const admin = await asAdmin(browser);
  const page = admin.page;
  // once: a group with no default salary and a staff member in it (no rate), made in the UI
  const groups = await op.school<{ id: string; name: string }[]>('list_staff_groups', {});
  if (!groups.some((g) => g.name === NO_RATE_GROUP)) {
    await page.goto('/staff/groups');
    await page.getByRole('button', { name: 'New staff group' }).click();
    const d = modal(page);
    await d.getByLabel('Name').fill(NO_RATE_GROUP);
    await d.getByRole('button', { name: /^Save/ }).click();
    await expect(d).toBeHidden({ timeout: 30_000 });
  }
  let staff = (await op.school<{ staff_id: string; name: string }[]>('list_staff', {})).find(
    (s) => s.name === NO_RATE_STAFF,
  );
  if (!staff) {
    await page.goto('/staff');
    await page.getByRole('button', { name: 'New staff member' }).click();
    const d = modal(page);
    await d.getByLabel('Full name').fill(NO_RATE_STAFF);
    await d.getByLabel('Employee number').fill(NO_RATE_EMP);
    await choose(d, 'Staff group', NO_RATE_GROUP);
    await d.getByLabel('Joined on').fill('2026-06-01');
    await d.getByRole('button', { name: /^Save/ }).click();
    await expect(d).toBeHidden({ timeout: 30_000 });
    staff = (await op.school<{ staff_id: string; name: string }[]>('list_staff', {})).find(
      (s) => s.name === NO_RATE_STAFF,
    )!;
  }
  const row = (await salaryMonth()).rows.find((r) => r.staff_id === staff.staff_id)!;
  expect(row.live?.resolution_reason).toBe('No salary rate recorded');

  await page.goto(`/salary?month=${MONTH_PARAM}`);
  const monthRow = page
    .getByTestId('salary-table')
    .getByTestId('salary-row')
    .filter({ hasText: NO_RATE_STAFF });
  await expect(monthRow.getByTestId('salary-status')).toHaveText(
    row.saved ? /Saved v\d+|Changed since saved/ : 'Needs manual resolution',
    { timeout: 60_000 },
  );
  await monthRow.getByRole('link', { name: NO_RATE_STAFF }).click();
  // a later run: the calculator opens with the saved version's override; clear it to see the plain calculation
  const clear = page.getByRole('button', { name: 'Clear overrides' });
  await expect(page.getByTestId('salary-formula')).toBeVisible({ timeout: 60_000 });
  if (await clear.isVisible()) await clear.click();
  await expect(page.getByText("Can't calculate yet: No salary rate recorded.")).toBeVisible({
    timeout: 60_000,
  });
  const save = page.getByRole('button', { name: 'Save calculation' });
  await expect(save).toBeDisabled();
  const overrideBtn = page.getByRole('button', { name: 'Override values' });
  if (await overrideBtn.isVisible()) await overrideBtn.click();
  const salary = page.getByLabel('Monthly salary (₹, required)');
  await salary.fill('');
  await page.getByLabel('Reason for the overrides').fill('');
  await page.getByRole('button', { name: 'Preview with these values' }).click();
  await expect(page.getByText(/No salary rate is recorded — enter the monthly salary/)).toBeVisible();
  // a per-run amount, so every run saves a new version
  const paise = 1_500_000 + (Date.now() % 997);
  await salary.fill(rupees(paise));
  await page.getByLabel('Reason for the overrides').fill(`Rate not entered yet (${RUN})`);
  // the new group has no staff calendar either: working days are required too
  const working = page.getByLabel(/^Working days \(0–31, steps of 0\.5/);
  await working.fill('');
  await page.getByRole('button', { name: 'Preview with these values' }).click();
  const noDays = page.getByText('There are no working days on the calendar — enter the working days');
  if (await noDays.isVisible()) {
    test
      .info()
      .annotations.push({ type: 'manual-resolution', description: 'no salary rate and no working days' });
    await working.fill('22');
    await page.getByRole('button', { name: 'Preview with these values' }).click();
  }
  await expect(page.getByTestId('salary-formula')).toContainText(
    `₹${Number(rupees(paise)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
  );
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await expect(page.getByTestId('salary-save-result')).toHaveText(/^Saved as version \d+\.$/, {
    timeout: 30_000,
  });
  const after = (await salaryMonth()).rows.find((r) => r.staff_id === staff.staff_id)!;
  expect(after.status).toBe('saved');
  await admin.context.close();
});

// ============================================================================ R4. staff changes tab
test('R4. Attendance changes, Staff tab: a corrected staff mark with old → new and the actor', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const day = '2026-10-01';
  const admin = await asAdmin(browser);
  await admin.page.goto(`/staff-attendance?date=${day}`);
  await expect(admin.page.getByTestId('staff-roster')).toBeVisible({ timeout: 30_000 });
  const lata = admin.page.getByTestId('staff-row').filter({ hasText: 'Lata Iyer' });
  const radio = (w: string) => lata.getByRole('radio', { name: w });
  let old = '';
  for (const w of ['Present', 'Late', 'Half day', 'Absent'])
    if ((await radio(w).getAttribute('aria-checked')) === 'true') old = w;
  if (!old) {
    // a first mark is not a correction: mark it once, then correct it
    await radio('Present').click();
    await admin.page.getByRole('button', { name: /Save staff attendance/ }).click();
    await expect(admin.page.getByTestId('roster-save-bar').getByText('Saved.', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    old = 'Present';
  }
  const next = old === 'Absent' ? 'Present' : 'Absent';
  await radio(next).click();
  await admin.page.getByRole('button', { name: /Save staff attendance/ }).click();
  await expect(admin.page.getByTestId('roster-save-bar').getByText('Saved.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await admin.context.close();

  const principal = await asPrincipal(browser);
  await principal.page.goto(`/attendance/changes?kind=staff&from=${day}&to=${day}`);
  await expect(principal.page.getByRole('tab', { name: 'Staff' })).toHaveAttribute('aria-selected', 'true');
  const first = principal.page.getByTestId('attendance-change').filter({ hasText: 'Lata Iyer' }).first();
  await expect(first).toBeVisible({ timeout: 30_000 });
  await expect(first.getByTestId('change-statuses')).toContainText(`${old} → changed to ${next}`);
  await expect(first.getByTestId('change-actor')).toContainText('Changed by Demo Admin (Admin)');
  await principal.context.close();
});

// ============================================================================ R5. CSV contents
test('R5. Every M4 CSV: salary month, register, coverage, fee-head totals — contents match the RPCs', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  // salary month (Admin)
  const admin = await asAdmin(browser);
  let page = admin.page;
  await page.goto(`/salary?month=${MONTH_PARAM}`);
  await expect(page.getByTestId('salary-table')).toBeVisible({ timeout: 60_000 });
  const m = await salaryMonth();
  let csv = await download(page, page.getByRole('button', { name: 'Export CSV' }));
  expect(csv.name).toBe(`salary-${MONTH_PARAM}.csv`);
  expect(csv.lines[0]).toBe(
    'Month,Employee no,Name,Group,Status,Version,Partial month,Monthly salary (₹),Working days,Attended days,Paid leave days,Unpaid days,Payable (₹),Override reason,Saved by,Saved at',
  );
  expect(csv.lines).toHaveLength(m.rows.length + 2);
  const lataLine = csv.lines.find((l) => l.includes(',Lata Iyer,'))!;
  const lataApi = m.rows.find((r) => r.staff_id === ids.lata)!;
  expect(lataLine).toContain(`,${rupees(lataApi.saved!.payable_paise)},`);
  expect(lataLine).toContain(`,${lataApi.saved!.version_no},`);
  expect(csv.lines.at(-1)).toContain(`,${rupees(m.totals.saved_payable_paise)},`);
  // nothing live is exported: a not-saved row has no amounts
  const notSaved = m.rows.find((r) => r.status === 'not_saved');
  if (notSaved)
    expect(csv.lines.find((l) => l.includes(`,${notSaved.name},`))).toMatch(/,Not calculated,,,,,,,,,,,$/);
  await admin.context.close();

  // register + coverage (Principal)
  const principal = await asPrincipal(browser);
  page = principal.page;
  await page.goto(`/attendance/register?section=${ids.sectionA}&month=${MONTH_PARAM}`);
  await expect(page.getByTestId('register-grid')).toBeVisible({ timeout: 60_000 });
  const reg = await op.school<{
    to: string;
    dates: { date: string }[];
    students: {
      name: string;
      cells: Record<string, { s?: string | null; held?: number; attended?: number; marked?: number }>;
    }[];
  }>('get_attendance_register', { p_section_id: ids.sectionA, p_month: MONTH });
  csv = await download(page, page.getByRole('button', { name: 'Export CSV' }));
  expect(csv.name).toBe(`register-Class-1-A-${MONTH_PARAM}.csv`);
  expect(csv.lines[0]).toBe(
    [
      'Roll no',
      'Name',
      'Admission no',
      ...reg.dates.map((d) => d.date),
      'Attended',
      'Marked',
      'Expected',
      'Unmarked',
      'Percentage',
      'Totals',
    ].join(','),
  );
  expect(csv.lines).toHaveLength(reg.students.length + 1);
  const col = 3 + reg.dates.findIndex((d) => d.date === '2026-10-20');
  const st = reg.students.find((s) => s.cells['2026-10-20']?.s !== undefined)!;
  const stLine = csv.lines.find((l) => l.includes(`,${st.name},`))!;
  expect(cells(stLine)[col]).toBe(st.cells['2026-10-20']!.s ?? 'Not marked');

  const from = '2026-10-01';
  const to = TODAY < '2026-11-01' ? TODAY : '2026-10-31';
  await page.goto(`/reports/coverage?from=${from}&to=${to}&section=${ids.sectionA}`);
  await expect(page.getByTestId('coverage-table')).toBeVisible({ timeout: 60_000 });
  const cov = await op.school<{
    rows: {
      subject: string;
      teacher: string;
      lessons: number;
      diary_written: number;
      homework_due_unchecked: number;
    }[];
  }>('get_academic_coverage', { p_from: from, p_to: to, p_section_id: ids.sectionA });
  csv = await download(page, page.getByRole('button', { name: 'Export CSV' }));
  expect(csv.lines[0]).toBe(
    'From,To,Section,Subject,Teacher,Lessons,Diary written,Diary missing,Homework set,Homework due,Due and fully checked,Due with no checks,Period-wise lessons,Period attendance marked',
  );
  expect(csv.lines).toHaveLength(cov.rows.length + 1);
  const eng = cov.rows.find((r) => r.subject === 'English' && r.teacher === 'Ravi Kumar')!;
  const engLine = csv.lines.find((l) => l.includes(',English,Ravi Kumar,'))!;
  const engCells = cells(engLine);
  expect([Number(engCells[5]), Number(engCells[6]), Number(engCells[7]), Number(engCells[11])]).toEqual([
    eng.lessons,
    eng.diary_written,
    eng.lessons - eng.diary_written,
    eng.homework_due_unchecked,
  ]);
  await principal.context.close();

  // fee-head totals (Accountant)
  const acc = await asAccountant(browser);
  page = acc.page;
  await page.goto('/fees/reports/heads');
  await expect(page.getByTestId('heads-charged')).toBeVisible({ timeout: 60_000 });
  const fh = await op.school<{
    heads: { code: string; gross_paise: number; concession_paise: number; adjustments_paise: number }[];
    adjustments_without_head_paise: number;
    totals: { charged_paise: number; paid_paise: number; balance_paise: number };
  }>('get_fee_head_report', {});
  csv = await download(page, page.getByRole('button', { name: 'Export CSV' }));
  expect(csv.name).toBe('fee-head-totals.csv');
  expect(csv.lines[0]).toBe(
    'Period,Code,Head,Kind,Invoices,Gross (₹),Concession (₹),Adjustments (₹),Net (₹)',
  );
  expect(csv.lines).toHaveLength(fh.heads.length + 6);
  const h = fh.heads[0]!;
  const hLine = csv.lines.find((l) => l.startsWith(`Whole year,${h.code},`))!;
  const hCells = cells(hLine);
  expect(hCells.slice(5)).toEqual([
    rupees(h.gross_paise),
    rupees(h.concession_paise),
    h.adjustments_paise < 0 ? `-${rupees(-h.adjustments_paise)}` : rupees(h.adjustments_paise),
    rupees(h.gross_paise - h.concession_paise + h.adjustments_paise),
  ]);
  expect(
    csv.lines
      .find((l) => l.includes('Charged (all invoices)'))!
      .endsWith(`,${rupees(fh.totals.charged_paise)}`),
  ).toBe(true);
  expect(
    csv.lines.find((l) => l.includes(',Balance,'))!.endsWith(`,${rupees(fh.totals.balance_paise)}`),
  ).toBe(true);
  await acc.context.close();
});

// ============================================================================ R6. ended session
/** The page's own access token from the Auth SDK's storage (`storageKey: 'primecampus-auth'`); memory only. */
const tokenOf = (page: Page) =>
  page.evaluate(
    () => (JSON.parse(localStorage.getItem('primecampus-auth')!) as { access_token: string }).access_token,
  );

test('R6. A page left open after the server ended the session goes to sign-in with the message (Operator console and a school page)', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // Operator console (op_* answers FORBIDDEN for an ended session; the app re-checks and signs out)
  const o = await newPage(browser, seen, DESKTOP);
  await signIn(o.page, OPERATOR, OPERATOR_PASSWORD);
  await expect(o.page).toHaveURL(/\/choose$/, { timeout: 30_000 });
  await o.page.goto('/operator/activity');
  await expect(o.page.getByRole('heading', { name: 'Activity log' })).toBeVisible({ timeout: 30_000 });
  expect(await endAppSessionWithToken(await tokenOf(o.page))).toBe(true); // "a second context" ends it
  // act: a new filter, so the page asks the server (the unchanged filter would be served from cache)
  await o.page.getByLabel('Action starts with').fill('operator.');
  await o.page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(o.page).toHaveURL(/\/sign-in$/, { timeout: 30_000 });
  await expect(o.page.getByTestId('signed-out-notice')).toHaveText(
    'Your session has ended. Please sign in again.',
  );
  await expect(o.page.getByText("You don't have access to this")).toHaveCount(0);
  await o.context.close();

  // a school page (school RPCs answer UNAUTHENTICATED)
  const admin = await asAdmin(browser);
  await expect(admin.page.getByTestId('block-attendance')).toBeVisible({ timeout: 60_000 });
  expect(await endAppSessionWithToken(await tokenOf(admin.page))).toBe(true);
  await admin.page.getByLabel('Date').fill('2026-10-19');
  await expect(admin.page).toHaveURL(/\/sign-in$/, { timeout: 30_000 });
  await expect(admin.page.getByTestId('signed-out-notice')).toHaveText(
    'Your session has ended. Please sign in again.',
  );
  await admin.context.close();
});

// ============================================================================ R7. the M2-3 race, forced
test('R7. Homework saved while the lesson page’s first list load is still in flight is listed (the M2-3 flake, reproduced on purpose)', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  type L = { lesson_session_id: number; source: string; status: string; subject: string };
  const extra = (
    await op.school<L[]>('get_date_schedule', { p_date: '2026-10-19', p_section_id: ids.sectionA })
  ).find((l) => l.source === 'extra' && l.status === 'scheduled' && l.subject === 'English');
  expect(extra, 'the extra English lesson of m4.spec on 19 Oct').toBeTruthy();
  const s = await as(browser, 'demo.teacher', pw.teacher!, 'dashboard-teacher');
  const page = s.page;
  // hold the FIRST list_homework answer for 6 s: the save below settles while it is still in flight,
  // exactly the order the API gateway logged for the failed M2-3 run
  let held = false;
  const lists: string[] = [];
  await page.route('**/rest/v1/rpc/list_homework', async (route) => {
    const first = !held;
    held = true;
    lists.push(`${first ? 'first (held 6 s)' : 'next'} sent ${new Date().toISOString()}`);
    const response = await route.fetch();
    if (first) await new Promise((r) => setTimeout(r, 6_000));
    // the held first load may have been cancelled by the page meanwhile
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.goto(`/lessons/${extra!.lesson_session_id}`);
  await expect(page.getByTestId('lesson-page')).toBeVisible({ timeout: 30_000 });
  const text = `Race check — ${RUN}`;
  await page.getByRole('button', { name: 'Set homework' }).click();
  const d = modal(page);
  await d.getByLabel('Homework').fill(text);
  await d.getByRole('button', { name: 'Set homework' }).click();
  await expect(d).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('lesson-homework').filter({ hasText: text })).toBeVisible({
    timeout: 30_000,
  });
  expect(lists.length, lists.join('\n')).toBeGreaterThanOrEqual(2); // a list request after the save
  await s.context.close();
});
