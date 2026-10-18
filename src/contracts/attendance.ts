import { z } from 'zod';
import { ATTENDANCE_MODES } from './setup';
import { resolvedDaySchema } from './timetable';

// DTOs for student and staff attendance RPCs (migrations 1000, 2200). Shapes follow the SQL exactly.

const id = z.guid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const pgTime = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);
const count = z.number().int();

/** P present · L late · H half day (daily and staff only) · A absent. No row = Unmarked. */
export const ATTENDANCE_STATUSES = ['P', 'L', 'H', 'A'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
export const PERIOD_STATUSES = ['P', 'L', 'A'] as const satisfies readonly AttendanceStatus[];
export const attendanceStatusSchema = z.enum(ATTENDANCE_STATUSES);

export const ROSTER_KINDS = ['daily', 'period'] as const;
export type RosterKind = (typeof ROSTER_KINDS)[number];

export const markingRosterSchema = z.object({
  section_id: id,
  date: isoDate,
  lesson_session_id: z.number().int().nullable(),
  mode_on_date: z.enum(ATTENDANCE_MODES),
  /** null for a daily roster */
  lesson_status: z.enum(['scheduled', 'cancelled']).nullable(),
  can_mark: z.boolean(),
  day: resolvedDaySchema,
  students: z.array(
    z.object({
      student_id: id,
      roll_no: z.string().nullable(),
      name: z.string(),
      admission_no: z.string(),
      status: attendanceStatusSchema.nullable(),
      version: z.number().int().nullable(),
    }),
  ),
});
export type MarkingRoster = z.infer<typeof markingRosterSchema>;

export const studentMarksSavedSchema = z.object({
  submission_id: z.number().int(),
  marked: count,
  changed: count,
  conflicts: z.array(
    z.object({ student_id: id, current_status: attendanceStatusSchema, current_version: z.number().int() }),
  ),
  eligible: count,
  unmarked_remaining: count,
});
export type StudentMarksSaved = z.infer<typeof studentMarksSavedSchema>;

export const attendanceOverviewSchema = z.object({
  date: isoDate,
  mode: z.enum(ATTENDANCE_MODES),
  day: resolvedDaySchema,
  sections: z.array(
    z.object({
      section_id: id,
      section: z.string(),
      eligible: count,
      marked: count,
      expected: count,
      /** Daily mode: half days count 0.5. Period mode: marks other than A. */
      present: z.number(),
    }),
  ),
});
export type AttendanceOverview = z.infer<typeof attendanceOverviewSchema>;

export const attendanceSummarySchema = z.object({
  student_id: id,
  from: isoDate,
  to: isoDate,
  expected_units: count,
  marked_units: count,
  attended_units: z.number(),
  unmarked_units: count,
  daily_units: count,
  period_units: count,
  marking_coverage_pct: z.number().nullable(),
  percentage: z.number().nullable(),
  is_final: z.boolean(),
  percentage_basis: z.enum(['final', 'provisional_marked_only']),
});
export type AttendanceSummary = z.infer<typeof attendanceSummarySchema>;

export const attendanceRecordSchema = z.object({
  date: isoDate,
  mode: z.enum(ATTENDANCE_MODES),
  day_type: z.string().nullable(),
  weight: z.number(),
  section_id: id,
  section: z.string(),
  /** daily mode on a working day: the mark, or null = Unmarked */
  status: attendanceStatusSchema.nullable(),
  /** period mode: every lesson of the day (cancelled ones included), else null */
  lessons: z
    .array(
      z.object({
        lesson_session_id: z.number().int(),
        slot_label: z.string(),
        start_time: pgTime,
        subject: z.string(),
        teacher: z.string().nullable(),
        lesson_status: z.enum(['scheduled', 'cancelled']),
        status: attendanceStatusSchema.nullable(),
      }),
    )
    .nullable(),
});
export type AttendanceRecord = z.infer<typeof attendanceRecordSchema>;

// ---------------------------------------------------------------------------
// Staff attendance

export const staffAttendanceSchema = z.object({
  date: isoDate,
  can_mark: z.boolean(),
  is_future: z.boolean(),
  staff: z.array(
    z.object({
      staff_id: id,
      employee_no: z.string(),
      name: z.string(),
      staff_group_id: id,
      group: z.string(),
      is_teaching: z.boolean(),
      day: z
        .object({
          day_type: z.string().nullable(),
          weight: z.number().nullable(),
          label: z.string().nullable(),
        })
        .nullable(),
      status: attendanceStatusSchema.nullable(),
      version: z.number().int().nullable(),
      /** fraction of the day on recorded paid leave (1 or 0.5), null = none */
      paid_leave: z.number().nullable(),
    }),
  ),
});
export type StaffAttendance = z.infer<typeof staffAttendanceSchema>;

export const staffMarksSavedSchema = z.object({
  submission_id: z.number().int(),
  marked: count,
  changed: count,
  conflicts: z.array(
    z.object({ staff_id: id, current_status: attendanceStatusSchema, current_version: z.number().int() }),
  ),
});
export type StaffMarksSaved = z.infer<typeof staffMarksSavedSchema>;
