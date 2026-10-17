import { expect, test, type Browser, type Locator, type Page, type Request } from '@playwright/test';
import { newPassword, operatorSession, setKnownPassword, type ApiSession } from './helpers/api';

// M1 (Setup & People) against the LIVE backend, Demo School (code `demo`) only; every login is `demo.*`.
// All school data is created through the UI. The API helper is used only to give existing demo logins a
// known password for this run (Edge reset_password + change_password) — never SQL, never a service key.
// Passwords exist only in memory here and are never printed.
//
// Re-runnable: base demo data is created only when missing; the enquiry → admission flow and the
// two-tab edit use run-unique values so they really happen every run.

const OPERATOR = process.env.E2E_OPERATOR_USERNAME ?? '';
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? '';
const SCREENS = 'docs/reports/m1-screens';
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const PHONE = { width: 375, height: 812 };

const YEAR = { name: '2026-27', from: '2026-04-01', to: '2027-03-31' };
const CLASSES = ['Class 1', 'Class 2', 'Class 3'];
const SECTIONS = ['A', 'B'];
const SUBJECTS = [
  { name: 'English', code: 'ENG' },
  { name: 'Mathematics', code: 'MATH' },
  { name: 'Science', code: 'SCI' },
  { name: 'Hindi', code: 'HIN' },
  { name: 'Social Studies', code: 'SST' },
];
const SCHEDULE = 'Regular day'; // name the "8 periods + lunch" preset fills in
const GROUPS = [
  { name: 'Teaching staff', salary: '30000' },
  { name: 'Office staff', salary: '18000' },
];
const STAFF = [
  {
    no: 'DEMO-T1',
    name: 'Ravi Kumar',
    group: 'Teaching staff',
    teaching: true,
    designation: 'Class teacher',
  },
  { no: 'DEMO-T2', name: 'Meera Rao', group: 'Teaching staff', teaching: true, designation: 'TGT Maths' },
  {
    no: 'DEMO-O1',
    name: 'Lata Iyer',
    group: 'Office staff',
    teaching: false,
    designation: 'Office assistant',
  },
];
interface DemoStudent {
  adm: string;
  name: string;
  gender: 'Female' | 'Male';
  dob: string;
  section: string;
  guardian: { name: string; phone?: string; existing?: boolean };
}
const STUDENTS: DemoStudent[] = [
  {
    adm: 'DEMO-S1',
    name: 'Aarav Sharma',
    gender: 'Male',
    dob: '2019-03-12',
    section: 'Class 1 A',
    guardian: { name: 'Priya Sharma', phone: '9000000101' },
  },
  {
    adm: 'DEMO-S2',
    name: 'Anaya Sharma',
    gender: 'Female',
    dob: '2017-07-02',
    section: 'Class 3 A',
    guardian: { name: 'Priya Sharma', existing: true },
  },
  {
    adm: 'DEMO-S3',
    name: 'Kabir Rao',
    gender: 'Male',
    dob: '2019-01-20',
    section: 'Class 1 B',
    guardian: { name: 'Meera Rao', phone: '9000000103' },
  },
  {
    adm: 'DEMO-S4',
    name: 'Ishaan Verma',
    gender: 'Male',
    dob: '2018-05-05',
    section: 'Class 2 A',
    guardian: { name: 'Sunita Verma', phone: '9000000104' },
  },
  {
    adm: 'DEMO-S5',
    name: 'Sara Khan',
    gender: 'Female',
    dob: '2018-09-09',
    section: 'Class 2 B',
    guardian: { name: 'Farah Khan', phone: '9000000105' },
  },
];

test.describe.configure({ mode: 'serial' });
test.skip(!OPERATOR || !OPERATOR_PASSWORD, 'E2E_OPERATOR_USERNAME / E2E_OPERATOR_PASSWORD not set');

// ------------------------------------------------------------------ shared state (memory only)
const pw: Record<string, string> = {};
let op: ApiSession;
let runLeadId = '';

test.beforeAll(async () => {
  op = await operatorSession();
  pw.admin = await setKnownPassword(op, 'demo.admin');
});
test.afterAll(async () => {
  await op?.signOut();
});

// ------------------------------------------------------------------ network audit (every page)
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

// ------------------------------------------------------------------ helpers
async function newPage(browser: Browser, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  watch(page);
  return { context, page };
}

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function asAdmin(browser: Browser, viewport?: { width: number; height: number }) {
  const s = await newPage(browser, viewport);
  await signIn(s.page, 'demo.admin', pw.admin!);
  await expect(s.page.getByTestId('dashboard-admin')).toBeVisible();
  return s;
}

const modal = (page: Page) => page.locator('[role="dialog"], [role="alertdialog"]').last();

async function choose(page: Page | Locator, label: string | RegExp, option: string) {
  const root = 'page' in page ? page.page() : page;
  await page.getByRole('combobox', { name: label }).click();
  await root.getByRole('option', { name: option, exact: true }).click();
}

