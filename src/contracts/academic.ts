import { z } from 'zod';

// DTOs for diary and homework RPCs (migrations 1000, 2200). Shapes follow the SQL exactly.

const id = z.guid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const pgTime = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);
const count = z.number().int();

// ---------------------------------------------------------------------------
// Diary

export const diaryEntrySchema = z.object({
  lesson: z.object({
    lesson_session_id: z.number().int(),
    date: isoDate,
    slot_label: z.string(),
    start_time: pgTime,
    end_time: pgTime,
    section_id: id,
    section: z.string(),
    subject: z.string(),
    teacher: z.string().nullable(),
    status: z.enum(['scheduled', 'cancelled']),
  }),
  entry: z
    .object({
      diary_entry_id: id,
      body: z.string(),
      version: z.number().int(),
      recorded_by_staff: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .nullable(),
  can_edit: z.boolean(),
});
export type DiaryEntry = z.infer<typeof diaryEntrySchema>;
export type LessonInfo = DiaryEntry['lesson'];

export const diarySavedSchema = z.object({
  diary_entry_id: id,
  version: z.number().int(),
  lesson_date: isoDate,
  entered_at: z.string(),
});

export const diaryListItemSchema = z.object({
  lesson_session_id: z.number().int(),
  date: isoDate,
  slot_label: z.string(),
  start_time: pgTime,
  section_id: id,
  section: z.string(),
  subject: z.string(),
  teacher_id: id.nullable(),
  teacher: z.string().nullable(),
  /** null = no diary written for this lesson ("Missing") */
  diary_entry_id: id.nullable(),
  body: z.string().nullable(),
  version: z.number().int().nullable(),
  updated_at: z.string().nullable(),
});
export type DiaryListItem = z.infer<typeof diaryListItemSchema>;

export const diaryPageSchema = z.object({
  items: z.array(diaryListItemSchema),
  next_cursor: z.object({ before_date: isoDate, before_id: z.number().int() }).nullable(),
});
export type DiaryPage = z.infer<typeof diaryPageSchema>;

export const studentDiaryItemSchema = z.object({
  lesson_session_id: z.number().int(),
  date: isoDate,
  slot_label: z.string(),
  start_time: pgTime,
  subject: z.string(),
  teacher: z.string().nullable(),
  body: z.string(),
  updated_at: z.string(),
});
export type StudentDiaryItem = z.infer<typeof studentDiaryItemSchema>;

// ---------------------------------------------------------------------------
// Homework

export const HOMEWORK_STATES = ['unchecked', 'completed', 'not_completed'] as const;
export type HomeworkState = (typeof HOMEWORK_STATES)[number];
export const CORRECTIONS = ['none', 'required', 'done'] as const;
export type Correction = (typeof CORRECTIONS)[number];

export const homeworkSavedSchema = z.object({ assignment_id: id, version: z.number().int() });

export const homeworkListItemSchema = z.object({
  assignment_id: id,
  section_id: id,
  section: z.string(),
  subject_id: id,
  subject: z.string(),
  assigned_by_staff: id.nullable(),
  assigned_by: z.string().nullable(),
  lesson_session_id: z.number().int().nullable(),
  assigned_on: isoDate,
  due_on: isoDate,
  description: z.string(),
  status: z.enum(['active', 'cancelled']),
  version: z.number().int(),
  eligible: count,
  checked: count,
  completed: count,
  not_completed: count,
  correction_required: count,
  can_edit: z.boolean(),
  can_check: z.boolean(),
});
export type HomeworkListItem = z.infer<typeof homeworkListItemSchema>;

export const homeworkPageSchema = z.object({
  items: z.array(homeworkListItemSchema),
  next_cursor: z.object({ before_date: isoDate, before_id: id }).nullable(),
});
export type HomeworkPage = z.infer<typeof homeworkPageSchema>;

export const homeworkRosterSchema = z.object({
  /** the homework_assignments row as JSON (minus school_id) */
  assignment: z.object({
    id,
    academic_year_id: id,
    section_id: id,
    subject_id: id,
    lesson_session_id: z.number().int().nullable(),
    assigned_by_staff: id.nullable(),
    assigned_on: isoDate,
    due_on: isoDate,
    description: z.string(),
    status: z.enum(['active', 'cancelled']),
    version: z.number().int(),
  }),
  students: z.array(
    z.object({
      student_id: id,
      roll_no: z.string().nullable(),
      name: z.string(),
      state: z.enum(HOMEWORK_STATES),
      correction: z.enum(CORRECTIONS).nullable(),
      observed_on: isoDate.nullable(),
      completed_on: isoDate.nullable(),
      comment: z.string().nullable(),
      version: z.number().int().nullable(),
    }),
  ),
});
export type HomeworkRoster = z.infer<typeof homeworkRosterSchema>;
export type HomeworkRosterStudent = HomeworkRoster['students'][number];

export const homeworkChecksSavedSchema = z.object({
  saved: count,
  conflicts: z.array(
    z.object({
      student_id: id,
      /** 'missing': the check we expected was not found · 'concurrent': someone created it just now */
      reason: z.enum(['missing', 'concurrent']).optional(),
      current_version: z.number().int().optional(),
      current_state: z.enum(['completed', 'not_completed']).optional(),
    }),
  ),
});
export type HomeworkChecksSaved = z.infer<typeof homeworkChecksSavedSchema>;

export const studentHomeworkItemSchema = z.object({
  assignment_id: id,
  subject: z.string(),
  assigned_by: z.string().nullable(),
  assigned_on: isoDate,
  due_on: isoDate,
  description: z.string(),
  state: z.enum(HOMEWORK_STATES),
  correction: z.enum(CORRECTIONS).nullable(),
  observed_on: isoDate.nullable(),
  completed_on: isoDate.nullable(),
  completed_after_due: z.boolean().nullable(),
  observed_after_due: z.boolean().nullable(),
  comment: z.string().nullable(),
});
export type StudentHomeworkItem = z.infer<typeof studentHomeworkItemSchema>;
