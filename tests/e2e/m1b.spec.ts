import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { expect, test, type Browser, type Page, type Request } from '@playwright/test';
import { ApiSession, operatorSession, setKnownPassword } from './helpers/api';

// M1b (spreadsheet imports) against the LIVE backend, Demo School (code `demo`) only; every login
// is `demo.*`. Files are built in memory here and uploaded through the UI; every school record is
// created by the import itself. The API helper only gives demo logins a known password for this run
// and makes the Teacher's direct FORBIDDEN call. Passwords exist only in memory and are never printed.
//
// Re-runnable: names, admission/employee numbers, roll numbers and mobiles carry a run suffix, so
// each run really creates its records. The second academic year (2027-28) and its Class 1 A section
// are created once and reused.

const OPERATOR = process.env.E2E_OPERATOR_USERNAME ?? '';
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? '';
const SCREENS = 'docs/reports/m1b-screens';
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const DIGITS = String(Date.now()).slice(-8); // for unique mobiles
const PHONE = { width: 375, height: 812 };
const NEXT_YEAR = { name: '2027-28', from: '2027-04-01', to: '2028-03-31' };

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.skip(!OPERATOR || !OPERATOR_PASSWORD, 'E2E_OPERATOR_USERNAME / E2E_OPERATOR_PASSWORD not set');

const pw: Record<string, string> = {};
let op: ApiSession;

test.beforeAll(async () => {
  op = await operatorSession();
  pw.admin = await setKnownPassword(op, 'demo.admin');
  pw.teacher = await setKnownPassword(op, 'demo.teacher');
});
test.afterAll(async () => {
  await op?.signOut();
});

// ------------------------------------------------------------------ network audit
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
async function asUser(
  browser: Browser,
  username: string,
  password: string,
  viewport = { width: 1280, height: 900 },
) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  watch(page);
  await page.goto('/sign-in');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  return { context, page };
}

async function asAdmin(browser: Browser, viewport?: { width: number; height: number }) {
  const s = await asUser(browser, 'demo.admin', pw.admin!, viewport);
  await expect(s.page.getByTestId('dashboard-admin')).toBeVisible();
  return s;
}

const modal = (page: Page) => page.locator('[role="dialog"], [role="alertdialog"]').last();

async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

interface Upload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}
const csv = (name: string, lines: string[]): Upload => ({
  name,
  mimeType: 'text/csv',
  buffer: Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'),
});

async function xlsx(name: string, rows: unknown[][]): Promise<Upload> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Students');
  for (const r of rows) ws.addRow(r);
  return {
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
  };
}

const DATASET_RADIO: Record<string, RegExp> = {
  classes: /^Classes & sections/,
  staff: /^Staff/,
  students: /^Students & parents/,
  placements: /^Placements/,
};

/** Wizard steps 1–5; returns the job id once every row is uploaded and checked. */
async function startImport(
  page: Page,
  dataset: keyof typeof DATASET_RADIO,
  file: Upload,
  opts: { year?: string; onMapping?: () => Promise<void>; expectEarlier?: boolean } = {},
): Promise<string> {
  await page.goto('/imports/new');
  await page.getByRole('radio', { name: DATASET_RADIO[dataset] }).check();
  if (opts.year) await choose(page, 'Academic year', opts.year);
  await page.getByLabel('Spreadsheet file (.xlsx or .csv)').setInputFiles(file);
  await expect(page.getByText('All required columns are matched.')).toBeVisible({ timeout: 30_000 });
  await opts.onMapping?.();
  await page.getByRole('button', { name: 'Upload rows for checking' }).click();
  await expect(page.getByText(/rows are uploaded and checked/)).toBeVisible({ timeout: 60_000 });
  const warning = page.getByText(/This file was imported on .* Importing again won't create duplicates\./);
  if (opts.expectEarlier === true) await expect(warning).toBeVisible();
  if (opts.expectEarlier === false) await expect(warning).toHaveCount(0);
  await page.getByRole('link', { name: 'Review rows' }).click();
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('tile-Ready')).toBeVisible();
  return page.url().split('/').pop()!;
}

