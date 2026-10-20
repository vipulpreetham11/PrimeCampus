import type { CollectionRow, DuesRow } from '@/contracts/fees';
import { paiseToCsvRupees } from '@/lib/money';
import { METHOD_LABELS } from '../labels';

// Client-side CSV of the day book and dues (brief §8): built from the RPC rows only, amounts as
// rupees with 2 decimals ("4500.50"), never floats. Text cells that a spreadsheet would run as a
// formula (=, +, -, @) are prefixed with an apostrophe.

type Cell = string | number | null;

function cell(v: Cell, isAmount = false): string {
  if (v === null) return '';
  let s = String(v);
  if (!isAmount && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text (CRLF line ends, as spreadsheets expect). `amountCols` are left unescaped numbers. */
export function toCsv(
  headers: string[],
  rows: Cell[][],
  amountCols: ReadonlySet<number> = new Set(),
): string {
  const lines = [headers.map((h) => cell(h)).join(',')];
  for (const r of rows) lines.push(r.map((v, i) => cell(v, amountCols.has(i))).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function dayBookCsv(rows: CollectionRow[]): string {
  return toCsv(
    [
      'Date',
      'Receipt no',
      'Student',
      'Admission no',
      'Method',
      'Account',
      'Reference',
      'Amount (₹)',
      'Reversed (₹)',
      'Collected by',
    ],
    rows.map((r) => [
      r.received_on,
      r.receipt_no,
      r.name,
      r.admission_no,
      METHOD_LABELS[r.method],
      r.account,
      r.external_ref,
      paiseToCsvRupees(r.amount_paise),
      paiseToCsvRupees(r.reversed_paise),
      r.collector,
    ]),
    new Set([7, 8]),
  );
}

export interface DuesTotals {
  charged: number;
  paid: number;
  balance: number;
  overdue: number;
  pendingCheques: number;
  students: number;
}

/** Totals row = the sum of the rows shown (never a separate figure). Unit-tested. */
export function duesTotals(rows: DuesRow[]): DuesTotals {
  return rows.reduce<DuesTotals>(
    (t, r) => ({
      charged: t.charged + (r.charged_paise ?? 0),
      paid: t.paid + r.paid_paise,
      balance: t.balance + r.balance_paise,
      overdue: t.overdue + r.overdue_paise,
      pendingCheques: t.pendingCheques + r.pending_cheque_paise,
      students: t.students + 1,
    }),
    { charged: 0, paid: 0, balance: 0, overdue: 0, pendingCheques: 0, students: 0 },
  );
}

export function duesCsv(rows: DuesRow[]): string {
  const t = duesTotals(rows);
  const money = (p: number | null) => (p === null ? null : paiseToCsvRupees(p));
  return toCsv(
    [
      'Student',
      'Admission no',
      'Class',
      'Charged (₹)',
      'Paid (₹)',
      'Balance (₹)',
      'Overdue (₹)',
      'Pending cheques (₹)',
      'Invoices',
    ],
    [
      ...rows.map((r) => [
        r.name,
        r.admission_no,
        r.class_section ?? 'Class not set',
        money(r.charged_paise),
        money(r.paid_paise),
        money(r.balance_paise),
        money(r.overdue_paise),
        money(r.pending_cheque_paise),
        r.invoices,
      ]),
      [
        'Total',
        null,
        `${t.students} students`,
        money(t.charged),
        money(t.paid),
        money(t.balance),
        money(t.overdue),
        money(t.pendingCheques),
        null,
      ],
    ],
    new Set([3, 4, 5, 6, 7, 8]),
  );
}
