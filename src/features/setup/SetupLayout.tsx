import { NavLink, Outlet, useLocation } from 'react-router';
import { PageHeader } from '@/components/shared/PageHeader';
import { useCan } from '@/lib/scope';
import { cn } from '@/lib/utils';

const TABS = [
  { to: '/setup/profile', label: 'School profile' },
  { to: '/setup/years', label: 'Academic years' },
  { to: '/setup/classes', label: 'Classes & sections' },
  { to: '/setup/subjects', label: 'Subjects' },
  { to: '/setup/bell-schedules', label: 'Bell schedules' },
  { to: '/setup/attendance-mode', label: 'Attendance mode' },
  { to: '/setup/calendar', label: 'Calendar' },
];

export function SetupLayout() {
  const canManage = useCan('setup.manage');
  const { search } = useLocation();
  return (
    <div>
      <PageHeader
        title="School setup"
        description={canManage ? undefined : 'You can view setup. Only Admins can change it.'}
      />
      <nav aria-label="Setup sections" className="-mx-1 mb-6 overflow-x-auto">
        <ul className="flex min-w-max gap-1 px-1">
          {TABS.map((t) => (
            <li key={t.to}>
              <NavLink
                to={{ pathname: t.to, search }}
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
      <Outlet />
    </div>
  );
}
