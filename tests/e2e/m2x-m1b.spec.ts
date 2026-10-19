import { expect, test, type Browser, type Page } from '@playwright/test';
import { ApiSession, operatorSession, setKnownPassword } from './helpers/api';
import {
  closeImport,
  csv,
  DATASET_RADIO,
  expectTiles,
  importRow,
  tile,
  xlsx,
  type Upload,
} from './helpers/imports';
import { auditNetwork, choose, expectDemoSchool, modal, newPage, signIn, type Seen } from './helpers/ui';

// M2X close-out of M1b (spreadsheet imports), LIVE backend, Demo School only (every login `demo.*`).
// Records created here: a class "M2X Bulk" with 110 sections in the NON-current year 2027-28 (once;
// later runs find them existing). Everything else is staged and checked, then the import is closed
// without importing — in particular the 10,000-row file creates no students.

const OPERATOR = process.env.E2E_OPERATOR_USERNAME ?? '';
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? '';
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const DIGITS = String(Date.now()).slice(-8);
const NEXT_YEAR = '2027-28';
const BULK = 'M2X Bulk';
const SECTIONS = Array.from({ length: 110 }, (_, i) => `B${String(i + 1).padStart(3, '0')}`);

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
});
test.afterAll(async () => {
  await op?.signOut();
});

async function asAdmin(browser: Browser) {
  const s = await newPage(browser, seen);
  await signIn(s.page, 'demo.admin', pw.admin!);
  await expect(s.page.getByTestId('dashboard-admin')).toBeVisible({ timeout: 30_000 });
  await expectDemoSchool(s.page);
  return s;
}

/** Choose dataset (+ year), upload the file and wait for the mapping check. */
async function upload(page: Page, dataset: keyof typeof DATASET_RADIO, file: Upload, year?: string) {
  await page.goto('/imports/new');
  await page.getByRole('radio', { name: DATASET_RADIO[dataset] }).check();
  if (year) await choose(page, 'Academic year', year);
  await page.getByLabel('Spreadsheet file (.xlsx or .csv)').setInputFiles(file);
  await expect(page.getByText('All required columns are matched.')).toBeVisible({ timeout: 120_000 });
}

async function stageAndReview(page: Page) {
  await page.getByRole('button', { name: 'Upload rows for checking' }).click();
  await expect(page.getByText(/^All [\d,]+ rows are uploaded and checked\./)).toBeVisible({
    timeout: 300_000,
  });
  await page.getByRole('link', { name: 'Review rows' }).click();
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('tile-Ready')).toBeVisible({ timeout: 30_000 });
}

const staffCsv = (n: number, name: string) =>
  csv(name, [
    'Employee no,Full name,Staff group,Joined on',
    ...Array.from(
      { length: n },
      (_, i) => `M2X${RUN}-${i + 1},M2x${RUN} Person ${i + 1},Office staff,2026-06-01`,
    ),
  ]);

// ------------------------------------------------------------------ 1. staging interrupted
test('M1b-1. A real network failure while staging → "Continue uploading" resumes; nothing imported (closed)', async ({
  browser,
}) => {
  test.setTimeout(400_000);
  const { context, page } = await asAdmin(browser);
  await upload(page, 'staff', staffCsv(1200, `m2x-stage-${RUN}.csv`)); // 3 batches of ≤ 500
  // the first batch arrives; then the connection drops
  const first = page.waitForResponse((r) => r.url().endsWith('/rpc/stage_import_rows') && r.ok());
  await page.getByRole('button', { name: 'Upload rows for checking' }).click();
  await first;
  await context.setOffline(true);
  const resume = page.getByRole('button', { name: 'Continue uploading' });
  await expect(resume).toBeVisible({ timeout: 60_000 });
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: /offline/i })
      .first(),
  ).toBeVisible();
  await context.setOffline(false);
  await resume.click();
  await expect(page.getByText(/^All [\d,]+ rows are uploaded and checked\./)).toBeVisible({
    timeout: 300_000,
  });
  await page.getByRole('link', { name: 'Review rows' }).click();
  await expectTiles(page, { Ready: 1200, 'Needs fixing': 0 });
  await closeImport(page); // nothing is imported
  await context.close();
});

