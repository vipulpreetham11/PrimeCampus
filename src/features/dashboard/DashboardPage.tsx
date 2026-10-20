import { PageHeader } from '@/components/shared/PageHeader';
import { useSession } from '@/lib/session/store';
import { ChildHomePage } from '@/features/child/ChildPages';
import { TeacherTodayPage } from '@/features/teacher/TeacherTodayPage';
import { SchoolDashboard } from './SchoolDashboard';

// The home screen by capability (never by role name): a teacher's home is "Today", a parent's or
// student's is the selected child's home, every other school role gets the dashboard built from
// get_dashboard — the server decides which blocks a role receives.

export function DashboardPage() {
  const s = useSession();
  const ctx = s.context;
  if (!ctx) return null; // the route gate sends users without a context to the chooser
  if (ctx.capabilities.includes('lessons.teach')) {
    return (
      <div data-testid={`dashboard-${ctx.role}`}>
        <TeacherTodayPage />
      </div>
    );
  }
  if (ctx.capabilities.includes('child.view')) {
    return (
      <div data-testid={`dashboard-${ctx.role}`}>
        <PageHeader
          title="Home"
          description={`${ctx.school_name}${ctx.current_year ? ` · ${ctx.current_year.name}` : ''}`}
        />
        <ChildHomePage />
      </div>
    );
  }
  return <SchoolDashboard />;
}
