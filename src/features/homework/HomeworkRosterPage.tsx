import { useCallback, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { ArrowLeft, Info } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { ErrorText } from '@/components/shared/ErrorText';
import { PageHeader } from '@/components/shared/PageHeader';
import {
  ChoiceGroup,
  RosterSaveBar,
  RowStateBadge,
  UnsavedChangesGuard,
  useRosterKeyboard,
  type ChoiceOption,
} from '@/components/shared/roster-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Correction, HomeworkRoster } from '@/contracts/academic';
import { ConflictLine } from '@/features/attendance/MarkingRosterPage';
import { useSetupSnapshot } from '@/features/setup/hooks';
import { useSectionNames } from '@/features/timetable/pickers';
import { compareIsoDates, formatDate, schoolToday } from '@/lib/dates';
import { routeId, toAppError, type AppError } from '@/lib/errors';
import {
  countStates,
  discardChanges,
  keepTheirs,
  pendingRows,
  reapplyMine,
  rowState,
  setValue,
  shownValue,
  type RosterRow,
} from '@/lib/roster';
import { useCanAny } from '@/lib/scope';
import { useRosterSave, useServerRoster } from '@/lib/use-roster-save';
import { sendHomeworkChecks, useHomeworkRoster, useInvalidateHomeworkChecks, type CheckValue } from './hooks';

// Homework checking roster (brief §7): per student Completed / Not completed, a correction
// (none / required / done), an optional completion date (≤ the checked date) and a comment.
// Unchecked is its own state — never shown as "not completed". Same save rules as attendance.

export const COMPLETION_OPTIONS: ChoiceOption<CheckValue['completion']>[] = [
  {
    value: 'completed',
    short: 'C',
    label: 'Completed',
    selectedClass: 'border-emerald-700 bg-emerald-700 text-white',
  },
  {
    value: 'not_completed',
    short: 'N',
    label: 'Not completed',
    selectedClass: 'border-red-700 bg-red-700 text-white',
  },
];
export const CORRECTION_OPTIONS: ChoiceOption<Correction>[] = [
  { value: 'none', short: '–', label: 'No correction' },
  {
    value: 'required',
    short: 'Fix',
    label: 'Correction required',
    selectedClass: 'border-amber-600 bg-amber-600 text-white',
  },
  { value: 'done', short: 'Done', label: 'Correction done' },
];
const COMPLETION_WORD = { completed: 'Completed', not_completed: 'Not completed' } as const;
const CORRECTION_WORD: Record<Correction, string> = {
  none: '',
  required: 'correction required',
  done: 'correction done',
};

export function checkEquals(a: CheckValue | null, b: CheckValue | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.completion === b.completion &&
    a.correction === b.correction &&
    (a.completed_on ?? null) === (b.completed_on ?? null) &&
    (a.comment ?? null) === (b.comment ?? null)
  );
}

export function checkWord(v: CheckValue | null): string {
  if (!v) return 'Unchecked';
  const c = CORRECTION_WORD[v.correction];
  return `${COMPLETION_WORD[v.completion]}${c ? `, ${c}` : ''}`;
}

/** Server row → roster value (unchecked = null). */
export function serverCheck(s: HomeworkRoster['students'][number]): CheckValue | null {
  if (s.state === 'unchecked') return null;
  return {
    completion: s.state,
    correction: s.correction ?? 'none',
    completed_on: s.completed_on,
    comment: s.comment,
  };
}

export function HomeworkRosterPage() {
  const params = useParams();
  let id: string | null = null;
  let bad: AppError | null = null;
  try {
    id = routeId(params.assignmentId);
  } catch (e) {
    bad = toAppError(e);
  }
  const query = useHomeworkRoster(id);
  if (bad) return <ErrorText error={bad} />;
  return (
    <DataState query={query}>
      {(data) => <CheckRoster data={data} reload={() => query.refetch()} />}
    </DataState>
  );
}

