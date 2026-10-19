import { Link, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { dayTypeText, isWorkingDay } from '@/features/schedule/LessonCard';
import { addDays, formatDateLong, isIsoDate, schoolToday } from '@/lib/dates';
import { useCan } from '@/lib/scope';
import { useAttendanceOverview } from './hooks';

// Attendance overview for a date (brief §4, attendance.summary): per section, marks recorded vs
// expected and the present count. "Not marked yet" is shown as such — never as absent or 0%.

function formatCount(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function AttendanceOverviewPage() {
  const canOpen = useCan('attendance.read_all');
  const [params, setParams] = useSearchParams();
  const raw = params.get('date');
  const date = raw && isIsoDate(raw) ? raw : schoolToday();
  const query = useAttendanceOverview(date);
  const go = (d: string) => setParams({ date: d }, { replace: true });

  return (
    <div className="space-y-4">
      <PageHeader title="Attendance" description="How much of each section's attendance is marked." />
      <div className="flex items-end gap-1">
        <Button
          variant="outline"
          size="icon"
          className="size-11 sm:size-9"
          aria-label="Previous day"
          onClick={() => go(addDays(date, -1))}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <div className="grid gap-1.5">
          <label htmlFor="overview-date" className="text-sm font-medium">
            Date
          </label>
          <DateInput id="overview-date" value={date} onChange={(v) => v && go(v)} />
        </div>
        <Button
          variant="outline"
          size="icon"
          className="size-11 sm:size-9"
          aria-label="Next day"
          onClick={() => go(addDays(date, 1))}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
      <DataState query={query}>
        {(o) => (
          <div className="space-y-3">
            <p className="text-sm">
              <strong>{formatDateLong(o.date)}</strong> · {dayTypeText(o.day)} ·{' '}
              {o.mode === 'daily' ? 'Day-wise attendance' : 'Attendance per period'}
            </p>
            {!isWorkingDay(o.day) ? (
              <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
                Not a working day for students — no attendance is expected.
              </p>
            ) : o.sections.length === 0 ? (
              <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
                No active sections on this date.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Section</TableHead>
                    <TableHead>Marked</TableHead>
                    <TableHead>Present</TableHead>
                    {canOpen && <TableHead className="sr-only">Open</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {o.sections.map((s) => {
                    const none = s.expected === 0;
                    const complete = !none && s.marked >= s.expected;
                    return (
                      <TableRow key={s.section_id} data-testid="overview-row">
                        <TableCell className="font-medium">{s.section}</TableCell>
                        <TableCell>
                          {none ? (
                            <span className="text-muted-foreground">
                              {o.mode === 'period' ? 'No lessons' : 'No students'}
                            </span>
                          ) : (
                            <>
                              {s.marked} of {s.expected}{' '}
                              <span className="text-muted-foreground text-xs">
                                {complete
                                  ? '(complete)'
                                  : s.marked === 0
                                    ? '(not marked yet)'
                                    : '(partly marked)'}
                              </span>
                            </>
                          )}
                        </TableCell>
                        <TableCell>
                          {s.marked === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            formatCount(s.present)
                          )}
                        </TableCell>
                        {canOpen && (
                          <TableCell>
                            {o.mode === 'daily' ? (
                              <Link className="underline" to={`/attendance/daily/${s.section_id}/${o.date}`}>
                                Open register
                              </Link>
                            ) : (
                              <Link
                                className="underline"
                                to={`/schedule?date=${o.date}&section=${s.section_id}`}
                              >
                                Lessons
                              </Link>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
            {o.mode === 'period' && (
              <p className="text-muted-foreground text-xs">
                Per period, “marked” counts one mark per student per lesson; cancelled lessons are not
                counted.
              </p>
            )}
          </div>
        )}
      </DataState>
    </div>
  );
}
