import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { ApiSession, operatorSession, setKnownPassword } from './helpers/api';
import {
  addDays,
  choose,
  DESKTOP,
  expectDemoSchool,
  modal,
  newPage,
  signIn,
  TODAY,
  type Seen,
} from './helpers/ui';

// M3 owner review, item 5: the fee flows not exercised live by m3.spec.ts, LIVE backend, Demo School only
// ("Demo School" is asserted before any action; every login `demo.*`). Everything through the UI; the API
// helper only gives demo logins a known password and looks up ids / balances for the checks.
// Run after m3.spec.ts (it makes demo.accountant and demo.owner).

const OPERATOR = process.env.E2E_OPERATOR_USERNAME ?? '';
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? '';
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
// per-run paise offset: the same cash payment within 30 minutes is a possible duplicate since 2330
const S = (Math.floor(Date.now() / 60_000) % 97) + 1;
const H = {
  tuition: { name: `Tuition R${RUN}`, code: `TR${RUN}` },
  bus: { name: `Transport R${RUN}`, code: `BR${RUN}` },
};
const TERM = `Review term ${RUN}`;
const SPARE = `Spare term ${RUN}`;
const BANK = `Review bank ${RUN}`;
const BANK2 = `Review bank ${RUN} (edited)`;
const PRESET = `Review 10% ${RUN}`;
const CHQ = Date.now().toString().slice(-7);

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.skip(!OPERATOR || !OPERATOR_PASSWORD, 'E2E_OPERATOR_USERNAME / E2E_OPERATOR_PASSWORD not set');

const seen: Seen[] = [];
const pw: Record<string, string> = {};
const ids: Record<string, string> = {};
const store: Record<string, string> = {};
let op: ApiSession;
let acct: ApiSession;

