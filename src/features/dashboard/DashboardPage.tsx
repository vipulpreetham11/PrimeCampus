import { Link } from 'react-router';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Role } from '@/contracts/roles';
import { useSession } from '@/lib/session/store';
import { buildNav } from '@/app/navigation';

// Placeholder per role dashboard (M0). No fake buttons or numbers (PRD §15): each page states
// which module delivers it. Choosing the *text* by role is presentation only — access is
// enforced by the server and navigation uses capabilities.

interface Placeholder {
  title: string;
  module: string;
  upcoming: { label: string; module: string }[];
}

const PLACEHOLDERS: Record<Role, Placeholder> = {
  operator: {
    title: 'Operator overview',
    module: 'M4',
    upcoming: [
      { label: 'Timetable, attendance, diary and homework', module: 'M2' },
      { label: 'Fees and receipts', module: 'M3' },
      { label: 'Activity, authentication and usage logs', module: 'M4' },
    ],
  },
  admin: {
    title: 'Admin operations dashboard',
    module: 'M4',
    upcoming: [
      { label: 'Timetable, attendance, diary and homework', module: 'M2' },
      { label: 'Fees configuration, invoices, collections and receipts', module: 'M3' },
      { label: 'Staff attendance and salary calculator', module: 'M4' },
    ],
  },
  accountant: {
    title: 'Fees dashboard',
    module: 'M3',
    upcoming: [
      { label: 'Fees configuration, invoices, collections, receipts and fee reports', module: 'M3' },
    ],
  },
  principal: {
    title: 'Principal academics dashboard',
    module: 'M4',
    upcoming: [
      { label: 'Timetable, attendance, diary and homework views', module: 'M2' },
      { label: 'Staff attendance', module: 'M4' },
    ],
  },
  owner: {
    title: 'Owner management dashboard',
    module: 'M4',
    upcoming: [
      { label: 'Fee reports', module: 'M3' },
      { label: 'Staff attendance and salary', module: 'M4' },
    ],
  },
  teacher: {
    title: 'Teacher Today',
    module: 'M2',
    upcoming: [{ label: 'Today’s lessons, attendance, diary and homework checking', module: 'M2' }],
  },
  parent: {
    title: 'Child overview',
    module: 'M2',
    upcoming: [
      { label: 'Timetable, attendance, diary and homework', module: 'M2' },
      { label: 'Fees and receipts', module: 'M3' },
    ],
  },
  student: {
    title: 'My overview',
    module: 'M2',
    upcoming: [
      { label: 'Timetable, attendance, diary and homework', module: 'M2' },
      { label: 'Fees and receipts', module: 'M3' },
    ],
  },
};

export function DashboardPage() {
  const s = useSession();
  const ctx = s.context;
  if (!ctx) return null; // the route gate sends users without a context to the chooser
  const p = PLACEHOLDERS[ctx.role];
  // Same capability-driven list as the sidebar (never role names).
  const available = buildNav(ctx, s.account?.isOperator ?? false).filter(
    (i): i is Extract<typeof i, { kind: 'live' }> => i.kind === 'live' && i.to !== '/dashboard',
  );

  return (
    <div data-testid={`dashboard-${ctx.role}`}>
      <PageHeader
        title={p.title}
        description={`${ctx.school_name}${ctx.current_year ? ` · ${ctx.current_year.name}` : ''}`}
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Coming in module {p.module}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            This dashboard is not built yet. Nothing on this page is live data.
          </p>
          <ul className="space-y-1">
            {p.upcoming.map((u) => (
              <li key={u.label} className="flex justify-between gap-4 border-b py-1.5 last:border-b-0">
                <span>{u.label}</span>
                <span className="text-muted-foreground shrink-0">{u.module}</span>
              </li>
            ))}
          </ul>
          {available.length > 0 && (
            <div>
              <p className="mb-2 font-medium">Available now</p>
              <ul className="flex flex-wrap gap-2" aria-label="Available now">
                {available.map((item) => (
                  <li key={item.to}>
                    <Button asChild variant="outline" size="sm">
                      <Link to={item.to}>{item.label}</Link>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
