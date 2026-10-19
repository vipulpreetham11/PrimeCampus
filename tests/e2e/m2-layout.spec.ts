import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

// 375px roster layout (M2 owner review): name, reference and state on the left, the choice buttons
// on the RIGHT of the same line, buttons ≥ 44px, ≤ 72px per row (M2X), the admission number readable
// in full without hover, no sideways page scroll.
//
// Runs WITHOUT the live backend: every Supabase request is answered here (a fake Auth session and
// fixed RPC replies) and anything unexpected is aborted, so nothing reaches the real project. It
// checks layout only — the live flows are in m2.spec.ts. Set M2_LAYOUT_SHOTS=1 to also write the
// 375px roster screenshots into docs/reports/m2-screens/.

const SHOTS = process.env.M2_LAYOUT_SHOTS === '1';
const SCREENS = 'docs/reports/m2-screens';
const PHONE = { width: 375, height: 812 };
const MAX_ROW = 72;

const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACCOUNT = uuid('11111111', 1);
const SCHOOL = uuid('22222222', 1);
const MEMBERSHIP = uuid('33333333', 1);
const YEAR = uuid('77777777', 1);
const CLASS1 = uuid('c1c1c1c1', 1);
const SECTION_A = uuid('a1a1a1a1', 1);
const MATHS = uuid('5a5a5a5a', 1);
const SCHEDULE = uuid('5c5c5c5c', 1);
const HOMEWORK = uuid('40404040', 1);
const GROUP_TEACHING = uuid('96969696', 1);
const GROUP_OFFICE = uuid('96969696', 2);
const DATE = '2026-10-17';

const CAPS = [
  'staff.member',
  'students.read_all',
  'timetable.read_all',
  'timetable.manage',
  'attendance.read_all',
  'attendance.mark_any',
  'attendance.summary',
  'academic.read_all',
  'academic.correct',
  'staff.read',
  'staff_attendance.read',
  'staff_attendance.manage',
];

// 40 students; a few long names to check truncation
const FIRST = ['Aarav', 'Bela', 'Chetan', 'Divya', 'Eshan', 'Farah', 'Gautam', 'Harini', 'Ishaan', 'Jaya'];
const LAST = ['Sharma', 'Nair', 'Das', 'Reddy', 'Iyer', 'Khan', 'Patel', 'Menon'];
const STUDENTS = Array.from({ length: 40 }, (_, i) => ({
  student_id: uuid('57d57d57', i + 1),
  roll_no: String(i + 1),
  name:
    i === 4
      ? 'Venkata Sai Lakshmi Narasimha Rao'
      : `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`,
  // live run-suffixed numbers are this long ("DEMO-S…" was all a phone showed before M2X)
  admission_no: i === 7 ? 'DEMO/2026-27/ADM/000008' : `DEMO-IMP-${String(i + 1).padStart(4, '0')}`,
}));

const day = { academic_year_id: YEAR, day_type: 'working', weight: 1, period_schedule_id: null, label: null };