const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const rs = (p: number) => `${Math.trunc(p / 100)}.${String(p % 100).padStart(2, '0')}`;
const inr = (p: number) => INR.format(Number(rs(p)));
const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T12:00:00Z`));

test.beforeAll(async () => {
  op = await operatorSession();
  await op.enterDemo();
  pw.accountant = await setKnownPassword(op, 'demo.accountant');
  pw.owner = await setKnownPassword(op, 'demo.owner');
  acct = await ApiSession.signIn('demo.accountant', pw.accountant);
  await acct.enterDemo('accountant');
  const find = async (q: string) =>
    (
      await op.school<{ items: { student_id: string; admission_no: string }[] }>('list_students', {
        p_search: q,
      })
    ).items.find((s) => s.admission_no === q)!.student_id;
  ids.aarav = await find('DEMO-S1');
});
test.afterAll(async () => {
  await acct?.signOut();
  await op?.signOut();
});

async function as(browser: Browser, username: string, password: string, dashboard: string) {
  const s = await newPage(browser, seen, DESKTOP);
  await signIn(s.page, username, password);
  await expect(s.page.getByTestId(dashboard)).toBeVisible({ timeout: 30_000 });
  await expectDemoSchool(s.page);
  return s;
}
const asAccountant = (b: Browser) => as(b, 'demo.accountant', pw.accountant!, 'dashboard-accountant');

type Inv = {
  invoice_id: string;
  invoice_no: string;
  term: string | null;
  balance_paise: number;
  status: string;
};
async function statement() {
  return acct.school<{
    invoices: Inv[];
    collections: { collection_id: string; receipt_id: string; receipt_no: string; method: string }[];
  }>('get_student_statement', { p_student_id: ids.aarav });
}

async function openCollect(page: Page) {
  await page.goto(`/fees/collect?student=${ids.aarav}`);
  await expect(page.getByTestId('statement-student')).toHaveText('Aarav Sharma', { timeout: 30_000 });
}
async function allocateOnly(page: Page, invoiceId: string, rupees: string) {
  const showAll = page.getByRole('button', { name: /^Show all \d+ invoices$/ });
  if (await showAll.isVisible()) await showAll.click();
  const inputs = page.getByTestId('allocation-rows').locator('input');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const input = inputs.nth(i);
    await input.fill((await input.getAttribute('id')) === `alloc-${invoiceId}` ? rupees : '0');
  }
  await expect(page.getByTestId('allocation-status')).toContainText('adds up exactly');
}
const balanceOf = (page: Page, invoiceNo: string) =>
  page.getByTestId(`invoice-${invoiceNo}`).getByTestId('invoice-balance').locator('dd');

// ------------------------------------------------------------------ R1 setup edits
test('R1. Edit a receiving account, a term and a concession preset; retire a term', async ({ browser }) => {
  test.setTimeout(300_000);
  const { context, page } = await asAccountant(browser);
  await page.goto('/fees/setup?tab=heads');
  for (const [h, optional] of [
    [H.tuition, false],
    [H.bus, true],
  ] as const) {
    await page.getByRole('button', { name: 'New fee head' }).click();
    await modal(page).getByLabel('Name').fill(h.name);
    await modal(page).getByLabel('Code').fill(h.code);
    if (optional)
      await modal(page)
        .getByLabel(/^Optional/)
        .check();
    await modal(page).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId(`head-${h.code}`)).toBeVisible({ timeout: 30_000 });
  }
  await expect(page.getByTestId(`head-${H.bus.code}`)).toContainText('optional');

  // account: create, then edit the name and clear the last 4 digits (only changed keys are sent)
  await page.getByRole('tab', { name: 'Receiving accounts' }).click();
  await page.getByRole('button', { name: 'New account' }).click();
  await modal(page).getByLabel('Name', { exact: true }).fill(BANK);
  await modal(page).getByLabel('Bank name').fill('Canara Bank');
  await modal(page)
    .getByLabel(/last 4 digits/)
    .fill('9876');
  await modal(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId(`account-${BANK}`)).toContainText('••••9876');
  await page.getByTestId(`account-${BANK}`).getByRole('button', { name: 'Edit' }).click();
  await modal(page).getByLabel('Name', { exact: true }).fill(BANK2);
  await modal(page)
    .getByLabel(/last 4 digits/)
    .fill('');
  await modal(page).getByRole('button', { name: 'Save' }).click();
  const acc = page.getByTestId(`account-${BANK2}`);
  await expect(acc).toBeVisible({ timeout: 30_000 });
  await expect(acc).toContainText('Canara Bank');
  await expect(acc).not.toContainText('••••');
  const saves = seen.filter((s) => s.url.endsWith('/rpc/save_receiving_account'));
  expect(JSON.parse(saves.at(-1)!.body!).p).toEqual({ label: BANK2, account_last4: '' });

  // terms: create two, edit one's due date, retire the other
  await page.getByRole('tab', { name: 'Terms' }).click();
  for (const name of [TERM, SPARE]) {
    await page.getByRole('button', { name: 'New term' }).click();
    await modal(page).getByLabel('Name').fill(name);
    await modal(page).getByLabel('Due date').fill(addDays(TODAY, 20));
    await modal(page).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId(`term-${name}`)).toBeVisible({ timeout: 30_000 });
  }
  await page.getByTestId(`term-${TERM}`).getByRole('button', { name: 'Edit' }).click();
  await modal(page).getByLabel('Due date').fill(addDays(TODAY, -5));
  await modal(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId(`term-${TERM}`)).toContainText(`Due ${fmtDate(addDays(TODAY, -5))}`, {
    timeout: 30_000,
  });
  await page.getByTestId(`term-${SPARE}`).getByRole('button', { name: 'Retire' }).click();
  await modal(page).getByRole('button', { name: 'Retire term' }).click();
  await expect(page.getByTestId(`term-${SPARE}`)).toContainText('Retired', { timeout: 30_000 });

  // price list: Tuition ₹5,000, Transport ₹1,000 (optional) for Class 1
  await page.getByRole('tab', { name: 'Price list' }).click();
  await choose(page, 'Term', TERM);
  const row = page.getByTestId('price-row-Class 1');
  await row.getByLabel(`Class 1 — ${H.tuition.name}`).fill('5000');
  await row.getByLabel(`Class 1 — ${H.bus.name}`).fill('1000');
  await row.getByRole('button', { name: 'Save Class 1' }).click();
  await expect(page.getByText('Class 1: price list saved.')).toBeVisible({ timeout: 30_000 });

  // preset: create 10%, edit to 15%
  await page.getByRole('tab', { name: 'Concessions' }).click();
  await page.getByRole('button', { name: 'New concession' }).click();
  await modal(page).getByLabel('Name').fill(PRESET);
  await modal(page).getByLabel('Percent').fill('10');
  await modal(page).getByLabel(`${H.tuition.name} (${H.tuition.code})`).check();
  await modal(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId(`preset-${PRESET}`)).toContainText('10%');
  await page.getByTestId(`preset-${PRESET}`).getByRole('button', { name: 'Edit' }).click();
  await modal(page).getByLabel('Percent').fill('15');
  await modal(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId(`preset-${PRESET}`)).toContainText('15%', { timeout: 30_000 });
  await context.close();
});

// ------------------------------------------------------------------ R2 optional fees, concession revoke, invoices
test('R2. Optional fees for one student; grant + revoke a concession; the preview follows both', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAccountant(browser);
  await page.goto('/fees/setup?tab=optional');
  await choose(page, 'Optional fee head', H.bus.name);
  await choose(page, 'Section', 'Class 1 A');
  const roster = page.getByTestId('optional-roster');
  const aarav = roster.locator('li').filter({ hasText: 'DEMO-S1' });
  await expect(aarav).toContainText('Not opted in', { timeout: 30_000 });
  await aarav.getByRole('checkbox').check();
  await expect(aarav).toContainText('(unsaved)');
  await page.getByRole('button', { name: 'Save 1 change' }).click();
  await expect(page.getByText(/Saved: 1 added, 0 removed/)).toBeVisible({ timeout: 30_000 });
  await expect(aarav).toContainText('Opted in');
  await expect(aarav).not.toContainText('(unsaved)');

  // concession granted then revoked → no concession on the invoice
  await page.goto(`/fees/students/${ids.aarav}`);
  await expect(page.getByTestId('statement-student')).toHaveText('Aarav Sharma', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Grant concession' }).click();
  await choose(modal(page), 'Concession', new RegExp(`^${PRESET}`));
  await choose(modal(page), 'For', `${TERM} only`);
  await modal(page).getByLabel('Reason').fill(`Review grant ${RUN}`);
  await modal(page).getByRole('button', { name: 'Grant' }).click();
  const conc = page.getByTestId(`concession-${PRESET}`);
  await expect(conc).toBeVisible({ timeout: 30_000 });
  await conc.getByRole('button', { name: 'Revoke' }).click();
  await modal(page).getByLabel('Reason').fill(`Granted by mistake ${RUN}`);
  await modal(page).getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('Concession revoked.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Show revoked' }).click();
  await expect(page.getByTestId(`concession-${PRESET}`)).toContainText('Revoked');
  await expect(page.getByTestId(`concession-${PRESET}`)).toContainText(`Granted by mistake ${RUN}`);

  await page.goto('/fees/invoices');
  await choose(page, 'Term', new RegExp(`^${TERM}`));
  await choose(page, 'Students', 'Class 1 A');
  await page.getByRole('button', { name: 'Preview' }).click();
  const row = page.getByTestId('preview-DEMO-S1');
  await expect(row).toContainText(H.bus.name, { timeout: 30_000 }); // opted in
  await expect(row).not.toContainText(PRESET); // revoked
  await expect(row).toContainText('net ₹6,000.00');
  const other = page
    .getByTestId('preview-rows')
    .locator('li')
    .filter({ hasNotText: 'DEMO-S1' })
    .filter({ hasText: 'Will be issued' })
    .first();
  await expect(other).not.toContainText(H.bus.name); // not opted in
  await page.getByRole('button', { name: /^Issue \d+ invoices?$/ }).click();
  await expect(page.getByTestId('issue-result')).toContainText(/Issued [1-9]/, { timeout: 60_000 });
  const inv = (await statement()).invoices.find((i) => i.term === TERM)!;
  expect(inv.balance_paise).toBe(600000);
  store.invoice = inv.invoice_id;
  store.invoiceNo = inv.invoice_no;
  await context.close();
});

// ------------------------------------------------------------------ R3 opening balance, adjustments, cancel
test('R3. Single opening balance from the statement (replay, DUPLICATE); adjustments; cancel an invoice', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAccountant(browser);
  await page.goto(`/fees/students/${ids.aarav}`);
  await expect(page.getByTestId('statement-student')).toHaveText('Aarav Sharma', { timeout: 30_000 });
  const addOpening = async (amount: string) => {
    await page.getByRole('button', { name: 'Add opening balance' }).click();
    const dlg = modal(page);
    await choose(dlg, 'Fee head', `${H.tuition.name} (${H.tuition.code})`);
    await dlg.getByLabel('Amount due').fill(amount);
    await dlg.getByLabel('What it is for').fill(`Old ledger ${RUN}`);
    await dlg.getByLabel(/Old reference/).fill(`LEDGER-${RUN}`);
    await dlg.getByRole('button', { name: 'Add opening balance' }).click();
  };
  await addOpening('1,234.50');
  const added = page.getByText(/^Opening balance added: INV\//);
  await expect(added).toBeVisible({ timeout: 30_000 });
  const openingNo = /INV\/[\d-]+\/\d+/.exec((await added.textContent())!)![0]!;
  await addOpening('1,234.50');
  await expect(page.getByText(`Already recorded as ${openingNo}.`)).toBeVisible({ timeout: 30_000 });
  await addOpening('999');
  await expect(modal(page)).toContainText('already used for a different student or amount', {
    timeout: 30_000,
  });
  await expect(modal(page)).toContainText(`Existing invoice: ${openingNo}`);
  await modal(page).getByRole('button', { name: 'Cancel' }).click();

  // adjustments on this run's invoice: +₹200 extra charge, −₹150 discount
  const card = page.getByTestId(`invoice-${store.invoiceNo}`);
  await card.getByRole('button', { name: 'Add adjustment' }).click();
  await choose(modal(page), 'Type', 'Extra charge (raises the amount due)');
  await modal(page).getByLabel('Amount').fill('200');
  await modal(page).getByLabel('Reason').fill(`Lost ID card ${RUN}`);
  await modal(page).getByRole('button', { name: 'Save adjustment' }).click();
  await expect(balanceOf(page, store.invoiceNo!)).toHaveText('₹6,200.00', { timeout: 30_000 });
  await card.getByRole('button', { name: 'Add adjustment' }).click();
  await modal(page).getByLabel('Amount').fill('150');
  await modal(page).getByLabel('Reason').fill(`Goodwill ${RUN}`);
  await modal(page).getByRole('button', { name: 'Save adjustment' }).click();
  await expect(balanceOf(page, store.invoiceNo!)).toHaveText('₹6,050.00', { timeout: 30_000 });
  await card.getByRole('button', { name: 'Details' }).click();
  await expect(card.getByRole('list', { name: 'Adjustments' })).toContainText(`Lost ID card ${RUN}`);
  await expect(card.getByRole('list', { name: 'Adjustments' })).toContainText(`Goodwill ${RUN}`);
  await expect(card.getByRole('list', { name: 'Adjustments' })).toContainText('Extra charge');
  await expect(card.getByRole('list', { name: 'Adjustments' })).toContainText('Discount');

  // cancel the (unpaid) opening-balance invoice
  const ob = page.getByTestId(`invoice-${openingNo}`);
  await ob.getByRole('button', { name: 'Cancel invoice' }).click();
  await modal(page).getByLabel('Reason').fill(`Entered twice ${RUN}`);
  await modal(page).getByRole('button', { name: 'Cancel invoice' }).click();
  await expect(ob.getByTestId('payment-state')).toHaveText('Cancelled', { timeout: 30_000 });
  await expect(ob.getByRole('button', { name: 'Cancel invoice' })).toHaveCount(0);
  await context.close();
});

// ------------------------------------------------------------------ R4 bank transfer + cheques
test('R4. Bank-transfer collection; a cheque cleared with changed allocations; a pending cheque bounced; a cheque cancelled', async ({
  browser,
}) => {
  test.setTimeout(400_000);
  const { context, page } = await asAccountant(browser);
  const bt = 40_000 + S;
  await openCollect(page);
  await choose(page, 'Method', 'Bank transfer');
  await choose(page, 'Received into', `${BANK2} (Bank account)`);
  await page.getByLabel('Transaction reference (UTR)').fill(`NEFT${RUN}B`);
  await page.getByLabel('Amount received').fill(rs(bt));
  await allocateOnly(page, store.invoice!, rs(bt));
  await page.getByTestId('save-payment').click();
  await expect(page).toHaveURL(/\/fees\/receipts\//, { timeout: 30_000 });
  await expect(page.getByTestId('receipt')).toContainText(`Bank transfer · ${BANK2}`);
  await expect(page.getByTestId('receipt')).toContainText(`NEFT${RUN}B`);
  store.btReceipt = (await page.getByTestId('receipt-no').textContent())!.trim();
  store.btAmount = String(bt);

  const recordCheque = async (no: string, rupees: string) => {
    await openCollect(page);
    await choose(page, 'Method', 'Cheque');
    await choose(page, 'Deposit into', `${BANK2} (Bank account)`);
    await page.getByLabel('Cheque number').fill(no);
    await page.getByLabel('Bank (of the cheque)').fill('ICICI Bank');
    await page.getByLabel('Amount received').fill(rupees);
    await allocateOnly(page, store.invoice!, rupees);
    await page.getByRole('button', { name: 'Record cheque (pending)' }).click();
    await expect(page.getByTestId('cheque-recorded')).toContainText('Cheque recorded — pending.');
  };

  // clear with changed allocations: planned on this run's invoice, cleared onto an older one
  const older = (await statement()).invoices.find(
    (i) => i.status === 'issued' && i.invoice_id !== store.invoice && i.balance_paise >= 60_000,
  )!;
  await recordCheque(`${CHQ}1`, '600');
  await page.goto('/fees/cheques');
  await page.getByTestId(`cheque-${CHQ}1`).getByRole('button', { name: 'Clear' }).click();
  const dlg = modal(page);
  await dlg.getByLabel('Allocate differently from the plan').check();
  await dlg.getByLabel(`Amount for ${older.invoice_no}`).fill('600');
  await expect(dlg).toContainText('adds up exactly');
  await dlg.getByRole('button', { name: 'Clear cheque' }).click();
  const cleared = page.getByText(/^Cheque cleared — receipt RCT\//);
  await expect(cleared).toBeVisible({ timeout: 30_000 });
  const chequeReceipt = /RCT\/[\d-]+\/\d+/.exec((await cleared.textContent())!)![0]!;
  await page.goto(`/fees/students/${ids.aarav}`);
  await expect(page.getByTestId(`payment-${chequeReceipt}`)).toContainText(
    `Went to: ${older.invoice_no} ₹600.00`,
    { timeout: 30_000 },
  );

  // a pending cheque bounced: never counted, so the dues don't change
  await recordCheque(`${CHQ}2`, '300');
  const before = (await statement()).invoices.find((i) => i.invoice_id === store.invoice)!.balance_paise;
  await page.goto('/fees/cheques');
  await page.getByTestId(`cheque-${CHQ}2`).getByRole('button', { name: 'Bounced' }).click();
  await modal(page).getByLabel('Reason').fill(`Signature mismatch ${RUN}`);
  await modal(page).getByRole('button', { name: 'Mark bounced' }).click();
  await expect(page.getByText('Marked bounced.')).toBeVisible({ timeout: 30_000 });
  await choose(page, 'Status', 'Bounced');
  await expect(page.getByTestId(`cheque-${CHQ}2`).getByTestId('cheque-status')).toHaveText('Bounced');
  expect((await statement()).invoices.find((i) => i.invoice_id === store.invoice)!.balance_paise).toBe(
    before,
  );

  // a pending cheque cancelled
  await recordCheque(`${CHQ}3`, '200');
  await page.goto('/fees/cheques');
  await page.getByTestId(`cheque-${CHQ}3`).getByRole('button', { name: 'Cancel cheque' }).click();
  await modal(page).getByLabel('Reason').fill(`Returned to parent ${RUN}`);
  await modal(page).getByRole('button', { name: 'Cancel cheque' }).click();
  await expect(page.getByText('Cheque cancelled.')).toBeVisible({ timeout: 30_000 });
  await choose(page, 'Status', 'Cancelled');
  await expect(page.getByTestId(`cheque-${CHQ}3`)).toContainText(`Returned to parent ${RUN}`);
  await context.close();
});

// ------------------------------------------------------------------ R5 possible duplicate
test('R5. The same cash payment again within 30 minutes asks first; "Yes" records a second receipt', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await asAccountant(browser);
  const amount = 33_300 + S;
  const pay = async () => {
    await openCollect(page);
    await page.getByLabel('Amount received').fill(rs(amount));
    await allocateOnly(page, store.invoice!, rs(amount));
    await page.getByTestId('save-payment').click();
  };
  const count = (await statement()).collections.length;
  await pay();
  await expect(page).toHaveURL(/\/fees\/receipts\//, { timeout: 30_000 });
  const firstId = page.url().split('/').pop()!;
  const firstNo = (await page.getByTestId('receipt-no').textContent())!.trim();
  await pay();
  const notice = page.getByTestId('possible-duplicate');
  await expect(notice).toContainText(
    new RegExp(
      `${inr(amount).replace(/[.]/g, '\\.')} by cash for Aarav Sharma was already recorded at .+ \\(receipt ${firstNo.replace(/\//g, '\\/')}\\)\\. Is this a second, separate payment\\?`,
    ),
    { timeout: 30_000 },
  );
  await expect(notice.getByRole('link', { name: 'Open that receipt' })).toHaveAttribute(
    'href',
    `/fees/receipts/${firstId}`,
  );
  expect((await statement()).collections.length).toBe(count + 1);
  await notice.getByRole('button', { name: 'Yes, record another payment' }).click();
  await expect(page).toHaveURL(/\/fees\/receipts\//, { timeout: 30_000 });
  await expect(page.getByTestId('receipt-no')).not.toHaveText(firstNo);
  expect((await statement()).collections.length).toBe(count + 2);
  const posts = seen
    .filter((s) => s.url.endsWith('/rpc/post_collection'))
    .slice(-2)
    .map((s) => JSON.parse(s.body!));
  expect(posts[0]).not.toHaveProperty('p_allow_possible_duplicate');
  expect(posts[1]).toMatchObject({ p_allow_possible_duplicate: true });
  expect(posts[1].p_operation_id).not.toBe(posts[0].p_operation_id);
  await context.close();
});