/** Wait until a list has rendered either its first item or its empty state. */
async function settled(...locators: Locator[]) {
  let l = locators[0]!;
  for (const o of locators.slice(1)) l = l.or(o);
  await expect(l.first()).toBeVisible({ timeout: 30_000 });
}

async function readSecretOnce(page: Page): Promise<string> {
  const secret = page.getByTestId('one-time-secret');
  await expect(secret).toBeVisible({ timeout: 30_000 });
  const value = (await secret.textContent())?.trim() ?? '';
  expect(value).toMatch(/^[A-Za-z0-9]{14}$/);
  await page.getByRole('button', { name: /I have noted it/ }).click();
  await expect(secret).toBeHidden();
  // Shown once: not left in the page, the URL or browser storage.
  expect(await page.content()).not.toContain(value);
  expect(page.url()).not.toContain(value);
  const stored = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
  );
  expect(stored).not.toContain(value);
  return value;
}

async function openUsers(page: Page) {
  await page.goto('/users');
  await settled(page.getByRole('list', { name: 'Users' }), page.getByText('No users yet'));
}

/** Reset (if the login exists) or create it; returns the one-time temporary password. */
async function issueLogin(
  page: Page,
  login: { username: string; name: string; role: string; staff?: string; guardian?: string },
) {
  await openUsers(page);
  const card = page.getByTestId(`user-${login.username}`);
  if (await card.isVisible()) {
    await page.getByRole('button', { name: `Actions for ${login.username}` }).click();
    await page.getByRole('menuitem', { name: 'Reset password' }).click();
    await modal(page).getByRole('button', { name: 'Reset password' }).click();
    return readSecretOnce(page);
  }
  await page.getByRole('button', { name: 'Create login', exact: true }).click();
  const dlg = modal(page);
  await dlg.getByLabel('Username').fill(login.username);
  await dlg.getByLabel('Full name').fill(login.name);
  await dlg.getByRole('checkbox', { name: new RegExp(`\\b${login.role}$`) }).click();
  if (login.staff) await choose(dlg, 'Link to staff record (optional)', login.staff);
  if (login.guardian) {
    await dlg.getByLabel('Find the guardian').fill(login.guardian);
    await dlg.getByTestId(`guardian-result-${login.guardian}`).click();
  }
  await dlg.getByRole('button', { name: 'Create login' }).click();
  return readSecretOnce(page);
}

async function changePassword(page: Page, temp: string): Promise<string> {
  await expect(page).toHaveURL(/\/change-password$/);
  const next = newPassword();
  await page.getByLabel('Temporary password').fill(temp);
  await page.getByLabel('New password', { exact: true }).fill(next);
  await page.getByLabel('Confirm new password').fill(next);
  await page.getByRole('button', { name: 'Save new password' }).click();
  return next;
}

async function studentIdFor(page: Page, adm: string): Promise<string | null> {
  await page.goto('/students');
  const search = page.getByLabel('Search');
  await search.fill(adm);
  const row = page.getByTestId(`student-${adm}`);
  await settled(row, page.getByText('No students match these filters'));
  if (!(await row.isVisible())) return null;
  const href = await row.getByRole('link').first().getAttribute('href');
  return href!.split('/').pop()!;
}

const revisionOf = (page: Page) => page.evaluate(() => window.__pcE2E!.revision());
const cachedRevisions = (page: Page) =>
  page.evaluate(() =>
    window
      .__pcE2E!.cachedQueryKeys()
      .filter((k) => k[0] === 'ctx')
      .map((k) => k[2] as number),
  );

