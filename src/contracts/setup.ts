import { z } from '@/lib/zod';

// DTOs for school setup RPCs (migrations 1300, 1800, 1900). Shapes follow the SQL exactly.

const id = z.guid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Postgres `time` as JSON: 'HH:MM:SS'. */
const pgTime = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);

export const DAY_TYPES = ['working', 'half_day', 'holiday', 'weekly_off'] as const;
export type DayType = (typeof DAY_TYPES)[number];
/** Weekly patterns cannot be holidays (SQL check on calendar_patterns). */
export const PATTERN_DAY_TYPES = ['working', 'half_day', 'weekly_off'] as const;
export const SLOT_KINDS = ['period', 'break'] as const;
export const SCHEDULE_KINDS = ['regular', 'half_day', 'special'] as const;
export const ATTENDANCE_MODES = ['daily', 'period'] as const;

export const schoolProfileSchema = z.object({
  school_id: id,
  name: z.string(),
  code: z.string(),
  udise_code: z.string().nullable(),
  board: z.string().nullable(),
  affiliation_no: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address_line: z.string().nullable(),
  city: z.string().nullable(),
  district: z.string().nullable(),
  state: z.string().nullable(),
  pincode: z.string().nullable(),
  logo_url: z.string().nullable(),
  timezone: z.string(),
  status: z.string(),
  version: z.number().int(),
  can_edit: z.boolean(),
});
export type SchoolProfile = z.infer<typeof schoolProfileSchema>;

export const academicYearRowSchema = z.object({
  id,
  name: z.string(),
  start_date: isoDate,
  end_date: isoDate,
  is_current: z.boolean(),
  status: z.string(),
  version: z.number().int(),
});
export type AcademicYearRow = z.infer<typeof academicYearRowSchema>;

export const classRowSchema = z.object({
  id,
  name: z.string(),
  sort_order: z.number().int(),
  status: z.enum(['active', 'retired']),
  version: z.number().int(),
});
export type ClassRow = z.infer<typeof classRowSchema>;

export const sectionRowSchema = z.object({
  id,
  academic_year_id: id,
  class_id: id,
  name: z.string(),
  capacity: z.number().int().nullable(),
  sort_order: z.number().int(),
  status: z.enum(['active', 'retired']),
  version: z.number().int(),
});
export type SectionRow = z.infer<typeof sectionRowSchema>;

export const subjectRowSchema = z.object({
  id,
  name: z.string(),
  code: z.string(),
  status: z.enum(['active', 'retired']),
  version: z.number().int(),
});
export type SubjectRow = z.infer<typeof subjectRowSchema>;

export const slotSchema = z.object({
  ordinal: z.number().int(),
  label: z.string(),
  kind: z.enum(SLOT_KINDS),
  start_time: pgTime,
  end_time: pgTime,
});
export type Slot = z.infer<typeof slotSchema>;

export const periodScheduleSchema = z.object({
  id,
  name: z.string(),
  kind: z.enum(SCHEDULE_KINDS),
  effective_from: isoDate,
  effective_to: isoDate.nullable(),
  // jsonb_agg over zero slots is null
  slots: z
    .array(slotSchema)
    .nullable()
    .transform((v) => v ?? []),
});
export type PeriodSchedule = z.infer<typeof periodScheduleSchema>;

export const setupSnapshotSchema = z.object({
  academic_years: z.array(academicYearRowSchema),
  selected_year_id: id.nullable(),
  classes: z.array(classRowSchema),
  sections: z.array(sectionRowSchema),
  subjects: z.array(subjectRowSchema),
  period_schedules: z.array(periodScheduleSchema),
  attendance_mode_today: z.enum(ATTENDANCE_MODES),
  attendance_modes: z.array(z.object({ mode: z.enum(ATTENDANCE_MODES), effective_from: isoDate })),
});
export type SetupSnapshot = z.infer<typeof setupSnapshotSchema>;

export const classSubjectSchema = z.object({
  id,
  class_id: id,
  subject_id: id,
  subject: z.string(),
  code: z.string(),
  is_optional: z.boolean(),
  sort_order: z.number().int(),
  status: z.string(),
});
export type ClassSubject = z.infer<typeof classSubjectSchema>;

export const calendarSchema = z.object({
  academic_year: z.object({ id, name: z.string(), start_date: isoDate, end_date: isoDate }),
  audience: z.enum(['student', 'staff']),
  staff_group_id: id.nullable(),
  patterns: z.array(
    z.object({
      id,
      weekday: z.number().int().min(1).max(7),
      day_type: z.enum(PATTERN_DAY_TYPES),
      period_schedule_id: id.nullable(),
      staff_group_id: id.nullable(),
      version: z.number().int(),
    }),
  ),
  overrides: z.array(
    z.object({
      id,
      date: isoDate,
      day_type: z.enum(DAY_TYPES),
      period_schedule_id: id.nullable(),
      label: z.string().nullable(),
      reason: z.string().nullable(),
      is_exam_day: z.boolean(),
      staff_group_id: id.nullable(),
      version: z.number().int(),
    }),
  ),
  resolved: z.array(
    z.object({
      date: isoDate,
      day_type: z.enum(DAY_TYPES),
      weight: z.number(),
      period_schedule_id: id.nullable(),
      label: z.string().nullable(),
    }),
  ),
  totals: z.object({
    working_days: z.number().int(),
    half_days: z.number().int(),
    holidays: z.number().int(),
    weekly_offs: z.number().int(),
    working_weight: z.number(),
  }),
});
export type Calendar = z.infer<typeof calendarSchema>;
export type ResolvedDay = Calendar['resolved'][number];

export const schoolProfileSavedSchema = z.object({ school_id: id, version: z.number().int() });
export const yearSavedSchema = z.object({ academic_year_id: id, version: z.number().int() });
export const classSavedSchema = z.object({ class_id: id, version: z.number().int() });
export const sectionSavedSchema = z.object({ section_id: id, version: z.number().int() });
export const subjectSavedSchema = z.object({ subject_id: id, version: z.number().int() });
export const scheduleSavedSchema = z.object({ period_schedule_id: id });
export const calendarRangeSavedSchema = z.object({
  dates_saved: z.number().int(),
  existing_attendance_marks_in_range: z.number().int(),
  note: z.string().nullable(),
});
export const countResultSchema = z.object({ count: z.number().int() });
export const attendanceModeSavedSchema = z.object({
  mode: z.enum(ATTENDANCE_MODES),
  effective_from: isoDate,
});
export const setCurrentYearSchema = z.object({ academic_year_id: id, is_current: z.boolean() });
