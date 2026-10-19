import { expect, test, type Browser, type Page } from '@playwright/test';
import { ApiSession, newPassword, operatorSession, setKnownPassword } from './helpers/api';
import { csv, expectTiles, runImport, startImport, STUDENT_HEADER } from './helpers/imports';
import {
  addDays,
  auditNetwork,
  choose,
  expectDemoSchool,
  isoWeekday,
  modal,
  newPage,
  PHONE,
  settled,
  signIn,
  TODAY,
  type Seen,
} from './helpers/ui';

// M2X close-out of M1 (Setup & People), LIVE backend, Demo School only (every login is `demo.*`).
// Every school record is created or changed through the UI; the API helper only gives demo logins a
// known password, counts rows, and makes the direct FORBIDDEN calls. Passwords stay in memory.
// Re-runnable: every run uses run-suffixed records or alternates a value, so each change is real.
// (The attendance-mode change is verified in m2x-m2.spec.ts, where it is needed.)

const OPERATOR = process.env.E2E_OPERATOR_USERNAME ?? '';
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? '';
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const DIGITS = String(Date.now()).slice(-8);

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

async function as(
  browser: Browser,
  username: string,
  password: string,
  dashboard: string,
  viewport?: typeof PHONE,
) {
  const s = await newPage(browser, seen, viewport);
  await signIn(s.page, username, password);
  await expect(s.page.getByTestId(dashboard)).toBeVisible({ timeout: 30_000 });
  await expectDemoSchool(s.page);
  return s;
}
const asAdmin = (browser: Browser, viewport?: typeof PHONE) =>
  as(browser, 'demo.admin', pw.admin!, 'dashboard-admin', viewport);

async function openStaff(page: Page, employeeNo: string) {
  await page.goto('/staff');
  await settled(page.getByRole('table'), page.getByText('No staff found'));
  await page.getByTestId(`staff-row-${employeeNo}`).getByRole('link').first().click();
  await expect(page.getByTestId('staff-name')).toBeVisible({ timeout: 30_000 });
}

async function studentId(adm: string): Promise<string> {
  const r = await op.school<{ items: { student_id: string; admission_no: string }[] }>('list_students', {
    p_search: adm,
  });
  return r.items.find((s) => s.admission_no === adm)!.student_id;
}

