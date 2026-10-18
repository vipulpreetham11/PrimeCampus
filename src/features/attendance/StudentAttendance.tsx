import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { AttendanceRecord, AttendanceSummary } from '@/contracts/attendance';
import {
  addDays,
  formatDate,
  formatDayShort,
  formatMonth,
  formatTime,
  minDate,
  monthEnd,
  monthStart,
  schoolToday,
} from '@/lib/dates';
import { useSessionSelector } from '@/lib/session/store';
import { useAttendanceRecords, useAttendanceSummary } from './hooks';
import { STATUS_WORD } from './MarkingRosterPage';

// One student's attendance (brief §4): the year-to-date summary — "provisional" while any expected
// mark is missing, with the marking coverage — and day / lesson records paged by month.

export function StudentAttendance({ studentId }: { studentId: string }) {
  const year = useSessionSelector((s) => s.context?.current_year ?? null);
  const today = schoolToday();
  const from = year?.start_date ?? monthStart(today);
  const to = year ? minDate(year.end_date, today) : today;
  const summary = useAttendanceSummary(studentId, from, to);
  const [month, setMonth] = useState(monthStart(today));
  const records = useAttendanceRecords(studentId, month, monthEnd(month));

  return (
    <div className="space-y-4" data-testid="student-attendance">
      <DataState query={summary}>{(s) => <SummaryView s={s} />}</DataState>
      <div>
        <div className="mb-2 flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-11 sm:size-9"
            aria-label="Previous month"
            onClick={() => setMonth(monthStart(addDays(month, -1)))}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <h3 className="min-w-36 text-center text-sm font-semibold">{formatMonth(month)}</h3>
          <Button
            variant="outline"
            size="icon"
            className="size-11 sm:size-9"
            aria-label="Next month"
            disabled={month >= monthStart(today)}
            onClick={() => setMonth(addDays(monthEnd(month), 1))}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
        <DataState
          query={records}
          isEmpty={(r) => r.length === 0}
          emptyTitle="No school days in this month"
          emptyDescription="Either the month has not started or the student was not in a section."
        >
          {(rows) => <RecordList rows={rows} />}
        </DataState>
      </div>
    </div>
  );
}

function SummaryView({ s }: { s: AttendanceSummary }) {
  if (s.expected_units === 0) {
    return <p className="text-muted-foreground text-sm">No attendance was expected yet this year.</p>;
  }
  return (
    <div className="space-y-1" data-testid="attendance-summary">
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-2xl font-semibold">{s.percentage === null ? '—' : `${s.percentage}%`}</span>
        <span className="text-muted-foreground text-sm">
          attendance {formatDate(s.from)} – {formatDate(s.to)}
        </span>
        {s.is_final ? (
          <Badge variant="outline">Final</Badge>
        ) : (
          <Badge variant="secondary" data-testid="provisional">
            Provisional
          </Badge>
        )}
      </p>
      <p className="text-sm">
        {s.marked_units} of {s.expected_units}{' '}
        {s.period_units > 0 && s.daily_units === 0 ? 'lessons' : 'marks'} recorded
        {s.marking_coverage_pct !== null && <> ({s.marking_coverage_pct}% coverage)</>}
        {s.unmarked_units > 0 && <> · {s.unmarked_units} not marked yet</>}
      </p>
      {!s.is_final && (
        <p className="text-muted-foreground text-xs">
          Provisional: the percentage counts only the marks recorded so far. Unmarked days or lessons are not
          counted as present or absent.
        </p>
      )}
    </div>
  );
}

function statusText(status: AttendanceRecord['status']): string {
  return status ? STATUS_WORD[status] : 'Not marked';
}

function RecordList({ rows }: { rows: AttendanceRecord[] }) {
  return (
    <ul className="divide-y rounded-lg border text-sm" aria-label="Attendance records">
      {rows.map((r) => (
        <li key={r.date} className="p-3" data-testid="attendance-record">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">{formatDayShort(r.date)}</span>
            {r.weight === 0 ? (
              <span className="text-muted-foreground">
                {r.day_type === 'holiday'
                  ? 'Holiday'
                  : r.day_type === 'weekly_off'
                    ? 'Weekly off'
                    : 'No school'}
              </span>
            ) : r.mode === 'daily' ? (
              <span className={r.status ? '' : 'text-muted-foreground italic'}>
                {statusText(r.status)}
                {r.day_type === 'half_day' && ' (half day)'}
              </span>
            ) : (
              <span className="text-muted-foreground">{r.section}</span>
            )}
          </div>
          {r.weight > 0 && r.mode === 'period' && (
            <ul className="mt-1 space-y-0.5">
              {(r.lessons ?? []).length === 0 && (
                <li className="text-muted-foreground">No lessons recorded</li>
              )}
              {(r.lessons ?? []).map((l) => (
                <li key={l.lesson_session_id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    {l.slot_label} ({formatTime(l.start_time)}) · {l.subject}
                  </span>
                  <span
                    className={
                      l.status || l.lesson_status === 'cancelled' ? '' : 'text-muted-foreground italic'
                    }
                  >
                    {l.lesson_status === 'cancelled' ? 'Lesson cancelled' : statusText(l.status)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