// ------------------------------------------------------------------ R6 CSV downloads
test('R6. Day book and dues CSV downloads: the files hold the rows, amounts as rupees with 2 decimals', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await asAccountant(browser);
  await page.goto('/fees/day-book');
  await page.getByLabel('Search').fill(store.btReceipt!);
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(page.getByTestId('day-book-rows')).toContainText(store.btReceipt!, { timeout: 30_000 });
  await expect(page.getByTestId('day-book-totals')).toContainText('Collections1');
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download CSV' }).click(),
  ]);
  expect(dl.suggestedFilename()).toBe(`day-book-${TODAY}-to-${TODAY}.csv`);
  const day = readFileSync((await dl.path())!, 'utf8').split('\r\n');
  expect(day[0]).toBe(
    'Date,Receipt no,Student,Admission no,Method,Account,Reference,Amount (₹),Reversed (₹),Collected by',
  );
  expect(day[1]).toBe(
    `${TODAY},${store.btReceipt},Aarav Sharma,DEMO-S1,Bank transfer,${BANK2},NEFT${RUN}B,${rs(Number(store.btAmount))},0.00,Demo Accountant`,
  );
  expect(day.filter(Boolean)).toHaveLength(2);

  await page.goto('/fees/dues');
  await expect(page.getByTestId('dues-table')).toBeVisible({ timeout: 30_000 });
  const [dd] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download CSV' }).click(),
  ]);
  expect(dd.suggestedFilename()).toBe('dues.csv');
  const dues = readFileSync((await dd.path())!, 'utf8')
    .split('\r\n')
    .filter(Boolean);
  expect(dues[0]).toBe(
    'Student,Admission no,Class,Charged (₹),Paid (₹),Balance (₹),Overdue (₹),Pending cheques (₹),Invoices',
  );
  const year = (await acct.rpc<{ current_year: { id: string } }>('get_context')).current_year.id;
  const rows = await acct.school<{ admission_no: string; balance_paise: number }[]>('get_dues_report', {
    p_academic_year_id: year,
    p_only_with_balance: true,
  });
  const aarav = rows.find((r) => r.admission_no === 'DEMO-S1')!;
  const line = dues.find((l) => l.startsWith('Aarav Sharma,DEMO-S1,'))!;
  expect(line.split(',')[5]).toBe(rs(aarav.balance_paise));
  expect(dues).toHaveLength(rows.length + 2); // header + one per student + total
  const total = rows.reduce((t, r) => t + r.balance_paise, 0);
  expect(dues.at(-1)!.split(',')[5]).toBe(rs(total));
  await context.close();
});

