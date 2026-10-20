import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { MoneyText } from '@/components/shared/MoneyText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import type { Dashboard } from '@/contracts/dashboard';
import { roleLabel } from '@/contracts/roles';
import { dayTypeText } from '@/features/schedule/LessonCard';
import { formatDateLong, formatDayShort, formatMonth, isIsoDate, schoolToday } from '@/lib/dates';
import { useCan } from '@/lib/scope';
import { useSession } from '@/lib/session/store';
import { useDashboard } from './hooks';
import { dashboardLinks as L, setupIssueLink } from './links';

// Role home screens (PRD §16) from ONE call, get_dashboard(date): the server includes a block only
// when the role has its capability, and this page renders exactly the blocks it receives — Admin
// (everything), Principal (attendance, staff, academic), Accountant (fees), Owner (fees, salary,
// attendance). Every number is a link to the page that counts it the same way. Loading, error and
// offline are their own states (DataState) — never a 0.

export function SchoolDashboard() {
  const s = useSession();
  const ctx = s.context;
  const [params, setParams] = useSearchParams();
  const today = schoolToday();
  const raw = params.get('date');
  const date = raw && isIsoDate(raw) && raw <= today ? raw : today;
  const query = useDashboard(date);
  if (!ctx) return null;
  return (
    <div className="space-y-4" data-testid={`dashboard-${ctx.role}`}>
      <PageHeader
        title={`${roleLabel(ctx.role)} dashboard`}
        description={`${ctx.school_name}${ctx.current_year ? ` · ${ctx.current_year.name}` : ''}`}
        actions={
          s.account?.isOperator ? (
            <Button asChild variant="outline">
              <Link to="/operator/activity">Operator console</Link>
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="dashboard-date">Date</Label>
          <DateInput
            id="dashboard-date"
            value={date}
            max={today}
            onChange={(v) => v && setParams(v === today ? {} : { date: v }, { replace: true })}
          />
        </div>
        <p className="text-muted-foreground pb-2 text-sm">{formatDateLong(date)}</p>
      </div>
      <QuickLinks />
      <DataState query={query}>{(d) => <Blocks d={d} />}</DataState>
    </div>
  );
}

function QuickLinks() {
  const canCollect = useCan('fees.manage');
  const fees = useCan('fees.read');
  const academic = useCan('academic.read_all');
  const links: { to: string; label: string }[] = [
    ...(canCollect ? [{ to: '/fees/collect', label: 'Collect payment' }] : []),
    ...(fees
      ? [
          { to: '/fees/day-book', label: 'Day book' },
          { to: '/fees/dues', label: 'Dues' },
          { to: '/fees/cheques', label: 'Cheques' },
        ]
      : []),
    ...(academic
      ? [
          { to: L.coverage(), label: 'Academic coverage' },
          { to: L.register(), label: 'Attendance register' },
        ]
      : []),
  ];
  if (links.length === 0) return null;
  return (
    <nav aria-label="Shortcuts">
      <ul className="flex flex-wrap gap-2">
        {links.map((l) => (
          <li key={l.to}>
            <Button asChild variant="outline" size="sm" className="min-h-11 sm:min-h-8">
              <Link to={l.to}>{l.label}</Link>
            </Button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Blocks({ d }: { d: Dashboard }) {
  const nothing =
    !d.attendance && !d.staff && !d.academic && !d.admissions && !d.fees && !d.salary && !d.setup_issues;
  return (
    <div className="space-y-4">
      <p className="text-sm" data-testid="dashboard-day">
        {formatDayShort(d.date)}: {dayTypeText(d.day)}
      </p>
      {d.setup_issues && d.setup_issues.length > 0 && <SetupIssues d={d} />}
      <div className="grid gap-4 lg:grid-cols-2">
        {d.attendance && <AttendanceBlock d={d} a={d.attendance} />}
        {d.staff && <StaffBlock d={d} s={d.staff} />}
        {d.academic && <AcademicBlock d={d} a={d.academic} />}
        {d.admissions && <AdmissionsBlock a={d.admissions} />}
        {d.fees && <FeesBlock d={d} f={d.fees} />}
        {d.salary && <SalaryBlock s={d.salary} />}
      </div>
      {nothing && (
        <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
          There is no summary for your role. Use the menu to open your pages.
        </p>
      )}
    </div>
  );
}

function Block({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</dl>
      </CardContent>
    </Card>
  );
}

/** One figure: label + value, where the value is a link to the page that counts it the same way. */
function Num({
  label,
  to,
  children,
  note,
  testId,
}: {
  label: string;
  to: string;
  children: ReactNode;
  note?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd>
        <Link
          to={to}
          className="text-lg font-semibold tabular-nums underline-offset-2 hover:underline"
          data-testid={testId}
        >
          {children}
        </Link>
        {note && <span className="text-muted-foreground block text-xs">{note}</span>}
      </dd>
    </div>
  );
}

function AttendanceBlock({ d, a }: { d: Dashboard; a: NonNullable<Dashboard['attendance']> }) {
  const link = L.attendanceOverview(d.date);
  return (
    <Block title="Student attendance" testId="block-attendance">
      <Num
        label="Sections complete"
        to={link}
        testId="num-sections-complete"
        note={`of ${a.sections_expected} sections expected to mark`}
      >
        {a.sections_complete}
      </Num>
      <Num label="Sections not started" to={link} testId="num-sections-not-started">
        {a.sections_not_started}
      </Num>
      <Num
        label={a.mode === 'period' ? 'Lesson marks entered' : 'Students marked'}
        to={link}
        note={`of ${a.expected} expected · ${a.mode === 'period' ? 'per lesson' : 'day-wise'}`}
      >
        {a.marked}
      </Num>
      <Num label="Present (of those marked)" to={link} note="Unmarked students are not counted as absent">
        {a.present}
      </Num>
    </Block>
  );
}

function StaffBlock({ d, s }: { d: Dashboard; s: NonNullable<Dashboard['staff']> }) {
  return (
    <Block title="Staff" testId="block-staff">
      <Num label="Teachers and staff absent" to={L.staffAttendance(d.date)} testId="num-staff-absent">
        {s.absent}
      </Num>
      <Num label="Half day" to={L.staffAttendance(d.date)}>
        {s.half_day}
      </Num>
      <Num
        label="Staff marked"
        to={L.staffAttendance(d.date)}
        note={`of ${s.active_staff} active · ${s.active_staff - s.marked} not marked`}
      >
        {s.marked}
      </Num>
      <Num
        label="Lessons with an absent teacher"
        to={L.uncoveredLessons(d.date)}
        testId="num-uncovered"
        note="Not covered by a substitute"
      >
        {s.lessons_with_absent_teacher}
      </Num>
    </Block>
  );
}

function AcademicBlock({ d, a }: { d: Dashboard; a: NonNullable<Dashboard['academic']> }) {
  return (
    <Block title="Lessons, diary and homework" testId="block-academic">
      <Num label="Lessons on this day" to={L.lessonsOn(d.date)}>
        {a.lessons_today}
      </Num>
      <Num
        label="Lessons without a diary (last 7 days)"
        to={L.diaryMissing(d.date)}
        testId="num-diary-missing"
      >
        {a.diary_missing_last_7_days}
      </Num>
      <Num
        label="Homework due, nothing checked"
        to={L.homeworkUnchecked(a.homework_due_unchecked_from, d.date)}
        testId="num-homework-unchecked"
        note={`Due ${formatDayShort(a.homework_due_unchecked_from)} – ${formatDayShort(d.date)}`}
      >
        {a.homework_due_unchecked}
      </Num>
    </Block>
  );
}

function AdmissionsBlock({ a }: { a: NonNullable<Dashboard['admissions']> }) {
  return (
    <Block title="Admissions follow-ups" testId="block-admissions">
      <Num label="Overdue" to={L.followups()} testId="num-followups-overdue">
        {a.followups_overdue}
      </Num>
      <Num label="Due today" to={L.followups()}>
        {a.followups_today}
      </Num>
      <Num label="Open enquiries" to={L.followups()}>
        {a.open_leads}
      </Num>
    </Block>
  );
}

function FeesBlock({ d, f }: { d: Dashboard; f: NonNullable<Dashboard['fees']> }) {
  return (
    <Block title="Fees" testId="block-fees">
      <Num
        label={`Collected on ${formatDayShort(d.date)}`}
        to={L.dayBook(d.date)}
        testId="num-collected"
        note={`${f.collected_on_date.count} ${f.collected_on_date.count === 1 ? 'payment' : 'payments'}`}
      >
        <MoneyText paise={f.collected_on_date.amount_paise} />
      </Num>
      <Num label="Dues (current year)" to={L.dues()} testId="num-dues">
        <MoneyText paise={f.due_paise} />
      </Num>
      <Num label="Overdue (current year)" to={L.overdue()} testId="num-overdue">
        <MoneyText paise={f.overdue_paise} />
      </Num>
      <Num
        label="Pending cheques"
        to={L.cheques()}
        note={`${f.pending_cheques.count} ${f.pending_cheques.count === 1 ? 'cheque' : 'cheques'} · not counted as paid`}
      >
        <MoneyText paise={f.pending_cheques.amount_paise} />
      </Num>
      <Num label="Open payment exceptions" to={L.exceptions()}>
        {f.open_exceptions}
      </Num>
      {f.older_years_due_paise > 0 && (
        <Num
          label="Dues from earlier years"
          to={L.dues()}
          note="Choose that year on the Dues page"
          testId="num-older-dues"
        >
          <MoneyText paise={f.older_years_due_paise} />
        </Num>
      )}
    </Block>
  );
}

function SalaryBlock({ s }: { s: NonNullable<Dashboard['salary']> }) {
  return (
    <Block title={`Salary — ${formatMonth(s.month)}`} testId="block-salary">
      <Num label="Saved" to={L.salary(s.month)} testId="num-salary-saved" note={`of ${s.staff} staff`}>
        {s.saved}
      </Num>
      <Num label="Saved payable" to={L.salary(s.month)} testId="num-salary-payable">
        <MoneyText paise={s.saved_payable_paise} />
      </Num>
    </Block>
  );
}

function SetupIssues({ d }: { d: Dashboard }) {
  const issues = d.setup_issues ?? [];
  return (
    <Card data-testid="block-setup" className="border-amber-500">
      <CardHeader>
        <CardTitle className="text-base">Setup issues ({issues.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1 text-sm">
          {issues.map((i, n) => {
            const fix = setupIssueLink(i);
            return (
              <li
                key={`${i.code}-${i.section_id ?? n}`}
                className="flex flex-wrap justify-between gap-2 border-b py-1.5 last:border-b-0"
              >
                <span>{i.message}</span>
                <Link to={fix.to} className="underline">
                  Fix in {fix.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
