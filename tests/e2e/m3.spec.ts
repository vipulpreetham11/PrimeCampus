import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ApiSession, newPassword, operatorSession, setKnownPassword } from './helpers/api';
import { csv, expectTiles, importRow, runImport } from './helpers/imports';
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
  settled,
  shot,
  signIn,
  TODAY,
  type Seen,
} from './helpers/ui';

// M3 fees, LIVE backend, Demo School only (every login `demo.*`; "Demo School" is asserted before any
// action). Everything is done through the UI. The API helper only gives demo logins a known password,
// looks up ids (students, this run's invoice) and counts rows for the checks.
//
// Each run makes its own fee heads (codes ending in RUN), term, bank account and concession, and issues
// that term for Class 1 A. Payments are allocated to THIS run's invoice only (earlier runs' invoices are
// older and would otherwise take the money first), so the balances below are exact.

const OPERATOR = process.env.E2E_OPERATOR_USERNAME ?? '';
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? '';
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const SHOTS = 'docs/reports/m3-screens';

const H = {
  tuition: { name: `Tuition ${RUN}`, code: `TU${RUN}` },
  lab: { name: `Lab ${RUN}`, code: `LB${RUN}` },
  late: { name: `Late fee ${RUN}`, code: `LF${RUN}` },
};
const TERM = `Term ${RUN}`;
const BANK = `Bank ${RUN}`;
const PRESET = `Tuition 10% ${RUN}`;
const CHEQUE_NO = Date.now().toString().slice(-8);
const UTR = `UTR${RUN}A1`;

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.skip(!OPERATOR || !OPERATOR_PASSWORD, 'E2E_OPERATOR_USERNAME / E2E_OPERATOR_PASSWORD not set');