// ------------------------------------------------------------------ 2. > 100 rows: Load more, Remove/Restore, commit interrupted
test('M1b-2. 110 rows: "Load more" past 100 · Remove + Restore a row · a network failure between commit chunks → "Continue"', async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { context, page } = await asAdmin(browser);
  await upload(
    page,
    'classes',
    csv(`m2x-bulk-${RUN}.csv`, ['Class,Section', ...SECTIONS.map((s) => `${BULK},${s}`)]),
    NEXT_YEAR,
  );
  await stageAndReview(page);
  const total = (await tile(page, 'Ready')) + (await tile(page, 'Already exist'));
  expect(total).toBe(110);

  // the list pages: 100 rows, then "Load more"
  const rows = page.getByRole('list', { name: 'Rows' }).getByTestId(/^import-row-/);
  await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(100);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(110);

  // remove a row, then restore it
  await importRow(page, 6).getByRole('button', { name: 'Remove' }).click();
  await modal(page).getByRole('button', { name: 'Remove row' }).click();
  await expectTiles(page, { Removed: 1 });
  await page.getByRole('tab', { name: /^Removed/ }).click();
  await importRow(page, 6).getByRole('button', { name: 'Restore' }).click();
  await expectTiles(page, { Removed: 0 });
  await page.getByRole('tab', { name: /^All/ }).click();

  // commit: chunks of 100; the connection drops just as the second chunk is sent (the browser is
  // switched offline at that moment, so the request really fails on the network)
  let chunks = 0;
  await page.route('**/rest/v1/rpc/commit_import_chunk', async (route) => {
    chunks += 1;
    if (chunks === 2) await context.setOffline(true);
    await route.continue().catch(() => undefined);
  });
  await page.getByRole('button', { name: /^(Import \d+ rows?|Confirm \d+ existing rows?)$/ }).click();
  await expect(page.getByText('Some rows may already be imported — choose Continue to resume.')).toBeVisible({
    timeout: 60_000,
  });
  await context.setOffline(false);
  await page.unroute('**/rest/v1/rpc/commit_import_chunk');
  expect(chunks).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('All rows in this import are done.')).toBeVisible({ timeout: 180_000 });
  expect((await tile(page, 'Imported')) + (await tile(page, 'Already exist'))).toBe(110);
  await expectTiles(page, { 'Not imported': 0 });
  await context.close();
});

// ------------------------------------------------------------------ 3. the "no rows processed" guard
test('M1b-3. The "no rows processed" guard stops the loop (server reply forced) and Reload recovers', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAdmin(browser);
  // two rows that exist already (from M1b-2): committing them only confirms them
  await upload(
    page,
    'classes',
    csv(`m2x-guard-${RUN}.csv`, ['Class,Section', `${BULK},B001`, `${BULK},B002`]),
    NEXT_YEAR,
  );
  await stageAndReview(page);
  await expectTiles(page, { 'Already exist': 2 });
  // The guard is for a server that reports ready rows but processes none in a chunk. That can't be
  // produced on demand, so the first chunk's real reply is rewritten to say exactly that.
  let forced = false;
  await page.route('**/rest/v1/rpc/commit_import_chunk', async (route) => {
    if (forced) return route.continue();
    forced = true;
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...body, processed: [], more_ready: true } });
  });
  await page.getByRole('button', { name: /^Confirm 2 existing rows$/ }).click();
  await expect(page.getByText('No rows were processed. Reload the import and try again.')).toBeVisible({
    timeout: 60_000,
  });
  expect(forced).toBe(true);
  await page.unroute('**/rest/v1/rpc/commit_import_chunk');
  await page.getByRole('button', { name: 'Reload' }).click();
  // recovered: the real state is shown — both rows were confirmed by that (rewritten) call; nothing
  // is left to run and no loop happened
  await expect(page.getByText('No rows were processed. Reload the import and try again.')).toHaveCount(0);
  await expectTiles(page, { 'Already exist': 2, Ready: 0, 'Not imported': 0 });
  await expect(page.getByRole('button', { name: /^(Import|Confirm) / })).toHaveCount(0);
  expect(forced).toBe(true);
  await context.close();
});

// ------------------------------------------------------------------ 4. file formats
/** Windows-1252 bytes as Excel's plain "CSV" on Windows writes them. */
function cp1252(text: string): Buffer {
  const special: Record<string, number> = { '–': 0x96, '€': 0x80, '’': 0x92 };
  return Buffer.from([...text].map((ch) => special[ch] ?? ch.charCodeAt(0)));
}

