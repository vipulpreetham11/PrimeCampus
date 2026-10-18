import { useState } from 'react';
import { Link } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { StudentDiaryItem, StudentHomeworkItem } from '@/contracts/academic';
import { StudentAttendance } from '@/features/attendance/StudentAttendance';
import { useStudentDiary } from '@/features/diary/hooks';
import { useStudentHomework } from '@/features/homework/hooks';
import { WeekView } from '@/features/schedule/ScheduleViews';
import {
  addDays,
  compareIsoDates,
  formatDate,
  formatDateTime,
  formatDayShort,
  formatTime,
  schoolToday,
  weekStart,
} from '@/lib/dates';
import { useSessionSelector } from '@/lib/session/store';

// Parent / student area (brief §8, child.view). Everything is for the child selected in the context
// (never an id from the URL); the server scopes every child RPC to that child. Switching child
// (M0) changes the context revision, which clears every cached query and remounts these pages.

export function useChildId(): string | null {
  return useSessionSelector((s) => s.context?.student_id ?? null);
}

function NoChild() {
  return (
    <p className="text-muted-foreground text-sm">Choose a child first (switch role / child in the header).</p>
  );
}

export function ChildHomePage() {
  const childId = useChildId();
  const today = schoolToday();
  const monday = weekStart(today);
  if (!childId) return <NoChild />;
  return (
    <div className="space-y-6" data-testid="child-home">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Homework</CardTitle>
            <Link to="/child/homework" className="text-sm underline">
              All homework
            </Link>
          </CardHeader>
          <CardContent>
            <HomeworkFeed childId={childId} from={addDays(today, -30)} to={today} dueOnly />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Latest diary notes</CardTitle>
            <Link to="/child/diary" className="text-sm underline">
              All diary notes
            </Link>
          </CardHeader>
          <CardContent>
            <DiaryFeed childId={childId} from={addDays(today, -6)} to={today} limit={5} />
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Attendance</CardTitle>
          <Link to="/child/attendance" className="text-sm underline">
            Details
          </Link>
        </CardHeader>
        <CardContent>
          <StudentAttendance studentId={childId} />
        </CardContent>
      </Card>
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">This week</h2>
          <Link to="/child/timetable" className="text-sm underline">
            Other weeks
          </Link>
        </div>
        <WeekView
          from={monday}
          to={addDays(monday, 6)}
          filter={{ sectionId: null, staffId: null }}
          showSection={false}
        />
      </section>
    </div>
  );
}

export function ChildTimetablePage() {
  const childId = useChildId();
  const [monday, setMonday] = useState(weekStart(schoolToday()));
  if (!childId) return <NoChild />;
  return (
    <div className="space-y-4">
      <PageHeader title="Timetable" description="Lessons for the week, with substitutes and cancellations." />
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          className="size-11"
          aria-label="Previous week"
          onClick={() => setMonday(addDays(monday, -7))}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <p className="min-w-48 text-center text-sm font-medium">
          {formatDayShort(monday)} – {formatDayShort(addDays(monday, 6))}
        </p>
        <Button
          variant="outline"
          size="icon"
          className="size-11"
          aria-label="Next week"
          onClick={() => setMonday(addDays(monday, 7))}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
      <WeekView
        from={monday}
        to={addDays(monday, 6)}
        filter={{ sectionId: null, staffId: null }}
        showSection={false}
      />
    </div>
  );
}

export function ChildAttendancePage() {
  const childId = useChildId();
  if (!childId) return <NoChild />;
  return (
    <div className="space-y-4">
      <PageHeader title="Attendance" description="This year so far, and day by day." />
      <StudentAttendance studentId={childId} />
    </div>
  );
}

/** Pages of 2 weeks back from today (get_student_diary accepts ≤ 63 days). */
export function ChildDiaryPage() {
  const childId = useChildId();
  const [to, setTo] = useState(schoolToday());
  const from = addDays(to, -13);
  if (!childId) return <NoChild />;
  return (
    <div className="space-y-4">
      <PageHeader title="Diary" description="What was covered in each lesson." />
      <RangeNav
        from={from}
        to={to}
        onPrev={() => setTo(addDays(to, -14))}
        onNext={() => setTo(addDays(to, 14))}
        canNext={compareIsoDates(to, schoolToday()) < 0}
      />
      <DiaryFeed childId={childId} from={from} to={to} />
    </div>
  );
}

export function ChildHomeworkPage() {
  const childId = useChildId();
  const [to, setTo] = useState(addDays(schoolToday(), 7));
  const from = addDays(to, -34);
  if (!childId) return <NoChild />;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Homework"
        description="Homework set in class, and what the teacher recorded when checking it."
      />
      <RangeNav
        from={from}
        to={to}
        onPrev={() => setTo(addDays(to, -35))}
        onNext={() => setTo(addDays(to, 35))}
        canNext
        label="Set between"
      />
      <HomeworkFeed childId={childId} from={from} to={to} />
    </div>
  );
}

