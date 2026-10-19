import type { Capability } from '@/contracts/capabilities';
import type { ActiveContext } from '@/contracts/session';

// Navigation is derived from server capabilities and context fields (CLAUDE.md rule 11),
// never from role names. Upcoming areas are listed as plain text — never clickable (PRD §15).

export type NavIcon =
  | 'dashboard'
  | 'setup'
  | 'calendar'
  | 'students'
  | 'admissions'
  | 'staff'
  | 'users'
  | 'imports'
  | 'operator'
  | 'today'
  | 'timetable'
  | 'schedule'
  | 'attendance'
  | 'diary'
  | 'homework'
  | 'staff-attendance'
  | 'fees';

export interface LiveNavItem {
  kind: 'live';
  label: string;
  to: string;
  icon: NavIcon;
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

interface LiveRule {
  label: string;
  to: string;
  icon: NavIcon;
  anyOf: Capability[];
  /** Hidden when the context has any of these (e.g. "School calendar" when full setup is shown). */
  unless?: Capability[];
}

// Live areas. Order is the sidebar order; phones show the first few in the bottom bar, so the areas
// used every day (M2) come before the office set-up screens (M1).
const LIVE: LiveRule[] = [
  // parent / student: the selected child's pages
  { label: 'Timetable', to: '/child/timetable', icon: 'timetable', anyOf: ['child.view'] },
  { label: 'Homework', to: '/child/homework', icon: 'homework', anyOf: ['child.view'] },
  { label: 'Attendance', to: '/child/attendance', icon: 'attendance', anyOf: ['child.view'] },
  { label: 'Diary', to: '/child/diary', icon: 'diary', anyOf: ['child.view'] },
  { label: 'Fees', to: '/child/fees', icon: 'fees', anyOf: ['child.view'] },
  // staff: academics (M2)
  { label: 'Schedule', to: '/schedule', icon: 'schedule', anyOf: ['timetable.read_all'] },
  { label: 'Homework', to: '/homework', icon: 'homework', anyOf: ['academic.read_all', 'lessons.teach'] },
  { label: 'Attendance', to: '/attendance', icon: 'attendance', anyOf: ['attendance.summary'] },
  { label: 'Diary', to: '/diary', icon: 'diary', anyOf: ['academic.read_all', 'lessons.teach'] },
  { label: 'Timetable', to: '/timetable', icon: 'timetable', anyOf: ['timetable.read_all'] },
  {
    label: 'Staff attendance',
    to: '/staff-attendance',
    icon: 'staff-attendance',
    anyOf: ['staff_attendance.read'],
  },
  // fees (M3)
  { label: 'Fees', to: '/fees', icon: 'fees', anyOf: ['fees.read'] },
  // office (M1, M1b)
  { label: 'Students', to: '/students', icon: 'students', anyOf: ['students.read_all'] },
  { label: 'Admissions', to: '/admissions', icon: 'admissions', anyOf: ['admissions.manage'] },
  { label: 'Staff', to: '/staff', icon: 'staff', anyOf: ['staff.read'] },
  { label: 'Users & logins', to: '/users', icon: 'users', anyOf: ['users.manage'] },
  { label: 'Imports', to: '/imports', icon: 'imports', anyOf: ['imports.manage'] },
  { label: 'School setup', to: '/setup', icon: 'setup', anyOf: ['setup.manage'] },
  {
    label: 'School calendar',
    to: '/setup/calendar',
    icon: 'calendar',
    anyOf: ['staff.member'],
    unless: ['setup.manage'],
  },
];

const UPCOMING: UpcomingRule[] = [
  { label: 'Salary', module: 'M4', anyOf: ['staff_finance.read'] },
  { label: 'Activity logs', module: 'M4', anyOf: ['audit.read'] },
];

/** The home destination's label: a teacher's home is "Today", a parent's or student's is "Home". */
export function homeLabel(context: ActiveContext): { label: string; icon: NavIcon } {
  const caps = context.capabilities;
  if (caps.includes('lessons.teach')) return { label: 'Today', icon: 'today' };
  if (caps.includes('child.view')) return { label: 'Home', icon: 'dashboard' };
  return { label: 'Dashboard', icon: 'dashboard' };
}

export function buildNav(context: ActiveContext | null, isOperator: boolean): NavItem[] {
  const items: NavItem[] = [];
  if (context) items.push({ kind: 'live', to: '/dashboard', ...homeLabel(context) });
  const caps = new Set(context?.capabilities ?? []);
  if (context) {
    for (const r of LIVE) {
      if (r.anyOf.some((c) => caps.has(c)) && !(r.unless ?? []).some((c) => caps.has(c))) {
        items.push({ kind: 'live', label: r.label, to: r.to, icon: r.icon });
      }
    }
  }
  if (isOperator)
    items.push({ kind: 'live', label: 'School onboarding', to: '/operator/onboarding', icon: 'operator' });
  if (!context) return items;
  for (const rule of UPCOMING) {
    const byCap = rule.anyOf?.some((c) => caps.has(c)) ?? false;
    const byStudent = rule.studentView === true && context.student_id !== null;
    if (byCap || byStudent) items.push({ kind: 'upcoming', label: rule.label, module: rule.module });
  }
  return items;
}