function rpcReply(fn: string): unknown {
  switch (fn) {
    case 'bootstrap_account':
      return {
        account_id: ACCOUNT,
        username: 'demo.admin',
        display_name: 'Demo Admin',
        must_change_password: false,
        is_operator: false,
        new_session: false,
        contexts: [
          { membership_id: MEMBERSHIP, school_id: SCHOOL, school_name: 'Demo School', role: 'admin' },
        ],
        selected: {
          membership_id: MEMBERSHIP,
          operator_school_id: null,
          student_id: null,
          context_revision: 1,
        },
      };
    case 'get_context':
      return {
        school_id: SCHOOL,
        school_name: 'Demo School',
        role: 'admin',
        via_operator: false,
        student_id: null,
        staff_id: null,
        context_revision: 1,
        current_year: { id: YEAR, name: '2026-27', start_date: '2026-04-01', end_date: '2027-03-31' },
        capabilities: CAPS,
      };
    case 'get_setup_snapshot':
      return {
        academic_years: [
          {
            id: YEAR,
            name: '2026-27',
            start_date: '2026-04-01',
            end_date: '2027-03-31',
            is_current: true,
            status: 'active',
            version: 1,
          },
        ],
        selected_year_id: YEAR,
        classes: [{ id: CLASS1, name: 'Class 1', sort_order: 1, status: 'active', version: 1 }],
        sections: [
          {
            id: SECTION_A,
            academic_year_id: YEAR,
            class_id: CLASS1,
            name: 'A',
            capacity: 40,
            sort_order: 1,
            status: 'active',
            version: 1,
          },
        ],
        subjects: [{ id: MATHS, name: 'Mathematics', code: 'MATH', status: 'active', version: 1 }],
        period_schedules: [
          {
            id: SCHEDULE,
            name: 'Regular day',
            kind: 'regular',
            effective_from: '2026-04-01',
            effective_to: null,
            slots: [],
          },
        ],
        attendance_mode_today: 'daily',
        attendance_modes: [],
      };
    case 'get_marking_roster':
      return {
        section_id: SECTION_A,
        date: DATE,
        lesson_session_id: null,
        mode_on_date: 'daily',
        lesson_status: null,
        can_mark: true,
        day,
        students: STUDENTS.map((s, i) => ({
          ...s,
          // the first 10 are saved, the rest unmarked
          status: i < 10 ? (i === 3 ? 'A' : i === 6 ? 'H' : 'P') : null,
          version: i < 10 ? 1 : null,
        })),
      };
    case 'list_staff_groups':
      return [
        {
          id: GROUP_TEACHING,
          name: 'Teaching',
          status: 'active',
          version: 1,
          staff_count: 10,
          default_monthly_salary_paise: null,
        },
        {
          id: GROUP_OFFICE,
          name: 'Office',
          status: 'active',
          version: 1,
          staff_count: 2,
          default_monthly_salary_paise: null,
        },
      ];
    case 'get_staff_attendance':
      return {
        date: DATE,
        can_mark: true,
        is_future: false,
        staff: Array.from({ length: 12 }, (_, i) => ({
          staff_id: uuid('57a57a57', i + 1),
          employee_no: `T${String(i + 1).padStart(3, '0')}`,
          name:
            i === 2 ? 'Subramanya Venkatachalapathy' : `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`,
          staff_group_id: i < 10 ? GROUP_TEACHING : GROUP_OFFICE,
          group: i < 10 ? 'Teaching' : 'Office',
          is_teaching: i < 10,
          day: { day_type: 'working', weight: 1, label: null },
          status: i < 4 ? 'P' : null,
          version: i < 4 ? 1 : null,
          paid_leave: i === 5 ? 1 : null,
        })),
      };
    case 'get_homework_roster':
      return {
        can_check: true,
        assignment: {
          id: HOMEWORK,
          academic_year_id: YEAR,
          section_id: SECTION_A,
          subject_id: MATHS,
          lesson_session_id: 501,
          assigned_by_staff: null,
          assigned_on: '2026-10-16',
          due_on: DATE,
          description: 'Exercise 3.1, questions 1–5',
          status: 'active',
          version: 1,
          created_by: ACCOUNT,
          created_at: '2026-10-16T10:00:00+05:30',
          updated_at: '2026-10-16T10:00:00+05:30',
        },
        students: STUDENTS.map((s, i) => ({
          student_id: s.student_id,
          roll_no: s.roll_no,
          name: s.name,
          state: i < 3 ? (i === 2 ? 'not_completed' : 'completed') : 'unchecked',
          correction: i === 0 ? 'required' : i < 3 ? 'none' : null,
          observed_on: i < 3 ? DATE : null,
          completed_on: null,
          comment: null,
          version: i < 3 ? 1 : null,
        })),
      };
    case 'record_telemetry':
    case 'end_app_session':
      return { ok: true };
    default:
      return undefined;
  }
}

/** A fake, unexpired Auth session for the client to resume (no password, no real token). */
function fakeSession() {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = {
    id: ACCOUNT,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'demo.admin@layout.test',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-10-01T00:00:00Z',
  };
  return {
    access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ACCOUNT, exp, role: 'authenticated' })}.layout`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: exp,
    refresh_token: 'layout-test',
    user,
  };
}

async function openMocked(page: Page, path: string) {
  const unexpected: string[] = [];
  await page.route(/supabase\.co\//, async (route: Route) => {
    const url = new URL(route.request().url());
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (rpc) {
      const body = rpcReply(rpc[1]!);
      if (body !== undefined) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }
    }
    if (url.pathname.endsWith('/auth/v1/user')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fakeSession().user),
      });
    }
    unexpected.push(url.pathname);
    return route.abort();
  });
  const session = fakeSession();
  await page.addInitScript(
    (s) => window.localStorage.setItem('primecampus-auth', JSON.stringify(s)),
    session,
  );
  await page.goto(path);
  await expect(page.getByText('Demo School').first()).toBeVisible();
  return unexpected;
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

/**
 * Each row: ≤ 72px; the choice buttons sit to the right of the name, on the name's line; ≥ 44px; the
 * reference (admission / employee number) is shown in full — not cut off, not hidden behind a tooltip.
 */
async function checkCompactRows(rows: Locator, { maxHeight = MAX_ROW, skip = new Set<number>() } = {}) {
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);
  const heights: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const row = rows.nth(i);
    const name = row.locator('p').first();
    const group = row.getByRole('radiogroup').first();
    const [r, nb, gb] = await Promise.all([row.boundingBox(), name.boundingBox(), group.boundingBox()]);
    if (!r || !nb || !gb) throw new Error(`row ${i} not laid out`);
    if (!skip.has(i)) {
      heights.push(r.height);
      expect(r.height, `row ${i} height`).toBeLessThanOrEqual(maxHeight);
    }
    expect(gb.x, `row ${i}: buttons to the right of the name`).toBeGreaterThanOrEqual(nb.x + nb.width - 1);
    expect(gb.y, `row ${i}: buttons on the name's line`).toBeLessThan(nb.y + nb.height);
    expect(gb.x + gb.width, `row ${i}: buttons inside the row`).toBeLessThanOrEqual(r.x + r.width + 1);
    const ref = row.getByTestId('row-reference');
    if ((await ref.count()) > 0) {
      const cut = await ref.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === 'ellipsis',
      );
      expect(cut, `row ${i}: reference shown in full`).toBe(false);
      const refBox = await ref.boundingBox();
      expect(refBox!.x + refBox!.width, `row ${i}: reference inside the row`).toBeLessThanOrEqual(
        r.x + r.width + 1,
      );
    }
    for (const b of await group.getByRole('radio').all()) {
      const bb = await b.boundingBox();
      expect(bb!.height).toBeGreaterThanOrEqual(44);
      expect(bb!.width).toBeGreaterThanOrEqual(44);
    }
  }
  // measured heights, for the module report
  test.info().annotations.push({
    type: 'row heights',
    description: `min ${Math.min(...heights)}px, max ${Math.max(...heights)}px over ${heights.length} rows`,
  });
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page
    .locator('[data-sonner-toaster]')
    .evaluateAll((els) => els.forEach((e) => ((e as HTMLElement).style.display = 'none')));
  await page.screenshot({ path: `${SCREENS}/${name}.png`, fullPage: true });
}

