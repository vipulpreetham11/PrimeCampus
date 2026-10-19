import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, ChevronLeft, ChevronRight, ClipboardCheck, NotebookPen } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { TeacherToday, TodayLesson } from '@/contracts/timetable';
import { addDays, formatDateLong, formatDayMonth, formatTime, isIsoDate, schoolToday } from '@/lib/dates';
import { getTeacherToday } from '@/lib/rpc';
import { useScopedKey } from '@/lib/scope';
import { cn } from '@/lib/utils';

// Teacher "Today" (brief §3, lessons.teach): my lessons for a date (substitutions included) with
// attendance / diary / homework state, my class-teacher sections' day registers, and homework due
// for checking. Every lesson leads to its attendance register and its diary & homework page.

export function useTeacherToday(date: string) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('teacher-today', date),
    queryFn: ({ signal }) => getTeacherToday({ p_date: date }, { signal }),
  });
}

export function TeacherTodayPage() {
  const [params, setParams] = useSearchParams();
  const today = schoolToday();
  const raw = params.get('date');
  const date = raw && isIsoDate(raw) ? raw : today;
  const query = useTeacherToday(date);
  const go = (d: string) => setParams(d === today ? {} : { date: d }, { replace: true });

  return (
    <div className="space-y-4" data-testid="teacher-today">
      <PageHeader title={date === today ? 'Today' : 'My day'} description={formatDateLong(date)} />
      <div className="flex items-end gap-1">
        <Button
          variant="outline"
          size="icon"
          className="size-11"
          aria-label="Previous day"
          onClick={() => go(addDays(date, -1))}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <div className="grid gap-1.5">
          <label htmlFor="today-date" className="text-sm font-medium">
            Date
          </label>
          <DateInput id="today-date" value={date} onChange={(v) => v && go(v)} />
        </div>
        <Button
          variant="outline"
          size="icon"
          className="size-11"
          aria-label="Next day"
          onClick={() => go(addDays(date, 1))}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
        {date !== today && (
          <Button variant="ghost" className="min-h-11" onClick={() => go(today)}>
            Today
          </Button>
        )}
      </div>
      <DataState query={query}>{(t) => <TodayView t={t} />}</DataState>
    </div>
  );
}

function TodayView({ t }: { t: TeacherToday }) {
  const daily = t.mode === 'daily';
  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        {daily
          ? 'Day-wise attendance: class teachers mark one register for the day.'
          : 'Attendance per period: mark each lesson you take.'}
      </p>

      {daily && t.class_teacher_sections.length > 0 && (
        <section aria-labelledby="ct-heading" className="space-y-2">
          <h2 id="ct-heading" className="text-base font-semibold">
            My class — day register
          </h2>
          <ul className="space-y-2">
            {t.class_teacher_sections.map((s) => (
              <li
                key={s.section_id}
                className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
                data-testid="ct-section"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{s.section}</p>
                  <MarkedText marked={s.daily_marked} eligible={s.eligible} />
                </div>
                <Button asChild className="min-h-11">
                  <Link to={`/attendance/daily/${s.section_id}/${t.date}`} state={{ section: s.section }}>
                    <ClipboardCheck aria-hidden="true" /> Day attendance
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="lessons-heading" className="space-y-2">
        <h2 id="lessons-heading" className="text-base font-semibold">
          My lessons
        </h2>
        {t.lessons.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
            No lessons for you on this day.
          </p>
        ) : (
          <ul className="space-y-2">
            {t.lessons.map((l) => (
              <TodayLessonCard key={l.lesson_session_id} l={l} daily={daily} />
            ))}
          </ul>
        )}
      </section>

      {t.homework_to_check.length > 0 && (
        <section aria-labelledby="hw-heading" className="space-y-2">
          <h2 id="hw-heading" className="text-base font-semibold">
            Homework to check
          </h2>
          <ul className="space-y-2">
            {t.homework_to_check.map((h) => (
              <li key={h.assignment_id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
                <p className="min-w-0 flex-1 text-sm" data-testid="homework-to-check">
                  <span className="font-medium">
                    {h.subject} · {h.section}
                  </span>{' '}
                  — {h.checked} of {h.eligible} checked, due {formatDayMonth(h.due_on)}
                </p>
                <Button asChild variant="outline" className="min-h-11">
                  <Link to={`/homework/${h.assignment_id}`}>Check</Link>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function MarkedText({ marked, eligible }: { marked: number; eligible: number }) {
  if (eligible === 0) return <p className="text-muted-foreground text-sm">No students</p>;
  const done = marked >= eligible;
  return (
    <p className={cn('text-sm', !done && marked === 0 && 'font-medium text-amber-800 dark:text-amber-300')}>
      {marked === 0
        ? 'Attendance not marked yet'
        : `${marked} of ${eligible} marked${done ? ' — complete' : ''}`}
    </p>
  );
}

function TodayLessonCard({ l, daily }: { l: TodayLesson; daily: boolean }) {
  const cancelled = l.status === 'cancelled';
  return (
    <li
      className={cn('rounded-lg border p-3', cancelled && 'bg-muted/40')}
      data-testid="today-lesson"
      data-lesson-id={l.lesson_session_id}
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground text-xs">
            {l.slot_label} · {formatTime(l.start_time)}–{formatTime(l.end_time)}
          </p>
          <p className={cn('font-medium', cancelled && 'line-through')}>
            {l.subject} · {l.section}
          </p>
        </div>
        {l.is_substitution && <Badge variant="secondary">Substitution</Badge>}
        {cancelled && <Badge variant="destructive">Cancelled</Badge>}
      </div>
      {!cancelled && (
        <>
          <ul className="mt-2 space-y-0.5 text-sm">
            <li>
              {daily ? (
                <span className="text-muted-foreground">Attendance: day register</span>
              ) : (
                <MarkedText marked={l.attendance_marked} eligible={l.eligible} />
              )}
            </li>
            <li className={l.has_diary ? '' : 'text-muted-foreground'}>
              <NotebookPen aria-hidden="true" className="mr-1 inline size-3.5" />
              {l.has_diary ? 'Diary written' : 'No diary yet'}
            </li>
            <li className={l.homework_count > 0 ? '' : 'text-muted-foreground'}>
              <BookOpen aria-hidden="true" className="mr-1 inline size-3.5" />
              {l.homework_count > 0 ? `Homework set (${l.homework_count})` : 'No homework set'}
            </li>
          </ul>
          <div className="mt-3 grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
            {!daily && (
              <Button asChild className="min-h-11">
                <Link to={`/attendance/lesson/${l.lesson_session_id}`}>
                  <ClipboardCheck aria-hidden="true" /> Attendance
                </Link>
              </Button>
            )}
            <Button asChild variant="outline" className="min-h-11">
              <Link to={`/lessons/${l.lesson_session_id}`}>Diary &amp; homework</Link>
            </Button>
          </div>
        </>
      )}
    </li>
  );
}
