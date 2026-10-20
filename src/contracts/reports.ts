import { z } from '@/lib/zod';
import { ATTENDANCE_MODES } from './setup';

// DTOs for the M4 report RPCs (migration 2400): attendance register, attendance changes, academic
// coverage and fee-head totals. Shapes follow the SQL exactly.

const id = z.guid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int();
const paise = z.number().int();

// ---------------------------------------------------------------------------- register (ATT-03)

export const DAILY_STATUSES = ['P', 'L', 'H', 'A'] as const;
export type DailyStatus = (typeof DAILY_STATUSES)[number];

export const registerDateSchema = z.object({
  date: isoDate,
  weekday: z.number().int().min(1).max(7),
  weight: z.number(),
  /** 'working' / 'half_day' / 'holiday' / 'weekly_off' / … ; 'none' outside every academic year. */
  day_type: z.string(),
  label: z.string().nullable(),
  mode: z.enum(ATTENDANCE_MODES),
});
export type RegisterDate = z.infer<typeof registerDateSchema>;

/** Day-wise cell: P / L / H / A, or null = not marked (never "absent"). */
export const dailyCellSchema = z.object({ s: z.enum(DAILY_STATUSES).nullable() });
/** Period-wise cell: lessons held that day, how many of them have a mark, how many attended. */
export const periodCellSchema = z.object({ held: count, marked: count, attended: count });
export const registerCellSchema = z.union([dailyCellSchema, periodCellSchema]);
export type RegisterCell = z.infer<typeof registerCellSchema>;

export const registerStudentSchema = z.object({
  student_id: id,
  name: z.string(),
  admission_no: z.string(),
  roll_no: z.string().nullable(),
  /** Keyed by date; a date with no key = the student was not in this section that day. */
  cells: z.record(isoDate, registerCellSchema),
  expected_units: z.number(),
  marked_units: z.number(),
  attended_units: z.number(),
  unmarked_units: z.number(),
  /** attended / marked; null when nothing is marked. */
  percentage: z.number().nullable(),
  /** Every expected day / lesson has a mark. Otherwise the totals are provisional. */
  is_final: z.boolean(),
});
export type RegisterStudent = z.infer<typeof registerStudentSchema>;

export const attendanceRegisterSchema = z.object({
  section_id: id,
  section: z.string(),
  month: isoDate,
  /** Last date covered: the month's end or today, whichever is earlier (absent before the month starts). */
  to: isoDate.optional(),
  dates: z.array(registerDateSchema),
  students: z.array(registerStudentSchema),
  note: z.string().optional(),
});
export type AttendanceRegister = z.infer<typeof attendanceRegisterSchema>;

// ---------------------------------------------------------------------------- attendance changes

export const ATTENDANCE_CHANGE_KINDS = ['student_daily', 'student_period', 'staff'] as const;

export const attendanceChangeSchema = z.object({
  id: z.number().int(),
  kind: z.enum(ATTENDANCE_CHANGE_KINDS),
  attendance_date: isoDate,
  person_id: id,
  person: z.string().nullable(),
  admission_no: z.string().nullable(),
  lesson_session_id: z.number().int().nullable(),
  lesson: z.object({ slot_label: z.string(), subject: z.string() }).nullable(),
  section: z.string().nullable(),
  /** null = there was no mark before. */
  old_status: z.string().nullable(),
  new_status: z.string(),
  changed_by: z.string().nullable(),
  changed_by_role: z.string().nullable(),
  changed_at: z.string(),
});
export type AttendanceChange = z.infer<typeof attendanceChangeSchema>;

export const attendanceChangePageSchema = z.object({
  items: z.array(attendanceChangeSchema),
  next_cursor: z.number().int().nullable(),
});
export type AttendanceChangePage = z.infer<typeof attendanceChangePageSchema>;

// ---------------------------------------------------------------------------- academic coverage

export const coverageRowSchema = z.object({
  section_id: id,
  section: z.string(),
  subject_id: id,
  subject: z.string(),
  staff_id: id.nullable(),
  /** 'Unassigned' when no teacher took the lessons. */
  teacher: z.string(),
  lessons: count,
  diary_written: count,
  period_lessons: count,
  period_attendance_marked: count,
  homework_set: count,
  homework_due: count,
  homework_due_fully_checked: count,
  homework_due_unchecked: count,
});
export type CoverageRow = z.infer<typeof coverageRowSchema>;

export const academicCoverageSchema = z.object({
  from: isoDate,
  to: isoDate,
  rows: z.array(coverageRowSchema),
  note: z.string(),
});
export type AcademicCoverage = z.infer<typeof academicCoverageSchema>;

// ---------------------------------------------------------------------------- fee-head totals

export const feeHeadTotalSchema = z.object({
  fee_head_id: id,
  code: z.string(),
  name: z.string(),
  kind: z.string(),
  invoices: count,
  gross_paise: paise,
  concession_paise: paise,
  /** Signed: + extra charges, − discounts / waivers. */
  adjustments_paise: paise,
});
export type FeeHeadTotal = z.infer<typeof feeHeadTotalSchema>;

export const feeHeadReportSchema = z.object({
  academic_year_id: id,
  fee_term_id: id.nullable(),
  heads: z.array(feeHeadTotalSchema),
  adjustments_without_head_paise: paise,
  totals: z.object({ charged_paise: paise, paid_paise: paise, balance_paise: paise }),
  note: z.string(),
});
export type FeeHeadReport = z.infer<typeof feeHeadReportSchema>;
