import type { ReactNode } from 'react';
import { DataState } from '@/components/shared/DataState';
import type { ScheduleDay, ScheduleLesson } from '@/contracts/timetable';
import { formatDateLong, formatDayShort, schoolToday } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { useDateSchedule, useScheduleRange, type ScheduleFilter } from './hooks';
import { dayTypeText, isUncovered, isWorkingDay, LessonCard } from './LessonCard';

// Day and week views, shared by the staff schedule page and the parent/student area (the server
// scopes a parent's request to the selected child's section).

interface ViewProps {
  filter: ScheduleFilter;
  showSection: boolean;
  lessonLink?: (l: ScheduleLesson) => string | undefined;
  actions?: (l: ScheduleLesson, date: string) => ReactNode;
  /** "Not covered only": scheduled lessons whose teacher is marked absent (the dashboard's rule). */
  onlyUncovered?: boolean;
}

function EmptyDay({ text }: { text: string }) {
  return <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">{text}</p>;
}

function DayLessons({
  date,
  day,
  lessons,
  ...props
}: ViewProps & { date: string; day: ScheduleDay['day'] | undefined; lessons: ScheduleLesson[] }) {
  if (props.onlyUncovered) {
    const uncovered = lessons.filter(isUncovered);
    if (uncovered.length === 0) return <EmptyDay text="No lessons with an absent teacher on this day." />;
    lessons = uncovered;
  }
  if (lessons.length === 0) {
    const working = day === undefined || isWorkingDay(day);
    return (
      <EmptyDay
        text={
          working
            ? props.lessonLink
              ? 'No lessons on this day. Lessons appear after the timetable is activated and lessons are updated.'
              : 'No lessons on this day.'
            : `${dayTypeText(day)} — no lessons.`
        }
      />
    );
  }
  return (
    <ul className="space-y-2">
      {lessons.map((l) => (
        <li key={l.lesson_session_id}>
          <LessonCard
            lesson={l}
            showSection={props.showSection}
            lessonLink={props.lessonLink?.(l)}
            actions={props.actions?.(l, date)}
          />
        </li>
      ))}
    </ul>
  );
}

export function DayView({ date, ...props }: ViewProps & { date: string }) {
  const query = useDateSchedule(date, props.filter);
  return (
    <section aria-label={`Lessons on ${formatDateLong(date)}`} data-testid="day-view">
      <DataState query={query}>
        {(lessons) => <DayLessons date={date} day={undefined} lessons={lessons} {...props} />}
      </DataState>
    </section>
  );
}

export function WeekView({ from, to, ...props }: ViewProps & { from: string; to: string }) {
  const query = useScheduleRange(from, to, props.filter);
  const today = schoolToday();
  return (
    <section aria-label="Week" data-testid="week-view">
      <DataState query={query}>
        {(days) => (
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {days.map((d) => (
              <div
                key={d.date}
                className={cn('space-y-2', d.date === today && 'rounded-lg ring-2 ring-offset-2')}
              >
                <h3 className="text-sm font-semibold">
                  {formatDayShort(d.date)}
                  {d.date === today && <span className="text-muted-foreground font-normal"> · Today</span>}
                  <span className="text-muted-foreground block text-xs font-normal">
                    {dayTypeText(d.day)}
                  </span>
                </h3>
                <DayLessons date={d.date} day={d.day} lessons={d.lessons} {...props} />
              </div>
            ))}
          </div>
        )}
      </DataState>
    </section>
  );
}
