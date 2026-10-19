import { describe, expect, it } from 'vitest';
import { buildNav } from '@/app/navigation';
import { contextSchema } from '@/contracts/session';
import { statementSchema, type FeeHead, type ReceivingAccount } from '@/contracts/fees';
import {
  checkAllocation,
  allocationList,
  oldestFirst,
  openInvoices,
  totalCap,
} from '@/features/fees/collect/allocation';
import { adjustmentArgs, collectionPayload, duesArgs, openingArgs } from '@/features/fees/hooks';
import { previewOutcome } from '@/features/fees/invoices/InvoicesPage';
import { dayBookCsv, duesCsv, duesTotals, toCsv } from '@/features/fees/reports/csv';
import { optionalChanges } from '@/features/fees/setup/OptionalFeesCard';
import { priceLines } from '@/features/fees/setup/PriceGrid';
import { accountPayload } from '@/features/fees/setup/SetupCards';
import { hasUnwaivedLateFee } from '@/features/fees/statement/StatementPage';
import { AppError } from '@/lib/errors';
import {
  amountInWords,
  formatBasisPoints,
  formatPaise,
  paiseToCsvRupees,
  parsePercentToBasisPoints,
  parseRupees,
} from '@/lib/money';
import { OperationTracker } from '@/lib/operation';
import { contextRow } from './fake-supabase';
import { duesRow, FEE_CAPS, invoiceRow, M3, statementRow } from './m3-fixtures';

const statement = (o = {}) => statementSchema.parse(statementRow(o));

// ------------------------------------------------------------------ money
describe('parseRupees / formatPaise (fee screens)', () => {
  it.each([
    ['4,500.50', 450050],
    ['₹1,00,000', 10000000],
    ['4500', 450000],
    ['0.05', 5],
    ['Rs 250.5', 25050],
    ['12,34,567.89', 123456789],
  ])('parses %s to %i paise', (text, paise) => {
    expect(parseRupees(text)).toEqual({ ok: true, paise });
  });

  it('rejects 3 decimals, negatives, empty text and junk', () => {
    expect(parseRupees('12.555').ok).toBe(false);
    expect(parseRupees('-5').ok).toBe(false);
    expect(parseRupees('').ok).toBe(false);
    expect(parseRupees('  ').ok).toBe(false);
    expect(parseRupees('4.5.0').ok).toBe(false);
    expect(parseRupees('1e3').ok).toBe(false);
  });

  it('0 is refused for amounts and allowed only where a ₹0 price means something', () => {
    expect(parseRupees('0')).toEqual({ ok: false, error: 'Amount must be more than ₹0' });
    expect(parseRupees('0', { allowZero: true })).toEqual({ ok: true, paise: 0 });
  });

  it('formats paise with Indian grouping, never via floats', () => {
    expect(formatPaise(450050)).toBe('₹4,500.50');
    expect(formatPaise(10000000)).toBe('₹1,00,000.00');
    expect(formatPaise(0)).toBe('₹0.00');
    expect(formatPaise(1)).toBe('₹0.01');
    expect(paiseToCsvRupees(450050)).toBe('4500.50');
  });

  it('percent text → basis points and back (1% = 100)', () => {
    expect(parsePercentToBasisPoints('10')).toEqual({ ok: true, bp: 1000 });
    expect(parsePercentToBasisPoints('12.5%')).toEqual({ ok: true, bp: 1250 });
    expect(parsePercentToBasisPoints('0.01')).toEqual({ ok: true, bp: 1 });
    expect(parsePercentToBasisPoints('100')).toEqual({ ok: true, bp: 10000 });
    expect(parsePercentToBasisPoints('0').ok).toBe(false);
    expect(parsePercentToBasisPoints('100.01').ok).toBe(false);
    expect(parsePercentToBasisPoints('12.345').ok).toBe(false);
    expect(formatBasisPoints(1250)).toBe('12.5%');
    expect(formatBasisPoints(1000)).toBe('10%');
    expect(formatBasisPoints(5)).toBe('0.05%');
  });
});