function RangeNav({
  from,
  to,
  onPrev,
  onNext,
  canNext,
  label,
}: {
  from: string;
  to: string;
  onPrev: () => void;
  onNext: () => void;
  canNext: boolean;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="icon" className="size-11" aria-label="Earlier" onClick={onPrev}>
        <ChevronLeft aria-hidden="true" />
      </Button>
      <p className="min-w-48 text-center text-sm font-medium">
        {label ? `${label} ` : ''}
        {formatDate(from)} – {formatDate(to)}
      </p>
      <Button
        variant="outline"
        size="icon"
        className="size-11"
        aria-label="Later"
        onClick={onNext}
        disabled={!canNext}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  );
}

function DiaryFeed({
  childId,
  from,
  to,
  limit,
}: {
  childId: string;
  from: string;
  to: string;
  limit?: number;
}) {
  const query = useStudentDiary(childId, from, to);
  return (
    <DataState query={query} isEmpty={(d) => d.length === 0} emptyTitle="No diary notes in this period">
      {(items) => (
        <ul className="space-y-2" aria-label="Diary notes">
          {(limit ? items.slice(0, limit) : items).map((d) => (
            <DiaryNote key={d.lesson_session_id} d={d} />
          ))}
        </ul>
      )}
    </DataState>
  );
}

function DiaryNote({ d }: { d: StudentDiaryItem }) {
  return (
    <li className="rounded-md border p-3" data-testid="child-diary-note">
      <p className="text-sm font-medium">
        {formatDayShort(d.date)} · {d.subject}
        <span className="text-muted-foreground font-normal">
          {' '}
          · {d.slot_label} ({formatTime(d.start_time)}){d.teacher && ` · ${d.teacher}`}
        </span>
      </p>
      <p className="mt-1 text-sm whitespace-pre-wrap">{d.body}</p>
      <p className="text-muted-foreground text-xs">Written {formatDateTime(d.updated_at)}</p>
    </li>
  );
}

const STATE_TEXT = {
  unchecked: 'Not checked yet',
  completed: 'Completed',
  not_completed: 'Not completed',
} as const;

export function homeworkFlags(h: StudentHomeworkItem, today: string): string[] {
  const flags: string[] = [];
  if (h.correction === 'required') flags.push('Correction required');
  if (h.correction === 'done') flags.push('Correction done');
  if (h.completed_after_due) flags.push('Completed after the due date');
  if (h.observed_after_due) flags.push('Checked after the due date');
  if (h.state === 'unchecked' && compareIsoDates(h.due_on, today) < 0) flags.push('Due date passed');
  return flags;
}

function HomeworkFeed({
  childId,
  from,
  to,
  dueOnly,
}: {
  childId: string;
  from: string;
  to: string;
  dueOnly?: boolean;
}) {
  const query = useStudentHomework(childId, from, to);
  const today = schoolToday();
  return (
    <DataState query={query} isEmpty={(h) => h.length === 0} emptyTitle="No homework in this period">
      {(items) => {
        // the home card: homework still due, plus anything not completed / needing correction
        const shown = dueOnly
          ? items.filter(
              (h) =>
                compareIsoDates(h.due_on, today) >= 0 ||
                h.state === 'not_completed' ||
                h.correction === 'required' ||
                h.state === 'unchecked',
            )
          : items;
        if (shown.length === 0)
          return <p className="text-muted-foreground text-sm">Nothing due or pending.</p>;
        return (
          <ul className="space-y-2" aria-label="Homework">
            {shown.map((h) => (
              <li key={h.assignment_id} className="rounded-md border p-3" data-testid="child-homework">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{h.subject}</span>
                  <Badge
                    variant={
                      h.state === 'unchecked'
                        ? 'outline'
                        : h.state === 'completed'
                          ? 'default'
                          : 'destructive'
                    }
                    className={h.state === 'unchecked' ? 'border-dashed' : undefined}
                  >
                    {STATE_TEXT[h.state]}
                  </Badge>
                  {homeworkFlags(h, today).map((f) => (
                    <Badge key={f} variant="secondary">
                      {f}
                    </Badge>
                  ))}
                </div>
                <p className="mt-1 text-sm whitespace-pre-wrap">{h.description}</p>
                <p className="text-muted-foreground text-xs">
                  Set {formatDate(h.assigned_on)} · due {formatDate(h.due_on)}
                  {h.assigned_by && ` · ${h.assigned_by}`}
                  {h.observed_on && ` · checked ${formatDate(h.observed_on)}`}
                  {h.completed_on && ` · completed ${formatDate(h.completed_on)}`}
                </p>
                {h.comment && <p className="mt-1 text-sm">Teacher&apos;s comment: {h.comment}</p>}
              </li>
            ))}
          </ul>
        );
      }}
    </DataState>
  );
}