// ------------------------------------------------------------------ R7 owner search
test('R7. The Owner finds a student (search_fee_students) and opens the statement', async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await as(browser, 'demo.owner', pw.owner!, 'dashboard-owner');
  await page.goto('/fees/dues');
  await page.getByLabel("Find a student's statement").fill('DEMO-S1');
  const results = page.getByTestId('student-results');
  await expect(results).toContainText('DEMO-S1 · Class 1 A', { timeout: 30_000 });
  await expect(results).toContainText('Balance');
  await results.getByRole('button', { name: /Aarav Sharma/ }).click();
  await expect(page).toHaveURL(new RegExp(`/fees/students/${ids.aarav}$`));
  await expect(page.getByTestId('statement-student')).toHaveText('Aarav Sharma', { timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Collect payment' })).toHaveCount(0);
  await context.close();
});

// ------------------------------------------------------------------ R8 keyboard only
test('R8. Keyboard-only: find the student, type the amount, save the payment (visible focus)', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await asAccountant(browser);
  const amount = 11_100 + S;
  await page.goto('/fees/collect');
  const search = page.getByLabel('Find student');
  await expect(search).toBeFocused({ timeout: 30_000 });
  await page.keyboard.type('DEMO-S1');
  await expect(page.getByTestId('student-results')).toContainText('Aarav Sharma', { timeout: 30_000 });
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('student-results').getByRole('button').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('statement-student')).toHaveText('Aarav Sharma', { timeout: 30_000 });

  const tabTo = async (target: Locator, max = 40) => {
    for (let i = 0; i < max; i++) {
      if (await target.evaluate((el) => el === document.activeElement)) return;
      await page.keyboard.press('Tab');
    }
    throw new Error('focus never reached the target by Tab');
  };
  await tabTo(page.getByLabel('Amount received'));
  await page.keyboard.type(rs(amount));
  await expect(page.getByTestId('allocation-status')).toContainText('adds up exactly');
  const save = page.getByTestId('save-payment');
  await tabTo(save);
  expect(await save.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/fees\/receipts\//, { timeout: 30_000 });
  await expect(page.getByTestId('receipt-total')).toHaveText(inr(amount));
  // the receipt's Print button is reachable by keyboard too
  await tabTo(page.getByRole('button', { name: 'Print' }));
  expect(
    await page.getByRole('button', { name: 'Print' }).evaluate((el) => el.matches(':focus-visible')),
  ).toBe(true);
  await context.close();
});