describe('amountInWords (Indian numbering)', () => {
  it.each([
    [0, 'Rupees Zero Only'],
    [5, 'Rupees Zero and Five Paise Only'],
    [100, 'Rupees One Only'],
    [455050, 'Rupees Four Thousand Five Hundred Fifty and Fifty Paise Only'],
    [10000000, 'Rupees One Lakh Only'],
    [1000000000, 'Rupees One Crore Only'],
    [
      123456789,
      'Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only',
    ],
    [
      9999999999,
      'Rupees Nine Crore Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine and Ninety Nine Paise Only',
    ],
    [1100000000000, 'Rupees One Thousand One Hundred Crore Only'],
  ])('%i paise → %s', (paise, words) => {
    expect(amountInWords(paise)).toBe(words);
  });

  it('refuses a negative amount', () => {
    expect(() => amountInWords(-1)).toThrow();
  });
});

// ------------------------------------------------------------------ allocation
describe('allocation (collect payment)', () => {
  it('open invoices are issued ones with a balance, oldest due first', () => {
    const st = statement({
      invoices: [
        invoiceRow({
          invoice_id: M3.inv2,
          invoice_no: 'INV/2',
          due_date: '2026-10-10',
          balance_paise: 300000,
        }),
        invoiceRow({
          invoice_id: M3.inv1,
          invoice_no: 'INV/1',
          due_date: '2026-07-10',
          balance_paise: 450000,
        }),
        invoiceRow({
          invoice_id: M3.inv3,
          invoice_no: 'INV/3',
          status: 'cancelled',
          balance_paise: 0,
          payment_state: 'cancelled',
        }),
      ],
    });
    expect(openInvoices(st, false).map((i) => i.invoice_no)).toEqual(['INV/1', 'INV/2']);
  });

  it('defaults to the oldest due invoice first, each up to its balance', () => {
    const inv = openInvoices(statement(), false);
    expect(oldestFirst(inv, 500000)).toEqual({ [M3.inv1]: 450000, [M3.inv2]: 50000 });
    expect(oldestFirst(inv, 100000)).toEqual({ [M3.inv1]: 100000, [M3.inv2]: 0 });
  });

  it('Save is allowed only when the rows add up exactly and each is within its cap', () => {
    const inv = openInvoices(statement(), false);
    expect(checkAllocation(500000, inv, { [M3.inv1]: 450000, [M3.inv2]: 50000 }).ok).toBe(true);
    const short = checkAllocation(500000, inv, { [M3.inv1]: 400000, [M3.inv2]: 50000 });
    expect(short.ok).toBe(false);
    expect(short.message).toBe('₹500.00 still to allocate.');
    const over = checkAllocation(500000, inv, { [M3.inv1]: 460000, [M3.inv2]: 40000 });
    expect(over.ok).toBe(false);
    expect(over.rowErrors[M3.inv1]).toBe('At most ₹4,500.00 (the amount due)');
    const tooMuch = checkAllocation(100000, inv, { [M3.inv1]: 100000, [M3.inv2]: 50000 });
    expect(tooMuch.message).toBe('Allocated ₹500.00 more than the amount received.');
    expect(checkAllocation(null, inv, {}).message).toBe('Enter the amount received.');
  });

  it('money above the dues is reported as extra and never allocated', () => {
    const inv = openInvoices(statement(), false);
    expect(totalCap(inv)).toBe(750000);
    const c = checkAllocation(800000, inv, oldestFirst(inv, 800000));
    expect(c.ok).toBe(false);
    expect(c.extra).toBe(50000);
    expect(c.message).toBe('₹500.00 more than the dues — this can’t be allocated.'.replace('’', "'"));
  });

  it('a cheque may not plan money other pending cheques already plan (2320 planned allocations)', () => {
    const st = statement({
      pending_cheques: [
        {
          cheque_id: M3.cheque1,
          cheque_no: '123456',
          bank_name: 'HDFC',
          amount_paise: 400000,
          received_on: '2026-10-18',
          cheque_date: '2026-10-18',
          version: 1,
          planned_allocations: [
            { invoice_id: M3.inv1, invoice_no: 'INV/2026-27/00001', amount_paise: 400000 },
          ],
        },
      ],
    });
    const forCheque = openInvoices(st, true);
    expect(forCheque[0]).toMatchObject({ balance_paise: 450000, planned_paise: 400000, cap_paise: 50000 });
    const c = checkAllocation(100000, forCheque, { [M3.inv1]: 100000, [M3.inv2]: 0 });
    expect(c.rowErrors[M3.inv1]).toMatch(/other pending cheques plan ₹4,000\.00/);
    // cash is not limited by pending cheques (they are not paid yet)
    expect(openInvoices(st, false)[0]!.cap_paise).toBe(450000);
  });

  it('sends only rows with an amount, oldest first', () => {
    const inv = openInvoices(statement(), false);
    expect(allocationList(inv, { [M3.inv2]: 100, [M3.inv1]: 0 })).toEqual([
      { invoice_id: M3.inv2, amount_paise: 100 },
    ]);
  });
});

