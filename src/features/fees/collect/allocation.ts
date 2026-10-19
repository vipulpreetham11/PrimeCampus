import type { Statement } from '@/contracts/fees';
import { formatPaise } from '@/lib/money';

// Allocation of one payment across a student's open invoices (brief §4). Pure functions, unit-tested.
//  - open invoices: issued, balance > 0, oldest due first (due date, then invoice number)
//  - cap per invoice: its balance; for a cheque also minus what other pending cheques already plan
//    to pay (record_cheque refuses more)
//  - Save only when every row is within its cap and the rows add up EXACTLY to the amount

export interface OpenInvoice {
  invoice_id: string;
  invoice_no: string;
  label: string;
  due_date: string;
  overdue: boolean;
  balance_paise: number;
  /** What this payment may put on the invoice. */
  cap_paise: number;
  /** Planned by other pending cheques (known from migration 2320; 0 before). */
  planned_paise: number;
}

export function openInvoices(statement: Statement, forCheque: boolean): OpenInvoice[] {
  const planned = new Map<string, number>();
  for (const ch of statement.pending_cheques) {
    for (const a of ch.planned_allocations ?? []) {
      planned.set(a.invoice_id, (planned.get(a.invoice_id) ?? 0) + a.amount_paise);
    }
  }
  return statement.invoices
    .filter((i) => i.status === 'issued' && i.balance_paise > 0)
    .map((i) => {
      const p = planned.get(i.invoice_id) ?? 0;
      return {
        invoice_id: i.invoice_id,
        invoice_no: i.invoice_no,
        label: i.term ?? i.origin_label ?? i.invoice_no,
        due_date: i.due_date,
        overdue: i.overdue,
        balance_paise: i.balance_paise,
        planned_paise: p,
        cap_paise: forCheque ? Math.max(0, i.balance_paise - p) : i.balance_paise,
      };
    })
    .sort((a, b) =>
      a.due_date === b.due_date ? a.invoice_no.localeCompare(b.invoice_no) : a.due_date < b.due_date ? -1 : 1,
    );
}

export type Allocations = Record<string, number>;

/** Default: fill the oldest due invoice first, each up to its cap. */
export function oldestFirst(invoices: OpenInvoice[], amount: number): Allocations {
  const out: Allocations = {};
  let left = Math.max(0, amount);
  for (const inv of invoices) {
    const take = Math.min(inv.cap_paise, left);
    out[inv.invoice_id] = take;
    left -= take;
  }
  return out;
}

export const totalCap = (invoices: OpenInvoice[]) => invoices.reduce((s, i) => s + i.cap_paise, 0);

export interface AllocationCheck {
  ok: boolean;
  sum: number;
  /** Amount minus what the invoices can take (> 0 = over-payment). */
  extra: number;
  /** Per invoice: a problem with that row. */
  rowErrors: Record<string, string>;
  /** Whole-form problem, e.g. "₹100 still to allocate". */
  message: string | null;
}

export function checkAllocation(
  amount: number | null,
  invoices: OpenInvoice[],
  alloc: Allocations,
  invalidRows: ReadonlySet<string> = new Set(),
): AllocationCheck {
  const rowErrors: Record<string, string> = {};
  let sum = 0;
  for (const inv of invoices) {
    const v = alloc[inv.invoice_id] ?? 0;
    if (invalidRows.has(inv.invoice_id)) rowErrors[inv.invoice_id] = 'Enter a valid amount';
    else if (v < 0) rowErrors[inv.invoice_id] = 'Cannot be negative';
    else if (v > inv.cap_paise)
      rowErrors[inv.invoice_id] =
        inv.planned_paise > 0 && v <= inv.balance_paise
          ? `At most ${formatPaise(inv.cap_paise)} (other pending cheques plan ${formatPaise(inv.planned_paise)})`
          : `At most ${formatPaise(inv.cap_paise)} (the amount due)`;
    sum += v;
  }
  const cap = totalCap(invoices);
  const extra = amount === null ? 0 : Math.max(0, amount - cap);
  let message: string | null = null;
  if (invoices.length === 0) message = 'This student has nothing to pay.';
  else if (amount === null || amount <= 0) message = 'Enter the amount received.';
  else if (extra > 0) message = `${formatPaise(extra)} more than the dues — this can't be allocated.`;
  else if (sum < amount) message = `${formatPaise(amount - sum)} still to allocate.`;
  else if (sum > amount) message = `Allocated ${formatPaise(sum - amount)} more than the amount received.`;
  const ok =
    message === null &&
    Object.keys(rowErrors).length === 0 &&
    amount !== null &&
    amount > 0 &&
    sum === amount;
  return { ok, sum, extra, rowErrors, message };
}

/** The allocations sent to the server: rows with an amount, oldest due first. */
export function allocationList(invoices: OpenInvoice[], alloc: Allocations) {
  return invoices
    .filter((i) => (alloc[i.invoice_id] ?? 0) > 0)
    .map((i) => ({ invoice_id: i.invoice_id, amount_paise: alloc[i.invoice_id]! }));
}
