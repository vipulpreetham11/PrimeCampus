import { useCallback, useMemo } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft, Info } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { PageHeader } from '@/components/shared/PageHeader';
import {
  ChoiceGroup,
  ROSTER_CHOICES_CLASS,
  ROSTER_ROW_CLASS,
  RosterRowLabel,
  RosterSaveBar,
  RowStateBadge,
  UnsavedChangesGuard,
  useRosterKeyboard,
  type ChoiceOption,
} from '@/components/shared/roster-ui';
import { Button } from '@/components/ui/button';
import {
  ATTENDANCE_STATUSES,
  PERIOD_STATUSES,
  type AttendanceStatus,
  type MarkingRoster,
} from '@/contracts/attendance';
import { useDiaryEntry } from '@/features/diary/hooks';
import { useSectionNames } from '@/features/timetable/pickers';
import { compareIsoDates, formatDateLong, formatTime, isIsoDate, schoolToday } from '@/lib/dates';
import { AppError, newRequestId, routeId, toAppError } from '@/lib/errors';
import {
  countStates,
  discardChanges,
  fillUnmarked,
  keepTheirs,
  pendingRows,
  reapplyMine,
  rowState,
  setValue,
  shownValue,
  strictEquals,
  type RosterRow,
} from '@/lib/roster';
import { useRosterSave, useServerRoster } from '@/lib/use-roster-save';
import { sendStudentMarks, useInvalidateAttendance, useMarkingRoster, type RosterTarget } from './hooks';

// Marking roster (brief §4): daily (class teacher) or period (the teacher taking the lesson).
// "Mark remaining present", then change the exceptions; P / L / A (+ H for daily). Only changed
// rows are sent, each with the version the teacher saw. Unmarked is its own state — never shown
// as present or absent — and a failed save keeps every mark on screen with "Not saved — retry".

export const STATUS_OPTIONS: Record<AttendanceStatus, ChoiceOption<AttendanceStatus>> = {
  P: {
    value: 'P',
    short: 'P',
    label: 'Present',
    selectedClass: 'border-emerald-700 bg-emerald-700 text-white',
  },
  L: { value: 'L', short: 'L', label: 'Late', selectedClass: 'border-sky-700 bg-sky-700 text-white' },
  H: { value: 'H', short: 'H', label: 'Half day', selectedClass: 'border-amber-600 bg-amber-600 text-white' },
  A: { value: 'A', short: 'A', label: 'Absent', selectedClass: 'border-red-700 bg-red-700 text-white' },
};

export const STATUS_WORD: Record<AttendanceStatus, string> = {
  P: 'Present',
  L: 'Late',
  H: 'Half day',
  A: 'Absent',
};

const eq = strictEquals as (a: AttendanceStatus | null, b: AttendanceStatus | null) => boolean;

/** Route: /attendance/lesson/:lessonId (period) or /attendance/daily/:sectionId/:date (daily). */
export function MarkingRosterPage() {
  const params = useParams();
  let target: RosterTarget | null = null;
  let badRoute: AppError | null = null;
  try {
    if (params.lessonId !== undefined) {
      const id = Number(params.lessonId);
      if (!Number.isSafeInteger(id) || id <= 0)
        throw new AppError('NOT_FOUND', 'That lesson was not found.', newRequestId());
      target = { kind: 'period', lessonId: id };
    } else {
      const date = params.date ?? '';
      if (!isIsoDate(date)) throw new AppError('NOT_FOUND', 'That date was not found.', newRequestId());
      target = { kind: 'daily', sectionId: routeId(params.sectionId), date };
    }
  } catch (e) {
    badRoute = toAppError(e);
  }
  const query = useMarkingRoster(target);
  if (badRoute || !target) return <ErrorText error={badRoute} />;
  return (
    <DataState query={query}>
      {(data) => <RosterScreen target={target} data={data} reload={() => query.refetch()} />}
    </DataState>
  );
}