const seen: Seen[] = [];
const pw: Record<string, string> = {};
const ids: Record<string, string> = {};
const receipts: Record<string, { id: string; no: string }> = {};
let op: ApiSession;
let acct: ApiSession;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  op = await operatorSession();
  await op.enterDemo();
  pw.admin = await setKnownPassword(op, 'demo.admin');
  pw.parent = await setKnownPassword(op, 'demo.parent');
  const find = async (q: string) =>
    (
      await op.school<{ items: { student_id: string; admission_no: string }[] }>('list_students', {
        p_search: q,
      })
    ).items.find((s) => s.admission_no === q)!.student_id;
  ids.aarav = await find('DEMO-S1');
  ids.anaya = await find('DEMO-S2');
  ids.kabir = await find('DEMO-S3');
});
test.afterAll(async () => {
  await acct?.signOut();
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
const asAccountant = (b: Browser, v = DESKTOP) =>
  as(b, 'demo.accountant', pw.accountant!, 'dashboard-accountant', v);

/** The student's statement through the API (checks only). */
async function statement(studentId: string) {
  return acct.school<{
    total_due_paise: number;
    invoices: {
      invoice_id: string;
      invoice_no: string;
      term: string | null;
      balance_paise: number;
      adjustments: { kind: string }[] | null;
    }[];
    collections: { collection_id: string; receipt_id: string; receipt_no: string; amount_paise: number }[];
  }>('get_student_statement', { p_student_id: studentId });
}
async function runInvoice(studentId: string) {
  const st = await statement(studentId);
  return st.invoices.find((i) => i.term === TERM)!;
}

/** Put the whole amount on this run's invoice, 0 on every other open invoice. */
async function allocateOnly(page: Page, invoiceId: string, rupees: string) {
  const inputs = page.getByTestId('allocation-rows').locator('input');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const input = inputs.nth(i);
    const id = await input.getAttribute('id');
    await input.fill(id === `alloc-${invoiceId}` ? rupees : '0');
  }
  await expect(page.getByTestId('allocation-status')).toContainText('adds up exactly');
}

async function openCollect(page: Page, studentId: string, name = 'Aarav Sharma') {
  await page.goto(`/fees/collect?student=${studentId}`);
  await expect(page.getByTestId('statement-student')).toHaveText(name, { timeout: 30_000 });
}

async function invoiceBalance(page: Page, studentId: string, invoiceNo: string) {
  await page.goto(`/fees/students/${studentId}`);
  const card = page.getByTestId(`invoice-${invoiceNo}`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card.getByTestId('invoice-balance').locator('dd');
}

// ------------------------------------------------------------------ 0. logins
test('0. Admin creates (or resets) demo.accountant and demo.owner through Users', async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await as(browser, 'demo.admin', pw.admin!, 'dashboard-admin');
  const page = admin.page;
  for (const [username, role, name] of [
    ['demo.accountant', 'Accountant', 'Demo Accountant'],
    ['demo.owner', 'Owner', 'Demo Owner'],
  ] as const) {
    await page.goto('/users');
    await settled(page.getByRole('list', { name: 'Users' }), page.getByText('No users yet'));
    if (await page.getByTestId(`user-${username}`).isVisible()) {
      pw[role.toLowerCase()] = await setKnownPassword(op, username);
      continue;
    }
    await page.getByRole('button', { name: 'Create login', exact: true }).click();
    const dlg = modal(page);
    await dlg.getByLabel('Username').fill(username);
    await dlg.getByLabel('Full name').fill(name);
    await dlg.getByRole('checkbox', { name: new RegExp(`\\b${role}$`) }).click();
    await dlg.getByRole('button', { name: 'Create login' }).click();
    const noted = page.getByRole('button', { name: /I have noted it/ });
    await expect(noted).toBeVisible({ timeout: 30_000 });
    const temp = (await page.getByTestId('one-time-secret').textContent())?.trim() ?? '';
    await noted.click();
    const u = await newPage(browser, seen);
    await signIn(u.page, username, temp);
    await expect(u.page).toHaveURL(/\/change-password$/, { timeout: 30_000 });
    const pass = newPassword();
    await u.page.getByLabel('Temporary password').fill(temp);
    await u.page.getByLabel('New password', { exact: true }).fill(pass);
    await u.page.getByLabel('Confirm new password').fill(pass);
    await u.page.getByRole('button', { name: 'Save new password' }).click();
    await expect(u.page.getByTestId('context-summary').first()).toContainText(role, { timeout: 30_000 });
    pw[role.toLowerCase()] = pass;
    await u.context.close();
  }
  await admin.context.close();
  acct = await ApiSession.signIn('demo.accountant', pw.accountant!);
  await acct.enterDemo('accountant');
});

// ------------------------------------------------------------------ 1. setup
test('1. Accountant sets up heads, a bank account, a term and a price list (one head left as "No price")', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAccountant(browser);
  await page.goto('/fees');
  await expect(page).toHaveURL(/\/fees\/collect$/);

  await page.goto('/fees/setup?tab=heads');
  for (const [h, kind] of [
    [H.tuition, 'Regular'],
    [H.lab, 'Regular'],
    [H.late, 'Late fee'],
  ] as const) {
    await page.getByRole('button', { name: 'New fee head' }).click();
    const dlg = modal(page);
    await dlg.getByLabel('Name').fill(h.name);
    await dlg.getByLabel('Code').fill(h.code);
    if (kind !== 'Regular') await choose(dlg, 'Kind', kind);
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId(`head-${h.code}`)).toBeVisible({ timeout: 30_000 });
  }
  // the same code again → DUPLICATE under Code
  await page.getByRole('button', { name: 'New fee head' }).click();
  await modal(page).getByLabel('Name').fill('Duplicate');
  await modal(page).getByLabel('Code').fill(H.tuition.code);
  await modal(page).getByRole('button', { name: 'Save' }).click();
  await expect(modal(page).getByText('This code is already used')).toBeVisible();
  await modal(page).getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('tab', { name: 'Receiving accounts' }).click();
  await page.getByRole('button', { name: 'New account' }).click();
  await modal(page).getByLabel('Name', { exact: true }).fill(BANK);
  await modal(page).getByLabel('Bank name').fill('State Bank of India');
  await modal(page)
    .getByLabel(/last 4 digits/)
    .fill('4321');
  await modal(page).getByLabel(/IFSC/).fill('sbin0001234');
  await modal(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId(`account-${BANK}`)).toContainText('SBIN0001234');

  await page.getByRole('tab', { name: 'Terms' }).click();
  await page.getByRole('button', { name: 'New term' }).click();
  await modal(page).getByLabel('Name').fill(TERM);
  await modal(page).getByLabel('Due date').fill(addDays(TODAY, -10));
  await modal(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId(`term-${TERM}`)).toBeVisible({ timeout: 30_000 });

  await page.getByRole('tab', { name: 'Price list' }).click();
  await choose(page, 'Term', TERM);
  const row = page.getByTestId('price-row-Class 1');
  await row.getByLabel(`Class 1 — ${H.tuition.name}`).fill('5,000');
  await expect(row.getByText('Unsaved changes')).toBeVisible();
  await row.getByRole('button', { name: 'Save Class 1' }).click();
  await expect(page.getByText('Class 1: price list saved.')).toBeVisible({ timeout: 30_000 });
  // the Lab head stays empty → "No price", visibly different from ₹0
  const lab = page.getByTestId(`price-Class 1-${H.lab.code}`);
  await expect(lab.getByRole('textbox')).toHaveValue('');
  await expect(lab).toContainText('No price');
  await expect(page.getByTestId(`price-Class 1-${H.tuition.code}`).getByRole('textbox')).toHaveValue(
    '5000.00',
  );
  await context.close();
});