async function tile(page: Page, label: string): Promise<number> {
  const text = (await page.getByTestId(`tile-${label}`).textContent()) ?? '';
  return Number(/(\d[\d,]*)/.exec(text.replace(label, ''))![1]!.replace(/,/g, ''));
}

async function expectTiles(page: Page, want: Record<string, number>) {
  for (const [label, n] of Object.entries(want)) {
    await expect.poll(() => tile(page, label), { message: `tile ${label}` }).toBe(n);
  }
}

/** Import button → wait for the run summary. */
async function runImport(page: Page, button: RegExp = /^(Import \d+ rows?|Confirm \d+ existing rows?)$/) {
  await page.getByRole('button', { name: button }).click();
  await expect(page.getByText(/^This run: /)).toBeVisible({ timeout: 120_000 });
  return (await page.getByText(/^This run: /).textContent()) ?? '';
}

const row = (page: Page, n: number) => page.getByTestId(`import-row-${n}`);

async function editRow(page: Page, n: number, field: string, value: string) {
  await row(page, n).getByRole('button', { name: 'Edit' }).click();
  const dlg = modal(page);
  const input = dlg.getByLabel(new RegExp(`^${field}( \\(required\\))?$`));
  await input.fill(value);
  await dlg.getByRole('button', { name: 'Save and check' }).click();
  await expect(dlg).toBeHidden();
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SCREENS}/375-${name}.png`, fullPage: true });
const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

// ------------------------------------------------------------------ run data
const CLS1 = `Imp${RUN} 1`;
const CLS2 = `Imp${RUN} 2`;
const PARENT = `Imp${RUN} Parent`;
const PARENT_PHONE = `9${DIGITS}1`;
const STUDENT = (i: number) => ({ adm: `IMP${RUN}-${i}`, name: `Imp${RUN} Student${'ABCD'[i - 1]}` });
const ROLL = (i: number) => `I${RUN}${i}`;
let studentsFile: Upload | null = null;

// ------------------------------------------------------------------ 1. classes & sections
test('1. Classes & sections (one already exists) → 1 "already exists" → import → classes appear in Setup', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await asAdmin(browser);

  // The existing one: class CLS1 with section A, made in Setup.
  await page.goto('/setup/classes');
  await page.getByRole('button', { name: 'New class' }).click();
  await modal(page).getByLabel('Class name').fill(CLS1);
  await modal(page).getByRole('button', { name: 'Save' }).click();
  const card1 = page.getByTestId(`class-card-${CLS1}`);
  await expect(card1).toBeVisible();
  await card1.getByRole('button', { name: 'Add section' }).click();
  await modal(page).getByLabel('Section name').fill('A');
  await modal(page).getByRole('button', { name: 'Save' }).click();
  await expect(card1.getByRole('button', { name: `Section ${CLS1} A, edit` })).toBeVisible();

  // Template download (generated in the browser from get_import_template)
  await page.goto('/imports/new');
  await page.getByRole('radio', { name: DATASET_RADIO.classes }).check();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download template (.xlsx)' }).click(),
  ]);
  const wb = new ExcelJS.Workbook();
  const bytes = await readFile((await download.path())!);
  await wb.xlsx.load(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  expect(wb.worksheets.map((w) => w.name)).toEqual(['Data', 'Help']);
  expect((wb.worksheets[0]!.getRow(1).values as unknown[]).slice(1)).toEqual([
    'Class',
    'Class order',
    'Section',
    'Capacity',
  ]);
  expect(wb.worksheets[0]!.actualRowCount).toBe(1);

  const file = csv(`classes-${RUN}.csv`, [
    'Class,Section,Capacity',
    `${CLS1},A,40`,
    `${CLS1},B,40`,
    `${CLS2},A,35`,
    `${CLS2},B,35`,
  ]);
  const jobId = await startImport(page, 'classes', file);
  await expectTiles(page, { Ready: 3, 'Already exist': 1, 'Needs fixing': 0 });
  await expect(row(page, 2)).toContainText('Already exists — nothing will change');

  const summary = await runImport(page, /^Import 3 rows$/);
  expect(summary).toContain('3 imported, 1 already existed');
  await expectTiles(page, { Imported: 3, 'Already exist': 1, 'Not imported': 0 });
  await expect(page.getByText('All rows in this import are done.')).toBeVisible();

  // Created rows link to Setup → Classes; the new classes and sections are there.
  await page.getByRole('tab', { name: /^Imported/ }).click();
  await row(page, 3).getByRole('link', { name: 'Open classes in Setup' }).click();
  for (const [cls, sections] of [
    [CLS1, ['A', 'B']],
    [CLS2, ['A', 'B']],
  ] as const) {
    const card = page.getByTestId(`class-card-${cls}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    for (const s of sections)
      await expect(card.getByRole('button', { name: `Section ${cls} ${s}, edit` })).toBeVisible();
  }
  expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
  await context.close();
});