// ------------------------------------------------------------------ 1. setup
test('1. Admin sets up the year, classes + sections, subjects, a bell schedule and the calendar', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAdmin(browser);

  // Academic year, made current
  await page.goto('/setup/years');
  await settled(page.getByRole('table'), page.getByText('No academic years yet'));
  const yearRow = page.getByTestId(`year-row-${YEAR.name}`);
  if (!(await yearRow.isVisible())) {
    await page.getByRole('button', { name: 'New year' }).click();
    const dlg = modal(page);
    await dlg.getByLabel('Name').fill(YEAR.name);
    await dlg.getByLabel('First day').fill(YEAR.from);
    await dlg.getByLabel('Last day').fill(YEAR.to);
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(yearRow).toBeVisible();
  }
  if (!(await yearRow.getByText('Current', { exact: true }).isVisible())) {
    await yearRow.getByRole('button', { name: 'Make current' }).click();
    await modal(page).getByRole('button', { name: 'Make current' }).click();
    await expect(yearRow.getByText('Current', { exact: true })).toBeVisible();
  }
  await expect(page.getByTestId('context-summary')).toContainText(YEAR.name);

  // Classes with sections A/B
  await page.goto('/setup/classes');
  await settled(page.getByText('No classes yet'), page.getByTestId(/^class-card-/));
  for (const cls of CLASSES) {
    const card = page.getByTestId(`class-card-${cls}`);
    if (!(await card.isVisible())) {
      await page.getByRole('button', { name: 'New class' }).click();
      const dlg = modal(page);
      await dlg.getByLabel('Class name').fill(cls);
      await dlg.getByRole('button', { name: 'Save' }).click();
      await expect(card).toBeVisible();
    }
    for (const sec of SECTIONS) {
      const chip = card.getByRole('button', { name: `Section ${cls} ${sec}, edit` });
      if (!(await chip.isVisible())) {
        await card.getByRole('button', { name: 'Add section' }).click();
        const dlg = modal(page);
        await dlg.getByLabel('Section name').fill(sec);
        await dlg.getByLabel('Capacity (optional)').fill('40');
        await dlg.getByRole('button', { name: 'Save' }).click();
        await expect(chip).toBeVisible();
      }
    }
  }

  // Subjects
  await page.goto('/setup/subjects');
  await settled(page.getByRole('table'), page.getByText('No subjects yet'));
  for (const s of SUBJECTS) {
    const row = page.getByTestId(`subject-row-${s.code}`);
    if (!(await row.isVisible())) {
      await page.getByRole('button', { name: 'New subject' }).click();
      const dlg = modal(page);
      await dlg.getByLabel('Name').fill(s.name);
      await dlg.getByLabel('Code').fill(s.code);
      await dlg.getByRole('button', { name: 'Save' }).click();
      await expect(row).toBeVisible();
    }
  }

  // Class subjects (all five for every class)
  await page.goto('/setup/classes');
  for (const cls of CLASSES) {
    await page.getByTestId(`class-card-${cls}`).getByRole('button', { name: 'Subjects' }).click();
    const dlg = modal(page);
    await expect(dlg.getByRole('checkbox', { name: 'English (ENG)' })).toBeVisible();
    let changed = false;
    for (const s of SUBJECTS) {
      const box = dlg.getByRole('checkbox', { name: `${s.name} (${s.code})` });
      if ((await box.getAttribute('aria-checked')) !== 'true') {
        await box.click();
        changed = true;
      }
    }
    if (changed) {
      await dlg.getByRole('button', { name: 'Save subjects' }).click();
      await expect(page.getByText(`Subjects for ${cls} saved.`)).toBeVisible();
    } else {
      await dlg.getByRole('button', { name: 'Cancel' }).click();
    }
    await expect(dlg).toBeHidden();
  }

  // Bell schedule
  await page.goto('/setup/bell-schedules');
  await settled(page.getByText('No bell schedules yet'), page.getByTestId(/^schedule-/));
  if (!(await page.getByTestId(`schedule-${SCHEDULE}`).isVisible())) {
    await page.getByRole('button', { name: 'New bell schedule' }).click();
    await page.getByRole('button', { name: '8 periods + lunch' }).click();
    await page.getByRole('button', { name: 'Save schedule' }).click();
  }
  const sched = page.getByTestId(`schedule-${SCHEDULE}`);
  await expect(sched).toBeVisible();
  await expect(sched).toContainText('Lunch');

  // Calendar: weekly off (Sunday) + one holiday range
  await page.goto('/setup/calendar');
  await expect(page.getByTestId('calendar-totals')).toBeVisible({ timeout: 30_000 });
  if (await page.getByText('No weekly pattern yet').isVisible()) {
    await page.getByRole('button', { name: 'Weekly pattern' }).click();
    const dlg = modal(page);
    await expect(dlg.getByRole('combobox', { name: 'Sunday day type' })).toHaveText('Weekly off');
    await dlg.getByRole('button', { name: 'Save pattern' }).click();
    await expect(page.getByText('Weekly pattern saved.')).toBeVisible();
    await expect(page.getByText('No weekly pattern yet')).toBeHidden();
  }
  const heading = page.getByText('November 2026');
  while (!(await heading.isVisible())) await page.getByRole('button', { name: 'Next month' }).click();
  const diwali = page.getByTestId('day-2026-11-09');
  await expect(diwali).toBeVisible();
  if ((await diwali.getAttribute('data-day-type')) !== 'holiday') {
    await page.getByRole('button', { name: 'Holidays & special days' }).click();
    const dlg = modal(page);
    await dlg.getByLabel('First date').fill('2026-11-09');
    await dlg.getByLabel('Last date').fill('2026-11-11');
    await choose(dlg, 'Day type', 'Holiday');
    await dlg.getByLabel('Label (shown on the calendar)').fill('Diwali break');
    await dlg.getByRole('button', { name: 'Save dates' }).click();
    await expect(page.getByText(/date\(s\) saved/)).toBeVisible();
  }
  await expect(diwali).toHaveAttribute('data-day-type', 'holiday');
  await expect(diwali).toContainText('Diwali break');
  await expect(page.getByTestId('day-2026-11-11')).toHaveAttribute('data-day-type', 'holiday');
  await expect(page.getByTestId('day-2026-11-08')).toHaveAttribute('data-day-type', 'weekly_off'); // Sunday
  await expect(page.getByTestId('day-2026-11-12')).toHaveAttribute('data-day-type', 'working');
  await context.close();
});

