import { z } from 'zod';
import { ATTENDANCE_MODES, SLOT_KINDS } from './setup';

// DTOs for timetable and lesson RPCs (migrations 1000, 1300, 2200). Shapes follow the SQL exactly.

const id = z.guid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Postgres `time` as JSON: 'HH:MM:SS'. */
const pgTime = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);
const count = z.number().int();
/** jsonb_agg over zero rows is null in some RPCs; treat as an empty list. */
const list = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .nullable()
    .transform((v) => v ?? []);

export const TIMETABLE_STATUSES = ['draft', 'active', 'retired'] as const;
export type TimetableStatus = (typeof TIMETABLE_STATUSES)[number];

export const timetableVersionRowSchema = z.object({
  timetable_version_id: id,
  status: z.enum(TIMETABLE_STATUSES),
  effective_from: isoDate,
  effective_to: isoDate.nullable(),
  period_schedule_id: id,
  period_schedule: z.string(),
  copied_from_id: id.nullable(),
  version: z.number().int(),
  updated_at: z.string(),
  entry_count: count,
  unassigned_teacher_count: count,
});
export type TimetableVersionRow = z.infer<typeof timetableVersionRowSchema>;

/** A teacher double-booked against another section's active timetable (private.timetable_conflicts). */
export const timetableConflictSchema = z.object({
  weekday: z.number().int(),
  slot_ordinal: z.number().int(),
  staff_id: id,
  clashes_with_section_id: id,
  other_slot_ordinal: z.number().int(),
});
export type TimetableConflict = z.infer<typeof timetableConflictSchema>;

export const timetableEntrySchema = z.object({
  weekday: z.number().int().min(1).max(7),
  slot_ordinal: z.number().int(),
  subject_id: id,
  subject: z.string(),
  staff_id: id.nullable(),
  staff: z.string().nullable(),
});
export type TimetableEntry = z.infer<typeof timetableEntrySchema>;

export const timetableVersionSchema = z.object({
  timetable_version_id: id,
  section_id: id,
  section: z.string(),
  class_id: id,
  academic_year_id: id,
  period_schedule_id: id,
  period_schedule: z.string(),
  effective_from: isoDate,
  effective_to: isoDate.nullable(),
  status: z.enum(TIMETABLE_STATUSES),
  copied_from_id: id.nullable(),
  version: z.number().int(),
  can_edit: z.boolean(),
  weekdays: z.array(z.number().int().min(1).max(7)),
  slots: z.array(
    z.object({
      ordinal: z.number().int(),
      label: z.string(),
      kind: z.enum(SLOT_KINDS),
      start_time: pgTime,
      end_time: pgTime,
    }),
  ),
  entries: z.array(timetableEntrySchema),
  conflicts: z.array(timetableConflictSchema),
  unassigned_periods: count,
});
export type TimetableVersion = z.infer<typeof timetableVersionSchema>;
export type TimetableSlot = TimetableVersion['slots'][number];

export const timetableDraftSavedSchema = z.object({
  timetable_version_id: id,
  version: z.number().int(),
  conflicts: z.array(timetableConflictSchema),
  unassigned_periods: count,
  subjects_not_in_class: z.array(z.string()),
});
export type TimetableDraftSaved = z.infer<typeof timetableDraftSavedSchema>;

export const timetableDiscardedSchema = z.object({ timetable_version_id: id, discarded: z.boolean() });
export const timetableActivatedSchema = z.object({
  timetable_version_id: id,
  status: z.literal('active'),
  next_step: z.string(),
});
export const timetableCopiedSchema = z.object({
  timetable_version_id: id,
  status: z.literal('draft'),
  conflicts: z.array(timetableConflictSchema),
});

export const keptLessonSchema = z.object({
  lesson_session_id: z.number().int(),
  date: isoDate,
  section_id: id,
  slot_ordinal: z.number().int(),
});
export type KeptLesson = z.infer<typeof keptLessonSchema>;

export const lessonsGeneratedSchema = z.object({
  created: count,
  updated: count,
  cancelled_unused: count,
  cancelled_timetable_changed: count,
  cancelled_not_working: count,
  kept_used: z.array(keptLessonSchema),
});
export type LessonsGenerated = z.infer<typeof lessonsGeneratedSchema>;

// ---------------------------------------------------------------------------
// Dated lessons (get_date_schedule / get_schedule_range) and lesson actions

export const LESSON_STATUSES = ['scheduled', 'cancelled'] as const;

