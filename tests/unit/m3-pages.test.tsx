import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { contextSchema } from '@/contracts/session';
import { sessionStore } from '@/lib/session/store';
import { contextRow, fakeSupabase, ids, onRpc, resetFake, rpcCalls } from './fake-supabase';
import {
  collectionRowStmt,
  duesRow,
  FEE_CAPS,
  feeSetupRow,
  invoiceRow,
  M3,
  receiptRow,
  snapshotM3,
  statementRow,
} from './m3-fixtures';

vi.mock('@/lib/supabase', () => ({ supabase: fakeSupabase }));

const { CollectPage } = await import('@/features/fees/collect/CollectPage');
const { StatementPage } = await import('@/features/fees/statement/StatementPage');
const { DuesPage } = await import('@/features/fees/reports/DuesPage');
const { FeeSetupPage } = await import('@/features/fees/setup/FeeSetupPage');
const { InvoicesPage } = await import('@/features/fees/invoices/InvoicesPage');
const { ReceiptPage } = await import('@/features/fees/receipts/ReceiptPage');
const { ChildFeesPage, ChildReceiptPage } = await import('@/features/fees/ChildFees');
const { FeesLayout } = await import('@/features/fees/parts');
const { DayBookPage } = await import('@/features/fees/reports/DayBookPage');

const calls = (fn: string) => rpcCalls.filter((c) => c.fn === fn);
const NETWORK_ERROR = { error: { message: 'TypeError: Failed to fetch' } };
const hinted = (hint: string, message: string, details = '') => ({
  error: { code: 'P0001', hint, message, details },
});

function setCtx(caps: string[], role: string, extra: Record<string, unknown> = {}) {
  sessionStore.reset();
  sessionStore.set({
    status: 'ready',
    account: { accountId: ids.account, username: 'demo.x', displayName: 'Demo', isOperator: false },
    context: contextSchema.parse({ ...contextRow(1, role, caps), ...extra }),
  });
}