// ------------------------------------------------------------------ 2. concession + invoices
test('2. 10% tuition concession granted to one student; the preview shows it; issue; issue again → nothing new', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAccountant(browser);
  await page.goto('/fees/setup?tab=concessions');
  await page.getByRole('button', { name: 'New concession' }).click();
  const dlg = modal(page);
  await dlg.getByLabel('Name').fill(PRESET);
  await dlg.getByLabel('Percent').fill('10');
  await dlg.getByLabel(`${H.tuition.name} (${H.tuition.code})`).check();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId(`preset-${PRESET}`)).toContainText('10%');

  // granted for this term only (a year-wide grant would clash with the next run's preset)
  await page.goto(`/fees/students/${ids.aarav}`);
  await expect(page.getByTestId('statement-student')).toHaveText('Aarav Sharma', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Grant concession' }).click();
  const g = modal(page);
  await choose(g, 'Concession', new RegExp(`^${PRESET}`));
  await choose(g, 'For', `${TERM} only`);
  await g.getByLabel('Reason').fill(`Sibling discount ${RUN}`);
  await g.getByRole('button', { name: 'Grant' }).click();
  await expect(page.getByTestId(`concession-${PRESET}`)).toBeVisible({ timeout: 30_000 });

  await page.goto('/fees/invoices');
  await choose(page, 'Term', new RegExp(`^${TERM}`));
  await choose(page, 'Students', 'Class 1 A');
  await page.getByRole('button', { name: 'Preview' }).click();
  const aarav = page.getByTestId('preview-DEMO-S1');
  await expect(aarav).toContainText('Will be issued', { timeout: 30_000 });
  await expect(aarav).toContainText(PRESET);
  await expect(aarav).toContainText('net ₹4,500.00');
  await page.getByRole('button', { name: /^Issue \d+ invoices?$/ }).click();
  const result = page.getByTestId('issue-result');
  await expect(result).toContainText(/Issued [1-9]\d* · already existed 0/, { timeout: 60_000 });

  // issue again → nothing new (preview: already issued; the server agrees)
  await page.getByRole('button', { name: 'Preview again' }).click();
  await expect(page.getByTestId('preview-DEMO-S1')).toContainText('Already issued', { timeout: 30_000 });
  await expect(page.getByTestId('preview-summary')).toContainText('0 to issue');
  await expect(page.getByRole('button', { name: 'Issue 0 invoices' })).toBeDisabled();
  const termId = (await acct.school<{ terms: { id: string; name: string }[] }>('get_fee_setup')).terms.find(
    (t) => t.name === TERM,
  )!.id;
  const again = await acct.school<{ issued: number; already_existing: number }>('issue_term_invoices', {
    p_operation_id: crypto.randomUUID(),
    p_term_id: termId,
    p_student_ids: [ids.aarav],
  });
  expect(again).toMatchObject({ issued: 0, already_existing: 1 });
  const inv = await runInvoice(ids.aarav);
  expect(inv.balance_paise).toBe(450000);
  ids.invoice = inv.invoice_id;
  ids.invoiceNo = inv.invoice_no;
  await context.close();
});