function RosterScreen({
  target,
  data,
  reload,
}: {
  target: RosterTarget;
  data: MarkingRoster;
  reload: () => Promise<unknown>;
}) {
  const lesson = useDiaryEntry(target.kind === 'period' ? target.lessonId : null);
  const sectionNames = useSectionNames();
  const location = useLocation();
  const invalidate = useInvalidateAttendance();
  const today = schoolToday();

  const [roster, setRoster] = useServerRoster<AttendanceStatus, MarkingRoster>(
    data,
    (d) => d.students.map((s) => ({ id: s.student_id, value: s.status, version: s.version })),
    eq,
  );

  const options = (target.kind === 'daily' ? ATTENDANCE_STATUSES : PERIOD_STATUSES).map(
    (s) => STATUS_OPTIONS[s],
  );
  const allowed = new Set<string>(options.map((o) => o.value));

  const blocked = blockReason(target, data, today);
  const readOnly = blocked !== null || !data.can_mark;

  const send = useCallback(
    async (rows: RosterRow<AttendanceStatus>[], operationId: string) => {
      const marks = rows.map((r) => ({
        student_id: r.id,
        status: r.draft as AttendanceStatus,
        expected_version: r.baseVersion,
      }));
      const result = await sendStudentMarks(target, operationId, marks);
      return {
        conflicts: result.conflicts.map((c) => ({
          id: c.student_id,
          value: c.current_status,
          version: c.current_version,
        })),
      };
    },
    [target],
  );
  const payloadOf = useCallback(
    (rows: RosterRow<AttendanceStatus>[]) => ({
      target,
      marks: rows.map((r) => [r.id, r.draft, r.baseVersion]),
    }),
    [target],
  );
  const reloadAll = useCallback(() => Promise.all([reload(), invalidate()]), [reload, invalidate]);
  const saver = useRosterSave<AttendanceStatus>({
    setRoster,
    batchSize: 100,
    send,
    payloadOf,
    reload: reloadAll,
  });

  const counts = countStates(roster);
  const pending = pendingRows(roster).length;
  const students = data.students;
  const byStatus = useMemo(() => {
    const c: Record<AttendanceStatus, number> = { P: 0, L: 0, H: 0, A: 0 };
    for (const id of roster.order) {
      const row = roster.rows[id];
      const v = row ? shownValue(row) : null;
      if (v) c[v] += 1;
    }
    return c;
  }, [roster]);

  const set = (id: string, v: AttendanceStatus) => {
    if (saver.phase === 'saved') saver.acknowledge();
    setRoster((r) => setValue(r, id, v, eq));
  };

  const keyboard = useRosterKeyboard(students.length, (i, key) => {
    const s = students[i];
    if (!s || readOnly || saver.phase === 'saving' || !allowed.has(key)) return false;
    set(s.student_id, key as AttendanceStatus);
    return true;
  });

  const unmarkedNow = counts.unmarked;
  const allUnmarked = unmarkedNow === students.length;
  // the section name: Today passes it with the link; otherwise the setup snapshot / the lesson
  const passed = (location.state as { section?: string } | null)?.section;
  const sectionLabel = sectionNames.get(data.section_id) ?? lesson.data?.lesson.section ?? passed ?? null;
  const lessonTitle = lesson.data
    ? `${lesson.data.lesson.section} · ${lesson.data.lesson.subject}`
    : sectionLabel;
  const title =
    target.kind === 'period'
      ? `Attendance${lessonTitle ? ` — ${lessonTitle}` : ''}`
      : `Day attendance${sectionLabel ? ` — ${sectionLabel}` : ''}`;

  return (
    <div className="space-y-4" data-testid="marking-roster">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to={target.kind === 'period' ? `/lessons/${target.lessonId}` : '/dashboard'}>
          <ArrowLeft aria-hidden="true" /> {target.kind === 'period' ? 'Lesson' : 'Back'}
        </Link>
      </Button>
      <PageHeader
        title={title}
        description={
          <>
            {formatDateLong(data.date)}
            {target.kind === 'period' && lesson.data && (
              <>
                {' '}
                · {lesson.data.lesson.slot_label} ({formatTime(lesson.data.lesson.start_time)}) ·{' '}
                {lesson.data.lesson.teacher ?? 'No teacher'}
              </>
            )}{' '}
            · {target.kind === 'daily' ? 'Day-wise register' : 'Period register'}
          </>
        }
      />

      {blocked && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border p-3 text-sm"
          data-testid="roster-blocked"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {blocked.text}
            {blocked.dailyLink && (
              <>
                {' '}
                <Link className="underline" to={`/attendance/daily/${data.section_id}/${data.date}`}>
                  Open the day register
                </Link>
              </>
            )}
          </span>
        </p>
      )}
      {!blocked && !data.can_mark && (
        <p role="status" className="flex items-start gap-2 rounded-md border p-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          You can see this register but not change it.
        </p>
      )}

      {students.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
          No students are in this section on this date.
        </p>
      ) : (
        <>
          {!readOnly && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="min-h-11"
                disabled={unmarkedNow === 0 || saver.phase === 'saving'}
                onClick={() => setRoster((r) => fillUnmarked(r, 'P' as AttendanceStatus))}
              >
                {unmarkedNow === 0
                  ? 'Everyone is marked'
                  : allUnmarked
                    ? 'Mark all present'
                    : `Mark remaining ${unmarkedNow} present`}
              </Button>
              {(pending > 0 || counts.conflict > 0) && (
                <Button
                  variant="ghost"
                  className="min-h-11"
                  disabled={saver.phase === 'saving'}
                  onClick={() => setRoster((r) => discardChanges(r))}
                >
                  Undo unsaved changes
                </Button>
              )}
              <p className="text-muted-foreground w-full text-xs">
                Keyboard: ↑ ↓ to move, {options.map((o) => o.short).join(' / ')} to mark.
              </p>
            </div>
          )}

          <ol
            className="divide-y rounded-lg border"
            aria-label="Students"
            onKeyDown={keyboard.onKeyDown}
            data-testid="roster-rows"
          >
            {students.map((s, i) => {
              const row = roster.rows[s.student_id];
              if (!row) return null;
              const state = rowState(row);
              const value = shownValue(row);
              return (
                <li
                  key={s.student_id}
                  {...keyboard.rowProps(i)}
                  className={ROSTER_ROW_CLASS}
                  aria-label={`${s.name}: ${value ? STATUS_WORD[value] : 'unmarked'}${state === 'changed' ? ', not saved' : ''}`}
                  data-testid="roster-row"
                  data-student={s.name}
                  data-state={state}
                >
                  <RosterRowLabel
                    lead={s.roll_no ?? '–'}
                    name={s.name}
                    badge={<RowStateBadge state={state} />}
                    reference={s.admission_no}
                    referenceLabel="Admission number"
                  />
                  <ChoiceGroup
                    className={ROSTER_CHOICES_CLASS}
                    options={options}
                    value={value}
                    onChange={(v) => set(s.student_id, v)}
                    disabled={readOnly || saver.phase === 'saving'}
                    label={`Attendance for ${s.name}`}
                  />
                  {row.conflict && (
                    <ConflictLine
                      theirs={row.conflict.value}
                      mine={row.draft}
                      onMine={() => setRoster((r) => reapplyMine(r, s.student_id))}
                      onTheirs={() => setRoster((r) => keepTheirs(r, s.student_id))}
                    />
                  )}
                </li>
              );
            })}
          </ol>

          {!readOnly && (
            <RosterSaveBar
              summary={
                <>
                  <span data-testid="roster-summary">
                    {students.length - counts.unmarked} of {students.length} marked
                    {counts.unmarked > 0 && <> · {counts.unmarked} unmarked</>}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    Present {byStatus.P} · Late {byStatus.L}
                    {target.kind === 'daily' && <> · Half day {byStatus.H}</>} · Absent {byStatus.A}
                    {pending > 0 && <> · {pending} not saved</>}
                  </span>
                </>
              }
              pendingCount={pending}
              conflictCount={saver.conflictCount}
              phase={saver.phase}
              error={saver.error}
              onSave={() => void saver.save(roster)}
              saveLabel="Save attendance"
            />
          )}
          <UnsavedChangesGuard when={pending > 0 || counts.conflict > 0} />
        </>
      )}
    </div>
  );
}

