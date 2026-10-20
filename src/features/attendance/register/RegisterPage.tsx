import { useSearchParams } from 'react-router';
import { Download } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { MonthPicker } from '@/components/shared/MonthPicker';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { AttendanceRegister, RegisterDate, RegisterStudent } from '@/contracts/reports';
import { SectionSelect, useSectionOptions } from '@/features/timetable/pickers';
import { downloadCsv } from '@/lib/csv';
import {
  formatDayShort,
  formatMonth,
  monthParam,
  monthStart,
  parseMonthParam,
  schoolToday,
  weekdayShort,
} from '@/lib/dates';
import { useCan } from '@/lib/scope';
import { cn } from '@/lib/utils';
import { AttendanceTabs } from './AttendanceTabs';
import { useAttendanceRegister } from './hooks';
import {
  cellLong,
  cellShort,
  cellView,
  dayLabel,
  finalText,
  isIncomplete,
  isWorking,
  registerCsv,
  totalsText,
  type CellView,
} from './logic';

// Attendance register (ATT-03): one section × one month. Principal/Admin see any section; a class
// teacher may open their own section (the server answers FORBIDDEN otherwise). Desktop: a grid of
// students × dates. Phones: one card per student with the month summary and a per-day list.

export function RegisterPage() {
  const [params, setParams] = useSearchParams();
  const today = schoolToday();
  const thisMonth = monthStart(today);
  const parsed = parseMonthParam(params.get('month'));
  const month = parsed && parsed <= thisMonth ? parsed : thisMonth;
  const sectionId = params.get('section');
  const readAll = useCan('attendance.read_all');
  const { options: sections } = useSectionOptions();
  const query = useAttendanceRegister(sectionId, month);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-4">
      <AttendanceTabs />
      <PageHeader
        title="Attendance register"
        description={
          readAll ? 'One section for one month.' : 'The month register of a section you are class teacher of.'
        }
        actions={
          <Button
            variant="outline"
            disabled={!query.data}
            onClick={() =>
              query.data &&
              downloadCsv(
                registerCsv(query.data),
                `register-${query.data.section.replace(/\s+/g, '-')}-${monthParam(month)}.csv`,
              )
            }
          >
            <Download aria-hidden="true" /> Export CSV
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-4">
        <SectionSelect
          id="register-section"
          value={sectionId}
          onChange={(v) => update({ section: v })}
          options={sections}
        />
        <MonthPicker
          id="register-month"
          month={month}
          max={thisMonth}
          onChange={(m) => update({ month: monthParam(m) })}
        />
      </div>
      {sectionId === null ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
          Choose a section to see its register for {formatMonth(month)}.
        </p>
      ) : (
        <DataState
          query={query}
          isEmpty={(r) => r.students.length === 0}
          emptyTitle="No students in this register"
          emptyDescription={
            query.data?.note ?? 'No student was in this section on a working day of this month.'
          }
        >
          {(r) => <RegisterView reg={r} />}
        </DataState>
      )}
    </div>
  );
}

function RegisterView({ reg }: { reg: AttendanceRegister }) {
  return (
    <div className="space-y-3" data-testid="register">
      <p className="text-sm">
        <span className="font-medium">{reg.section}</span> · {formatMonth(reg.month)}
        {reg.to && <span className="text-muted-foreground"> · up to {formatDayShort(reg.to)}</span>}
      </p>
      <Legend />
      <div className="hidden md:block">
        <RegisterGrid reg={reg} />
      </div>
      <ul className="space-y-2 md:hidden" aria-label="Students" data-testid="register-phone">
        {reg.students.map((s) => (
          <StudentCard key={s.student_id} s={s} dates={reg.dates} />
        ))}
      </ul>
    </div>
  );
}

function Legend() {
  return (
    <p className="text-muted-foreground text-xs" data-testid="register-legend">
      Day-wise: P present · L late · H half day · A absent · <strong>blank = not marked</strong> (not absent).
      Per lesson: attended / held lessons that day; <span aria-hidden="true">*</span> = some lessons not
      marked. — = not in this section. Grey = not a working day. Totals are provisional until every day is
      marked.
    </p>
  );
}

function headerText(d: RegisterDate): string {
  return `${Number(d.date.slice(8))}`;
}