// ------------------------------------------------------------------ 3. cash, double click, lost response
test('3. Cash partial payment → receipt; double-click and a lost-response retry → one receipt each (AC-20); balance (AC-19)', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAccountant(browser);
  const before = (await statement(ids.aarav)).collections.length;

  await openCollect(page, ids.aarav);
  await page.getByLabel('Amount received').fill('1,000');
  await allocateOnly(page, ids.invoice!, '1000');
  await page.getByTestId('save-payment').dblclick();
  await expect(page).toHaveURL(/\/fees\/receipts\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.getByTestId('posted-notice')).toHaveText('Payment saved.');
  receipts.cash = {
    id: page.url().split('/').pop()!,
    no: (await page.getByTestId('receipt-no').textContent())!.trim(),
  };
  await expect(page.getByTestId('receipt-total')).toHaveText('₹1,000.00');
  expect((await statement(ids.aarav)).collections.length).toBe(before + 1);

  // the response is lost after the server saved: "Not confirmed" → retry → the same receipt
  await openCollect(page, ids.aarav);
  await page.getByLabel('Amount received').fill('500');
  await allocateOnly(page, ids.invoice!, '500');
  let lost = false;
  await page.route('**/rest/v1/rpc/post_collection', async (route) => {
    if (lost) return route.continue();
    lost = true;
    await route.fetch(); // reaches the server and is saved there
    await route.abort('failed'); // …but the browser never hears back
  });
  await page.getByTestId('save-payment').click();
  const notice = page.getByTestId('unconfirmed');
  await expect(notice).toContainText('Not confirmed — check the statement before trying again.');
  await expect(page.getByLabel('Amount received')).toBeDisabled();
  await notice.getByRole('button', { name: 'Try again (same payment)' }).click();
  await expect(page).toHaveURL(/\/fees\/receipts\//, { timeout: 30_000 });
  await expect(page.getByTestId('posted-notice')).toContainText('already saved');
  await page.unroute('**/rest/v1/rpc/post_collection');
  const posts = seen.filter((s) => s.url.endsWith('/rpc/post_collection')).slice(-2);
  expect(JSON.parse(posts[0]!.body!).p_operation_id).toBe(JSON.parse(posts[1]!.body!).p_operation_id);
  expect((await statement(ids.aarav)).collections.length).toBe(before + 2);

  await expect(await invoiceBalance(page, ids.aarav, ids.invoiceNo!)).toHaveText('₹3,000.00');
  await context.close();
});

// ------------------------------------------------------------------ 4. UPI duplicate reference
test('4. UPI payment with a reference; the same reference again → DUPLICATE naming the earlier receipt', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await asAccountant(browser);
  const pay = async () => {
    await openCollect(page, ids.aarav);
    await choose(page, 'Method', 'UPI');
    await choose(page, 'Received into', `${BANK} (Bank account)`);
    await page.getByLabel('Transaction reference (UTR)').fill(UTR);
    await page.getByLabel('Amount received').fill('700');
    await allocateOnly(page, ids.invoice!, '700');
    await page.getByTestId('save-payment').click();
  };
  await pay();
  await expect(page).toHaveURL(/\/fees\/receipts\//, { timeout: 30_000 });
  receipts.upi = {
    id: page.url().split('/').pop()!,
    no: (await page.getByTestId('receipt-no').textContent())!.trim(),
  };
  await pay();
  await expect(page.getByTestId('duplicate-receipt')).toContainText(
    `Already posted on receipt ${receipts.upi.no}`,
    {
      timeout: 30_000,
    },
  );
  await expect(await invoiceBalance(page, ids.aarav, ids.invoiceNo!)).toHaveText('₹2,300.00');
  await context.close();
});