export function ConflictLine({
  theirs,
  mine,
  onMine,
  onTheirs,
  word = (v) => (v ? (STATUS_WORD[v as AttendanceStatus] ?? v) : 'Unmarked'),
}: {
  theirs: string | null;
  mine: string | null;
  onMine: () => void;
  onTheirs: () => void;
  word?: (v: string | null) => string;
}) {
  return (
    <div
      className="border-destructive/40 bg-destructive/5 w-full rounded-md border p-2 text-sm"
      role="alert"
      data-testid="row-conflict"
    >
      <p>
        Someone else saved <strong>{word(theirs)}</strong> before you. Your choice:{' '}
        <strong>{word(mine)}</strong>.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" className="min-h-11 sm:min-h-8" onClick={onMine}>
          Use mine ({word(mine)})
        </Button>
        <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={onTheirs}>
          Keep theirs ({word(theirs)})
        </Button>
      </div>
    </div>
  );
}

/** Why this roster can't be marked right now (server rules, shown before the server refuses). */
export function blockReason(
  target: RosterTarget,
  data: MarkingRoster,
  today: string,
): { text: string; dailyLink?: boolean } | null {
  if (target.kind === 'period' && data.lesson_status === 'cancelled') {
    return { text: 'This lesson was cancelled, so there is no attendance for it.' };
  }
  if ((data.day?.weight ?? 0) === 0) {
    return { text: 'This date is not a working day for students.' };
  }
  if (target.kind === 'period' && data.mode_on_date === 'daily') {
    return {
      text: 'The school takes day-wise attendance on this date: the class teacher marks it once for the day.',
      dailyLink: true,
    };
  }
  if (target.kind === 'daily' && data.mode_on_date === 'period') {
    return { text: 'The school takes attendance per period on this date: each lesson has its own register.' };
  }
  if (compareIsoDates(data.date, today) > 0) {
    return { text: 'Attendance can only be marked on or after the day itself.' };
  }
  return null;
}