// ------------------------------------------------------------------ 2. staff (375px)
test('2. Staff: unknown group + bad mobile flagged → fix mobile in Edit, remove the other → import → directory', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await asAdmin(browser, PHONE);
  const file = csv(`staff-${RUN}.csv`, [
    'EMPLOYEE NO,full name,Staff Group,Mobile,Joined on,Teaching staff?',
    `IMP${RUN}-1,Imp${RUN} Teacher,Teaching staff,+91 98765 43210,01/06/2026,yes`,
    `IMP${RUN}-2,Imp${RUN} Nogroup,No such group ${RUN},9876543211,01/06/2026,no`,
    `IMP${RUN}-3,Imp${RUN} Badmobile,Office staff,12345,2026-06-01,no`,
  ]);
  await startImport(page, 'staff', file, {
    onMapping: async () => {
      await noHorizontalScroll(page);
      await shot(page, 'mapping-step');
    },
  });
  await expectTiles(page, { Ready: 1, 'Needs fixing': 2 });
  await expect(row(page, 3)).toContainText(
    `No active staff group named "No such group ${RUN}". Create it first.`,
  );
  await expect(row(page, 4)).toContainText('Mobile: Use a 10-digit mobile number');
  await noHorizontalScroll(page);
  await shot(page, 'preview-with-errors');

  await editRow(page, 4, 'Mobile', `9${DIGITS}4`);
  await expect(row(page, 4)).toContainText('Ready');
  await row(page, 3).getByRole('button', { name: 'Remove' }).click();
  await expect(modal(page)).toContainText('Removing a row never deletes a school record');
  await modal(page).getByRole('button', { name: 'Remove row' }).click();
  await expectTiles(page, { Ready: 2, 'Needs fixing': 0, Removed: 1 });

  const summary = await runImport(page, /^Import 2 rows$/);
  expect(summary).toContain('2 imported');
  await expectTiles(page, { Imported: 2, Removed: 1, 'Not imported': 0 });
  await noHorizontalScroll(page);
  await shot(page, 'results');

  // Phones show the directory as a list (the table is hidden below sm).
  await page.goto('/staff');
  const visible = (name: string) => page.getByText(name, { exact: true }).filter({ visible: true });
  await expect(visible(`Imp${RUN} Teacher`)).toHaveCount(1, { timeout: 30_000 });
  await expect(visible(`Imp${RUN} Badmobile`)).toHaveCount(1);
  await expect(page.getByText(`Imp${RUN} Nogroup`)).toHaveCount(0);
  await context.close();
});