// ------------------------------------------------------------------ RPC payloads
describe('RPC payloads', () => {
  it('post_collection: account/reference only when given; allocations exact', () => {
    expect(
      collectionPayload({
        studentId: M3.student,
        method: 'cash',
        amount: 100,
        receivedOn: '2026-10-19',
        accountId: null,
        reference: null,
        payer: null,
        notes: null,
        allocations: [{ invoice_id: M3.inv1, amount_paise: 100 }],
      }),
    ).toEqual({
      p_student_id: M3.student,
      p_method: 'cash',
      p_amount_paise: 100,
      p_received_on: '2026-10-19',
      p_allocations: [{ invoice_id: M3.inv1, amount_paise: 100 }],
    });
  });

  it('a discount is typed positive and sent negative; an extra charge stays positive', () => {
    expect(
      adjustmentArgs('op', { invoiceId: M3.inv1, kind: 'discount', amount: 5000, reason: 'r' })
        .p_amount_paise,
    ).toBe(-5000);
    expect(
      adjustmentArgs('op', { invoiceId: M3.inv1, kind: 'additional_charge', amount: 5000, reason: 'r' })
        .p_amount_paise,
    ).toBe(5000);
  });

  it('dues always sends the year', () => {
    expect(
      duesArgs({
        yearId: 'y',
        classId: null,
        sectionId: null,
        termId: null,
        onlyOverdue: false,
        onlyWithBalance: true,
      }),
    ).toEqual({ p_academic_year_id: 'y', p_only_overdue: false, p_only_with_balance: true });
  });

  it('opening balance: no due date → p_due_date left out (the server uses the year start)', () => {
    const a = openingArgs({
      studentId: 's',
      yearId: 'y',
      headId: 'h',
      amount: 1,
      origin: 'o',
      reference: 'r',
      dueDate: null,
    });
    expect(a).not.toHaveProperty('p_due_date');
    expect(
      openingArgs({
        studentId: 's',
        yearId: 'y',
        headId: 'h',
        amount: 1,
        origin: 'o',
        reference: 'r',
        dueDate: '2026-07-01',
      }),
    ).toHaveProperty('p_due_date', '2026-07-01');
  });

  it('receiving account edit sends only changed keys; an emptied field is sent as "" (clears it)', () => {
    const original: ReceivingAccount = {
      id: M3.bank,
      label: 'SBI current',
      kind: 'bank',
      bank_name: 'SBI',
      account_last4: '1234',
      ifsc: 'SBIN0001234',
      upi_id: null,
      status: 'active',
      version: 3,
    };
    const base = {
      label: 'SBI current',
      kind: 'bank' as const,
      bank_name: 'SBI',
      account_last4: '1234',
      ifsc: 'sbin0001234',
      upi_id: '',
      status: 'active' as const,
    };
    expect(accountPayload(original, base)).toEqual({});
    expect(accountPayload(original, { ...base, account_last4: '' })).toEqual({ account_last4: '' });
    expect(accountPayload(null, { ...base, upi_id: '' })).toEqual({
      label: 'SBI current',
      kind: 'bank',
      bank_name: 'SBI',
      account_last4: '1234',
      ifsc: 'SBIN0001234',
    });
  });
});

