import { z } from '@/lib/zod';

// DTOs for the salary RPCs (1200 compute_salary, 2400 salary month / paid leave, 2410 marked_days,
// calculated_by and status for every reader). Salary data is confidential: only staff_finance.read
// roles ever receive it (the server checks); these schemas never leave the salary feature.

const id = z.guid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Salary days are numeric(5,2) on the server: 0.5 steps from attendance, 0.25 on half-weight days. */
const days = z.number();
const paise = z.number().int();

export const SALARY_STATUSES = ['not_saved', 'saved', 'changed', 'needs_resolution'] as const;
export type SalaryStatus = (typeof SALARY_STATUSES)[number];

export const markedDaysSchema = z.object({
  present: z.number().int(),
  late: z.number().int(),
  half_day: z.number().int(),
  absent: z.number().int(),
});
export type MarkedDays = z.infer<typeof markedDaysSchema>;

export const salaryDiscrepancySchema = z.object({ date: isoDate, issue: z.string() });
export type SalaryDiscrepancy = z.infer<typeof salaryDiscrepancySchema>;

/** Override keys the server accepts (private.salary_overrides_check). */
export const OVERRIDE_KEYS = [
  'working_days',
  'attended_days',
  'paid_leave_days',
  'monthly_salary_paise',
] as const;
export type OverrideKey = (typeof OVERRIDE_KEYS)[number];
export type SalaryOverrides = Partial<Record<OverrideKey, number>>;

const overridesSchema = z.record(z.string(), z.number());

/** private.compute_salary: preview_salary, and save_salary_calculation (+ id/version/replayed). */
export const salaryComputationSchema = z.object({
  staff_id: id,
  month: isoDate,
  /** null = no salary rate recorded (needs a monthly salary override). */
  monthly_salary_paise: paise.nullable(),
  working_days: days,
  attended_days: days,
  paid_leave_days: days,
  unpaid_days: days,
  marked_days: markedDaysSchema,
  /** null when it can't be calculated (no salary, no working days, paid days above working days). */
  payable_paise: paise.nullable(),
  needs_manual_resolution: z.boolean(),
  resolution_reason: z.string().nullable(),
  unmarked_working_dates: z.array(isoDate),
  discrepancies: z.array(salaryDiscrepancySchema),
  overrides: overridesSchema,
});
export type SalaryComputation = z.infer<typeof salaryComputationSchema>;

export const salarySavedSchema = salaryComputationSchema.extend({
  salary_calculation_id: id,
  version_no: z.number().int(),
  /** Nothing changed since the saved version: no new version was made. */
  replayed: z.literal(true).optional(),
});
export type SalarySaved = z.infer<typeof salarySavedSchema>;

export const savedSnapshotSchema = z.object({
  id,
  version_no: z.number().int(),
  monthly_salary_paise: paise,
  working_days: days,
  attended_days: days,
  paid_leave_days: days,
  unpaid_days: days,
  payable_paise: paise,
  overrides: overridesSchema,
  override_reason: z.string().nullable(),
  created_at: z.string(),
  calculated_by: z.string().nullable(),
});
export type SavedSnapshot = z.infer<typeof savedSnapshotSchema>;

export const liveSummarySchema = z.object({
  monthly_salary_paise: paise.nullable(),
  working_days: days,
  attended_days: days,
  paid_leave_days: days,
  unpaid_days: days,
  payable_paise: paise.nullable(),
  marked_days: markedDaysSchema,
  needs_manual_resolution: z.boolean(),
  resolution_reason: z.string().nullable(),
  unmarked_count: z.number().int(),
  discrepancy_count: z.number().int(),
});
export type LiveSummary = z.infer<typeof liveSummarySchema>;

export const salaryMonthRowSchema = z.object({
  staff_id: id,
  name: z.string(),
  employee_no: z.string(),
  staff_group_id: id.nullable(),
  group: z.string().nullable(),
  joined_on: isoDate,
  left_on: isoDate.nullable(),
  partial_month: z.boolean(),
  status: z.enum(SALARY_STATUSES),
  saved: savedSnapshotSchema.nullable(),
  /** Managers only (staff_finance.manage); null for readers such as the Owner. */
  live: liveSummarySchema.nullable(),
});
export type SalaryMonthRow = z.infer<typeof salaryMonthRowSchema>;

export const salaryMonthSchema = z.object({
  month: isoDate,
  can_manage: z.boolean(),
  rows: z.array(salaryMonthRowSchema),
  totals: z.object({
    staff: z.number().int(),
    saved: z.number().int(),
    changed: z.number().int(),
    needs_resolution: z.number().int(),
    not_saved: z.number().int(),
    saved_payable_paise: paise,
  }),
});
export type SalaryMonth = z.infer<typeof salaryMonthSchema>;

export const salaryVersionSchema = z.object({
  id,
  staff_id: id,
  staff_name: z.string(),
  employee_no: z.string(),
  month: isoDate,
  version_no: z.number().int(),
  status: z.enum(['final', 'superseded']),
  monthly_salary_paise: paise,
  working_days: days,
  attended_days: days,
  paid_leave_days: days,
  unpaid_days: days,
  payable_paise: paise,
  discrepancies: z.unknown(),
  overrides: overridesSchema,
  override_reason: z.string().nullable(),
  created_at: z.string(),
  calculated_by: z.string().nullable(),
});
export type SalaryVersion = z.infer<typeof salaryVersionSchema>;

export const paidLeaveSchema = z.object({
  id,
  staff_id: id,
  name: z.string(),
  leave_date: isoDate,
  day_fraction: z.number(),
  reason: z.string().nullable(),
  status: z.enum(['active', 'cancelled']),
  recorded_by: z.string().nullable(),
  created_at: z.string(),
});
export type PaidLeave = z.infer<typeof paidLeaveSchema>;

export const paidLeaveRecordedSchema = z.object({
  paid_leave_id: id,
  /** e.g. attendance for that day is already marked present. */
  note: z.string().nullable(),
});
export const paidLeaveCancelledSchema = z.object({
  paid_leave_id: id,
  status: z.literal('cancelled'),
});