test.use({ viewport: PHONE, trace: 'off', screenshot: 'off', video: 'off' });

test('375px: student day register rows are compact, buttons on the right', async ({ page }) => {
  const unexpected = await openMocked(page, `/attendance/daily/${SECTION_A}/${DATE}`);
  await expect(page.getByTestId('marking-roster')).toBeVisible();
  const rows = page.getByTestId('roster-row');
  await expect(rows).toHaveCount(40);
  // a few unsaved changes, as a teacher would have mid-register
  await page.getByRole('button', { name: /^Mark remaining \d+ present$/ }).click();
  await rows.nth(12).getByRole('radio', { name: 'Absent' }).click();
  await rows.nth(15).getByRole('radio', { name: 'Half day' }).click();
  await expect(rows.nth(12)).toHaveAttribute('data-state', 'changed');
  // the state stays in words next to the admission number
  await expect(rows.nth(12).getByText('Not saved')).toBeVisible();
  await expect(rows.nth(0).getByText('Saved', { exact: true })).toBeVisible();
  await expect(rows.nth(7).getByTestId('row-reference')).toContainText('DEMO/2026-27/ADM/000008');
  await expect(rows.nth(12).getByTestId('row-reference')).toContainText('DEMO-IMP-0013');

  // row 7 has a 23-character admission number: it needs two lines of its own (known limit, M2X
  // report); still shown in full, the row may be up to 88px. Every other row stays within 72px.
  await checkCompactRows(rows, { skip: new Set([7]) });
  expect((await rows.nth(7).boundingBox())!.height).toBeLessThanOrEqual(88);
  await noHorizontalScroll(page);
  const list = await page.getByTestId('roster-rows').boundingBox();
  // 40 students in well under 40 × 72px
  expect(list!.height).toBeLessThanOrEqual(40 * MAX_ROW + 40);
  await shot(page, '375-marking-roster');
  expect(unexpected).toEqual([]);
});

test('375px: staff register rows are compact; paid leave adds a line only for that person', async ({
  page,
}) => {
  const unexpected = await openMocked(page, `/staff-attendance?date=${DATE}`);
  const rows = page.getByTestId('staff-row');
  await expect(rows).toHaveCount(12);
  await expect(rows.nth(5).getByText('Paid leave')).toBeVisible();
  await checkCompactRows(rows, { skip: new Set([5]) });
  await noHorizontalScroll(page);
  expect(unexpected).toEqual([]);
});

test('375px: homework roster keeps Completed / Not completed on the name row', async ({ page }) => {
  const unexpected = await openMocked(page, `/homework/${HOMEWORK}`);
  await expect(page.getByTestId('homework-roster')).toBeVisible();
  const rows = page.getByTestId('check-row');
  await expect(rows).toHaveCount(40);
  await rows.nth(3).getByRole('radio', { name: 'Completed', exact: true }).click();
  // checked rows add the correction / comment line below; unchecked rows stay one line
  const checked = new Set([0, 1, 2, 3]);
  await checkCompactRows(rows, { skip: checked });
  await expect(rows.nth(10).getByText('Unchecked')).toBeVisible();
  await noHorizontalScroll(page);
  await shot(page, '375-homework-roster');
  expect(unexpected).toEqual([]);
});
