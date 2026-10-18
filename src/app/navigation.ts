import type { Capability } from '@/contracts/capabilities';
import type { ActiveContext } from '@/contracts/session';

// Navigation is derived from server capabilities and context fields (CLAUDE.md rule 11),
// never from role names. Upcoming areas are listed as plain text — never clickable (PRD §15).

export type NavIcon =
  'dashboard' | 'setup' | 'calendar' | 'students' | 'admissions' | 'staff' | 'users' | 'imports' | 'operator';

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

// M1 areas (live). Order is the sidebar order; phones show the first few in the bottom bar.
const LIVE: LiveRule[] = [
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
  if (context) items.push({ kind: 'live', label: 'Dashboard', to: '/dashboard', icon: 'dashboard' });
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
