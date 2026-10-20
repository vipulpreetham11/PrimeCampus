import { NavLink } from 'react-router';
import type { Capability } from '@/contracts/capabilities';
import { useSessionSelector } from '@/lib/session/store';
import { cn } from '@/lib/utils';

// Attendance area tabs (capability-driven): overview of a day, the month register, the change trail.

const TABS: { to: string; label: string; anyOf: Capability[] }[] = [
  { to: '/attendance', label: 'Overview', anyOf: ['attendance.summary'] },
  { to: '/attendance/register', label: 'Register', anyOf: ['attendance.read_all', 'lessons.teach'] },
  { to: '/attendance/changes', label: 'Changes', anyOf: ['attendance.read_all', 'staff_attendance.read'] },
];

export function AttendanceTabs() {
  const caps = useSessionSelector((s) => s.context?.capabilities ?? []);
  const tabs = TABS.filter((t) => t.anyOf.some((c) => caps.includes(c)));
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Attendance sections" className="-mx-1 mb-4 overflow-x-auto">
      <ul className="flex min-w-max gap-1 px-1">
        {tabs.map((t) => (
          <li key={t.to}>
            <NavLink
              to={t.to}
              end
              className={({ isActive }) =>
                cn(
                  'inline-block rounded-md border px-3 py-1.5 text-sm whitespace-nowrap',
                  isActive
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'bg-background hover:bg-accent',
                )
              }
            >
              {t.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