// ------------------------------------------------------------------ 2. staff
test('2. Admin creates staff groups, staff and teaching assignments (class teacher + subject)', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAdmin(browser);

  await page.goto('/staff/groups');
  await settled(page.getByRole('table'), page.getByText('No staff groups yet'));
  for (const g of GROUPS) {
    const row = page.getByTestId(`group-row-${g.name}`);
    if (!(await row.isVisible())) {
      await page.getByRole('button', { name: 'New staff group' }).click();
      const dlg = modal(page);
      await dlg.getByLabel('Name').fill(g.name);
      await dlg.getByLabel('Default monthly salary').fill(g.salary);
      await dlg.getByRole('button', { name: 'Save' }).click();
      await expect(row).toBeVisible();
    }
  }
  // Admin (staff_finance.read) sees the confidential salary column.
  await expect(page.getByTestId('group-row-Teaching staff').getByTestId('group-salary')).toContainText('₹');

  for (const s of STAFF) {
    await page.goto('/staff');
    await settled(page.getByRole('table'), page.getByText('No staff found'));
    if (await page.getByTestId(`staff-row-${s.no}`).isVisible()) continue;
    await page.getByRole('button', { name: 'New staff member' }).click();
    const dlg = modal(page);
    await dlg.getByLabel('Full name').fill(s.name);
    await dlg.getByLabel('Employee number').fill(s.no);
    await choose(dlg, 'Staff group', s.group);
    await dlg.getByLabel('Designation').fill(s.designation);
    await dlg.getByLabel('Joined on').fill('2026-04-01');
    if (s.teaching) await dlg.getByRole('checkbox', { name: /Teaching staff/ }).click();
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('staff-name')).toHaveText(s.name);
  }

  const assignments = [
    { staff: STAFF[0]!, section: 'Class 1 A', duty: 'Class teacher', text: 'Class 1 A · Class teacher' },
    {
      staff: STAFF[1]!,
      section: 'Class 1 A',
      duty: 'Subject teacher',
      subject: 'Mathematics',
      text: 'Class 1 A · Mathematics',
    },
  ];
  for (const a of assignments) {
    await page.goto('/staff');
    await page.getByTestId(`staff-row-${a.staff.no}`).getByRole('link').click();
    await expect(page.getByTestId('staff-name')).toHaveText(a.staff.name);
    const teaches = page
      .locator('[data-slot="card"]')
      .filter({ has: page.getByText('Teaches', { exact: true }) });
    await settled(
      teaches.getByText('No current assignments'),
      teaches.getByText(a.text),
      teaches.getByText(/ · /),
    );
    if (!(await teaches.getByText(a.text).isVisible())) {
      await teaches.getByRole('button', { name: 'Add' }).click();
      const dlg = modal(page);
      await choose(dlg, 'Section', a.section);
      await choose(dlg, 'Duty', a.duty);
      if (a.subject) await choose(dlg, 'Subject', a.subject);
      await dlg.getByLabel('Starts on').fill(YEAR.from);
      await dlg.getByRole('button', { name: 'Add' }).click();
      await expect(page.getByText('Teaching assignment added.')).toBeVisible();
    }
    await expect(teaches.getByText(a.text)).toBeVisible();
    // Admin sees the confidential finance card on the profile.
    await expect(page.getByTestId('staff-finance-card')).toBeVisible();
  }

  // By section: the class teacher of Class 1 A
  await page.goto('/staff/teaching');
  await choose(page, 'Section (current year)', 'Class 1 A');
  await expect(page.getByTestId('class-teacher')).toContainText('Ravi Kumar');
  await expect(page.getByText('Meera Rao · Mathematics')).toBeVisible();
  await context.close();
});

// ------------------------------------------------------------------ 3. teacher login
test('3. Admin provisions demo.teacher: temp password shown once; the teacher must change it', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const admin = await asAdmin(browser);
  const temp = await issueLogin(admin.page, {
    username: 'demo.teacher',
    name: 'Ravi Kumar',
    role: 'Teacher',
    staff: 'Ravi Kumar (DEMO-T1)',
  });
  await expect(admin.page.getByTestId('user-demo.teacher')).toContainText(
    'Must change password at next sign-in',
  );

  const t = await newPage(browser, PHONE);
  await signIn(t.page, 'demo.teacher', temp);
  await expect(t.page).toHaveURL(/\/change-password$/);
  for (const path of ['/dashboard', '/staff', '/choose']) {
    await t.page.goto(path);
    await expect(t.page).toHaveURL(/\/change-password$/);
  }
  pw.teacher = await changePassword(t.page, temp);
  await expect(t.page.getByTestId('dashboard-teacher')).toBeVisible();
  await expect(t.page.getByTestId('context-summary')).toContainText('Teacher');
  await t.context.close();

  // The staff record now shows the linked login (admin view).
  await admin.page.goto('/staff');
  await admin.page.getByTestId('staff-row-DEMO-T1').getByRole('link').click();
  await expect(admin.page.getByTestId('linked-login')).toContainText('demo.teacher');
  await admin.context.close();
});

