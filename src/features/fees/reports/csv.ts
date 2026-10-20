import type { CollectionRow, DuesRow } from '@/contracts/fees';
import { toCsv } from '@/lib/csv';
import { paiseToCsvRupees } from '@/lib/money';
import { METHOD_LABELS } from '../labels';

// Day book and dues CSV (brief §8); the cell rules live in @/lib/csv.

export { toCsv };

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