function renderAt(path: string, routes: { path: string; element: ReactElement }[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(
    [
      ...routes,
      { path: '/fees/receipts/:receiptId', element: <p>receipt page</p> },
      { path: '*', element: <p>other page</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { qc, router };
}

function baseReads(fn: string) {
  if (fn === 'get_fee_setup') return { data: feeSetupRow() };
  if (fn === 'get_setup_snapshot') return { data: snapshotM3() };
  if (fn === 'list_student_concessions') return { data: { items: [], next_cursor: null } };
  return null;
}

beforeEach(() => {
  resetFake();
  setCtx(FEE_CAPS.accountant, 'accountant');
});

// ------------------------------------------------------------------ collect payment
describe('collect payment', () => {
  const posted = {
    collection_id: M3.col1,
    receipt_id: M3.rcpt1,
    receipt_no: 'RCT/2026-27/00007',
    amount_paise: 500000,
  };

  function open(reply: (fn: string, args: Record<string, unknown> | undefined) => unknown) {
    onRpc((fn, args) => {
      const r = reply(fn, args);
      if (r) return r as never;
      if (fn === 'get_student_statement') return { data: statementRow() };
      return baseReads(fn) ?? { data: null };
    });
    return renderAt(`/fees/collect?student=${M3.student}`, [
      { path: '/fees/collect', element: <CollectPage /> },
    ]);
  }

  async function typeAmount(user: ReturnType<typeof userEvent.setup>, text: string) {
    const input = await screen.findByLabelText('Amount received');
    await user.clear(input);
    await user.type(input, text);
  }

  it('shows the student, allocates oldest due first, and enables Save only when the rows add up', async () => {
    const user = userEvent.setup();
    open(() => null);
    expect(await screen.findByTestId('statement-student')).toHaveTextContent('Aarav Sharma');
    const save = screen.getByTestId('save-payment');
    expect(save).toBeDisabled();
    await typeAmount(user, '5,000');
    const rows = screen.getByTestId('allocation-rows');
    expect(within(rows).getByLabelText('Amount for INV/2026-27/00001')).toHaveValue('4500.00');
    expect(within(rows).getByLabelText('Amount for INV/2026-27/00002')).toHaveValue('500.00');
    expect(screen.getByTestId('allocation-status')).toHaveTextContent('adds up exactly');
    expect(save).toBeEnabled();
    // editing a row so the sum no longer matches disables Save
    const second = within(rows).getByLabelText('Amount for INV/2026-27/00002');
    await user.clear(second);
    await user.type(second, '400');
    expect(screen.getByTestId('allocation-status')).toHaveTextContent('₹100.00 still to allocate');
    expect(save).toBeDisabled();
    // more than an invoice's balance is refused on that row
    const first = within(rows).getByLabelText('Amount for INV/2026-27/00001');
    await user.clear(first);
    await user.type(first, '4600');
    expect(screen.getByText('At most ₹4,500.00 (the amount due)')).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Reset to oldest first' }));
    expect(save).toBeEnabled();
  });

  it('a network failure says "Not confirmed", locks the form and retries with the SAME operation id', async () => {
    const user = userEvent.setup();
    let n = 0;
    const { router } = open((fn) => {
      if (fn !== 'post_collection') return null;
      n += 1;
      return n === 1 ? NETWORK_ERROR : { data: { ...posted, replayed: true } };
    });
    await typeAmount(user, '5000');
    await user.click(screen.getByTestId('save-payment'));
    const notice = await screen.findByTestId('unconfirmed');
    expect(notice).toHaveTextContent('Not confirmed — check the statement before trying again.');
    expect(screen.getByLabelText('Amount received')).toBeDisabled();
    await user.click(within(notice).getByRole('button', { name: 'Try again (same payment)' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/fees/receipts/${M3.rcpt1}`));
    const sent = calls('post_collection');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.args).toEqual(sent[0]!.args);
    expect(router.state.location.state).toEqual({ posted: true, replayed: true });
    expect(sent[0]!.args).toMatchObject({
      p_method: 'cash',
      p_amount_paise: 500000,
      p_allocations: [
        { invoice_id: M3.inv1, amount_paise: 450000 },
        { invoice_id: M3.inv2, amount_paise: 50000 },
      ],
    });
  });

  it('CONFLICT "already being saved" keeps the operation id (unconfirmed, not a refusal)', async () => {
    const user = userEvent.setup();
    let n = 0;
    open((fn) => {
      if (fn !== 'post_collection') return null;
      n += 1;
      return n === 1 ? hinted('CONFLICT', 'This payment is already being saved.') : { data: posted };
    });
    await typeAmount(user, '5000');
    await user.click(screen.getByTestId('save-payment'));
    await user.click(await screen.findByRole('button', { name: 'Try again (same payment)' }));
    await waitFor(() => expect(calls('post_collection')).toHaveLength(2));
    expect(calls('post_collection')[1]!.args!.p_operation_id).toBe(
      calls('post_collection')[0]!.args!.p_operation_id,
    );
  });

  it('a definite refusal renews the id; a DUPLICATE reference names the earlier receipt', async () => {
    const user = userEvent.setup();
    let n = 0;
    open((fn) => {
      if (fn !== 'post_collection') return null;
      n += 1;
      return n === 1
        ? hinted(
            'DUPLICATE',
            'This transaction reference was already posted',
            JSON.stringify({ collection_id: M3.col1, receipt_no: 'RCT/2026-27/00003' }),
          )
        : { data: posted };
    });
    await typeAmount(user, '5000');
    await user.click(screen.getByTestId('save-payment'));
    expect(await screen.findByTestId('duplicate-receipt')).toHaveTextContent(
      'Already posted on receipt RCT/2026-27/00003',
    );
    await user.click(screen.getByTestId('save-payment'));
    await waitFor(() => expect(calls('post_collection')).toHaveLength(2));
    expect(calls('post_collection')[1]!.args!.p_operation_id).not.toBe(
      calls('post_collection')[0]!.args!.p_operation_id,
    );
  });

  it('more than the dues is blocked and offers a payment exception for the extra', async () => {
    const user = userEvent.setup();
    open((fn) => (fn === 'record_payment_exception' ? { data: { payment_exception_id: M3.col1 } } : null));
    await typeAmount(user, '8000');
    expect(screen.getByTestId('overpayment')).toHaveTextContent('₹500.00 more than this student');
    expect(screen.getByTestId('save-payment')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Record the extra as a payment exception' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Amount')).toHaveValue('500.00');
    await user.type(within(dialog).getByLabelText('Note'), 'Parent paid extra');
    await user.click(within(dialog).getByRole('button', { name: 'Record exception' }));
    await waitFor(() => expect(calls('record_payment_exception')).toHaveLength(1));
    expect(calls('record_payment_exception')[0]!.args).toMatchObject({
      p_kind: 'overpayment',
      p_amount_paise: 50000,
      p_student_id: M3.student,
      p_note: 'Parent paid extra',
    });
    expect(calls('post_collection')).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ statement: unknown is never ₹0
describe('statement', () => {
  const at = (role: string, caps: string[]) => {
    setCtx(caps, role);
    return renderAt(`/fees/students/${M3.student}`, [
      { path: '/fees/students/:studentId', element: <StatementPage /> },
    ]);
  };

  it('a failed load shows the error, never "₹0" or "Paid"', async () => {
    onRpc((fn) => (fn === 'get_student_statement' ? NETWORK_ERROR : (baseReads(fn) ?? { data: null })));
    at('accountant', FEE_CAPS.accountant);
    expect(await screen.findByText('You are offline')).toBeInTheDocument();
    expect(screen.queryByText(/₹0\.00/)).toBeNull();
    expect(screen.queryByText('Paid')).toBeNull();
    expect(screen.queryByTestId('total-due')).toBeNull();
  });

  it('while loading, no amount is shown', async () => {
    onRpc(
      (fn) =>
        (fn === 'get_student_statement'
          ? new Promise(() => undefined)
          : (baseReads(fn) ?? { data: null })) as never,
    );
    at('accountant', FEE_CAPS.accountant);
    expect(await screen.findByLabelText('Loading')).toBeInTheDocument();
    expect(screen.queryByTestId('total-due')).toBeNull();
  });

  it('shows dues, states in words, where a payment went, and a pending cheque as not paid', async () => {
    onRpc((fn) =>
      fn === 'get_student_statement'
        ? {
            data: statementRow({
              invoices: [invoiceRow({ paid_paise: 200000, balance_paise: 250000, payment_state: 'partial' })],
              collections: [collectionRowStmt()],
              pending_cheques: [
                {
                  cheque_id: M3.cheque1,
                  cheque_no: '123456',
                  bank_name: 'HDFC',
                  amount_paise: 100000,
                  received_on: '2026-10-18',
                  cheque_date: '2026-10-18',
                  version: 1,
                  planned_allocations: [
                    { invoice_id: M3.inv1, invoice_no: 'INV/2026-27/00001', amount_paise: 100000 },
                  ],
                },
              ],
              total_due_paise: 250000,
            }),
          }
        : (baseReads(fn) ?? { data: null }),
    );
    at('accountant', FEE_CAPS.accountant);
    expect(await screen.findByTestId('total-due')).toHaveTextContent('₹2,500.00');
    expect(screen.getByTestId('payment-state')).toHaveTextContent('Partly paid');
    expect(screen.getByTestId('overdue')).toHaveTextContent('Overdue');
    expect(screen.getByTestId('payment-RCT/2026-27/00007')).toHaveTextContent(
      'Went to: INV/2026-27/00001 ₹2,000.00',
    );
    const cheque = screen.getByTestId('pending-cheque-123456');
    expect(cheque).toHaveTextContent('Pending — not counted as paid');
    expect(cheque).toHaveTextContent('Planned for: INV/2026-27/00001 ₹1,000.00');
    expect(screen.getByRole('button', { name: 'Reverse' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Collect payment' })).toBeInTheDocument();
  });

  it('owner (fees.read only) sees the statement with no action buttons', async () => {
    onRpc((fn) =>
      fn === 'get_student_statement'
        ? { data: statementRow({ collections: [collectionRowStmt()] }) }
        : (baseReads(fn) ?? { data: null }),
    );
    at('owner', FEE_CAPS.owner);
    expect(await screen.findByTestId('statement-student')).toHaveTextContent('Aarav Sharma');
    for (const name of [
      'Collect payment',
      'Grant concession',
      'Add opening balance',
      'Reverse',
      'Add adjustment',
      'Cancel invoice',
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
      expect(screen.queryByRole('link', { name })).toBeNull();
    }
  });
});

// ------------------------------------------------------------------ dues
describe('dues report', () => {
  it('a failure is an error state, not ₹0; the totals row is the sum of the rows', async () => {
    let fail = true;
    onRpc((fn) => {
      if (fn === 'get_dues_report')
        return fail
          ? hinted('TEMPORARILY_UNAVAILABLE', 'x')
          : {
              data: [
                duesRow(),
                duesRow({
                  student_id: M3.other,
                  admission_no: '2024/002',
                  name: 'Kabir',
                  class_section: null,
                  charged_paise: 100000,
                  paid_paise: 0,
                  balance_paise: 100000,
                  overdue_paise: 0,
                }),
              ],
            };
      return baseReads(fn) ?? { data: null };
    });
    const user = userEvent.setup();
    renderAt('/fees/dues', [{ path: '/fees/dues', element: <DuesPage /> }]);
    expect(await screen.findByText('Could not load this')).toBeInTheDocument();
    expect(screen.queryByTestId('dues-totals')).toBeNull();
    expect(screen.queryByText(/₹0\.00/)).toBeNull();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    const totals = await screen.findByTestId('dues-totals');
    expect(totals).toHaveTextContent('Total (2 students)');
    expect(totals).toHaveTextContent('₹4,500.00'); // balance 3500 + 1000
    expect(screen.getByTestId('dues-2024/002')).toHaveTextContent('Class not set');
    expect(calls('get_dues_report')[0]!.args).toMatchObject({ p_academic_year_id: ids.year });
  });
});

// ------------------------------------------------------------------ day book
describe('day book', () => {
  const row = (n: number, amount: number) => ({
    collection_id: `f3f3f3f3-0000-4000-8000-00000000000${n}`,
    receipt_id: `f4f4f4f4-0000-4000-8000-00000000000${n}`,
    receipt_no: `RCT/2026-27/0000${n}`,
    received_on: '2026-10-19',
    student_id: M3.student,
    name: 'Aarav Sharma',
    admission_no: '2024/001',
    method: 'cash',
    amount_paise: amount,
    reversed_paise: 0,
    external_ref: null,
    payer_name: null,
    account: 'Cash',
    receiving_account_id: null,
    collector: 'Demo Accountant',
    collected_by: ids.account,
    created_at: '2026-10-19T05:00:00Z',
  });

  it('totals are the server totals for the filters (all pages), not the sum of the rows loaded', async () => {
    onRpc((fn) => {
      if (fn === 'list_collections')
        return {
          data: {
            items: [row(1, 100000), row(2, 50000)],
            next_cursor: { before_date: '2026-10-19', before_id: 'f3f3f3f3-0000-4000-8000-000000000002' },
            totals: { count: 7, amount_paise: 900000, reversed_paise: 30000 },
          },
        };
      return baseReads(fn) ?? { data: null };
    });
    renderAt('/fees/day-book', [{ path: '/fees/day-book', element: <DayBookPage /> }]);
    const totals = await screen.findByTestId('day-book-totals');
    expect(totals).toHaveTextContent('Collections7');
    expect(totals).toHaveTextContent('₹9,000.00');
    expect(totals).toHaveTextContent('₹8,700.00');
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ price list
describe('price list', () => {
  const openGrid = (role: string, caps: string[]) => {
    setCtx(caps, role);
    onRpc((fn) => {
      if (fn === 'save_fee_structure')
        return {
          data: {
            fee_term_id: M3.term1,
            class_id: M3.class1,
            lines: 2,
            removed: 0,
            invoices_already_issued: 0,
            note: null,
          },
        };
      return baseReads(fn) ?? { data: null };
    });
    return renderAt('/fees/setup?tab=prices', [{ path: '/fees/setup', element: <FeeSetupPage /> }]);
  };

  it('read-only: an empty cell says "No price", a ₹0 price says ₹0.00', async () => {
    openGrid('owner', FEE_CAPS.owner);
    await screen.findByTestId('price-grid');
    expect(screen.getByTestId('price-Class 1-BUS')).toHaveTextContent('₹0.00');
    expect(screen.getByTestId('price-Class 1-LAB')).toHaveTextContent('No price');
    expect(screen.getByTestId('price-Class 1-TUITION')).toHaveTextContent('₹5,000.00');
    expect(screen.getByTestId('price-Class 2-TUITION')).toHaveTextContent('No price');
    expect(screen.queryByRole('button', { name: /Save Class/ })).toBeNull();
  });

  it('editing: saving a class sends only priced heads (₹0 included, empty left out)', async () => {
    const user = userEvent.setup();
    openGrid('accountant', FEE_CAPS.accountant);
    await screen.findByTestId('price-grid');
    const row = screen.getByTestId('price-row-Class 1');
    expect(within(row).getByLabelText('Class 1 — Lab fee')).toHaveValue('');
    expect(within(screen.getByTestId('price-Class 1-LAB')).getAllByText('No price').length).toBeGreaterThan(
      0,
    );
    const tuition = within(row).getByLabelText('Class 1 — Tuition fee');
    await user.clear(tuition);
    await user.type(tuition, '5,500');
    expect(within(row).getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Save Class 1' }));
    await waitFor(() => expect(calls('save_fee_structure')).toHaveLength(1));
    expect(calls('save_fee_structure')[0]!.args).toMatchObject({
      p_fee_term_id: M3.term1,
      p_class_id: M3.class1,
      p_lines: [
        { fee_head_id: M3.tuition, amount_paise: 550000 },
        { fee_head_id: M3.transport, amount_paise: 0 },
      ],
    });
  });
});

// ------------------------------------------------------------------ invoicing
describe('issue term invoices', () => {
  const previewRows = [
    {
      student_id: M3.student,
      name: 'Aarav Sharma',
      admission_no: '2024/001',
      already_issued: false,
      class_id: M3.class1,
      class: 'Class 1',
      section: 'A',
      roll_no: '1',
      lines: [
        {
          fee_head_id: M3.tuition,
          label: 'Tuition fee',
          gross_paise: 500000,
          student_concession_id: M3.preset,
          concession_name: 'Sibling 10%',
          concession_paise: 50000,
        },
      ],
      concession_conflicts: [],
      missing_prices: [],
      gross_paise: 500000,
      concession_paise: 50000,
      net_paise: 450000,
    },
    {
      student_id: M3.other,
      name: 'Kabir Rao',
      admission_no: '2024/002',
      already_issued: false,
      class_id: M3.class2,
      class: 'Class 2',
      section: 'A',
      roll_no: '2',
      lines: [],
      concession_conflicts: [],
      missing_prices: ['Tuition fee'],
      gross_paise: 0,
      concession_paise: 0,
      net_paise: 0,
    },
    {
      student_id: 'f1f1f1f1-0000-4000-8000-000000000009',
      name: 'Ira Nair',
      admission_no: '2024/009',
      already_issued: false,
      skip_reason: 'No placement in this academic year',
    },
  ];

  it('the preview names every skipped student with the reason; issuing shows the result with the skipped list', async () => {
    const user = userEvent.setup();
    onRpc((fn) => {
      if (fn === 'preview_term_invoices') return { data: previewRows };
      if (fn === 'issue_term_invoices')
        return {
          data: {
            issued: 1,
            already_existing: 0,
            skipped: [
              {
                student_id: M3.other,
                name: 'Kabir Rao',
                admission_no: '2024/002',
                reason: 'No price set for: Tuition fee',
              },
              {
                student_id: 'f1f1f1f1-0000-4000-8000-000000000009',
                name: 'Ira Nair',
                admission_no: '2024/009',
                reason: 'No placement in this academic year',
              },
            ],
          },
        };
      return baseReads(fn) ?? { data: null };
    });
    renderAt('/fees/invoices', [{ path: '/fees/invoices', element: <InvoicesPage /> }]);
    await user.click(await screen.findByLabelText('Term'));
    await user.click(await screen.findByRole('option', { name: /Term 1/ }));
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByTestId('preview-summary')).toHaveTextContent(
      '1 to issue (₹4,500.00 in total) · 0 already issued · 2 will be skipped',
    );
    expect(screen.getByTestId('preview-2024/001')).toHaveTextContent('Sibling 10%');
    expect(screen.getByTestId('preview-2024/002')).toHaveTextContent('Will be skipped');
    expect(screen.getByTestId('preview-2024/002')).toHaveTextContent('No price set for: Tuition fee');
    expect(screen.getByTestId('preview-2024/009')).toHaveTextContent('No placement in this academic year');
    await user.click(screen.getByRole('button', { name: 'Issue 1 invoice' }));
    const result = await screen.findByTestId('issue-result');
    expect(result).toHaveTextContent('Issued 1 · already existed 0 · skipped 2');
    expect(screen.getByTestId('issue-skipped')).toHaveTextContent(
      'Kabir Rao (2024/002) — No price set for: Tuition fee',
    );
    expect(calls('issue_term_invoices')[0]!.args).toMatchObject({ p_term_id: M3.term1 });
    expect(calls('issue_term_invoices')[0]!.args!.p_operation_id).toEqual(expect.any(String));
  });
});

// ------------------------------------------------------------------ receipts
describe('receipt', () => {
  it('renders from the snapshot only, with the amount in words and reversals under it', async () => {
    onRpc((fn) =>
      fn === 'get_receipt'
        ? {
            data: receiptRow({
              reversals: [
                { amount_paise: 50000, cause: 'error', reason: 'Wrong amount', at: '2026-10-19T08:00:00Z' },
              ],
            }),
          }
        : { data: null },
    );
    renderAt(`/fees/receipts/${M3.rcpt1}`, [{ path: '/fees/receipts/:receiptId', element: <ReceiptPage /> }]);
    const r = await screen.findByTestId('receipt');
    expect(r).toHaveTextContent('Demo School');
    expect(screen.getByTestId('receipt-no')).toHaveTextContent('RCT/2026-27/00007');
    expect(r).toHaveTextContent('Aarav Sharma');
    expect(r).toHaveTextContent('Class 1 A');
    expect(r).toHaveTextContent('UPI · School UPI');
    expect(r).toHaveTextContent('UTR123456');
    expect(screen.getByTestId('receipt-total')).toHaveTextContent('₹4,550.50');
    expect(screen.getByTestId('amount-in-words')).toHaveTextContent(
      'Rupees Four Thousand Five Hundred Fifty and Fifty Paise Only',
    );
    expect(r).toHaveTextContent('Received by: Demo Accountant');
    expect(screen.getByTestId('receipt-reversals')).toHaveTextContent('Wrong amount');
    // only the snapshot was read: no statement or student call
    expect(rpcCalls.map((c) => c.fn)).toEqual(['get_receipt']);
    // print rules: only the receipt prints, A5 by default
    const css = [...document.querySelectorAll('style')].map((x) => x.textContent ?? '').join(' ');
    expect(css).toContain('size: A5 portrait');
    expect(css).toContain('#fee-receipt, #fee-receipt * { visibility: visible');
  });
});

// ------------------------------------------------------------------ parent
describe('parent fee view', () => {
  beforeEach(() => setCtx(FEE_CAPS.parent, 'parent', { student_id: M3.student }));

  it('shows the selected child (from the context, not the URL), read-only', async () => {
    onRpc((fn) =>
      fn === 'get_student_statement'
        ? { data: statementRow({ collections: [collectionRowStmt()] }) }
        : { data: null },
    );
    renderAt('/child/fees', [{ path: '/child/fees', element: <ChildFeesPage /> }]);
    expect(await screen.findByTestId('statement-student')).toHaveTextContent('Aarav Sharma');
    expect(calls('get_student_statement')[0]!.args).toMatchObject({ p_student_id: M3.student });
    expect(screen.getByRole('link', { name: 'RCT/2026-27/00007' })).toHaveAttribute(
      'href',
      `/child/fees/receipts/${M3.rcpt1}`,
    );
    expect(screen.queryByRole('button', { name: 'Reverse' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add adjustment' })).toBeNull();
  });

  it("another child's receipt by URL → no access (the server refuses it)", async () => {
    onRpc((fn) => (fn === 'get_receipt' ? hinted('FORBIDDEN', 'Not permitted') : { data: null }));
    renderAt(`/child/fees/receipts/${M3.rcpt1}`, [
      { path: '/child/fees/receipts/:receiptId', element: <ChildReceiptPage /> },
    ]);
    expect(await screen.findByText("You don't have access to this")).toBeInTheDocument();
    expect(screen.queryByTestId('receipt')).toBeNull();
  });
});

// ------------------------------------------------------------------ fee tabs by capability
describe('fee area tabs', () => {
  const tabs = () =>
    within(screen.getByRole('navigation', { name: 'Fee sections' }))
      .getAllByRole('link')
      .map((l) => l.textContent);

  it('accountant: collect and invoices; owner: reports and registers only', () => {
    renderAt('/fees/dues', [{ path: '/fees/dues', element: <FeesLayout /> }]);
    expect(tabs()).toEqual(expect.arrayContaining(['Collect payment', 'Invoices', 'Dues', 'Fee setup']));
    setCtx(FEE_CAPS.owner, 'owner');
    renderAt('/fees/dues', [{ path: '/fees/dues', element: <FeesLayout /> }]);
    const owner = within(screen.getAllByRole('navigation', { name: 'Fee sections' }).at(-1)!)
      .getAllByRole('link')
      .map((l) => l.textContent);
    expect(owner).not.toContain('Collect payment');
    expect(owner).not.toContain('Invoices');
    expect(owner).toEqual(expect.arrayContaining(['Day book', 'Collection report', 'Dues', 'Cheques']));
  });
});