// ------------------------------------------------------------------ 4. admissions
test('4. Enquiry → follow-up → admit → the student profile shows the guardian', async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await asAdmin(browser);
  const parent = `E2E Parent ${RUN}`;
  const child = `E2E Child ${RUN}`;
  const phone = `98${String(Date.now()).slice(-8)}`;

  await page.goto('/admissions');
  await page.getByRole('button', { name: 'New enquiry' }).click();
  const dlg = modal(page);
  await dlg.getByLabel('Parent’s name').fill(parent);
  await dlg.getByLabel('Mobile', { exact: true }).fill(phone);
  await dlg.getByLabel('Child’s name').fill(child);
  await dlg.getByLabel('Child’s date of birth').fill('2020-05-10');
  await choose(dlg, 'Class wanted', 'Class 1');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/admissions\/[0-9a-f-]{36}$/);
  runLeadId = page.url().split('/').pop()!;
  await expect(page.getByTestId('lead-title')).toHaveText(`${parent} — ${child}`);
  await expect(page.getByTestId('lead-stage')).toHaveText('New');

  const form = page.getByRole('form', { name: 'Log a follow-up' });
  await form.getByLabel('Note').fill('Called; family will visit on Saturday.');
  await form.getByRole('button', { name: 'Log follow-up' }).click();
  await expect(page.getByTestId('followups')).toContainText('Spoke to them');
  await expect(page.getByTestId('lead-stage')).toHaveText('Contacted');

  await page.getByRole('link', { name: 'Admit' }).click();
  await expect(page.getByRole('heading', { name: 'Admit a student' })).toBeVisible();
  await expect(page.getByLabel('Full name').first()).toHaveValue(child); // prefilled from the enquiry
  await page.getByLabel('Admission number').fill(`E2E-${RUN}`);
  await expect(page.getByRole('combobox', { name: 'Class and section' })).toHaveText('Class 1 A');
  await choose(page, 'Gender', 'Female');
  await expect(page.getByTestId('admit-guardian-0').getByLabel('Full name')).toHaveValue(parent);
  await page.getByRole('button', { name: 'Admit student' }).click();

  await expect(page).toHaveURL(/\/students\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('student-name')).toHaveText(child);
  await expect(page.getByTestId('guardians')).toContainText(parent);
  await expect(page.getByTestId('guardians')).toContainText('Primary');
  await expect(page.getByTestId('placements')).toContainText('Class 1 A');

  await page.goto(`/admissions/${runLeadId}`);
  await expect(page.getByTestId('lead-stage')).toHaveText('Admitted');
  await expect(page.getByRole('link', { name: 'Open student' })).toBeVisible();

  // Base demo data: at least three enquiries in total.
  for (const extra of ['Demo Enquiry Two', 'Demo Enquiry Three']) {
    await page.goto('/admissions');
    await page.getByLabel('Search').fill(extra);
    const list = page.getByRole('list', { name: 'Enquiries' });
    await settled(list, page.getByText('No enquiries'));
    if (await list.getByText(extra).isVisible()) continue;
    await page.getByRole('button', { name: 'New enquiry' }).click();
    const d = modal(page);
    await d.getByLabel('Parent’s name').fill(extra);
    await d.getByLabel('Mobile', { exact: true }).fill(extra.endsWith('Two') ? '9000000201' : '9000000202');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('lead-title')).toHaveText(extra);
  }
  await context.close();
});

