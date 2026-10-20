import type { SetupIssue } from '@/contracts/dashboard';
import { addDays, monthParam } from '@/lib/dates';

// Every dashboard number links to the page that shows the same count with the same rules
// (PRD §16). Kept as pure functions so the mapping is unit-tested.

export const dashboardLinks = {
  attendanceOverview: (date: string) => `/attendance?date=${date}`,
  staffAttendance: (date: string) => `/staff-attendance?date=${date}`,
  /** Scheduled lessons whose teacher (after substitution) is marked absent: get_date_schedule.actual_teacher_absent. */
  uncoveredLessons: (date: string) => `/schedule?date=${date}&uncovered=1`,
  lessonsOn: (date: string) => `/schedule?date=${date}`,
  /** Scheduled lessons in the 7 days before the date without a diary entry (list_diary_entries only_missing). */
  diaryMissing: (date: string) => `/diary?from=${addDays(date, -7)}&to=${addDays(date, -1)}&missing=1`,
  /** Active homework due from `from` to the date with no checks (list_homework p_due_unchecked, 2410). */
  homeworkUnchecked: (from: string, date: string) => `/homework?due_unchecked=1&from=${from}&to=${date}`,
  followups: () => '/admissions',
  dayBook: (date: string) => `/fees/day-book?from=${date}&to=${date}`,
  dues: () => '/fees/dues',
  overdue: () => '/fees/dues?overdue=1',
  cheques: () => '/fees/cheques',
  exceptions: () => '/fees/exceptions',
  salary: (month: string) => `/salary?month=${monthParam(month)}`,
  register: () => '/attendance/register',
  coverage: () => '/reports/coverage',
};

export interface SetupIssueGroup {
  code: string;
  /** "12 sections have no active timetable", or the single issue's own message. */
  title: string;
  issues: SetupIssue[];
  fix: { to: string; label: string };
}

const GROUP_TITLE: Record<string, (n: number) => string> = {
  no_timetable: (n) => `${n} ${n === 1 ? 'section has' : 'sections have'} no active timetable`,
  no_class_teacher: (n) => `${n} ${n === 1 ? 'section has' : 'sections have'} no class teacher today`,
};

/**
 * Per-section issues grouped by kind (a school with many sections would otherwise get a list that
 * fills the whole dashboard; found on the live Demo School at 375px). Order: the server's.
 */
export function groupSetupIssues(issues: SetupIssue[]): SetupIssueGroup[] {
  const groups: SetupIssueGroup[] = [];
  for (const i of issues) {
    const g = groups.find((x) => x.code === i.code);
    if (g) g.issues.push(i);
    else
      groups.push({
        code: i.code,
        title: i.message,
        issues: [i],
        fix: setupIssueLink({ ...i, section_id: undefined }),
      });
  }
  for (const g of groups) {
    const title = GROUP_TITLE[g.code];
    if (title && g.issues.length > 1) g.title = title(g.issues.length);
    else if (g.issues.length === 1) g.fix = setupIssueLink(g.issues[0]!);
  }
  return groups;
}

/** Where each setup issue is fixed. */
export function setupIssueLink(issue: SetupIssue): { to: string; label: string } {
  switch (issue.code) {
    case 'no_current_year':
      return { to: '/setup/years', label: 'Academic years' };
    case 'no_sections':
      return { to: '/setup/classes', label: 'Classes and sections' };
    case 'no_timetable':
      return {
        to: issue.section_id ? `/timetable?section=${issue.section_id}` : '/timetable',
        label: 'Timetable',
      };
    case 'no_class_teacher':
      return { to: '/staff/teaching', label: 'Teaching assignments' };
    case 'no_attendance_mode':
      return { to: '/setup/attendance-mode', label: 'Attendance mode' };
    default:
      return { to: '/setup', label: 'School setup' };
  }
}
