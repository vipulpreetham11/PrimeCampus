import { NavLink, Outlet } from 'react-router';
import { PageHeader } from '@/components/shared/PageHeader';
import { useCan } from '@/lib/scope';
import { cn } from '@/lib/utils';

export function StaffLayout() {
  const canTeaching = useCan('staff.member');
  const tabs = [
    { to: '/staff', label: 'Directory', end: true },
    { to: '/staff/groups', label: 'Staff groups', end: false },
    ...(canTeaching ? [{ to: '/staff/teaching', label: 'Teaching assignments', end: false }] : []),
  ];
  return (
    <div>
      <PageHeader title="Staff" />
      <nav aria-label="Staff sections" className="-mx-1 mb-6 overflow-x-auto">
        <ul className="flex min-w-max gap-1 px-1">
          {tabs.map((t) => (
            <li key={t.to}>
              <NavLink
                to={t.to}
                end={t.end}
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