// ------------------------------------------------------------------ base students (siblings share a guardian)
test('4b. Demo students admitted through the UI; siblings share one guardian record', async ({ browser }) => {
  test.setTimeout(400_000);
  const { context, page } = await asAdmin(browser);
  for (const s of STUDENTS) {
    if (await studentIdFor(page, s.adm)) continue;
    await page.goto('/admissions/admit');
    await expect(page.getByRole('heading', { name: 'Admit a student' })).toBeVisible();
    await page.getByLabel('Admission number').fill(s.adm);
    await choose(page, 'Class and section', s.section);
    await page.getByLabel('Full name').first().fill(s.name);
    await choose(page, 'Gender', s.gender);
    await page.getByLabel('Date of birth').fill(s.dob);
    if (s.guardian.existing) {
      await page.getByLabel('Add an existing parent / guardian').fill(s.guardian.name);
      await page.getByTestId(`guardian-result-${s.guardian.name}`).click();
      await expect(page.getByTestId('admit-guardian-0')).toContainText(`${s.guardian.name} (existing)`);
    } else {
      await page.getByRole('button', { name: 'Add a new parent / guardian' }).click();
      const g = page.getByTestId('admit-guardian-0');
      await g.getByLabel('Full name').fill(s.guardian.name);
      await g.getByLabel('Mobile').fill(s.guardian.phone!);
    }
    await page.getByRole('button', { name: 'Admit student' }).click();
    await expect(page.getByTestId('student-name')).toHaveText(s.name);
    await expect(page.getByTestId('guardians')).toContainText(s.guardian.name);
  }
  // Siblings: the guardian record lists both children.
  await page.goto(`/students/${await studentIdFor(page, 'DEMO-S2')}`);
  await page.getByTestId('guardians').getByRole('button', { name: 'Details' }).click();
  await expect(modal(page)).toContainText(/Linked to: .*Aarav Sharma/);
  await expect(modal(page)).toContainText('Anaya Sharma');
  await context.close();
});

// ------------------------------------------------------------------ 5. second role
test('5. find_school_account + grant a second role (demo.teachparent: Teacher + Parent)', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAdmin(browser);
  await openUsers(page);
  if (!(await page.getByTestId('user-demo.teachparent').isVisible())) {
    await issueLogin(page, {
      username: 'demo.teachparent',
      name: 'Meera Rao',
      role: 'Teacher',
      staff: 'Meera Rao (DEMO-T2)',
    });
  }
  const card = page.getByTestId('user-demo.teachparent');
  // Re-run: take the Parent role away first so granting it is exercised again.
  if (await card.getByText('Parent', { exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Actions for demo.teachparent' }).click();
    await page.getByRole('menuitem', { name: 'Disable Parent role here' }).click();
    await modal(page).getByLabel('Reason (required)').fill('E2E re-run: grant again via find');
    await modal(page).getByRole('button', { name: 'Disable role' }).click();
    await expect(card.getByText('Parent — disabled')).toBeVisible();
  }

  await page.getByRole('button', { name: 'Add role to existing login' }).click();
  const dlg = modal(page);
  await dlg.getByLabel('Username').fill('demo.no-such-login-e2e');
  await dlg.getByRole('button', { name: 'Find' }).click();
  await expect(dlg.getByTestId('account-not-found')).toBeVisible();
  await dlg.getByLabel('Username').fill('demo.teachparent');
  await dlg.getByRole('button', { name: 'Find' }).click();
  await expect(dlg.getByTestId('account-found')).toContainText('demo.teachparent');
  await expect(dlg.getByTestId('account-found')).toContainText('Teacher');
  await dlg.getByRole('combobox', { name: 'Role to add' }).click();
  await page.getByRole('option', { name: /^Parent/ }).click();
  await dlg.getByRole('button', { name: 'Add role' }).click();
  await expect(page.getByText('Parent role added for demo.teachparent.')).toBeVisible();
  await expect(card.getByText('Parent', { exact: true })).toBeVisible();
  await expect(card.getByText('Teacher', { exact: true })).toBeVisible();

  // Link the login to Kabir's guardian record so the child appears for the Parent role.
  await page.goto(`/students/${await studentIdFor(page, 'DEMO-S3')}`);
  await page.getByTestId('guardians').getByRole('button', { name: 'Details' }).click();
  const g = modal(page);
  const linked = g.getByTestId('linked-login');
  await settled(linked, g.getByText('No login linked.'));
  if (!(await linked.isVisible()) || !(await linked.textContent())?.includes('demo.teachparent')) {
    await g.getByRole('combobox', { name: /Link a/ }).click();
    await page.getByRole('option', { name: 'Meera Rao (demo.teachparent)' }).click();
    await g.getByRole('button', { name: 'Link', exact: true }).click();
  }
  await expect(linked).toContainText('demo.teachparent');
  await context.close();
});

// ------------------------------------------------------------------ 6. AC-02
test('6. AC-02: a parent with two children picks a child, switches, and the old context cache is cleared', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const admin = await asAdmin(browser);
  await openUsers(admin.page);
  if (!(await admin.page.getByTestId('user-demo.parent').isVisible())) {
    await issueLogin(admin.page, {
      username: 'demo.parent',
      name: 'Priya Sharma',
      role: 'Parent',
      guardian: 'Priya Sharma',
    });
  }
  await admin.context.close();
  pw.parent = await setKnownPassword(op, 'demo.parent');

  const { context, page } = await newPage(browser, PHONE);
  await signIn(page, 'demo.parent', pw.parent);
  await expect(page).toHaveURL(/\/choose$/);
  const aarav = page.getByRole('button', { name: /Aarav Sharma/ });
  const anaya = page.getByRole('button', { name: /Anaya Sharma/ });
  await expect(aarav).toBeVisible();
  await expect(anaya).toBeVisible();
  await page.screenshot({ path: `${SCREENS}/375-chooser-parent-two-children.png`, fullPage: true });

  await aarav.click();
  await expect(page.getByTestId('dashboard-parent')).toBeVisible();
  await expect(page.getByTestId('context-summary')).toContainText('Aarav Sharma');
  const rev1 = await revisionOf(page);

  await page.getByTestId('switch-context').click();
  await expect(page).toHaveURL(/\/choose$/);
  await expect(aarav).toContainText('Current');
  await anaya.click();
  await expect(page.getByTestId('context-summary')).toContainText('Anaya Sharma');
  await expect(page.getByTestId('context-summary')).not.toContainText('Aarav Sharma');
  const rev2 = await revisionOf(page);
  expect(rev2).not.toBe(rev1);
  expect(await cachedRevisions(page)).not.toContain(rev1);
  await context.close();
});

