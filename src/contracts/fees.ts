import { z } from '@/lib/zod';

// DTOs for the fee RPCs (migrations 1100 and 2300; 2320 additions are optional until it is live).
// Shapes follow the SQL exactly. Money is integer paise; bigint sums arrive as JSON numbers.

const id = z.guid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int();
const paise = z.number().int();
/** jsonb_agg over zero rows is null. */
const list = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .nullable()
    .transform((v) => v ?? []);

export const FEE_HEAD_KINDS = ['regular', 'late_fee', 'other'] as const;
export type FeeHeadKind = (typeof FEE_HEAD_KINDS)[number];
export const ACCOUNT_KINDS = ['cash_desk', 'bank', 'upi'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const PAYMENT_METHODS = ['cash', 'upi', 'bank_transfer', 'cheque'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const CHEQUE_STATUSES = ['pending', 'cleared', 'bounced', 'cancelled'] as const;
export type ChequeStatus = (typeof CHEQUE_STATUSES)[number];
const status = z.enum(['active', 'retired']);
const replayed = z.boolean().optional();

// ---------------------------------------------------------------------------
// Setup (get_fee_setup and its writes)

export const feeHeadSchema = z.object({
  id,
  name: z.string(),
  code: z.string(),
  kind: z.enum(FEE_HEAD_KINDS),
  is_optional: z.boolean(),
  status,
  version: count,
});
export type FeeHead = z.infer<typeof feeHeadSchema>;

export const receivingAccountSchema = z.object({
  id,
  label: z.string(),
  kind: z.enum(ACCOUNT_KINDS),
  bank_name: z.string().nullable(),
  account_last4: z.string().nullable(),
  ifsc: z.string().nullable(),
  upi_id: z.string().nullable(),
  status,
  version: count,
});
export type ReceivingAccount = z.infer<typeof receivingAccountSchema>;

export const feeTermSchema = z.object({
  id,
  name: z.string(),
  sort_order: count,
  due_date: isoDate,
  status,
  version: count,
  invoices_issued: count,
});
export type FeeTerm = z.infer<typeof feeTermSchema>;

export const structureLineSchema = z.object({
  fee_term_id: id,
  class_id: id,
  fee_head_id: id,
  amount_paise: paise,
});
export type StructureLine = z.infer<typeof structureLineSchema>;

export const concessionPresetSchema = z.object({
  id,
  name: z.string(),
  kind: z.enum(['fixed', 'percent']),
  percent_bp: count.nullable(),
  fixed_paise: paise.nullable(),
  status,
  version: count,
  fee_head_ids: z.array(id),
});
export type ConcessionPreset = z.infer<typeof concessionPresetSchema>;

export const lateFeeRuleSchema = z.object({
  id,
  fee_head_id: id,
  amount_paise: paise,
  grace_days: count,
});
export type LateFeeRule = z.infer<typeof lateFeeRuleSchema>;

export const feeSetupSchema = z.object({
  academic_year_id: id.nullable(),
  can_manage: z.boolean(),
  fee_heads: z.array(feeHeadSchema),
  receiving_accounts: z.array(receivingAccountSchema),
  terms: z.array(feeTermSchema),
  structure: z.array(structureLineSchema),
  concession_presets: z.array(concessionPresetSchema),
  late_fee_rule: lateFeeRuleSchema.nullable(),
});
export type FeeSetup = z.infer<typeof feeSetupSchema>;

export const feeHeadSavedSchema = z.object({ fee_head_id: id, version: count });
export const receivingAccountSavedSchema = z.object({ receiving_account_id: id, version: count });
export const feeTermSavedSchema = z.object({
  fee_term_id: id,
  version: count,
  invoices_issued: count,
  note: z.string().nullable(),
});
export type FeeTermSaved = z.infer<typeof feeTermSavedSchema>;
export const feeStructureSavedSchema = z.object({
  fee_term_id: id,
  class_id: id,
  lines: count,
  removed: count,
  invoices_already_issued: count,
  note: z.string().nullable(),
});
export type FeeStructureSaved = z.infer<typeof feeStructureSavedSchema>;
export const concessionPresetSavedSchema = z.object({
  concession_preset_id: id,
  version: count,
  students_using: count,
  note: z.string().nullable(),
});
export const lateFeeRuleSavedSchema = z.object({ late_fee_rule_id: id, note: z.string().nullable() });
export const lateFeeRuleRetiredSchema = z.object({ retired: count });

export const optionalRosterRowSchema = z.object({
  student_id: id,
  name: z.string(),
  admission_no: z.string(),
  roll_no: z.string().nullable(),
  enabled: z.boolean(),
});
export type OptionalRosterRow = z.infer<typeof optionalRosterRowSchema>;
export const optionalFeesSavedSchema = z.object({
  enabled: count,
  disabled: count,
  note: z.string().nullable(),
  replayed,
});
export type OptionalFeesSaved = z.infer<typeof optionalFeesSavedSchema>;

// ---------------------------------------------------------------------------
// Concessions for students

export const studentConcessionSchema = z.object({
  id,
  student_id: id,
  name: z.string(),
  admission_no: z.string(),
  academic_year_id: id,
  preset_id: id,
  preset_name: z.string(),
  kind: z.enum(['fixed', 'percent']),
  percent_bp: count.nullable(),
  fixed_paise: paise.nullable(),
  fee_term_id: id.nullable(),
  term: z.string().nullable(),
  reason: z.string(),
  status: z.enum(['active', 'revoked']),
  granted_by: z.string().nullable(),
  granted_at: z.string(),
  revoked_at: z.string().nullable(),
  revoke_reason: z.string().nullable(),
});
export type StudentConcession = z.infer<typeof studentConcessionSchema>;
export const studentConcessionPageSchema = z.object({
  items: z.array(studentConcessionSchema),
  next_cursor: id.nullable(),
});
export const concessionGrantedSchema = z.object({
  student_concession_id: id,
  issued_invoices_not_changed: z.array(
    z.object({ invoice_id: id, invoice_no: z.string(), term: z.string().nullable() }),
  ),
  replayed,
});
export type ConcessionGranted = z.infer<typeof concessionGrantedSchema>;
export const concessionRevokedSchema = z.object({
  student_concession_id: id,
  status: z.literal('revoked'),
  note: z.string().nullable().optional(),
  replayed,
});

// ---------------------------------------------------------------------------
// Invoicing

export const previewLineSchema = z.object({
  fee_head_id: id,
  label: z.string(),
  gross_paise: paise,
  student_concession_id: id.nullable(),
  concession_name: z.string().nullable(),
  concession_paise: paise,
});
/** compute_term_lines || already_issued. A student without a placement has only skip_reason. */
export const previewRowSchema = z.object({
  student_id: id,
  name: z.string(),
  admission_no: z.string(),
  already_issued: z.boolean(),
  skip_reason: z.string().optional(),
  class_id: id.nullable().optional(),
  class: z.string().nullable().optional(),
  section: z.string().nullable().optional(),
  roll_no: z.string().nullable().optional(),
  lines: z.array(previewLineSchema).optional(),
  concession_conflicts: z.array(id).optional(),
  missing_prices: z.array(z.string()).optional(),
  gross_paise: paise.optional(),
  concession_paise: paise.optional(),
  net_paise: paise.optional(),
});
export type PreviewRow = z.infer<typeof previewRowSchema>;

export const termIssuedSchema = z.object({
  issued: count,
  already_existing: count,
  skipped: z.array(
    z.object({ student_id: id, name: z.string(), admission_no: z.string(), reason: z.string() }),
  ),
  replayed,
});
export type TermIssued = z.infer<typeof termIssuedSchema>;

export const openingBalanceIssuedSchema = z.object({ invoice_id: id, invoice_no: z.string(), replayed });
export type OpeningBalanceIssued = z.infer<typeof openingBalanceIssuedSchema>;
export const adjustmentSavedSchema = z.object({
  adjustment_id: id,
  balance_paise: paise.optional(),
  replayed,
});
export const lateFeesEvaluatedSchema = z.object({
  late_fees_added: count,
  skipped_pending_cheque: z.array(z.string()),
});
export type LateFeesEvaluated = z.infer<typeof lateFeesEvaluatedSchema>;
export const invoiceCancelledSchema = z.object({
  invoice_id: id,
  status: z.literal('cancelled'),
  note: z.string().nullable().optional(),
  replayed,
});

// ---------------------------------------------------------------------------
// Money in / out

export const collectionPostedSchema = z.object({
  collection_id: id,
  receipt_id: id,
  receipt_no: z.string(),
  amount_paise: paise,
  replayed,
});
export type CollectionPosted = z.infer<typeof collectionPostedSchema>;
export const chequeRecordedSchema = z.object({ cheque_id: id, status: z.string().optional(), replayed });
export const collectionReversedSchema = z.object({
  reversal_id: id,
  collection_id: id.optional(),
  reversed_paise: paise.optional(),
  still_reversible_paise: paise.optional(),
  replayed,
});
export type CollectionReversed = z.infer<typeof collectionReversedSchema>;
export const chequeClearedSchema = z.object({
  cheque_id: id,
  collection_id: id.nullable(),
  receipt_id: id.optional(),
  receipt_no: z.string().optional(),
  replayed,
});
export const chequeBouncedSchema = z.object({
  cheque_id: id,
  status: z.string().optional(),
  was_cleared: z.boolean().optional(),
  reversal_id: id.optional(),
  replayed,
});
export const chequeCancelledSchema = z.object({ cheque_id: id, status: z.literal('cancelled'), replayed });
export const exceptionRecordedSchema = z.object({ payment_exception_id: id, replayed });
export const exceptionResolvedSchema = z.object({ id, status: z.literal('resolved'), version: count });

// ---------------------------------------------------------------------------
// Statement and receipt

export const PAYMENT_STATES = ['unpaid', 'partial', 'paid', 'cancelled'] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const invoiceLineSchema = z.object({
  fee_head_id: id.optional(),
  label: z.string(),
  gross_paise: paise,
  concession_paise: paise,
  net_paise: paise,
});
export const ADJUSTMENT_KINDS = [
  'discount',
  'additional_charge',
  'correction',
  'late_fee',
  'late_fee_waiver',
] as const;
export const invoiceAdjustmentSchema = z.object({
  kind: z.string(),
  amount_paise: paise,
  reason: z.string().nullable(),
  at: z.string(),
});
export type InvoiceAdjustment = z.infer<typeof invoiceAdjustmentSchema>;

export const statementInvoiceSchema = z.object({
  invoice_id: id,
  invoice_no: z.string(),
  due_date: isoDate,
  status: z.enum(['issued', 'cancelled']),
  source: z.string(),
  origin_label: z.string().nullable(),
  term: z.string().nullable(),
  year: z.string().nullable(),
  charged_paise: paise,
  adjustments_paise: paise,
  paid_paise: paise,
  balance_paise: paise,
  payment_state: z.enum(PAYMENT_STATES),
  overdue: z.boolean(),
  lines: list(invoiceLineSchema),
  adjustments: list(invoiceAdjustmentSchema),
});
export type StatementInvoice = z.infer<typeof statementInvoiceSchema>;

const allocationSchema = z.object({ invoice_id: id, invoice_no: z.string(), amount_paise: paise });
export type Allocation = z.infer<typeof allocationSchema>;
export const reversalSchema = z.object({
  amount_paise: paise,
  cause: z.string(),
  reason: z.string().nullable(),
  at: z.string(),
});
export type Reversal = z.infer<typeof reversalSchema>;

export const statementCollectionSchema = z.object({
  collection_id: id,
  receipt_id: id,
  receipt_no: z.string(),
  received_on: isoDate,
  method: z.enum(PAYMENT_METHODS),
  amount_paise: paise,
  reference: z.string().nullable().optional(),
  allocations: list(allocationSchema)
    .optional()
    .transform((v) => v ?? []),
  reversed_paise: paise,
  reversals: list(reversalSchema),
});
export type StatementCollection = z.infer<typeof statementCollectionSchema>;

export const pendingChequeSchema = z.object({
  cheque_id: id,
  cheque_no: z.string(),
  bank_name: z.string(),
  amount_paise: paise,
  received_on: isoDate,
  // migration 2320
  cheque_date: isoDate,
  version: count,
  planned_allocations: z.array(allocationSchema),
});
export type PendingCheque = z.infer<typeof pendingChequeSchema>;

export const bouncedChequeSchema = z.object({
  cheque_id: id,
  cheque_no: z.string(),
  amount_paise: paise,
  bounced_on: isoDate.nullable(),
  reason: z.string().nullable(),
});

export const statementSchema = z.object({
  student_id: id,
  // migration 2320: who the statement is for (every fees.read role, incl. Owner who can't list students)
  student: z.object({
    name: z.string(),
    admission_no: z.string(),
    status: z.string(),
    class_id: id.nullable(),
    section_id: id.nullable(),
    class_section: z.string().nullable(),
  }),
  invoices: z.array(statementInvoiceSchema),
  collections: z.array(statementCollectionSchema),
  pending_cheques: z.array(pendingChequeSchema),
  bounced_cheques: z.array(bouncedChequeSchema),
  total_due_paise: paise,
  open_exceptions: count,
});
export type Statement = z.infer<typeof statementSchema>;

export const receiptSnapshotSchema = z.object({
  school_name: z.string().nullable(),
  school_address: z.string().nullable().optional(),
  receipt_no: z.string(),
  date: isoDate,
  student_name: z.string(),
  admission_no: z.string(),
  class_section: z.string().nullable().optional(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().nullable().optional(),
  account: z.string().nullable().optional(),
  payer: z.string().nullable().optional(),
  amount_paise: paise,
  allocations: list(z.object({ invoice_no: z.string(), term: z.string().nullable(), amount_paise: paise })),
  collected_by: z.string().nullable().optional(),
});
export type ReceiptSnapshot = z.infer<typeof receiptSnapshotSchema>;

export const receiptSchema = z.object({
  receipt_id: id,
  receipt_no: z.string(),
  issued_at: z.string(),
  template_version: count.nullable().optional(),
  snapshot: receiptSnapshotSchema,
  reversals: list(reversalSchema),
});
export type Receipt = z.infer<typeof receiptSchema>;

// ---------------------------------------------------------------------------
// Registers and reports

export const chequeRowSchema = z.object({
  cheque_id: id,
  cheque_no: z.string(),
  bank_name: z.string(),
  cheque_date: isoDate,
  amount_paise: paise,
  student_id: id,
  name: z.string(),
  admission_no: z.string(),
  received_on: isoDate,
  status: z.enum(CHEQUE_STATUSES),
  account: z.string().nullable(),
  cleared_on: isoDate.nullable(),
  bounced_on: isoDate.nullable(),
  bounce_reason: z.string().nullable(),
  receipt_no: z.string().nullable(),
  planned_allocations: z.array(allocationSchema),
  version: count,
});
export type ChequeRow = z.infer<typeof chequeRowSchema>;
const dateCursor = z.object({ before_date: isoDate, before_id: id }).nullable();
export const chequePageSchema = z.object({ items: z.array(chequeRowSchema), next_cursor: dateCursor });

export const exceptionRowSchema = z.object({
  id,
  kind: z.enum(['overpayment', 'unidentified', 'other']),
  amount_paise: paise,
  student_id: id.nullable(),
  name: z.string().nullable(),
  admission_no: z.string().nullable(),
  collection_id: id.nullable(),
  receipt_no: z.string().nullable(),
  reference: z.string().nullable(),
  note: z.string(),
  status: z.enum(['open', 'resolved']),
  resolution_note: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  resolved_by: z.string().nullable(),
  resolved_at: z.string().nullable(),
  version: count,
});
export type ExceptionRow = z.infer<typeof exceptionRowSchema>;
export const exceptionPageSchema = z.object({
  items: z.array(exceptionRowSchema),
  next_cursor: id.nullable(),
});

export const collectionRowSchema = z.object({
  collection_id: id,
  receipt_id: id,
  receipt_no: z.string(),
  received_on: isoDate,
  student_id: id,
  name: z.string(),
  admission_no: z.string(),
  method: z.enum(PAYMENT_METHODS),
  amount_paise: paise,
  reversed_paise: paise,
  external_ref: z.string().nullable(),
  payer_name: z.string().nullable(),
  account: z.string(),
  receiving_account_id: id.nullable(),
  collector: z.string().nullable(),
  collected_by: id,
  created_at: z.string(),
});
export type CollectionRow = z.infer<typeof collectionRowSchema>;
export const collectionTotalsSchema = z.object({
  count,
  amount_paise: paise,
  reversed_paise: paise,
});
export type CollectionTotals = z.infer<typeof collectionTotalsSchema>;
export const collectionPageSchema = z.object({
  items: z.array(collectionRowSchema),
  next_cursor: dateCursor,
  // migration 2320: totals for exactly the same filters (every page, not just this one)
  totals: collectionTotalsSchema,
});
export type CollectionPage = z.infer<typeof collectionPageSchema>;

export const duesRowSchema = z.object({
  student_id: id,
  name: z.string(),
  admission_no: z.string(),
  student_status: z.string(),
  class_id: id.nullable(),
  section_id: id.nullable(),
  class_section: z.string().nullable(),
  /** null = the student has no issued invoice in the filter (only cancelled ones) */
  charged_paise: paise.nullable(),
  paid_paise: paise,
  balance_paise: paise,
  overdue_paise: paise,
  invoices: count,
  pending_cheque_paise: paise,
});
export type DuesRow = z.infer<typeof duesRowSchema>;

export const collectionReportSchema = z.object({
  from: isoDate,
  to: isoDate,
  by_day_method: z.array(
    z.object({ date: isoDate, method: z.enum(PAYMENT_METHODS), count, amount_paise: paise }),
  ),
  by_collector: z.array(z.object({ collector: z.string().nullable(), amount_paise: paise })),
  by_account: z.array(z.object({ account: z.string(), amount_paise: paise })),
  gross_posted_paise: paise,
  reversed_paise: paise,
  pending_cheques: z.object({ count, amount_paise: paise }),
  bounced_cheques_in_range: count,
  concessions_paise: paise,
  waivers_paise: paise,
});
export type CollectionReport = z.infer<typeof collectionReportSchema>;
