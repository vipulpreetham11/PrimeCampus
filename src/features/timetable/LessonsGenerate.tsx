import { useState } from 'react';
import { Link } from 'react-router';
import { Loader2 } from 'lucide-react';
import { DateInput } from '@/components/shared/DateInput';
import { ErrorText } from '@/components/shared/ErrorText';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type { LessonsGenerated } from '@/contracts/timetable';
import { addDays, compareIsoDates, daysBetween, formatDate, formatDayShort, schoolToday } from '@/lib/dates';
import { toAppError, type AppError } from '@/lib/errors';
import { useGenerateLessons } from './hooks';
import { useSectionNames } from './pickers';

// "Update lessons" (generate_lesson_sessions): creates dated lessons from the active timetables and
// refreshes unused future ones. Lessons that already have attendance, diary or homework are never
// changed — they are listed so the Admin can decide what to do with each.

/** generate_lesson_sessions accepts at most 63 days (to − from ≤ 62). */
export const MAX_GENERATE_DAYS = 63;

export function validateRange(from: string, to: string): string | null {
  if (!from || !to) return 'Choose both dates.';
  if (compareIsoDates(to, from) < 0) return 'The end date must be on or after the start date.';
  if (daysBetween(from, to) > MAX_GENERATE_DAYS - 1)
    return `Choose at most ${MAX_GENERATE_DAYS} days at a time.`;
  return null;
}

export function LessonRefreshResult({ result }: { result: LessonsGenerated }) {
  const sectionNames = useSectionNames();
  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="lesson-refresh-result" role="status">
      <p className="font-medium">Lessons updated</p>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">New lessons</dt>
          <dd className="text-lg font-semibold" data-testid="result-created">
            {result.created}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Updated to the new plan</dt>
          <dd className="text-lg font-semibold" data-testid="result-updated">
            {result.updated}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cancelled (not used)</dt>
          <dd className="text-lg font-semibold" data-testid="result-cancelled">
            {result.cancelled_unused}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Kept unchanged</dt>
          <dd className="text-lg font-semibold" data-testid="result-kept">
            {result.kept_used.length}
          </dd>
        </div>
      </dl>
      {result.cancelled_unused > 0 && (
        <p className="text-muted-foreground text-sm">
          Cancelled: {result.cancelled_timetable_changed} no longer in the timetable,{' '}
          {result.cancelled_not_working} on days that are not working days.
        </p>
      )}
      {result.kept_used.length > 0 && (
        <div>
          <p className="text-sm font-medium">
            These lessons already have attendance, diary or homework — not changed:
          </p>
          <ul className="mt-1 space-y-1 text-sm" data-testid="kept-lessons">
            {result.kept_used.map((k) => (
              <li key={k.lesson_session_id} className="flex flex-wrap gap-x-2">
                <span>
                  {formatDayShort(k.date)} · {sectionNames.get(k.section_id) ?? 'Section'} · Slot{' '}
                  {k.slot_ordinal}
                </span>
                <Link className="underline" to={`/schedule?date=${k.date}&section=${k.section_id}`}>
                  Open day
                </Link>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-1 text-xs">
            Change or cancel them one by one from the day view if they should follow the new plan.
          </p>
        </div>
      )}
    </div>
  );
}

/** Date range form + result. `sectionId` null = every section. */
export function GenerateLessonsForm({
  sectionId,
  defaultFrom,
  onDone,
}: {
  sectionId: string | null;
  defaultFrom?: string;
  onDone?: (r: LessonsGenerated) => void;
}) {
  const today = schoolToday();
  const [from, setFrom] = useState<string>(defaultFrom ?? today);
  const [to, setTo] = useState<string>(addDays(defaultFrom ?? today, 13));
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [result, setResult] = useState<LessonsGenerated | null>(null);
  const generate = useGenerateLessons();

  const submit = () => {
    const p = validateRange(from, to);
    setProblem(p);
    setError(null);
    if (p) return;
    generate.mutate(
      { from, to, sectionId },
      {
        onSuccess: (r) => {
          setResult(r);
          onDone?.(r);
        },
        onError: (e) => setError(toAppError(e)),
      },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="gen-from">From</Label>
          <DateInput id="gen-from" value={from} onChange={(v) => setFrom(v)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="gen-to">To</Label>
          <DateInput id="gen-to" value={to} onChange={(v) => setTo(v)} min={from || undefined} />
        </div>
        <Button onClick={submit} disabled={generate.isPending} className="min-h-11">
          {generate.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
          Update lessons
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Up to {MAX_GENERATE_DAYS} days at a time. Past dates only get missing lessons added; lessons from
        today onwards follow the active timetable.{' '}
        {from && to && !validateRange(from, to) && (
          <>
            Range: {formatDate(from)} – {formatDate(to)}.
          </>
        )}
      </p>
      {problem && (
        <p role="alert" className="text-destructive text-sm">
          {problem}
        </p>
      )}
      <ErrorText error={error} />
      {result && <LessonRefreshResult result={result} />}
    </div>
  );
}
