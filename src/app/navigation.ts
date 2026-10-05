import type { Capability } from '@/contracts/capabilities';
import type { ActiveContext } from '@/contracts/session';

// Navigation is derived from server capabilities and context fields (CLAUDE.md rule 11),
// never from role names. Upcoming areas are listed as plain text — never clickable (PRD §15).

export interface LiveNavItem {
  kind: 'live';
  label: string;
  to: string;
}
export interface UpcomingNavItem {
  kind: 'upcoming';
  label: string;
  module: 'M1' | 'M2' | 'M3' | 'M4';
}
export type NavItem = LiveNavItem | UpcomingNavItem;

interface UpcomingRule {
  label: string;
  module: UpcomingNavItem['module'];
  anyOf?: Capability[];
  /** Shown for a context that represents one student (parent's selected child / student self). */
  studentView?: boolean;
}

const UPCOMING: UpcomingRule[] = [
  { label: 'School setup', module: 'M1', anyOf: ['setup.manage'] },
  { label: 'Users', module: 'M1', anyOf: ['users.manage'] },
  { label: 'Students', module: 'M1', anyOf: ['students.read_all', 'students.manage'] },
  { label: 'Admissions', module: 'M1', anyOf: ['admissions.manage'] },
  { label: 'Staff', module: 'M1', anyOf: ['staff.manage'] },
  { label: 'Timetable', module: 'M2', anyOf: ['timetable.read_all', 'timetable.manage'] },
  { label: 'Attendance', module: 'M2', anyOf: ['attendance.read_all', 'attendance.mark_any'] },
  { label: 'Diary & homework', module: 'M2', anyOf: ['academic.read_all', 'academic.correct'] },
  { label: 'Attendance, diary & homework', module: 'M2', studentView: true },
  { label: 'Fees', module: 'M3', anyOf: ['fees.read', 'fees.manage'] },
  { label: 'Fees & receipts', module: 'M3', studentView: true },
  {
    label: 'Staff attendance & salary',
    module: 'M4',
    anyOf: ['staff_attendance.read', 'staff_finance.read'],
  },
  { label: 'Activity logs', module: 'M4', anyOf: ['audit.read'] },
];

export function buildNav(context: ActiveContext | null, isOperator: boolean): NavItem[] {
  const items: NavItem[] = [];
  if (context) items.push({ kind: 'live', label: 'Dashboard', to: '/dashboard' });
  if (isOperator) items.push({ kind: 'live', label: 'School onboarding', to: '/operator/onboarding' });
  if (!context) return items;
  const caps = new Set(context.capabilities);
  for (const rule of UPCOMING) {
    const byCap = rule.anyOf?.some((c) => caps.has(c)) ?? false;
    const byStudent = rule.studentView === true && context.student_id !== null;
    if (byCap || byStudent) items.push({ kind: 'upcoming', label: rule.label, module: rule.module });
  }
  return items;
}