// ------------------------------------------------------------------ 5. cheque lifecycle
test('5. Cheque: pending (dues unchanged) → cleared → bounced → dues reopen (AC-21)', async ({ browser }) => {
  test.setTimeout(300_000);
  const { context, page } = await asAccountant(browser);
  await openCollect(page, ids.aarav);
  await choose(page, 'Method', 'Cheque');
  await choose(page, 'Deposit into', `${BANK} (Bank account)`);
  await page.getByLabel('Cheque number').fill(CHEQUE_NO);
  await page.getByLabel('Bank (of the cheque)').fill('HDFC Bank');
  await page.getByLabel('Amount received').fill('800');
  await allocateOnly(page, ids.invoice!, '800');
  await page.getByRole('button', { name: 'Record cheque (pending)' }).click();
  await expect(page.getByTestId('cheque-recorded')).toContainText('Cheque recorded — pending.');

  const balance = await invoiceBalance(page, ids.aarav, ids.invoiceNo!);
  await expect(balance).toHaveText('₹2,300.00'); // a pending cheque does not reduce the dues
  const pending = page.getByTestId(`pending-cheque-${CHEQUE_NO}`);
  await expect(pending).toContainText('Pending — not counted as paid');
  await expect(pending).toContainText(`Planned for: ${ids.invoiceNo} ₹800.00`);

  await page.goto('/fees/cheques');
  const row = page.getByTestId(`cheque-${CHEQUE_NO}`);
  await row.getByRole('button', { name: 'Clear' }).click();
  await modal(page).getByRole('button', { name: 'Clear cheque' }).click();
  await expect(page.getByText(/Cheque cleared — receipt RCT\//)).toBeVisible({ timeout: 30_000 });
  await choose(page, 'Status', 'Cleared');
  await expect(page.getByTestId(`cheque-${CHEQUE_NO}`).getByTestId('cheque-status')).toHaveText('Cleared');
  await expect(await invoiceBalance(page, ids.aarav, ids.invoiceNo!)).toHaveText('₹1,500.00');

  await page.goto('/fees/cheques');
  await choose(page, 'Status', 'Cleared');
  await page.getByTestId(`cheque-${CHEQUE_NO}`).getByRole('button', { name: 'Bounced' }).click();
  await modal(page).getByLabel('Reason').fill(`Insufficient funds ${RUN}`);
  await modal(page).getByRole('button', { name: 'Mark bounced' }).click();
  await expect(page.getByText('Bounced — the dues are reopened.')).toBeVisible({ timeout: 30_000 });
  await expect(await invoiceBalance(page, ids.aarav, ids.invoiceNo!)).toHaveText('₹2,300.00');
  await expect(page.getByTestId(`bounced-cheque-${CHEQUE_NO}`)).toContainText(`Insufficient funds ${RUN}`);
  await context.close();
});

// ------------------------------------------------------------------ 6. reversal
test('6. Reverse part of a collection with a reason; the original receipt still prints, with the reversal (AC-22)', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await asAccountant(browser);
  await page.goto(`/fees/students/${ids.aarav}`);
  const pay = page.getByTestId(`payment-${receipts.cash!.no}`);
  await pay.getByRole('button', { name: 'Reverse' }).click();
  const dlg = modal(page);
  await expect(dlg).toContainText('Still reversible: ₹1,000.00');
  await dlg.getByLabel(/Amount to reverse/).fill('300');
  await dlg.getByLabel('Reason').fill(`Entered too much ${RUN}`);
  await dlg.getByRole('button', { name: 'Reverse' }).click();
  await expect(page.getByText('Reversed. Still reversible: ₹700.00.')).toBeVisible({ timeout: 30_000 });
  await expect(pay).toContainText('Partly reversed');
  await expect(await invoiceBalance(page, ids.aarav, ids.invoiceNo!)).toHaveText('₹2,600.00');

  await page.goto(`/fees/receipts/${receipts.cash!.id}`);
  await expect(page.getByTestId('receipt-no')).toHaveText(receipts.cash!.no);
  await expect(page.getByTestId('receipt-total')).toHaveText('₹1,000.00'); // original content
  await expect(page.getByTestId('receipt-reversals')).toContainText(`Entered too much ${RUN}`);
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
  await context.close();
});

// ------------------------------------------------------------------ 7. late fees
test('7. Late-fee rule; Apply late fees twice → one charge; waive with a reason (AC-24)', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAccountant(browser);
  await page.goto('/fees/setup?tab=late-fee');
  await choose(page, 'Late-fee head', `${H.late.name} (${H.late.code})`);
  await page.getByLabel('Amount').fill('100');
  await page.getByLabel('Grace days after the due date').fill('0');
  await page.getByRole('button', { name: /^(Save rule|Replace rule)$/ }).click();
  await expect(page.getByTestId('late-fee-rule')).toContainText(`${H.late.name} ₹100.00`, {
    timeout: 30_000,
  });

  await page.goto('/fees/invoices');
  const apply = async () => {
    await page.getByRole('button', { name: /^Apply late fees/ }).click();
    await modal(page).getByRole('button', { name: 'Apply late fees' }).click();
    return page.getByTestId('late-fee-result');
  };
  await expect(await apply()).toContainText(/Late fees added: [1-9]/, { timeout: 60_000 });
  await expect(await apply()).toContainText('Late fees added: 0.', { timeout: 60_000 });
  let inv = await runInvoice(ids.aarav);
  expect((inv.adjustments ?? []).filter((a) => a.kind === 'late_fee')).toHaveLength(1);
  await expect(await invoiceBalance(page, ids.aarav, ids.invoiceNo!)).toHaveText('₹2,700.00');

  const card = page.getByTestId(`invoice-${ids.invoiceNo}`);
  await card.getByRole('button', { name: 'Waive late fee' }).click();
  await modal(page).getByLabel('Reason').fill(`First delay forgiven ${RUN}`);
  await modal(page).getByRole('button', { name: 'Waive late fee' }).click();
  await expect(page.getByText('Late fee waived.')).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('invoice-balance').locator('dd')).toHaveText('₹2,600.00');
  await card.getByRole('button', { name: 'Details' }).click();
  await expect(card).toContainText('Late fee waived');
  inv = await runInvoice(ids.aarav);
  expect(inv.balance_paise).toBe(260000);
  await context.close();
});