// ------------------------------------------------------------------ 7. AC-03
test('7. AC-03: one login, Teacher and Parent; switching clears the Teacher cache and menus', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  pw.teachparent = await setKnownPassword(op, 'demo.teachparent');
  const { context, page } = await newPage(browser);
  await signIn(page, 'demo.teachparent', pw.teachparent);
  await expect(page).toHaveURL(/\/choose$/);
  await expect(page.getByTestId('context-teacher')).toBeVisible();
  await expect(page.getByRole('button', { name: /Kabir Rao/ })).toBeVisible();

  await page.getByTestId('context-teacher').click();
  await expect(page.getByTestId('dashboard-teacher')).toBeVisible();
  await expect(page.getByRole('link', { name: 'School calendar' }).first()).toBeVisible();
  // Teacher-only screen: the school calendar (staff.member) — puts Teacher queries in the cache.
  await page.goto('/setup/calendar');
  await expect(page.getByTestId('calendar-totals')).toBeVisible({ timeout: 30_000 });
  const revT = await revisionOf(page);
  expect(await cachedRevisions(page)).toContain(revT);

  await page.getByTestId('switch-context').click();
  await page.getByRole('button', { name: /Kabir Rao/ }).click();
  await expect(page.getByTestId('dashboard-parent')).toBeVisible();
  const summary = page.getByTestId('context-summary');
  await expect(summary).toContainText('Parent');
  await expect(summary).toContainText('Kabir Rao');
  const revP = await revisionOf(page);
  expect(revP).not.toBe(revT);
  expect(await cachedRevisions(page)).not.toContain(revT);
  // Teacher menus are gone for the Parent role.
  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: 'School calendar' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Staff' })).toHaveCount(0);
  await context.close();
});

// ------------------------------------------------------------------ 8. no finance
test('8. A role without staff_finance (Teacher) never sees salary fields — UI and server', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  expect(pw.teacher, 'test 3 sets the teacher password').toBeTruthy();
  const mark = seen.length;
  const { context, page } = await newPage(browser);
  await signIn(page, 'demo.teacher', pw.teacher!);
  await expect(page.getByTestId('dashboard-teacher')).toBeVisible();

  const groupsResponse = page.waitForResponse((r) => r.url().endsWith('/rest/v1/rpc/list_staff_groups'));
  await page.goto('/staff/groups');
  const groups = (await (await groupsResponse).json()) as { default_monthly_salary_paise: number | null }[];
  await expect(page.getByTestId('group-row-Teaching staff')).toBeVisible();
  await expect(page.getByTestId('group-salary')).toHaveCount(0);
  await expect(page.getByText('Default monthly salary')).toHaveCount(0);
  // The server does not send salary to this role either.
  expect(groups.length).toBeGreaterThan(0);
  for (const g of groups) expect(g.default_monthly_salary_paise ?? null).toBeNull();

  await page.goto('/staff');
  await page.getByTestId('staff-row-DEMO-T1').getByRole('link').click();
  await expect(page.getByTestId('staff-name')).toHaveText('Ravi Kumar');
  await expect(page.getByTestId('staff-finance-card')).toHaveCount(0);
  await expect(page.getByText(/salary/i)).toHaveCount(0);
  // The confidential read was never even attempted from this role.
  expect(seen.slice(mark).some((s) => s.url.endsWith('/rpc/get_staff_confidential'))).toBe(false);
  await context.close();
});