// ------------------------------------------------------------------ 3. students & parents (XLSX)
test('3. Students XLSX: siblings share a parent, roll clash "Not imported" → edit → import again; bad date flagged', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAdmin(browser);
  const header = [
    'Admission no',
    'Student name',
    'Gender',
    'Date of birth',
    'Class',
    'Section',
    'Roll no',
    'Parent 1 name',
    'Parent 1 mobile',
    'Parent 1 relationship',
  ];
  const dob = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)); // real Excel date cells
  studentsFile = await xlsx(`students-${RUN}.xlsx`, [
    header,
    [
      STUDENT(1).adm,
      STUDENT(1).name,
      'F',
      dob(2019, 5, 1),
      'Class 1',
      'A',
      ROLL(1),
      PARENT,
      PARENT_PHONE,
      'mother',
    ],
    [
      STUDENT(2).adm,
      STUDENT(2).name,
      'M',
      dob(2018, 2, 14),
      'Class 1',
      'A',
      ROLL(2),
      PARENT,
      PARENT_PHONE,
      'Mom',
    ],
    // same roll number as row 2 in the same section → rejected at import time
    [
      STUDENT(3).adm,
      STUDENT(3).name,
      'boy',
      '12/06/2019',
      'Class 1',
      'A',
      ROLL(1),
      `Imp${RUN} Other`,
      `9${DIGITS}3`,
      'father',
    ],
    [
      STUDENT(4).adm,
      STUDENT(4).name,
      'girl',
      '31/02/2019',
      'Class 1',
      'A',
      ROLL(4),
      `Imp${RUN} Fourth`,
      `9${DIGITS}5`,
      'mother',
    ],
  ]);
  await startImport(page, 'students', studentsFile, { expectEarlier: false });
  await expectTiles(page, { Ready: 3, 'Needs fixing': 1 });
  // the bad date sits under the field it belongs to
  await expect(row(page, 5)).toContainText('Date of birth: Not a valid date (use YYYY-MM-DD or DD/MM/YYYY)');
  // Excel date cells arrived as YYYY-MM-DD (UTC parts)
  await row(page, 2).getByRole('button', { name: 'Edit' }).click();
  await expect(modal(page).getByLabel('Date of birth (required)')).toHaveValue('2019-05-01');
  await modal(page).getByRole('button', { name: 'Cancel' }).click();

  await editRow(page, 5, 'Date of birth', '28/02/2019');
  await expectTiles(page, { Ready: 4, 'Needs fixing': 0 });

  let summary = await runImport(page, /^Import 4 rows$/);
  expect(summary).toContain('3 imported');
  expect(summary).toContain('1 not imported');
  await expectTiles(page, { Imported: 3, 'Not imported': 1 });
  await expect(row(page, 4)).toContainText('Not imported');
  await expect(row(page, 4)).toContainText('Roll number already used in this section');
  await expect(page.getByText('All rows in this import are done.')).toHaveCount(0);

  await editRow(page, 4, 'Roll no', ROLL(3));
  await expectTiles(page, { Ready: 1, 'Not imported': 0 });
  summary = await runImport(page, /^Import 1 row$/);
  expect(summary).toContain('1 imported');
  await expectTiles(page, { Imported: 4, 'Not imported': 0, 'Needs fixing': 0, Ready: 0 });
  await expect(page.getByText('All rows in this import are done.')).toBeVisible();

  // Created rows link to the student profile
  await page.getByRole('tab', { name: /^Imported/ }).click();
  await row(page, 2).getByRole('link', { name: 'Open student' }).click();
  await expect(page.getByTestId('student-name')).toHaveText(STUDENT(1).name, { timeout: 30_000 });
  await expect(page.getByTestId('guardians')).toContainText(PARENT);

  // Siblings share ONE guardian: guardian search shows both children under one result.
  await page.goto('/admissions/admit');
  await page.getByLabel('Add an existing parent / guardian').fill(PARENT);
  const result = page.getByTestId(`guardian-result-${PARENT}`);
  await expect(result).toHaveCount(1, { timeout: 30_000 });
  await expect(result).toContainText(STUDENT(1).name);
  await expect(result).toContainText(STUDENT(2).name);

  // Parsed rows never reach browser storage.
  const stored = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
  );
  expect(stored.includes(STUDENT(1).name), 'no student data in browser storage').toBe(false);
  expect(stored.includes(PARENT_PHONE), 'no parent mobile in browser storage').toBe(false);
  const idb = await page.evaluate(async () =>
    indexedDB.databases ? (await indexedDB.databases()).length : 0,
  );
  expect(idb).toBe(0);
  await context.close();
});

