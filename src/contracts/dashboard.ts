import { z } from '@/lib/zod';
import { ATTENDANCE_MODES } from './setup';
import { resolvedDaySchema } from './timetable';

// get_dashboard (2400, fees block changed in 2410): one capability-scoped summary. A block is
// present only when the role has its capability — the page renders exactly the blocks it gets.

const id = z.guid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int();
const paise = z.number().int();

export const SETUP_ISSUE_CODES = [
  'no_current_year',
  'no_sections',
  'no_timetable',
  'no_class_teacher',
  'no_attendance_mode',
] as const;

export const setupIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  section_id: id.optional(),
});
export type SetupIssue = z.infer<typeof setupIssueSchema>;

export const dashboardSchema = z.object({
  date: isoDate,
  today: isoDate,
  role: z.string(),
  day: resolvedDaySchema,
  attendance: z
    .object({
      mode: z.enum(ATTENDANCE_MODES),
      sections_expected: count,
      sections_complete: count,
      sections_not_started: count,
      expected: count,
      marked: count,
      present: z.number(),
    })
    .optional(),
  staff: z
    .object({
      active_staff: count,
      marked: count,
      absent: count,
      half_day: count,
      lessons_with_absent_teacher: count,
    })
    .optional(),
  academic: z
    .object({
      lessons_today: count,
      diary_missing_last_7_days: count,
      homework_due_unchecked_from: isoDate,
      homework_due_unchecked: count,
    })
    .optional(),
  admissions: z.object({ followups_overdue: count, followups_today: count, open_leads: count }).optional(),
  fees: z
    .object({
      collected_on_date: z.object({ count, amount_paise: paise }),
      academic_year_id: id.nullable(),
      due_paise: paise,
      overdue_paise: paise,
      older_years_due_paise: paise,
      pending_cheques: z.object({ count, amount_paise: paise }),
      open_exceptions: count,
    })
    .optional(),
  salary: z.object({ month: isoDate, staff: count, saved: count, saved_payable_paise: paise }).optional(),
  setup_issues: z.array(setupIssueSchema).optional(),
});
export type Dashboard = z.infer<typeof dashboardSchema>;
