import { Link, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DateInput } from '@/components/shared/DateInput';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  SectionSelect,
  TeacherSelect,
  useSectionOptions,
  useTeacherOptions,
} from '@/features/timetable/pickers';
import { addDays, formatDateLong, formatDayShort, isIsoDate, schoolToday, weekStart } from '@/lib/dates';
import { useCan, useCanAny } from '@/lib/scope';
import { LessonActions } from './LessonActions';
import { DayView, WeekView } from './ScheduleViews';

// Day and week schedule for a section or a teacher (brief §2). Filters live in the URL so a day can
// be linked to (e.g. from "kept" lessons after a timetable change).

export function SchedulePage() {
  const canManage = useCan('timetable.manage');
  const canOpenLessons = useCanAny('academic.read_all', 'lessons.teach');
  const [params, setParams] = useSearchParams();
  const today = schoolToday();
  const rawDate = params.get('date');
  const date = rawDate && isIsoDate(rawDate) ? rawDate : today;
  const view = params.get('view') === 'week' ? 'week' : 'day';
  const sectionId = params.get('section');
  const staffId = params.get('staff');
  const { options: sections } = useSectionOptions();
  const { options: teachers } = useTeacherOptions();

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  const step = view === 'week' ? 7 : 1;
  const from = view === 'week' ? weekStart(date) : date;
  const to = addDays(from, 6);
  const filter = { sectionId, staffId };
  const lessonLink = canOpenLessons
    ? (l: { lesson_session_id: number }) => `/lessons/${l.lesson_session_id}`
    : undefined;
  const actions = canManage
    ? (l: Parameters<typeof LessonActions>[0]['lesson'], d: string) => <LessonActions lesson={l} date={d} />
    : undefined;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Schedule"
        description="Dated lessons with substitutes, cancellations and teacher absence."
        actions={
          <Button asChild variant="outline">
            <Link to="/schedule/substitutions">Substitution history</Link>
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <Tabs value={view} onValueChange={(v) => update({ view: v === 'week' ? 'week' : null })}>
          <TabsList>
            <TabsTrigger value="day" className="min-h-9">
              Day
            </TabsTrigger>
            <TabsTrigger value="week" className="min-h-9">
              Week
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-end gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-11 sm:size-9"
            aria-label={view === 'week' ? 'Previous week' : 'Previous day'}
            onClick={() => update({ date: addDays(date, -step) })}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <div className="grid gap-1.5">
            <label htmlFor="schedule-date" className="text-sm font-medium">
              Date
            </label>
            <DateInput id="schedule-date" value={date} onChange={(v) => v && update({ date: v })} />
          </div>
          <Button
            variant="outline"
            size="icon"
            className="size-11 sm:size-9"
            aria-label={view === 'week' ? 'Next week' : 'Next day'}
            onClick={() => update({ date: addDays(date, step) })}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          {date !== today && (
            <Button variant="ghost" onClick={() => update({ date: null })}>
              Today
            </Button>
          )}
        </div>
        <SectionSelect
          id="schedule-section"
          value={sectionId}
          onChange={(v) => update({ section: v, staff: null })}
          options={sections}
          allowAll
        />
        {teachers.length > 0 && (
          <TeacherSelect
            id="schedule-teacher"
            value={staffId}
            onChange={(v) => update({ staff: v, section: null })}
            options={teachers}
          />
        )}
      </div>
      <h2 className="text-base font-semibold">
        {view === 'week' ? `Week of ${formatDayShort(from)} – ${formatDayShort(to)}` : formatDateLong(date)}
      </h2>
      {view === 'week' ? (
        sectionId || staffId ? (
          <WeekView
            from={from}
            to={to}
            filter={filter}
            showSection={!sectionId}
            lessonLink={lessonLink}
            actions={actions}
          />
        ) : (
          <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
            Choose a section or a teacher to see their week.
          </p>
        )
      ) : (
        <DayView
          date={date}
          filter={filter}
          showSection={!sectionId}
          lessonLink={lessonLink}
          actions={actions}
        />
      )}
    </div>
  );
}