// ------------------------------------------------------------------ 1. office data
test('M1-1. School profile save · staff salary rate + bank · ending a teaching assignment', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAdmin(browser);

  // school profile: the city alternates every run (a real save each time)
  await page.goto('/setup/profile');
  const city = page.getByLabel('City');
  await expect(city).toBeVisible({ timeout: 30_000 });
  const next = (await city.inputValue()) === 'Hyderabad' ? 'Secunderabad' : 'Hyderabad';
  await city.fill(next);
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('School profile saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('City')).toHaveValue(next, { timeout: 30_000 });

  // salary rate (a future date unique to this run) and bank details for Lata Iyer
  await openStaff(page, 'DEMO-O1');
  const fin = page.getByTestId('staff-finance-card');
  await expect(fin).toBeVisible();
  const from = addDays(TODAY, 30 + (Math.floor(Date.now() / 60_000) % 600));
  const amount = String(18_000 + (Number(DIGITS.slice(-3)) % 900));
  await fin.getByLabel('New monthly salary').fill(amount);
  await fin.getByLabel('Effective from').fill(from);
  await fin.getByLabel('Reason (optional)').fill(`E2E ${RUN}`);
  await fin.getByRole('button', { name: 'Add salary rate' }).click();
  await expect(page.getByText('Salary rate saved.')).toBeVisible();
  await expect(fin).toContainText(`₹${Number(amount).toLocaleString('en-IN')}`);
  const account = `5${DIGITS}2`;
  await fin.getByLabel('Account holder').fill('Lata Iyer');
  await fin.getByLabel('Account number').fill(account);
  await fin.getByLabel('IFSC').fill('SBIN0001234');
  await fin.getByLabel('Bank name (optional)').fill('State Bank of India');
  await fin.getByRole('button', { name: 'Save bank details' }).click();
  await expect(page.getByText('Bank details saved.')).toBeVisible();
  await expect(fin).toContainText('SBIN0001234');
  await expect(fin).toContainText(account.slice(-4));
  // the full number is masked until asked for
  await expect(fin.getByText(account, { exact: true })).toHaveCount(0);

  // teaching assignment: Meera Rao, Science in Class 2 B, starting on a future day unique to this run
  // (assignments of one teacher, section and subject may not overlap), then ended after one day
  const start = addDays(TODAY, 2 + (Math.floor(Date.now() / 60_000) % 120));
  const shown = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${start}T12:00:00Z`));
  await openStaff(page, 'DEMO-T2');
  const teaches = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText('Teaches', { exact: true }) });
  await teaches.getByRole('button', { name: 'Add' }).click();
  const dlg = modal(page);
  await choose(dlg, 'Section', 'Class 2 B');
  await choose(dlg, 'Duty', 'Subject teacher');
  await choose(dlg, 'Subject', 'Science');
  await dlg.getByLabel('Starts on').fill(start);
  await dlg.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Teaching assignment added.')).toBeVisible();
  const item = teaches
    .getByRole('listitem')
    .filter({ hasText: 'Class 2 B · Science' })
    .filter({ hasText: `From ${shown}` });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(`Starts ${shown}`);
  await item.getByRole('button', { name: 'End' }).click();
  const end = modal(page);
  await end.getByLabel('No longer from').fill(addDays(start, 1));
  await end.getByRole('button', { name: 'End assignment' }).click();
  await expect(page.getByText('Assignment ended.')).toBeVisible();
  // one day long now: "From X to X"
  await expect(item).toContainText(`From ${shown} to ${shown}`);
  await context.close();
});

// ------------------------------------------------------------------ 2. users & logins
test('M1-2. Admissions-duty toggle: the Teacher gets Admissions, then loses it', async ({ browser }) => {
  test.setTimeout(240_000);
  const admin = await asAdmin(browser);
  await admin.page.goto('/users');
  const card = admin.page.getByTestId('user-demo.teacher');
  await expect(card).toBeVisible({ timeout: 30_000 });
  const duty = card.getByRole('switch', { name: 'Admissions duty for Teacher' });
  if ((await duty.getAttribute('aria-checked')) === 'true') {
    await duty.click(); // start from "off"
    await expect(admin.page.getByText('Admissions duty removed.')).toBeVisible();
  }
  await duty.click();
  await expect(admin.page.getByText('Admissions duty given.')).toBeVisible();
  await expect(duty).toHaveAttribute('aria-checked', 'true');

  const t = await as(browser, 'demo.teacher', pw.teacher!, 'dashboard-teacher');
  await expect(t.page.getByRole('link', { name: 'Admissions' }).first()).toBeVisible();
  await t.page.goto('/admissions');
  await expect(t.page.getByRole('heading', { name: 'Admissions' })).toBeVisible({ timeout: 30_000 });
  await t.context.close();

  await admin.page.bringToFront();
  await duty.click();
  await expect(admin.page.getByText('Admissions duty removed.')).toBeVisible();
  await expect(duty).toHaveAttribute('aria-checked', 'false');
  const t2 = await as(browser, 'demo.teacher', pw.teacher!, 'dashboard-teacher');
  await expect(t2.page.getByRole('link', { name: 'Admissions' })).toHaveCount(0);
  await t2.page.goto('/admissions');
  await expect(t2.page.getByText("You don't have access to this page")).toBeVisible();
  await t2.context.close();
  await admin.context.close();
});

test('M1-3. Principal: provisioned through the UI, sees read-only views, gets FORBIDDEN on writes; unlink/relink; disable/enable', async ({
  browser,
}) => {
  test.setTimeout(400_000);
  const admin = await asAdmin(browser);
  const page = admin.page;

  // demo.principal: created (linked to Lata Iyer's staff record) or reset on re-runs
  await page.goto('/users');
  await settled(page.getByRole('list', { name: 'Users' }), page.getByText('No users yet'));
  const card = page.getByTestId('user-demo.principal');
  if (await card.isVisible()) {
    await page.getByRole('button', { name: 'Actions for demo.principal' }).click();
    await page.getByRole('menuitem', { name: 'Reset password' }).click();
    await modal(page).getByRole('button', { name: 'Reset password' }).click();
  } else {
    await page.getByRole('button', { name: 'Create login', exact: true }).click();
    const dlg = modal(page);
    await dlg.getByLabel('Username').fill('demo.principal');
    await dlg.getByLabel('Full name').fill('Lata Iyer');
    await dlg.getByRole('checkbox', { name: /\bPrincipal$/ }).click();
    await choose(dlg, 'Link to staff record (optional)', 'Lata Iyer (DEMO-O1)');
    await dlg.getByRole('button', { name: 'Create login' }).click();
  }
  const secret = page.getByTestId('one-time-secret');
  const noted = page.getByRole('button', { name: /I have noted it/ });
  await expect(noted).toBeVisible({ timeout: 30_000 });
  const temp = (await secret.textContent())?.trim() ?? '';
  await noted.click();
  await expect(card).toBeVisible();

  // first sign-in → forced change → Principal home
  const p = await newPage(browser, seen);
  await signIn(p.page, 'demo.principal', temp);
  await expect(p.page).toHaveURL(/\/change-password$/, { timeout: 30_000 });
  pw.principal = newPassword();
  await p.page.getByLabel('Temporary password').fill(temp);
  await p.page.getByLabel('New password', { exact: true }).fill(pw.principal);
  await p.page.getByLabel('Confirm new password').fill(pw.principal);
  await p.page.getByRole('button', { name: 'Save new password' }).click();
  await expect(p.page.getByTestId('context-summary').first()).toContainText('Principal', { timeout: 30_000 });
  await expectDemoSchool(p.page);

  // read-only views: students, a profile, classes, staff, timetable — no write controls
  await p.page.goto('/students');
  await expect(p.page.getByTestId('student-DEMO-S1')).toBeVisible({ timeout: 30_000 });
  await expect(p.page.getByRole('link', { name: 'Admit a student' })).toHaveCount(0);
  await p.page.getByTestId('student-DEMO-S1').getByRole('link').first().click();
  await expect(p.page.getByTestId('student-name')).toHaveText('Aarav Sharma', { timeout: 30_000 });
  await expect(p.page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await p.page.goto('/setup/classes');
  await expect(p.page.getByTestId('class-card-Class 1')).toBeVisible({ timeout: 30_000 });
  await expect(p.page.getByRole('button', { name: 'New class' })).toHaveCount(0);
  await p.page.goto('/staff');
  await expect(p.page.getByTestId('staff-row-DEMO-T1')).toBeVisible({ timeout: 30_000 });
  await expect(p.page.getByRole('button', { name: 'New staff member' })).toHaveCount(0);
  await p.page.goto('/users');
  await expect(p.page.getByText("You don't have access to this page")).toBeVisible();
  await p.context.close();

  // writes are refused by the server
  const api = await ApiSession.signIn('demo.principal', pw.principal);
  try {
    await api.enterDemo('principal');
    const sid = await studentId('DEMO-S1');
    await expect(api.school('save_class', { p_name: `Nope ${RUN}`, p_sort_order: 99 })).rejects.toThrow(
      /FORBIDDEN/,
    );
    await expect(
      api.school('update_student', { p_student_id: sid, p: { mother_tongue: 'x' }, p_expected_version: 1 }),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(api.school('save_staff', { p: { full_name: 'Nope' } })).rejects.toThrow(/FORBIDDEN/);
    // a non-admin can't disable a login: the Edge Function refuses
    const teacher = await op.rpc<{ account_id: string }>('op_find_account', { p_username: 'demo.teacher' });
    await expect(api.edge('set_status', { account_id: teacher.account_id, active: false })).rejects.toThrow(
      /FORBIDDEN/,
    );
  } finally {
    await api.signOut();
  }

  // unlink the login from Lata Iyer's staff record, then link it again
  await openStaff(page, 'DEMO-O1');
  const login = page.locator('[data-slot="card"]').filter({ has: page.getByText('Login', { exact: true }) });
  await expect(login.getByTestId('linked-login')).toContainText('demo.principal');
  await login.getByRole('button', { name: 'Unlink' }).click();
  await modal(page)
    .getByRole('button', { name: /^Unlink/ })
    .click();
  await expect(page.getByText('Login unlinked.')).toBeVisible();
  await expect(login.getByTestId('linked-login')).toHaveCount(0);
  await login.getByRole('combobox', { name: /Link a/ }).click();
  await page.getByRole('option', { name: /\(demo\.principal\)/ }).click();
  await login.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.getByText('Login linked.')).toBeVisible();
  await expect(login.getByTestId('linked-login')).toContainText('demo.principal');

  // disable the login: it can no longer sign in; enable: it can again
  await page.goto('/users');
  await page.getByRole('button', { name: 'Actions for demo.principal' }).click();
  await page.getByRole('menuitem', { name: 'Disable login' }).click();
  await modal(page).getByRole('button', { name: 'Disable login' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Login disabled.' })).toBeVisible();
  await expect(card).toContainText('Login disabled.');
  const blocked = await newPage(browser, seen);
  await signIn(blocked.page, 'demo.principal', pw.principal);
  await expect(blocked.page.getByRole('alert')).toBeVisible({ timeout: 30_000 });
  await expect(blocked.page).toHaveURL(/\/sign-in$/);
  await blocked.context.close();
  await page.getByRole('button', { name: 'Actions for demo.principal' }).click();
  await page.getByRole('menuitem', { name: 'Enable login' }).click();
  await modal(page).getByRole('button', { name: 'Enable login' }).click();
  await expect(page.getByText('Login enabled.')).toBeVisible();
  const ok = await ApiSession.signIn('demo.principal', pw.principal);
  await ok.signOut();
  await admin.context.close();
});

// ------------------------------------------------------------------ 3. students
const NEW = (i: number) => ({
  adm: `M2X${RUN}-${i}`,
  name: `M2x${RUN} Pupil${'ABCDEFGHIJKLMNOPQRST'[i - 1]}`,
});

test('M1-4. Students: "Load more" past 50 · placement move · guardian add + edit · sensitive identifiers (+ DUPLICATE under the field)', async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { context, page } = await asAdmin(browser);

  // enough students for a second page (51+), plus two new ones every run, through the importer
  const all = await op.school<{ items: unknown[] }>('list_students', { p_limit: 200 });
  const count = Math.max(2, 52 - all.items.length);
  const rows = Array.from({ length: count }, (_, k) => {
    const s = NEW(k + 1);
    return `${s.adm},${s.name},${k % 2 ? 'M' : 'F'},2018-0${(k % 9) + 1}-1${k % 9},Class 2,A,M2x${RUN} Parent${k + 1},9${DIGITS.slice(0, 7)}${k % 10}`;
  });
  await startImport(page, 'students', csv(`m2x-students-${RUN}.csv`, [STUDENT_HEADER.join(','), ...rows]));
  await expectTiles(page, { Ready: count, 'Needs fixing': 0 });
  const summary = await runImport(page);
  expect(summary).toContain(`${count} imported`);

  // the directory shows 50, then "Load more" adds the rest
  await page.goto('/students');
  const list = page.getByRole('list', { name: 'Students' }).filter({ visible: true });
  await expect(list.getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });
  const shown = () => list.getByRole('listitem').count();
  await expect.poll(shown).toBe(50);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(50);

  // placement move: pupil A from Class 2 A to Class 2 B from today
  await page.getByLabel('Search').fill(NEW(1).adm);
  await expect(page.getByTestId(`student-${NEW(1).adm}`).filter({ visible: true })).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByRole('checkbox', { name: `Select ${NEW(1).name}` })
    .first()
    .check();
  await page.getByRole('button', { name: 'Move 1 selected' }).click();
  const mv = modal(page);
  await choose(mv, 'Move to section', 'Class 2 B');
  await mv.getByLabel('From date').fill(TODAY);
  await mv.getByLabel('Reason (required)').fill(`E2E ${RUN}: section change`);
  await mv.getByRole('button', { name: 'Preview' }).click();
  await expect(mv.getByTestId(`move-row-${NEW(1).adm}`)).toBeVisible({ timeout: 30_000 });
  await mv.getByRole('button', { name: 'Move 1' }).click();
  await expect(page.getByText('1 student moved.')).toBeVisible({ timeout: 30_000 });
  await page.goto(`/students/${await studentId(NEW(1).adm)}`);
  await expect(page.getByTestId('placements')).toContainText('Class 2 B', { timeout: 30_000 });

  // guardian: add a second parent (new person), then edit their occupation
  const guardians = page.getByTestId('guardians');
  await guardians.getByRole('button', { name: 'Add' }).click();
  const add = modal(page);
  await add.getByRole('button', { name: 'New person' }).click();
  await add.getByLabel('Full name').fill(`M2x${RUN} Father`);
  await add.getByLabel('Mobile', { exact: true }).fill(`8${DIGITS.slice(0, 8)}1`);
  await choose(add, 'Relationship', 'Father');
  await add.getByRole('button', { name: 'Create and link' }).click();
  await expect(guardians).toContainText(`M2x${RUN} Father`, { timeout: 30_000 });
  await guardians
    .getByRole('listitem')
    .filter({ hasText: `M2x${RUN} Father` })
    .getByRole('button', { name: 'Details' })
    .click();
  const g = modal(page);
  await g.getByLabel('Occupation').fill(`Engineer ${RUN}`);
  await g.getByRole('button', { name: 'Save guardian' }).click();
  await expect(page.getByText('Guardian saved.')).toBeVisible();

  // sensitive identifiers: pupil A gets a run-unique Aadhaar number
  const aadhaar = `7${DIGITS}${RUN.length}${DIGITS.slice(-2)}`.slice(0, 12);
  const sens = page.getByTestId('sensitive-card');
  await sens.getByRole('button', { name: /^(Add|Edit)$/ }).click();
  let dlg = modal(page);
  await dlg.getByLabel('Name as per Aadhaar').fill(NEW(1).name);
  await dlg.getByLabel('Aadhaar number').fill(aadhaar);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Sensitive details saved.')).toBeVisible();
  await expect(sens).toContainText(aadhaar.slice(-4));

  // the same Aadhaar for pupil B: the server's DUPLICATE (2310) is shown under the field
  await page.goto(`/students/${await studentId(NEW(2).adm)}`);
  await page
    .getByTestId('sensitive-card')
    .getByRole('button', { name: /^(Add|Edit)$/ })
    .click();
  dlg = modal(page);
  const field = dlg.getByLabel('Aadhaar number');
  await field.fill(aadhaar);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(dlg.getByText('Another student in this school already has this Aadhaar number')).toBeVisible();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(dlg.getByRole('alert')).toHaveCount(0); // not the generic form error
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await context.close();
});

// ------------------------------------------------------------------ 4. enquiries
test('M1-5. Enquiries: "Load more" past 50 · enquiry edit', async ({ browser }) => {
  test.setTimeout(600_000);
  const { context, page } = await asAdmin(browser);
  const leads = await op.school<{ items: unknown[] }>('list_leads', { p_limit: 200 });
  const missing = Math.max(1, 52 - leads.items.length);
  await page.goto('/admissions');
  for (let i = 1; i <= missing; i += 1) {
    await page.getByRole('button', { name: 'New enquiry' }).click();
    const d = modal(page);
    await d.getByLabel('Parent’s name').fill(`M2x${RUN} Enquirer ${i}`);
    await d.getByLabel('Mobile', { exact: true }).fill(`7${DIGITS.slice(0, 7)}${String(i).padStart(2, '0')}`);
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('lead-title')).toHaveText(`M2x${RUN} Enquirer ${i}`, { timeout: 30_000 });
    await page.goto('/admissions');
  }

  const list = page.getByRole('list', { name: 'Enquiries' });
  await expect(list.getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });
  const shown = () => list.getByRole('listitem').count();
  await expect.poll(shown).toBe(50);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(50);

  // edit the first enquiry of this run: child's name and class wanted
  await page.getByLabel('Search').fill(`M2x${RUN} Enquirer 1`);
  await list
    .getByRole('link', { name: new RegExp(`M2x${RUN} Enquirer 1\\b`) })
    .first()
    .click();
  await expect(page.getByTestId('lead-title')).toHaveText(`M2x${RUN} Enquirer 1`, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Edit' }).click();
  const d = modal(page);
  await d.getByLabel('Child’s name').fill(`M2x${RUN} Child`);
  await choose(d, 'Class wanted', 'Class 2');
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Enquiry saved.')).toBeVisible();
  await expect(page.getByTestId('lead-title')).toHaveText(`M2x${RUN} Enquirer 1 — M2x${RUN} Child`);
  await page.reload();
  await expect(page.getByTestId('lead-title')).toHaveText(`M2x${RUN} Enquirer 1 — M2x${RUN} Child`, {
    timeout: 30_000,
  });
  await context.close();
});

// ------------------------------------------------------------------ 5. staff calendars
test('M1-6. Staff calendar tab and a staff-group calendar (Office staff: Saturday alternates working / weekly off)', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAdmin(browser);
  await page.goto('/setup/calendar');
  await expect(page.getByTestId('calendar-totals')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Staff' }).click();
  await expect(page.getByTestId('calendar-totals')).toBeVisible({ timeout: 30_000 });
  await choose(page, 'Staff group', 'Office staff');
  await expect(page.getByTestId('calendar-totals')).toBeVisible({ timeout: 30_000 });

  // the coming Saturday in this month's view (or next month's)
  const sat = addDays(TODAY, (6 - isoWeekday(TODAY) + 7) % 7 || 7);
  const cell = () => page.getByTestId(`day-${sat}`);
  while (!(await cell().isVisible())) await page.getByRole('button', { name: 'Next month' }).click();
  const was = await cell().getAttribute('data-day-type');
  const want = was === 'weekly_off' ? 'Working day' : 'Weekly off';
  await page.getByRole('button', { name: 'Weekly pattern' }).click();
  const dlg = modal(page);
  await choose(dlg, 'Saturday day type', want);
  await dlg.getByRole('button', { name: 'Save pattern' }).click();
  await expect(page.getByText('Weekly pattern saved.')).toBeVisible();
  await expect(cell()).toHaveAttribute('data-day-type', was === 'weekly_off' ? 'working' : 'weekly_off', {
    timeout: 30_000,
  });

  // the group's change does not touch the default staff calendar
  await choose(page, 'Staff group', 'All staff (default)');
  await expect(page.getByTestId('calendar-totals')).toBeVisible({ timeout: 30_000 });
  while (!(await cell().isVisible())) await page.getByRole('button', { name: 'Next month' }).click();
  await expect(cell()).toHaveAttribute('data-day-type', 'working');
  await context.close();
});

// ------------------------------------------------------------------ 6. offline
test('M1-7. Offline: a list shows "You are offline" (never empty); a form keeps the input and says nothing was saved', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await asAdmin(browser, PHONE);
  // list: the enquiries list, opened while offline
  await page.goto('/students');
  await expect(page.getByRole('list', { name: 'Students' }).first()).toBeVisible({ timeout: 30_000 });
  await context.setOffline(true);
  await page
    .getByRole('link', { name: 'Admissions' })
    .first()
    .click()
    .catch(async () => {
      // on a phone the link may sit in the "More" menu
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('link', { name: 'Admissions' }).first().click();
    });
  await expect(page.getByText('You are offline').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('No enquiries')).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByRole('list', { name: 'Enquiries' })).toBeVisible({ timeout: 30_000 });

  // form: the school profile, saved while offline
  await page.goto('/setup/profile');
  const district = page.getByLabel('District');
  await expect(district).toBeVisible({ timeout: 30_000 });
  const typed = `Offline ${RUN}`;
  await district.fill(typed);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /offline/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('alert').filter({ hasText: /Nothing was changed/ })).toBeVisible();
  await expect(district).toHaveValue(typed);
  await context.setOffline(false);
  await context.close();
});

test('M1-8. Network audit of these tests', () => {
  expect(seen.length).toBeGreaterThan(50);
  auditNetwork(seen);
});