// ------------------------------------------------------------------ two tabs → CONFLICT
test('9. Editing the same student in two tabs: the second save gets CONFLICT and reloads', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page: tabA } = await asAdmin(browser);
  const id = await studentIdFor(tabA, 'DEMO-S4');
  expect(id).toBeTruthy();
  await tabA.goto(`/students/${id}`);
  await expect(tabA.getByTestId('student-name')).toHaveText('Ishaan Verma');

  const tabB = await context.newPage();
  watch(tabB);
  await tabB.goto(`/students/${id}`);
  await expect(tabB.getByTestId('student-name')).toHaveText('Ishaan Verma');
  // B opens the edit form on the version it loaded and starts typing.
  await tabB.getByRole('button', { name: 'Edit' }).click();
  await modal(tabB).getByLabel('Mother tongue').fill(`Tamil ${RUN}`);

  // Meanwhile A saves a change to the same record.
  await tabA.bringToFront();
  await tabA.getByRole('button', { name: 'Edit' }).click();
  await modal(tabA).getByLabel('Mother tongue').fill(`Telugu ${RUN}`);
  await modal(tabA).getByRole('button', { name: 'Save' }).click();
  await expect(tabA.getByText('Student record saved.')).toBeVisible();
  await expect(tabA.getByText(`Telugu ${RUN}`)).toBeVisible();

  // B saves on the old version → CONFLICT → reload shows A's value; B's change is not applied.
  await tabB.bringToFront();
  const conflict = tabB.waitForResponse(
    (r) => r.url().endsWith('/rest/v1/rpc/update_student') && r.status() >= 400,
  );
  await modal(tabB).getByRole('button', { name: 'Save' }).click();
  // The warning toast is short-lived: check it before reading the response body.
  await expect(
    tabB.locator('[data-sonner-toast]').filter({ hasText: 'Someone else changed this record' }),
  ).toBeVisible();
  expect(((await (await conflict).json()) as { hint?: string }).hint).toBe('CONFLICT');
  await expect(modal(tabB)).toBeHidden();
  await expect(tabB.getByText(`Telugu ${RUN}`)).toBeVisible();
  await expect(tabB.getByText(`Tamil ${RUN}`)).toHaveCount(0);
  await context.close();
});

// ------------------------------------------------------------------ 375px screenshots
test('10. 375px screenshots: student directory, student profile, calendar list, enquiry detail, users', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await asAdmin(browser, PHONE);
  const shot = (name: string) => page.screenshot({ path: `${SCREENS}/375-${name}.png`, fullPage: true });
  const noHorizontalScroll = async () =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await page.goto('/students');
  await expect(page.getByTestId('student-DEMO-S1')).toBeVisible({ timeout: 30_000 });
  await noHorizontalScroll();
  await shot('student-directory');

  await page.getByTestId('student-DEMO-S1').getByRole('link').first().click();
  await expect(page.getByTestId('guardians')).toBeVisible();
  await noHorizontalScroll();
  await shot('student-profile');

  await page.goto('/setup/calendar');
  await expect(page.getByTestId('calendar-totals')).toBeVisible({ timeout: 30_000 });
  const heading = page.getByText('November 2026');
  while (!(await heading.isVisible())) await page.getByRole('button', { name: 'Next month' }).click();
  await expect(page.getByTestId('list-day-2026-11-09')).toBeVisible(); // list view on phones
  await expect(page.getByTestId('day-2026-11-09')).toBeHidden(); // grid hidden below sm
  await noHorizontalScroll();
  await shot('calendar-list');

  expect(runLeadId, 'test 4 creates the enquiry').not.toBe('');
  await page.goto(`/admissions/${runLeadId}`);
  await expect(page.getByTestId('followups')).toBeVisible();
  await noHorizontalScroll();
  await shot('enquiry-detail');

  await openUsers(page);
  await expect(page.getByTestId('user-demo.teacher')).toBeVisible();
  await noHorizontalScroll();
  await shot('users');
  await context.close();
});

// ------------------------------------------------------------------ network audit
test('11. Network audit: RPC only, p_ctx_rev on every school RPC, nothing else contacted', async () => {
  expect(seen.length).toBeGreaterThan(50);
  const rest = seen.filter((s) => s.url.includes('/rest/v1/'));
  for (const s of rest) expect(s.url).toMatch(/\/rest\/v1\/rpc\/[a-z_0-9]+(\?|$)/);
  const contextFree = new Set([
    'bootstrap_account',
    'select_context',
    'end_app_session',
    'get_context',
    'record_telemetry',
  ]);
  const school = rest.filter((s) => {
    const fn = /\/rpc\/([a-z_0-9]+)/.exec(s.url)![1]!;
    return !contextFree.has(fn) && !fn.startsWith('op_');
  });
  expect(school.length).toBeGreaterThan(20);
  for (const s of school) expect(JSON.parse(s.body ?? '{}'), s.url).toHaveProperty('p_ctx_rev');
  for (const s of seen) expect(s.url).toMatch(/\/(auth\/v1|rest\/v1\/rpc|functions\/v1\/accounts)\b/);
  // Temporary passwords are never put in a URL.
  for (const s of seen) expect(s.url).not.toMatch(/password=|temporary/i);
});