test('M1b-4. Windows-1252 and lossy UTF-8 CSVs, a hidden first sheet, formulas with empty results, skipped blank rows, the parent-mobile alias (all closed without importing)', async ({
  browser,
}) => {
  test.setTimeout(500_000);
  const { context, page } = await asAdmin(browser);

  // Windows-1252: accents, an en dash and ’ come out right
  const w = cp1252(
    [
      'Employee no,Full name,Staff group,Joined on,Designation',
      `M2XW${RUN}-1,José Fernández,Office staff,2026-06-01,Clerk – front desk`,
      `M2XW${RUN}-2,Zoë D’Souza,Office staff,2026-06-01,Accounts`,
    ].join('\r\n') + '\r\n',
  );
  await upload(page, 'staff', { name: `m2x-1252-${RUN}.csv`, mimeType: 'text/csv', buffer: w });
  await expect(page.getByText(/could not be read/)).toHaveCount(0);
  await stageAndReview(page);
  await expect(importRow(page, 2)).toContainText('José Fernández');
  // columns not in the row summary: read them in the row's Edit dialog
  await importRow(page, 2).getByRole('button', { name: 'Edit' }).click();
  await expect(modal(page).getByLabel('Designation')).toHaveValue('Clerk – front desk');
  await modal(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(importRow(page, 3)).toContainText('Zoë D’Souza');
  await closeImport(page);

  // lossy UTF-8: a Telugu name stays intact; the row with a stray byte is named
  const good = Buffer.from(
    `Employee no,Full name,Staff group,Joined on\r\nM2XU${RUN}-1,రవి కుమార్,Office staff,2026-06-01\r\nM2XU${RUN}-2,Bad `,
    'utf8',
  );
  const lossy = Buffer.concat([
    good,
    Buffer.from([0x96]),
    Buffer.from(' Name,Office staff,2026-06-01\r\n', 'utf8'),
  ]);
  await upload(page, 'staff', { name: `m2x-lossy-${RUN}.csv`, mimeType: 'text/csv', buffer: lossy });
  await expect(page.getByText(/Some characters could not be read and show as � in row 3\b/)).toBeVisible();
  await stageAndReview(page);
  await expect(importRow(page, 2)).toContainText('రవి కుమార్');
  await expect(importRow(page, 3)).toContainText('�');
  await closeImport(page);

  // a workbook whose first sheet is hidden: the first VISIBLE sheet is read; a formula whose saved
  // result is empty is a blank cell (optional Designation: the row is fine); a fully blank row is skipped
  const book = await xlsx(`m2x-book-${RUN}.xlsx`, [
    {
      name: 'Old',
      hidden: true,
      rows: [
        ['Wrong', 'Headers'],
        ['x', 'y'],
      ],
    },
    {
      name: 'Staff',
      rows: [
        ['Employee no', 'Full name', 'Staff group', 'Joined on', 'Designation', 'Notes'],
        [
          `M2XB${RUN}-1`,
          `M2x${RUN} Visible One`,
          'Office staff',
          '2026-06-01',
          { formula: 'IF(1=1,"","x")', result: '' },
        ],
        [], // fully blank: dropped while reading
        ['', '', '', '', '', 'only a note'], // data only in a column that isn't imported
        [`M2XB${RUN}-2`, `M2x${RUN} Visible Two`, 'Office staff', '2026-06-01', 'Clerk'],
      ],
    },
  ]);
  await upload(page, 'staff', book);
  await expect(page.getByRole('combobox', { name: 'Import "Employee no" as' })).toBeVisible();
  await expect(page.getByText('Wrong', { exact: true })).toHaveCount(0);
  // shown before uploading: 2 rows will be checked, the note-only row is skipped
  await expect(
    page.getByText(/1 row had no data in the mapped columns and was skipped \(row 4\)/),
  ).toBeVisible();
  await expect(page.getByText(/^2 rows will be checked/)).toBeVisible();
  await page.getByRole('button', { name: 'Upload rows for checking' }).click();
  await expect(page.getByText(/^All 2 rows are uploaded and checked\./)).toBeVisible({
    timeout: 120_000,
  });
  await page.getByRole('link', { name: 'Review rows' }).click();
  await expectTiles(page, { Ready: 2, 'Needs fixing': 0 });
  await expect(importRow(page, 2)).toContainText(`M2x${RUN} Visible One`);
  await expect(importRow(page, 5)).toContainText(`M2x${RUN} Visible Two`);
  await closeImport(page);

  // students: a "Mobile" column is matched to Parent 1 mobile by the alias
  await upload(
    page,
    'students',
    csv(`m2x-alias-${RUN}.csv`, [
      'Admission no,Student name,Gender,Date of birth,Class,Section,Parent 1 name,Mobile',
      `M2XA${RUN},M2x${RUN} Alias,F,2018-01-01,Class 1,A,M2x${RUN} Mother,9${DIGITS}7`,
    ]),
  );
  await expect(page.getByRole('combobox', { name: 'Import "Mobile" as' })).toContainText('Parent 1 mobile');
  await stageAndReview(page);
  await expectTiles(page, { Ready: 1, 'Needs fixing': 0 });
  await closeImport(page);
  await context.close();
});

// ------------------------------------------------------------------ 5. large file + leave-mid-upload
test('M1b-5. 10,000 rows / ~5 MB: parsed, staged and checked (timings + memory recorded), leave-mid-upload asks first; closed without importing', async ({
  browser,
}) => {
  test.setTimeout(1_500_000);
  const { context, page } = await asAdmin(browser);
  const address = 'House 12-3-456, Lane 7, Ameerpet, Hyderabad, Telangana — near the old water tank. '
    .repeat(5)
    .slice(0, 400);
  const lines = [
    'Admission no,Student name,Gender,Date of birth,Class,Section,Parent 1 name,Parent 1 mobile,Address',
  ];
  for (let i = 1; i <= 10_000; i += 1) {
    lines.push(
      `M2XL${RUN}-${i},M2x${RUN} Large ${i},${i % 2 ? 'M' : 'F'},2018-01-${String((i % 28) + 1).padStart(2, '0')},Class 1,A,M2x${RUN} Parent ${i},9${String(10_000_000 + i).slice(-8)}1,"${address}"`,
    );
  }
  const big = csv(`m2x-large-${RUN}.csv`, lines);
  const mb = big.buffer.length / (1024 * 1024);
  expect(mb).toBeGreaterThan(4.5);
  expect(mb).toBeLessThanOrEqual(5);

  await page.goto('/imports/new');
  await page.getByRole('radio', { name: DATASET_RADIO.students }).check();
  const heap = () =>
    page.evaluate(
      () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
    );
  const heapBefore = await heap();
  const t0 = Date.now();
  await page.getByLabel('Spreadsheet file (.xlsx or .csv)').setInputFiles(big);
  await expect(page.getByText('All required columns are matched.')).toBeVisible({ timeout: 300_000 });
  const parseMs = Date.now() - t0;
  const heapAfterParse = await heap();

  // leaving while the upload runs asks first; "Stay" keeps it going
  const t1 = Date.now();
  await page.getByRole('button', { name: 'Upload rows for checking' }).click();
  await expect(page.getByText(/Uploaded [\d,]+ of 10,000 rows/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('link', { name: 'Students' }).first().click();
  const leave = modal(page);
  await expect(leave).toContainText('Leave before the upload finishes?');
  await leave.getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL(/\/imports\/new$/);
  await expect(page.getByText(/^All [\d,]+ rows are uploaded and checked\./)).toBeVisible({
    timeout: 1_200_000,
  });
  const stageMs = Date.now() - t1;
  const heapAfterStage = await heap();

  await page.getByRole('link', { name: 'Review rows' }).click();
  await expect
    .poll(async () => (await tile(page, 'Ready')) + (await tile(page, 'Needs fixing')), {
      timeout: 60_000,
    })
    .toBe(10_000);
  await closeImport(page); // no student is created
  test.info().annotations.push({
    type: 'large file',
    description: `${mb.toFixed(2)} MB, 10,000 rows: parse + mapping ${(parseMs / 1000).toFixed(1)} s; upload + server check ${(stageMs / 1000).toFixed(1)} s; main-thread JS heap (the parser runs in a Web Worker, not counted) ${(heapBefore / 1e6).toFixed(0)} → ${(heapAfterParse / 1e6).toFixed(0)} MB after parsing → ${(heapAfterStage / 1e6).toFixed(0)} MB after upload`,
  });
  await context.close();
});

test('M1b-6. Network audit of these tests', () => {
  expect(seen.length).toBeGreaterThan(20);
  auditNetwork(seen);
});