export const scheduleLessonSchema = z.object({
  lesson_session_id: z.number().int(),
  section_id: id,
  section: z.string(),
  slot_ordinal: z.number().int(),
  slot_label: z.string(),
  start_time: pgTime,
  end_time: pgTime,
  subject: z.string(),
  subject_id: id,
  planned_staff_id: id.nullable(),
  planned_staff: z.string().nullable(),
  actual_staff_id: id.nullable(),
  actual_staff: z.string().nullable(),
  status: z.enum(LESSON_STATUSES),
  cancel_reason: z.string().nullable(),
  version: z.number().int(),
  /** null = the planned teacher's attendance is not marked (or there is no planned teacher). */
  planned_teacher_absent: z.boolean().nullable(),
  planned_teacher_half_day: z.boolean().nullable(),
  has_diary: z.boolean(),
  homework_count: count,
  is_substituted: z.boolean(),
  unassigned: z.boolean(),
});
export type ScheduleLesson = z.infer<typeof scheduleLessonSchema>;

/** private.resolve_day row as JSON (null when the date is outside every academic year). */
export const resolvedDaySchema = z
  .object({
    academic_year_id: id.nullable(),
    day_type: z.string().nullable(),
    weight: z.number().nullable(),
    period_schedule_id: id.nullable(),
    label: z.string().nullable(),
  })
  .nullable();
export type ResolvedDayInfo = z.infer<typeof resolvedDaySchema>;

export const scheduleDaySchema = z.object({
  date: isoDate,
  day: resolvedDaySchema,
  lessons: list(scheduleLessonSchema),
});
export type ScheduleDay = z.infer<typeof scheduleDaySchema>;

export const lessonUpdatedSchema = z.object({
  lesson_session_id: z.number().int(),
  version: z.number().int(),
});

export const SUBSTITUTE_AVAILABILITY = ['present', 'absent', 'half_day', 'unmarked'] as const;
export const substituteSuggestionSchema = z.object({
  staff_id: id,
  name: z.string(),
  availability: z.enum(SUBSTITUTE_AVAILABILITY),
  has_conflict: z.boolean(),
  teaches_subject_in_section: z.boolean(),
});
export type SubstituteSuggestion = z.infer<typeof substituteSuggestionSchema>;

export const substituteAssignedSchema = z.object({
  substitution_id: id,
  lesson_session_id: z.number().int(),
  conflict_overridden: z.boolean(),
  version: z.number().int(),
});

/** CONFLICT details of assign_substitute: why an override reason is needed. */
export const substituteConflictDetailsSchema = z.object({
  has_conflict: z.boolean(),
  is_absent: z.boolean(),
});

export const substitutionRowSchema = z.object({
  substitution_id: id,
  lesson_session_id: z.number().int(),
  date: isoDate,
  slot_label: z.string(),
  start_time: pgTime,
  section: z.string(),
  subject: z.string(),
  original_staff_id: id.nullable(),
  original_staff: z.string().nullable(),
  substitute_staff_id: id,
  substitute_staff: z.string(),
  reason: z.string().nullable(),
  conflict_override_reason: z.string().nullable(),
  status: z.enum(['active', 'replaced', 'cancelled']),
  assigned_by: z.string().nullable(),
  assigned_at: z.string(),
  ended_by: z.string().nullable(),
  ended_at: z.string().nullable(),
});
export type SubstitutionRow = z.infer<typeof substitutionRowSchema>;

// ---------------------------------------------------------------------------
// Teacher "Today"

export const teacherTodaySchema = z.object({
  date: isoDate,
  mode: z.enum(ATTENDANCE_MODES),
  lessons: z.array(
    z.object({
      lesson_session_id: z.number().int(),
      slot_label: z.string(),
      start_time: pgTime,
      end_time: pgTime,
      section_id: id,
      section: z.string(),
      subject: z.string(),
      status: z.enum(LESSON_STATUSES),
      is_substitution: z.boolean(),
      attendance_marked: count,
      eligible: count,
      version: z.number().int(),
      has_diary: z.boolean(),
      homework_count: count,
    }),
  ),
  class_teacher_sections: z.array(
    z.object({ section_id: id, section: z.string(), daily_marked: count, eligible: count }),
  ),
  homework_to_check: z.array(
    z.object({ assignment_id: id, section_id: id, due_on: isoDate, checked: count }),
  ),
});
export type TeacherToday = z.infer<typeof teacherTodaySchema>;
export type TodayLesson = TeacherToday['lessons'][number];