// ------------------------------------------------------------------ 8. over-payment
test('8. Over-payment is blocked, recorded as a payment exception, then resolved (AC-25)', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await asAccountant(browser);
  const due = (await statement(ids.aarav)).total_due_paise;
  await openCollect(page, ids.aarav);
  const typed = String(Math.trunc(due / 100) + 100) + '.' + String(due % 100).padStart(2, '0');
  await page.getByLabel('Amount received').fill(typed);
  await expect(page.getByTestId('overpayment')).toContainText('₹100.00 more than');
  await expect(page.getByTestId('save-payment')).toBeDisabled();
  await page.getByRole('button', { name: 'Record the extra as a payment exception' }).click();
  const dlg = modal(page);
  await expect(dlg.getByLabel('Amount')).toHaveValue('100.00');
  await dlg.getByLabel('Note').fill(`Parent paid ₹100 extra ${RUN}`);
  await dlg.getByRole('button', { name: 'Record exception' }).click();
  await expect(page.getByText('Payment exception recorded.')).toBeVisible({ timeout: 30_000 });
  expect((await statement(ids.aarav)).total_due_paise).toBe(due); // nothing credited

  await page.goto('/fees/exceptions');
  const row = page
    .getByTestId('exception-rows')
    .locator('li')
    .filter({ hasText: `Parent paid ₹100 extra ${RUN}` });
  await expect(row).toContainText('Over-payment');
  await expect(row).toContainText('Open');
  await row.getByRole('button', { name: 'Resolve' }).click();
  await modal(page).getByLabel('How it was resolved').fill(`Refunded in cash ${RUN}`);
  await modal(page).getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('Exception resolved.')).toBeVisible({ timeout: 30_000 });
  await choose(page, 'Show', 'Resolved');
  await expect(
    page
      .getByTestId('exception-rows')
      .locator('li')
      .filter({ hasText: `Refunded in cash ${RUN}` }),
  ).toBeVisible();
  await context.close();
});