// ------------------------------------------------------------------ 4. same file again
test('4. Re-upload the same students file: warning, rows already exist, importing creates nothing', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  expect(studentsFile, 'test 3 built the file').not.toBeNull();
  const { context, page } = await asAdmin(browser);
  await startImport(page, 'students', studentsFile!, { expectEarlier: true });
  // Rows 2–4 exist. Row 5 still has 31/02/2019 in the file: the server checks the date before it
  // looks for the record, so that row is flagged again rather than shown as existing.
  await expectTiles(page, { Ready: 0, 'Already exist': 3, 'Needs fixing': 1 });
  for (const n of [2, 3, 4]) await expect(row(page, n)).toContainText('Already exists — nothing will change');
  await expect(row(page, 5)).toContainText('Not a valid date');

  const summary = await runImport(page, /^Confirm 3 existing rows$/);
  expect(summary).toContain('0 imported, 3 already existed (nothing changed)');
  await expectTiles(page, { Imported: 0, 'Already exist': 3 });

  // Close: what happens to rows not imported is explained; afterwards it's read-only.
  await page.getByRole('button', { name: 'Close import' }).click();
  await expect(modal(page)).toContainText(
    'Rows that were not imported stay listed with their errors — nothing is deleted',
  );
  await modal(page).getByRole('button', { name: 'Close import' }).click();
  await expect(page.getByText(/This import is closed and read-only/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByText('Closed — some rows not imported')).toBeVisible();

  // Still exactly one student per admission number.
  await page.goto('/students');
  await page.getByLabel('Search').fill(`Imp${RUN} Student`); // name-prefix search
  await expect(page.getByRole('list', { name: 'Students' }).getByRole('listitem')).toHaveCount(4, {
    timeout: 30_000,
  });
  await context.close();
});

// ------------------------------------------------------------------ 5. placements into a second year
test('5. Placements into 2027-28 → students placed; the 2026-27 placement closes at that year end', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAdmin(browser);

  // Second academic year (created once; not made current)
  await page.goto('/setup/years');
  const yearRow = page.getByTestId(`year-row-${NEXT_YEAR.name}`);
  await expect(page.getByTestId('year-row-2026-27')).toBeVisible({ timeout: 30_000 });
  if (!(await yearRow.isVisible())) {
    await page.getByRole('button', { name: 'New year' }).click();
    const dlg = modal(page);
    await dlg.getByLabel('Name').fill(NEXT_YEAR.name);
    await dlg.getByLabel('First day').fill(NEXT_YEAR.from);
    await dlg.getByLabel('Last day').fill(NEXT_YEAR.to);
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(yearRow).toBeVisible();
  }

  // Its section Class 1 A, through a classes & sections import (already exists on re-runs).
  await startImport(page, 'classes', csv(`classes-2027-${RUN}.csv`, ['Class,Section', 'Class 1,A']), {
    year: NEXT_YEAR.name,
  });
  await runImport(page);
  await expect.poll(async () => (await tile(page, 'Imported')) + (await tile(page, 'Already exist'))).toBe(1);

  await startImport(
    page,
    'placements',
    csv(`placements-${RUN}.csv`, [
      'Admission no,Class,Section,Roll no',
      `${STUDENT(1).adm},Class 1,A,${ROLL(1)}`,
      `${STUDENT(2).adm},Class 1,A,${ROLL(2)}`,
      `IMP${RUN}-NOPE,Class 1,A,`,
    ]),
    { year: NEXT_YEAR.name },
  );
  await expectTiles(page, { Ready: 2, 'Needs fixing': 1 });
  await expect(row(page, 4)).toContainText('No student with this admission number. Import students first.');
  const summary = await runImport(page, /^Import 2 rows$/);
  expect(summary).toContain('2 imported');

  await page.getByRole('tab', { name: /^Imported/ }).click();
  await row(page, 2).getByRole('link', { name: 'Open student' }).click();
  const history = page.getByTestId('placements');
  await expect(history).toContainText(`${NEXT_YEAR.name}: Class 1 A · Roll ${ROLL(1)}`, { timeout: 30_000 });
  await expect(history).toContainText('1 Apr 2027 – now');
  // 2026-27 placement: effective_to is exclusive = the day after the year's last day (31 Mar 2027).
  await expect(history.getByText(/^2026-27: Class 1 A/)).toBeVisible();
  await expect(history).toContainText('1 Apr 2026 – 1 Apr 2027');
  await context.close();
});