// ------------------------------------------------------------------ operation ids
describe('OperationTracker for money actions', () => {
  const err = (code: string) => new AppError(code as never, 'x', 'req');

  it('keeps the id after a network failure, renews after success', () => {
    const t = new OperationTracker();
    const a = t.idFor({ amount: 1 });
    t.failed(err('NETWORK'));
    expect(t.idFor({ amount: 1 })).toBe(a);
    t.succeeded();
    expect(t.idFor({ amount: 1 })).not.toBe(a);
  });

  it('post_collection CONFLICT ("already being saved") keeps the id; elsewhere CONFLICT renews it', () => {
    const t = new OperationTracker();
    const a = t.idFor({ amount: 1 });
    t.failed(err('CONFLICT'), { keep: ['CONFLICT'] });
    expect(t.idFor({ amount: 1 })).toBe(a);
    t.failed(err('CONFLICT'));
    expect(t.idFor({ amount: 1 })).not.toBe(a);
  });

  it('a definite refusal renews; discarding an unconfirmed payment renews', () => {
    const t = new OperationTracker();
    const a = t.idFor({ amount: 1 });
    t.failed(err('VALIDATION_ERROR'));
    const b = t.idFor({ amount: 1 });
    expect(b).not.toBe(a);
    t.failed(err('UNKNOWN'));
    t.discard();
    expect(t.idFor({ amount: 1 })).not.toBe(b);
  });
});

// ------------------------------------------------------------------ setup / invoicing helpers
const head = (id: string, name: string): FeeHead => ({
  id,
  name,
  code: name.toUpperCase(),
  kind: 'regular',
  is_optional: false,
  status: 'active',
  version: 1,
});

describe('price list cells', () => {
  const heads = [head(M3.tuition, 'Tuition'), head(M3.lab, 'Lab'), head(M3.transport, 'Bus')];

  it('an empty cell is "No price" (left out); 0 is a ₹0 price (sent)', () => {
    expect(priceLines(heads, { [M3.tuition]: '5,000', [M3.lab]: '', [M3.transport]: '0' })).toEqual({
      lines: [
        { fee_head_id: M3.tuition, amount_paise: 500000 },
        { fee_head_id: M3.transport, amount_paise: 0 },
      ],
      errors: {},
    });
  });

  it('a bad cell is an error under that cell', () => {
    expect(priceLines(heads, { [M3.tuition]: '12.555' }).errors[M3.tuition]).toMatch(/at most 2 decimal/);
  });
});

describe('issue preview outcome (the server order of checks)', () => {
  const base = { student_id: M3.student, name: 'A', admission_no: '1', already_issued: false };
  it.each([
    [{ ...base, already_issued: true, lines: [] }, { kind: 'existing' }],
    [
      { ...base, skip_reason: 'No placement in this academic year' },
      { kind: 'skip', reason: 'No placement in this academic year' },
    ],
    [
      { ...base, lines: [{}], concession_conflicts: [M3.tuition], missing_prices: [] },
      { kind: 'skip', reason: 'More than one concession applies to the same fee head' },
    ],
    [
      { ...base, lines: [{}], concession_conflicts: [], missing_prices: ['Lab fee'] },
      { kind: 'skip', reason: 'No price set for: Lab fee' },
    ],
    [
      { ...base, lines: [], concession_conflicts: [], missing_prices: [] },
      { kind: 'skip', reason: 'No fee lines configured for this class/term' },
    ],
    [{ ...base, lines: [{}], concession_conflicts: [], missing_prices: [] }, { kind: 'issue' }],
  ])('%#', (row, outcome) => {
    expect(previewOutcome(row as never)).toEqual(outcome);
  });
});

describe('statement helpers', () => {
  it('waive is offered only while a late fee is not waived', () => {
    const at = '2026-10-19T00:00:00Z';
    expect(hasUnwaivedLateFee(statement().invoices[0]!)).toBe(false);
    const withFee = statement({
      invoices: [invoiceRow({ adjustments: [{ kind: 'late_fee', amount_paise: 10000, reason: 'x', at }] })],
    });
    expect(hasUnwaivedLateFee(withFee.invoices[0]!)).toBe(true);
    const waived = statement({
      invoices: [
        invoiceRow({
          adjustments: [
            { kind: 'late_fee', amount_paise: 10000, reason: 'x', at },
            { kind: 'late_fee_waiver', amount_paise: -10000, reason: 'y', at },
          ],
        }),
      ],
    });
    expect(hasUnwaivedLateFee(waived.invoices[0]!)).toBe(false);
  });

  it('optional fees send only changed rows', () => {
    const rows = [
      { student_id: 'a', name: 'A', admission_no: '1', roll_no: null, enabled: true },
      { student_id: 'b', name: 'B', admission_no: '2', roll_no: null, enabled: false },
    ];
    expect(optionalChanges(rows, { a: true, b: true })).toEqual([{ student_id: 'b', enabled: true }]);
  });
});