// ------------------------------------------------------------------ 9. opening balances import
test('9. Admin imports 3 opening balances (one bad row fixed in the wizard); statement shows them; re-import skips', async ({
  browser,
}) => {
  test.setTimeout(400_000);
  const admin = await as(browser, 'demo.admin', pw.admin!, 'dashboard-admin');
  const page = admin.page;
  const file = csv(`opening-${RUN}.csv`, [
    'Admission no,Fee head code,Amount due (₹),What it is for,Due date,Old reference',
    `DEMO-S1,${H.tuition.code},"1,500.50",Balance 2025-26 ${RUN},,OB${RUN}-1`,
    `DEMO-S2,${H.tuition.code},2000,Balance 2025-26 ${RUN},,OB${RUN}-2`,
    `DEMO-S3,NOPE${RUN},750,Balance 2025-26 ${RUN},,OB${RUN}-3`,
  ]);
  const stage = async (upload: typeof file) => {
    await page.goto('/imports/new?dataset=opening_balances');
    await expect(page.getByRole('radio', { name: /^Opening balances/ })).toBeChecked();
    await page.getByLabel('Spreadsheet file (.xlsx or .csv)').setInputFiles(upload);
    await expect(page.getByText('All required columns are matched.')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Upload rows for checking' }).click();
    await expect(page.getByText(/^All [\d,]+ rows are uploaded and checked\./)).toBeVisible({
      timeout: 120_000,
    });
    await page.getByRole('link', { name: 'Review rows' }).click();
    await expect(page.getByTestId('tile-Ready')).toBeVisible({ timeout: 30_000 });
  };
  await stage(file);
  await expectTiles(page, { Ready: 2, 'Needs fixing': 1 });
  await expect(page.getByTestId('ready-amount')).toHaveText('₹3,500.50');
  // rows are numbered like the spreadsheet (header = row 1): the bad third data row is row 4
  await importRow(page, 4).getByRole('button', { name: 'Edit' }).click();
  await modal(page).getByLabel('Fee head code (required)').fill(H.tuition.code);
  await modal(page).getByRole('button', { name: 'Save and check' }).click();
  await expectTiles(page, { Ready: 3, 'Needs fixing': 0 });
  await expect(page.getByTestId('ready-amount')).toHaveText('₹4,250.50');
  expect(await runImport(page)).toContain('3 imported');
  await page.reload();
  await expect(page.getByTestId('created-amount')).toHaveText('₹4,250.50', { timeout: 30_000 });

  // statement shows the opening balance
  await page.goto(`/fees/students/${ids.aarav}`);
  await expect(page.getByText(`Balance 2025-26 ${RUN}`)).toBeVisible({ timeout: 30_000 });

  // the corrected file again (as staff would re-run it) → every row already exists, nothing is created
  const fixed = csv(`opening-fixed-${RUN}.csv`, [
    'Admission no,Fee head code,Amount due (₹),What it is for,Due date,Old reference',
    `DEMO-S1,${H.tuition.code},"1,500.50",Balance 2025-26 ${RUN},,OB${RUN}-1`,
    `DEMO-S2,${H.tuition.code},2000,Balance 2025-26 ${RUN},,OB${RUN}-2`,
    `DEMO-S3,${H.tuition.code},750,Balance 2025-26 ${RUN},,OB${RUN}-3`,
  ]);
  await stage(fixed);
  await expectTiles(page, { Ready: 0, 'Already exist': 3 });
  await expect(page.getByTestId('ready-amount')).toHaveText('₹0.00');
  expect(await runImport(page)).toContain('0 imported, 3 already existed');
  await admin.context.close();
});

// ------------------------------------------------------------------ 10. owner + parent
test('10. Owner sees reports with no action buttons; parent sees own child statement and receipt, not the other child', async ({
  browser,
}) => {
  test.setTimeout(400_000);
  // a receipt for Anaya (the parent's other child), so "the other child's receipt by URL" is real
  const a = await asAccountant(browser);
  await openCollect(a.page, ids.anaya, 'Anaya Sharma');
  await a.page.getByLabel('Amount received').fill('100');
  await a.page.getByTestId('save-payment').click();
  await expect(a.page).toHaveURL(/\/fees\/receipts\//, { timeout: 30_000 });
  receipts.anaya = { id: a.page.url().split('/').pop()!, no: '' };
  await a.context.close();

  // owner: fees.read only
  const o = await as(browser, 'demo.owner', pw.owner!, 'dashboard-owner');
  await o.page.goto('/fees');
  await expect(o.page).toHaveURL(/\/fees\/dues$/);
  await expect(o.page.getByTestId('dues-table')).toBeVisible({ timeout: 30_000 });
  await expect(o.page.getByTestId('dues-DEMO-S1')).toBeVisible();
  await o.page.goto('/fees/day-book');
  await expect(o.page.getByTestId('day-book-totals')).toBeVisible({ timeout: 30_000 });
  await o.page.goto('/fees/reports');
  await expect(o.page.getByTestId('collection-report')).toBeVisible({ timeout: 30_000 });
  await o.page.goto(`/fees/students/${ids.aarav}`);
  await expect(o.page.getByTestId('statement-student')).toHaveText('Aarav Sharma', { timeout: 30_000 });
  for (const name of [
    'Collect payment',
    'Grant concession',
    'Add opening balance',
    'Reverse',
    'Add adjustment',
  ]) {
    await expect(o.page.getByRole('button', { name })).toHaveCount(0);
    await expect(o.page.getByRole('link', { name })).toHaveCount(0);
  }
  await o.page.goto('/fees/collect');
  await expect(o.page.getByText("You don't have access to this page")).toBeVisible();
  // the server refuses a write too
  const ownerApi = await ApiSession.signIn('demo.owner', pw.owner!);
  await ownerApi.enterDemo('owner');
  await expect(ownerApi.school('save_fee_head', { p_name: 'X', p_code: `X${RUN}` })).rejects.toThrow(
    /FORBIDDEN/,
  );
  await ownerApi.signOut();
  await o.context.close();

  // parent: Aarav selected
  const p = await newPage(browser, seen, PHONE);
  await signIn(p.page, 'demo.parent', pw.parent!);
  await expect(p.page).toHaveURL(/\/choose$/, { timeout: 30_000 });
  await p.page.getByRole('button', { name: /Aarav Sharma/ }).click();
  await expect(p.page.getByTestId('dashboard-parent')).toBeVisible({ timeout: 30_000 });
  await expectDemoSchool(p.page);
  await p.page.goto('/child/fees');
  await expect(p.page.getByTestId('statement-student')).toHaveText('Aarav Sharma', { timeout: 30_000 });
  await expect(p.page.getByTestId('total-due')).toBeVisible();
  await expect(p.page.getByRole('button', { name: 'Reverse' })).toHaveCount(0);
  await noHorizontalScroll(p.page);
  await shot(p.page, `${SHOTS}/375-parent-fees.png`);
  await p.page.getByRole('link', { name: receipts.cash!.no }).click();
  await expect(p.page.getByTestId('receipt-no')).toHaveText(receipts.cash!.no, { timeout: 30_000 });
  await p.page.goto(`/child/fees/receipts/${receipts.anaya.id}`);
  await expect(p.page.getByText("You don't have access to this")).toBeVisible({ timeout: 30_000 });
  await expect(p.page.getByTestId('receipt')).toHaveCount(0);
  await p.context.close();
});

// ------------------------------------------------------------------ screenshots + audit
test('11. 375px screenshots (collect, statement, receipt print preview, dues) and the network audit', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await asAccountant(browser, PHONE);
  await openCollect(page, ids.aarav);
  await page.getByLabel('Amount received').fill('250');
  await expect(page.getByTestId('allocation-status')).toContainText('adds up exactly');
  await noHorizontalScroll(page);
  await shot(page, `${SHOTS}/375-collect-payment.png`);

  await page.goto(`/fees/students/${ids.aarav}`);
  await expect(page.getByTestId(`invoice-${ids.invoiceNo}`)).toBeVisible({ timeout: 30_000 });
  await noHorizontalScroll(page);
  await shot(page, `${SHOTS}/375-statement.png`);

  await page.goto(`/fees/receipts/${receipts.cash!.id}`);
  await expect(page.getByTestId('receipt')).toBeVisible({ timeout: 30_000 });
  await page.emulateMedia({ media: 'print' });
  await page.screenshot({ path: `${SHOTS}/375-receipt-print.png`, fullPage: true });
  await page.emulateMedia({ media: 'screen' });

  await page.goto('/fees/dues');
  await expect(page.getByTestId('dues-m-totals')).toBeVisible({ timeout: 30_000 });
  await noHorizontalScroll(page);
  await shot(page, `${SHOTS}/375-dues.png`);
  await context.close();

  auditNetwork(seen);
  const fees = new Set(
    seen
      .map((s) => /\/rest\/v1\/rpc\/([a-z_0-9]+)$/.exec(new URL(s.url).pathname)?.[1])
      .filter((f): f is string => !!f),
  );
  for (const fn of [
    'get_fee_setup',
    'save_fee_head',
    'save_receiving_account',
    'save_fee_term',
    'save_fee_structure',
    'save_concession_preset',
    'grant_concession',
    'preview_term_invoices',
    'issue_term_invoices',
    'get_student_statement',
    'post_collection',
    'record_cheque',
    'list_cheques',
    'clear_cheque',
    'bounce_cheque',
    'reverse_collection',
    'get_receipt',
    'save_late_fee_rule',
    'evaluate_late_fees',
    'waive_late_fee',
    'record_payment_exception',
    'list_payment_exceptions',
    'resolve_payment_exception',
    'get_dues_report',
    'list_collections',
    'get_collection_report',
    'list_student_concessions',
  ]) {
    expect(fees.has(fn), `${fn} exercised`).toBe(true);
  }
});