// ------------------------------------------------------------------ 6. Teacher: no imports
test('6. A role without imports.manage (Teacher) cannot see Imports and gets FORBIDDEN', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await asUser(browser, 'demo.teacher', pw.teacher!);
  await expect(page.getByTestId('dashboard-teacher')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Imports' })).toHaveCount(0);
  await page.goto('/imports');
  await expect(page.getByRole('alert')).toContainText("You don't have access to this page");
  await page.goto('/imports/new');
  await expect(page.getByRole('alert')).toContainText("You don't have access to this page");
  await context.close();

  // Server side: the RPCs themselves refuse the Teacher.
  const t = await ApiSession.signIn('demo.teacher', pw.teacher!);
  try {
    await t.enterDemo('teacher');
    await expect(t.school('list_import_jobs')).rejects.toThrow(/^list_import_jobs: FORBIDDEN/);
    await expect(t.school('get_import_template', { p_dataset: 'staff' })).rejects.toThrow(/FORBIDDEN/);
  } finally {
    await t.signOut();
  }
});

// ------------------------------------------------------------------ 7. history screenshot
test('7. 375px: imports history', async ({ browser }) => {
  const { context, page } = await asAdmin(browser, PHONE);
  await page.goto('/imports');
  await expect(page.getByRole('list', { name: 'Imports' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('list', { name: 'Imports' })).toContainText(`students-${RUN}.xlsx`);
  await noHorizontalScroll(page);
  await shot(page, 'imports-history');
  await context.close();
});

// ------------------------------------------------------------------ 8. network audit
test('8. Network audit: RPC only, p_ctx_rev on every school RPC, no cell values in telemetry', async () => {
  const rest = seen.filter((s) => s.url.includes('/rest/v1/'));
  for (const s of rest) expect(s.url).toMatch(/\/rest\/v1\/rpc\/[a-z_0-9]+(\?|$)/);
  const fn = (s: Seen) => /\/rpc\/([a-z_0-9]+)/.exec(s.url)![1]!;
  const importCalls = rest.filter((s) => /import/.test(fn(s)));
  expect(new Set(importCalls.map(fn))).toEqual(
    new Set([
      'get_import_template',
      'start_import',
      'stage_import_rows',
      'get_import_job',
      'update_import_row',
      'set_import_row_removed',
      'commit_import_chunk',
      'close_import',
      'list_import_jobs',
    ]),
  );
  for (const s of importCalls) expect(JSON.parse(s.body ?? '{}'), s.url).toHaveProperty('p_ctx_rev');
  const telemetry = rest.filter((s) => fn(s) === 'record_telemetry').map((s) => s.body ?? '');
  for (const body of telemetry) {
    expect(body.includes(STUDENT(1).name), 'telemetry carries no cell values').toBe(false);
    expect(body.includes(PARENT_PHONE), 'telemetry carries no cell values').toBe(false);
  }
  for (const s of seen) expect(s.url).toMatch(/\/(auth\/v1|rest\/v1\/rpc|functions\/v1\/accounts)\b/);
});