function CheckRoster({ data, reload }: { data: HomeworkRoster; reload: () => Promise<unknown> }) {
  const location = useLocation();
  const listSaysCanCheck = (location.state as { canCheck?: boolean } | null)?.canCheck;
  // get_homework_roster has no can_check flag: the list's flag when we came from it, else the
  // capabilities that can check homework. The server still decides (FORBIDDEN is shown).
  const capsCanCheck = useCanAny('academic.correct', 'lessons.teach');
  const canCheck = listSaysCanCheck ?? capsCanCheck;
  const hw = data.assignment;
  const today = schoolToday();
  const readOnly = !canCheck || hw.status !== 'active';
  const snapshot = useSetupSnapshot(hw.academic_year_id);
  const sectionNames = useSectionNames(hw.academic_year_id);
  const subject = snapshot.data?.subjects.find((s) => s.id === hw.subject_id)?.name ?? 'Homework';
  const section = sectionNames.get(hw.section_id) ?? '';
  const invalidate = useInvalidateHomeworkChecks();

  const [observedOn, setObservedOn] = useState<string>(
    compareIsoDates(today, hw.assigned_on) >= 0 ? today : hw.assigned_on,
  );
  const [roster, setRoster] = useServerRoster<CheckValue, HomeworkRoster>(
    data,
    (d) => d.students.map((s) => ({ id: s.student_id, value: serverCheck(s), version: s.version })),
    checkEquals,
  );

  const send = useCallback(
    async (rows: RosterRow<CheckValue>[], operationId: string) => {
      const res = await sendHomeworkChecks(
        hw.id,
        observedOn,
        operationId,
        rows.map((r) => ({ student_id: r.id, ...(r.draft as CheckValue), expected_version: r.baseVersion })),
      );
      return {
        conflicts: res.conflicts.map((c) => ({
          id: c.student_id,
          value: c.current_state
            ? {
                completion: c.current_state,
                correction: 'none' as Correction,
                completed_on: null,
                comment: null,
              }
            : null,
          version: c.current_version ?? null,
        })),
      };
    },
    [hw.id, observedOn],
  );
  const payloadOf = useCallback(
    (rows: RosterRow<CheckValue>[]) => ({
      a: hw.id,
      o: observedOn,
      c: rows.map((r) => [r.id, r.draft, r.baseVersion]),
    }),
    [hw.id, observedOn],
  );
  const reloadAll = useCallback(() => Promise.all([reload(), invalidate()]), [reload, invalidate]);
  const saver = useRosterSave<CheckValue>({ setRoster, batchSize: 100, send, payloadOf, reload: reloadAll });

  const students = data.students;
  const counts = countStates(roster);
  const pending = pendingRows(roster);
  const tallies = useMemo(() => {
    const t = { completed: 0, not_completed: 0, required: 0 };
    for (const sid of roster.order) {
      const row = roster.rows[sid];
      const v = row ? shownValue(row) : null;
      if (!v) continue;
      t[v.completion] += 1;
      if (v.correction === 'required') t.required += 1;
    }
    return t;
  }, [roster]);

  const update = (sid: string, patch: Partial<CheckValue>) => {
    if (saver.phase === 'saved') saver.acknowledge();
    setRoster((r) => {
      const row = r.rows[sid];
      if (!row) return r;
      const base: CheckValue = shownValue(row) ?? {
        completion: 'completed',
        correction: 'none',
        completed_on: null,
        comment: null,
      };
      const next: CheckValue = { ...base, ...patch };
      if (next.completion !== 'completed') next.completed_on = null;
      return setValue(r, sid, next, checkEquals);
    });
  };

  const keyboard = useRosterKeyboard(students.length, (i, key) => {
    const s = students[i];
    if (!s || readOnly || saver.phase === 'saving') return false;
    if (key === 'C') update(s.student_id, { completion: 'completed' });
    else if (key === 'N') update(s.student_id, { completion: 'not_completed' });
    else return false;
    return true;
  });

  const observedProblem =
    compareIsoDates(observedOn, hw.assigned_on) < 0 || compareIsoDates(observedOn, today) > 0
      ? `The checked date must be between ${formatDate(hw.assigned_on)} and today.`
      : null;
  const completedProblem = pending.some(
    (r) =>
      r.draft?.completed_on &&
      (compareIsoDates(r.draft.completed_on, hw.assigned_on) < 0 ||
        compareIsoDates(r.draft.completed_on, observedOn) > 0),
  )
    ? `A completion date must be between ${formatDate(hw.assigned_on)} and the checked date.`
    : null;

  return (
    <div className="space-y-4" data-testid="homework-roster">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to={hw.lesson_session_id ? `/lessons/${hw.lesson_session_id}` : '/homework'}>
          <ArrowLeft aria-hidden="true" /> {hw.lesson_session_id ? 'Lesson' : 'Homework'}
        </Link>
      </Button>
      <PageHeader
        title={`Check homework — ${subject}${section ? ` · ${section}` : ''}`}
        description={
          <>
            Set on {formatDate(hw.assigned_on)} · due {formatDate(hw.due_on)}
            {hw.status === 'cancelled' && ' · Cancelled'}
          </>
        }
      />
      <p className="rounded-md border p-3 text-sm whitespace-pre-wrap">{hw.description}</p>
      {readOnly && (
        <p role="status" className="flex items-start gap-2 rounded-md border p-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {hw.status !== 'active'
            ? 'This homework was cancelled; checks can no longer be changed.'
            : 'You can see the checks but not change them.'}
        </p>
      )}
      {!readOnly && (
        <div className="grid max-w-xs gap-1.5">
          <Label htmlFor="observed-on">Checked on</Label>
          <DateInput
            id="observed-on"
            value={observedOn}
            onChange={setObservedOn}
            min={hw.assigned_on}
            max={today}
          />
          <p className="text-muted-foreground text-xs">
            The day you looked at the work (may be earlier than today).
          </p>
        </div>
      )}
      {students.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
          No students to check.
        </p>
      ) : (
        <ol className="divide-y rounded-lg border" aria-label="Students" onKeyDown={keyboard.onKeyDown}>
          {students.map((s, i) => {
            const row = roster.rows[s.student_id];
            if (!row) return null;
            const state = rowState(row);
            const v = shownValue(row);
            return (
              <li
                key={s.student_id}
                {...keyboard.rowProps(i)}
                className="focus-visible:bg-accent/60 space-y-2 p-3 outline-none"
                aria-label={`${s.name}: ${checkWord(v)}${state === 'changed' ? ', not saved' : ''}`}
                data-testid="check-row"
                data-student={s.name}
                data-state={state}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="font-medium">
                      <span className="text-muted-foreground mr-2 tabular-nums">{s.roll_no ?? '–'}</span>
                      {s.name}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <RowStateBadge state={state} unmarkedLabel="Unchecked" />
                      {v && <span className="text-muted-foreground text-xs">{checkWord(v)}</span>}
                      {state === 'marked' && s.observed_on && (
                        <span className="text-muted-foreground text-xs">
                          checked {formatDate(s.observed_on)}
                        </span>
                      )}
                    </div>
                  </div>
                  <ChoiceGroup
                    options={COMPLETION_OPTIONS}
                    value={v?.completion ?? null}
                    onChange={(c) => update(s.student_id, { completion: c })}
                    disabled={readOnly || saver.phase === 'saving'}
                    label={`Homework for ${s.name}`}
                  />
                </div>
                {v && (
                  <div className="flex flex-wrap items-end gap-3">
                    <ChoiceGroup
                      options={CORRECTION_OPTIONS}
                      value={v.correction}
                      onChange={(c) => update(s.student_id, { correction: c })}
                      disabled={readOnly || saver.phase === 'saving'}
                      label={`Correction for ${s.name}`}
                    />
                    {v.completion === 'completed' && (
                      <div className="grid gap-1">
                        <Label htmlFor={`done-${s.student_id}`} className="text-xs">
                          Completed on (optional)
                        </Label>
                        <DateInput
                          id={`done-${s.student_id}`}
                          value={v.completed_on ?? ''}
                          onChange={(d) => update(s.student_id, { completed_on: d || null })}
                          min={hw.assigned_on}
                          max={observedOn}
                          disabled={readOnly || saver.phase === 'saving'}
                        />
                      </div>
                    )}
                    <div className="grid min-w-48 flex-1 gap-1">
                      <Label htmlFor={`comment-${s.student_id}`} className="text-xs">
                        Comment (optional)
                      </Label>
                      <Input
                        id={`comment-${s.student_id}`}
                        value={v.comment ?? ''}
                        maxLength={1000}
                        onChange={(e) =>
                          update(s.student_id, { comment: e.target.value === '' ? null : e.target.value })
                        }
                        disabled={readOnly || saver.phase === 'saving'}
                      />
                    </div>
                  </div>
                )}
                {row.conflict && (
                  <ConflictLine
                    theirs={checkWord(row.conflict.value)}
                    mine={checkWord(row.draft)}
                    word={(w) => w ?? 'Unchecked'}
                    onMine={() => setRoster((r) => reapplyMine(r, s.student_id))}
                    onTheirs={() => setRoster((r) => keepTheirs(r, s.student_id))}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}
      {!readOnly && students.length > 0 && (
        <>
          {(observedProblem || completedProblem) && (
            <p role="alert" className="text-destructive text-sm">
              {observedProblem ?? completedProblem}
            </p>
          )}
          <RosterSaveBar
            summary={
              <>
                <span data-testid="check-summary">
                  {students.length - counts.unmarked} of {students.length} checked
                  {counts.unmarked > 0 && <> · {counts.unmarked} unchecked</>}
                </span>
                <span className="text-muted-foreground block text-xs">
                  Completed {tallies.completed} · Not completed {tallies.not_completed} · Correction required{' '}
                  {tallies.required}
                  {pending.length > 0 && <> · {pending.length} not saved</>}
                </span>
              </>
            }
            pendingCount={pending.length}
            conflictCount={saver.conflictCount}
            phase={saver.phase}
            error={saver.error}
            disabled={observedProblem !== null || completedProblem !== null}
            onSave={() => void saver.save(roster)}
            saveLabel="Save checks"
            extra={
              (pending.length > 0 || counts.conflict > 0) && (
                <Button
                  variant="ghost"
                  className="min-h-11"
                  onClick={() => setRoster((r) => discardChanges(r))}
                >
                  Undo
                </Button>
              )
            }
          />
        </>
      )}
      <UnsavedChangesGuard when={pending.length > 0 || counts.conflict > 0} />
    </div>
  );
}
