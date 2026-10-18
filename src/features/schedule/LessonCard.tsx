import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { BookOpen, NotebookPen } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { ResolvedDayInfo, ScheduleLesson } from '@/contracts/timetable';
import { formatTime } from '@/lib/dates';
import { cn } from '@/lib/utils';

// One dated lesson as shown in the day/week views: planned vs actual teacher, substitute badge,
// cancellation with its reason, "planned teacher absent / half day" flags and diary/homework state.

export function dayTypeText(day: ResolvedDayInfo): string {
  if (!day || !day.day_type) return 'Outside the academic year';
  const base =
    day.day_type === 'working'
      ? 'Working day'
      : day.day_type === 'half_day'
        ? 'Half day'
        : day.day_type === 'holiday'
          ? 'Holiday'
          : day.day_type === 'weekly_off'
            ? 'Weekly off'
            : day.day_type;
  return day.label ? `${base} — ${day.label}` : base;
}

export function isWorkingDay(day: ResolvedDayInfo): boolean {
  return (day?.weight ?? 0) > 0;
}

export function LessonCard({
  lesson,
  showSection,
  lessonLink,
  actions,
  compact,
}: {
  lesson: ScheduleLesson;
  showSection?: boolean;
  /** Link target for staff ("Open lesson"); none for parents. */
  lessonLink?: string;
  actions?: ReactNode;
  compact?: boolean;
}) {
  const cancelled = lesson.status === 'cancelled';
  return (
    <article
      className={cn('rounded-lg border p-3', cancelled && 'bg-muted/40')}
      aria-label={`${lesson.slot_label}, ${lesson.subject}${showSection ? `, ${lesson.section}` : ''}`}
      data-testid="lesson-card"
      data-lesson-id={lesson.lesson_session_id}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground text-xs">
            {lesson.slot_label} · {formatTime(lesson.start_time)}–{formatTime(lesson.end_time)}
            {showSection && <> · {lesson.section}</>}
          </p>
          <p className={cn('font-medium', cancelled && 'line-through')}>{lesson.subject}</p>
          <TeacherLine lesson={lesson} />
        </div>
        {actions}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {cancelled && (
          <Badge variant="destructive" data-testid="badge-cancelled">
            Cancelled{lesson.cancel_reason ? ` — ${lesson.cancel_reason}` : ''}
          </Badge>
        )}
        {lesson.is_substituted && !lesson.unassigned && (
          <Badge variant="secondary" data-testid="badge-substitute">
            Substitute
          </Badge>
        )}
        {lesson.unassigned && <Badge variant="outline">No teacher assigned</Badge>}
        {lesson.planned_teacher_absent === true && (
          <Badge variant="outline" className="border-amber-500" data-testid="badge-planned-absent">
            Planned teacher absent
          </Badge>
        )}
        {lesson.planned_teacher_half_day === true && (
          <Badge variant="outline" className="border-amber-500">
            Planned teacher on half day
          </Badge>
        )}
        {!compact && !cancelled && (
          <>
            <Badge variant="outline" data-testid="badge-diary">
              <NotebookPen aria-hidden="true" />
              {lesson.has_diary ? 'Diary written' : 'No diary yet'}
            </Badge>
            {lesson.homework_count > 0 && (
              <Badge variant="outline">
                <BookOpen aria-hidden="true" />
                Homework: {lesson.homework_count}
              </Badge>
            )}
          </>
        )}
      </div>
      {lessonLink && (
        <Link to={lessonLink} className="mt-2 inline-flex min-h-11 items-center text-sm underline sm:min-h-0">
          Open lesson
        </Link>
      )}
    </article>
  );
}

function TeacherLine({ lesson }: { lesson: ScheduleLesson }) {
  if (lesson.unassigned) return <p className="text-sm text-amber-800 dark:text-amber-300">Unassigned</p>;
  if (lesson.is_substituted) {
    return (
      <p className="text-sm">
        {lesson.actual_staff}{' '}
        <span className="text-muted-foreground">(planned: {lesson.planned_staff ?? 'unassigned'})</span>
      </p>
    );
  }
  return <p className="text-muted-foreground text-sm">{lesson.actual_staff}</p>;
}
