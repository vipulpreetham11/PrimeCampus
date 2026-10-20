import type { AccountKind, ChequeStatus, FeeHeadKind, PaymentMethod, PaymentState } from '@/contracts/fees';

// Plain-English labels for fee values. Every state is shown in words (colour is never the only signal).

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
};
export const methodLabel = (m: string) => METHOD_LABELS[m as PaymentMethod] ?? m;

export const HEAD_KIND_LABELS: Record<FeeHeadKind, string> = {
  regular: 'Regular',
  late_fee: 'Late fee',
  other: 'Other',
};

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  cash_desk: 'Cash desk',
  bank: 'Bank account',
  upi: 'UPI',
};

export const PAYMENT_STATE_LABELS: Record<PaymentState, string> = {
  unpaid: 'Unpaid',
  partial: 'Partly paid',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

export const CHEQUE_STATUS_LABELS: Record<ChequeStatus, string> = {
  pending: 'Pending — not counted as paid',
  cleared: 'Cleared',
  bounced: 'Bounced',
  cancelled: 'Cancelled',
};

const ADJUSTMENT_LABELS: Record<string, string> = {
  discount: 'Discount',
  additional_charge: 'Extra charge',
  correction: 'Correction',
  late_fee: 'Late fee',
  late_fee_waiver: 'Late fee waived',
};
export const adjustmentLabel = (k: string) => ADJUSTMENT_LABELS[k] ?? k;

const REVERSAL_CAUSES: Record<string, string> = {
  error: 'Reversed',
  cheque_bounce: 'Cheque bounced',
};
export const reversalCauseLabel = (c: string) => REVERSAL_CAUSES[c] ?? c;

const EXCEPTION_KINDS: Record<string, string> = {
  overpayment: 'Over-payment',
  unidentified: 'Unidentified money',
  other: 'Other',
};
export const exceptionKindLabel = (k: string) => EXCEPTION_KINDS[k] ?? k;

const SOURCES: Record<string, string> = {
  term: 'Term fees',
  opening_balance: 'Opening balance',
};
export const invoiceSourceLabel = (s: string) => SOURCES[s] ?? s;

/** Receiving-account kinds a payment method may use (mirrors _post_collection / record_cheque). */
export const ACCOUNT_KINDS_FOR: Record<PaymentMethod, AccountKind[]> = {
  cash: ['cash_desk'],
  upi: ['upi', 'bank'],
  bank_transfer: ['bank'],
  cheque: ['bank'],
};