function RegisterGrid({ reg }: { reg: AttendanceRegister }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="text-sm" data-testid="register-grid">
        <caption className="sr-only">
          Attendance register of {reg.section} for {formatMonth(reg.month)}
        </caption>
        <thead>
          <tr className="border-b">
            <th scope="col" className="bg-background sticky left-0 z-10 min-w-48 p-2 text-left font-medium">
              Student
            </th>
            {reg.dates.map((d) => (
              <th
                key={d.date}
                scope="col"
                className={cn('min-w-9 p-1 text-center text-xs font-medium', !isWorking(d) && 'bg-muted')}
                title={
                  isWorking(d)
                    ? `${formatDayShort(d.date)} · ${d.mode === 'period' ? 'per lesson' : 'day-wise'}`
                    : dayLabel(d)
                }
              >
                <span className="block">{headerText(d)}</span>
                <span className="text-muted-foreground block font-normal">
                  {weekdayShort(d.weekday).slice(0, 2)}
                </span>
                {isWorking(d) && d.mode === 'period' && (
                  <span className="text-muted-foreground block font-normal">
                    <span aria-hidden="true">per</span>
                    <span className="sr-only">attendance per lesson</span>
                  </span>
                )}
              </th>
            ))}
            <th scope="col" className="min-w-56 p-2 text-left font-medium">
              Month
            </th>
          </tr>
        </thead>
        <tbody>
          {reg.students.map((s) => (
            <tr key={s.student_id} className="border-b" data-testid="register-row">
              <th scope="row" className="bg-background sticky left-0 z-10 p-2 text-left font-normal">
                <span className="block font-medium">{s.name}</span>
                <span className="text-muted-foreground text-xs">
                  {s.roll_no ? `Roll ${s.roll_no} · ` : ''}
                  {s.admission_no}
                </span>
              </th>
              {reg.dates.map((d) => (
                <GridCell key={d.date} v={cellView(s, d)} date={d.date} />
              ))}
              <td className="p-2 text-xs">
                <span className="block">{totalsText(s)}</span>
                <FinalBadge s={s} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GridCell({ v, date }: { v: CellView; date: string }) {
  const long = cellLong(v);
  return (
    <td
      className={cn(
        'border-l p-1 text-center tabular-nums',
        v.kind === 'non_working' && 'bg-muted',
        v.kind === 'daily' && v.status === 'A' && 'text-destructive font-semibold',
        v.kind === 'daily' && v.status === null && 'bg-amber-50 dark:bg-amber-950/30',
      )}
      title={`${formatDayShort(date)}: ${long}`}
      data-testid="register-cell"
      data-date={date}
      data-state={v.kind === 'daily' ? (v.status ?? 'unmarked') : v.kind}
    >
      <span aria-hidden="true">
        {cellShort(v)}
        {isIncomplete(v) && '*'}
      </span>
      <span className="sr-only">{long}</span>
    </td>
  );
}

function FinalBadge({ s }: { s: RegisterStudent }) {
  return (
    <Badge variant={s.is_final ? 'secondary' : 'outline'} className="mt-1" data-testid="register-final">
      {finalText(s)}
    </Badge>
  );
}

function StudentCard({ s, dates }: { s: RegisterStudent; dates: RegisterDate[] }) {
  const working = dates.filter(isWorking);
  return (
    <li className="rounded-lg border" data-testid="register-student">
      <details>
        <summary className="flex min-h-11 cursor-pointer list-none flex-col gap-1 p-3">
          <span className="font-medium">
            {s.roll_no ? `${s.roll_no}. ` : ''}
            {s.name}
          </span>
          <span className="text-muted-foreground text-xs">{s.admission_no}</span>
          <span className="text-sm">{totalsText(s)}</span>
          <span>
            <FinalBadge s={s} />
          </span>
          <span className="text-xs underline">Show each day</span>
        </summary>
        <ul className="border-t px-3 py-2 text-sm" aria-label={`Days of ${s.name}`}>
          {working.map((d) => {
            const v = cellView(s, d);
            return (
              <li key={d.date} className="flex justify-between gap-3 border-b py-1.5 last:border-b-0">
                <span>{formatDayShort(d.date)}</span>
                <span
                  className={cn(
                    v.kind === 'daily' &&
                      v.status === null &&
                      'font-medium text-amber-800 dark:text-amber-300',
                    v.kind === 'daily' && v.status === 'A' && 'text-destructive',
                  )}
                >
                  {cellLong(v)}
                </span>
              </li>
            );
          })}
          {dates.length > working.length && (
            <li className="text-muted-foreground pt-1.5 text-xs">
              {dates.length - working.length} non-working{' '}
              {dates.length - working.length === 1 ? 'day' : 'days'} not shown.
            </li>
          )}
        </ul>
      </details>
    </li>
  );
}