// ------------------------------------------------------------------ reports
describe('dues totals and CSV', () => {
  it('the totals row is the sum of the rows (no issued invoices counts as nothing charged)', () => {
    const rows = [
      duesRow(),
      duesRow({
        student_id: M3.other,
        charged_paise: null,
        paid_paise: 0,
        balance_paise: 0,
        overdue_paise: 0,
      }),
    ];
    expect(duesTotals(rows as never)).toEqual({
      charged: 450000,
      paid: 100000,
      balance: 350000,
      overdue: 350000,
      pendingCheques: 0,
      students: 2,
    });
  });

  it('CSV amounts are rupees with 2 decimals; class not set is written out; formulas are neutralised', () => {
    const csv = duesCsv([duesRow({ class_section: null, name: '=HYPERLINK("x")' })] as never);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toContain('Balance (₹)');
    expect(lines[1]).toBe(
      `"'=HYPERLINK(""x"")",2024/001,Class not set,4500.00,1000.00,3500.00,3500.00,0.00,1`,
    );
    expect(lines[2]).toBe('Total,,1 students,4500.00,1000.00,3500.00,3500.00,0.00,');
    expect(toCsv(['a'], [['x,y']])).toBe('a\r\n"x,y"\r\n');
  });

  it('day book CSV', () => {
    const csv = dayBookCsv([
      {
        collection_id: M3.col1,
        receipt_id: M3.rcpt1,
        receipt_no: 'RCT/1',
        received_on: '2026-10-19',
        student_id: M3.student,
        name: 'Aarav',
        admission_no: '2024/001',
        method: 'bank_transfer',
        amount_paise: 123405,
        reversed_paise: 0,
        external_ref: 'UTR9',
        payer_name: null,
        account: 'SBI',
        receiving_account_id: M3.bank,
        collector: 'Demo Accountant',
        collected_by: M3.other,
        created_at: '2026-10-19T05:00:00Z',
      },
    ]);
    expect(csv.split('\r\n')[1]).toBe(
      '2026-10-19,RCT/1,Aarav,2024/001,Bank transfer,SBI,UTR9,1234.05,0.00,Demo Accountant',
    );
  });
});

// ------------------------------------------------------------------ navigation
describe('capability-driven fee navigation', () => {
  const live = (caps: string[], role: string, student: string | null = null) =>
    buildNav(contextSchema.parse({ ...contextRow(1, role, caps), student_id: student }), false)
      .filter((i) => i.kind === 'live')
      .map((i) => `${i.label} ${(i as { to: string }).to}`);
  const upcoming = (caps: string[], role: string) =>
    buildNav(contextSchema.parse(contextRow(1, role, caps)), false)
      .filter((i) => i.kind === 'upcoming')
      .map((i) => i.label);

  it('accountant and owner get Fees; nobody sees Fees as "coming"', () => {
    expect(live(FEE_CAPS.accountant, 'accountant')).toContain('Fees /fees');
    expect(live(FEE_CAPS.owner, 'owner')).toContain('Fees /fees');
    expect(upcoming(FEE_CAPS.owner, 'owner')).not.toContain('Fees');
  });

  it('parent gets the child Fees page, not the office one', () => {
    const nav = live(FEE_CAPS.parent, 'parent', M3.student);
    expect(nav).toContain('Fees /child/fees');
    expect(nav).not.toContain('Fees /fees');
  });

  it('a teacher gets no fee page', () => {
    expect(
      live(['staff.member', 'lessons.teach', 'timetable.read_all', 'staff.read'], 'teacher').join(),
    ).not.toMatch(/fees/);
  });
});
