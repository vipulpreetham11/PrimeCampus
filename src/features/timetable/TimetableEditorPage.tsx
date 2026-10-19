import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AlertTriangle, ArrowLeft, Copy, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { CreateCheckNotice } from '@/components/shared/CreateCheckNotice';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { ErrorText } from '@/components/shared/ErrorText';
import { PageHeader } from '@/components/shared/PageHeader';
import { UnsavedChangesGuard } from '@/components/shared/roster-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { TimetableConflict, TimetableDraftSaved, TimetableVersion } from '@/contracts/timetable';
import { useClassSubjects, useSetupSnapshot } from '@/features/setup/hooks';
import { isUncertainFailure, useCreateCheck } from '@/lib/create-check';
import { formatTime, maxDate, schoolToday, weekdayLong, weekdayShort } from '@/lib/dates';
import { AppError, routeId, toAppError } from '@/lib/errors';
import { isConflict } from '@/lib/save-feedback';
import { useCan } from '@/lib/scope';
import {
  cellKey,
  cellsOffSchedule,
  conflictsByCell,
  entriesFromGrid,
  gridCounts,
  gridFromEntries,
  sameGrid,
  setCell,
  type Cell,
  type Grid,
} from './grid-model';
import {
  findCopiedDraft,
  useActivateTimetable,
  useCopyTimetable,
  useDiscardDraft,
  useSaveTimetableDraft,
  useTimetableVersion,
  useTimetableVersions,
} from './hooks';
import { GenerateLessonsForm } from './LessonsGenerate';
import { SectionSelect, useSectionNames, useSectionOptions, useTeacherOptions } from './pickers';
import { versionDates } from './TimetablePage';

// Timetable grid (brief §1): weekdays (from the server) × the bell schedule's slots. Breaks are shown
// but not editable. A period without a subject has no lesson; a lesson without a teacher is
// "Unassigned". The server reports teacher clashes against other sections' active timetables; they
// are shown in the cell, and a draft with clashes cannot be activated.

export function TimetableEditorPage() {
  const params = useParams();
  let versionId: string | null = null;
  let badId: AppError | null = null;
  try {
    versionId = routeId(params.versionId);
  } catch (e) {
    badId = toAppError(e);
  }
  const query = useTimetableVersion(versionId);
  // Kept above the editor, which remounts on every new version of the draft.
  const [lastSave, setLastSave] = useState<TimetableDraftSaved | null>(null);
  const [generateFor, setGenerateFor] = useState<TimetableVersion | null>(null);
  if (badId) return <ErrorText error={badId} />;
  return (
    <>
      <DataState query={query}>
        {(v) => (
          <Editor
            key={`${v.timetable_version_id}:${v.version}`}
            version={v}
            refetch={() => query.refetch()}
            lastSave={lastSave?.version === v.version ? lastSave : null}
            onSaved={setLastSave}
            onActivated={() => setGenerateFor(v)}
          />
        )}
      </DataState>
      {generateFor && (
        <Dialog open onOpenChange={(o) => !o && setGenerateFor(null)}>
          <DialogContent className="max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Update lessons for the coming weeks</DialogTitle>
              <DialogDescription>
                {generateFor.section}&apos;s timetable is active. Lessons for each date are created from it —
                update them now so Today, attendance and the schedule follow the new plan.
              </DialogDescription>
            </DialogHeader>
            <GenerateLessonsForm
              sectionId={generateFor.section_id}
              defaultFrom={maxDate(generateFor.effective_from, schoolToday())}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setGenerateFor(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function Editor({
  version,
  refetch,
  lastSave,
  onSaved,
  onActivated,
}: {
  version: TimetableVersion;
  refetch: () => Promise<unknown>;
  lastSave: TimetableDraftSaved | null;
  onSaved: (r: TimetableDraftSaved) => void;
  onActivated: () => void;
}) {
  const navigate = useNavigate();
  const canManage = useCan('timetable.manage');
  const editable = version.can_edit;
  const snapshot = useSetupSnapshot(version.academic_year_id);
  const classSubjects = useClassSubjects(version.academic_year_id, version.class_id);
  const teachers = useTeacherOptions();
  const sectionNames = useSectionNames(version.academic_year_id);

  const original = useMemo(() => gridFromEntries(version.entries), [version.entries]);
  const [grid, setGrid] = useState<Grid>(original);
  const [scheduleId, setScheduleId] = useState(version.period_schedule_id);
  const [effectiveFrom, setEffectiveFrom] = useState(version.effective_from);
  const [editing, setEditing] = useState<{ weekday: number; ordinal: number } | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [copying, setCopying] = useState(false);

  const save = useSaveTimetableDraft();
  const activate = useActivateTimetable();
  const discard = useDiscardDraft();

  const schedules = (snapshot.data?.period_schedules ?? []).filter(
    (p) => p.effective_to === null || p.id === version.period_schedule_id,
  );
  const chosenSchedule = schedules.find((p) => p.id === scheduleId);
  // The version's own slots until another schedule is chosen (its slots come from the snapshot).
  const slots = scheduleId === version.period_schedule_id ? version.slots : (chosenSchedule?.slots ?? []);
  const periodOrdinals = new Set(slots.filter((s) => s.kind === 'period').map((s) => s.ordinal));
  const weekdays = version.weekdays;

  const dirty =
    editable &&
    (!sameGrid(grid, original) ||
      scheduleId !== version.period_schedule_id ||
      effectiveFrom !== version.effective_from);
  const conflicts = lastSave?.conflicts ?? version.conflicts;
  const byCell = useMemo(() => conflictsByCell(dirty ? [] : conflicts), [conflicts, dirty]);
  const counts = gridCounts(grid, weekdays, [...periodOrdinals]);
  const dropped = cellsOffSchedule(grid, periodOrdinals);

  const subjectNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of snapshot.data?.subjects ?? []) m.set(s.id, s.name);
    for (const e of version.entries) m.set(e.subject_id, e.subject);
    return m;
  }, [snapshot.data, version.entries]);
  const classSubjectIds = new Set(
    (classSubjects.data ?? []).filter((c) => c.status === 'active').map((c) => c.subject_id),
  );
  const teacherNames = useMemo(() => {
    const m = new Map(teachers.options.map((t) => [t.id, t.name]));
    for (const e of version.entries) if (e.staff_id && e.staff) m.set(e.staff_id, e.staff);
    return m;
  }, [teachers.options, version.entries]);

  const onSave = () => {
    setError(null);
    save.mutate(
      {
        sectionId: version.section_id,
        periodScheduleId: scheduleId,
        effectiveFrom,
        entries: entriesFromGrid(grid, periodOrdinals),
        versionId: version.timetable_version_id,
        expectedVersion: version.version,
      },
      {
        onSuccess: (r) => {
          onSaved(r);
          toast.success('Draft saved.');
          // the editor remounts on the new version (key) with the saved grid and fresh conflicts
          void refetch();
        },
        onError: (e) => {
          const err = toAppError(e);
          if (isConflict(err)) {
            toast.warning(
              'Someone else changed this draft. It has been reloaded — please redo your changes.',
            );
            void refetch();
            return;
          }
          setError(err);
        },
      },
    );
  };

  const onActivate = () => {
    setError(null);
    activate.mutate(version.timetable_version_id, {
      onSuccess: () => {
        toast.success('Timetable activated.');
        onActivated();
      },
      onError: (e) => {
        const err = toAppError(e);
        // CONFLICT here = a teacher is double-booked (the clashes are reloaded into the grid)
        if (isConflict(err)) {
          setError(
            new AppError(
              'CONFLICT',
              'A teacher is double-booked in this timetable. Fix the clashes shown in the grid first.',
              err.requestId,
            ),
          );
          void refetch();
          return;
        }
        setError(err);
      },
    });
  };

  const onDiscard = () => {
    discard.mutate(
      { versionId: version.timetable_version_id, version: version.version },
      {
        onSuccess: () => {
          toast.success('Draft discarded.');
          navigate(`/timetable?section=${version.section_id}`);
        },
        onError: (e) => {
          setConfirmDiscard(false);
          const err = toAppError(e);
          if (isConflict(err)) void refetch();
          setError(err);
        },
      },
    );
  };

  const editingCell = editing ? (grid.get(cellKey(editing.weekday, editing.ordinal)) ?? null) : null;
  const editingSlot = editing ? slots.find((s) => s.ordinal === editing.ordinal) : undefined;

  const statusBadge = (
    <Badge
      variant={version.status === 'active' ? 'default' : version.status === 'draft' ? 'secondary' : 'outline'}
    >
      {version.status === 'draft' ? 'Draft' : version.status === 'active' ? 'Active' : 'Retired'}
    </Badge>
  );

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to={`/timetable?section=${version.section_id}`}>
          <ArrowLeft aria-hidden="true" /> All versions
        </Link>
      </Button>
      <PageHeader
        title={`Timetable — ${version.section}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {statusBadge}
            {versionDates(version)} · {version.period_schedule}
          </span>
        }
        actions={
          canManage && (
            <>
              <Button variant="outline" onClick={() => setCopying(true)} disabled={dirty}>
                <Copy aria-hidden="true" /> Copy to another section
              </Button>
              {version.status === 'draft' && (
                <Button variant="outline" onClick={() => setConfirmDiscard(true)}>
                  <Trash2 aria-hidden="true" /> Discard draft
                </Button>
              )}
            </>
          )
        }
      />

      {editable && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="tt-schedule">Bell schedule</Label>
            <Select value={scheduleId} onValueChange={setScheduleId}>
              <SelectTrigger id="tt-schedule" className="min-h-11 w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {schedules.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tt-from">Starts on</Label>
            <DateInput id="tt-from" value={effectiveFrom} onChange={setEffectiveFrom} />
          </div>
        </div>
      )}

      <GridSummary
        counts={counts}
        conflicts={dirty ? null : conflicts.length}
        notInClass={lastSave?.subjects_not_in_class ?? []}
        dropped={dropped}
        dirty={dirty}
      />

      <TimetableGrid
        weekdays={weekdays}
        slots={slots}
        grid={grid}
        conflicts={byCell}
        subjectNames={subjectNames}
        teacherNames={teacherNames}
        sectionNames={sectionNames}
        classSubjectIds={classSubjectIds}
        editable={editable}
        onEdit={(weekday, ordinal) => setEditing({ weekday, ordinal })}
      />

      <ErrorText error={error} />

      {editable && (
        <div
          className="bg-background/95 sticky bottom-16 z-20 flex flex-wrap items-center gap-3 rounded-lg border p-3 shadow-sm md:bottom-2"
          data-testid="timetable-actions"
        >
          <p className="min-w-0 flex-1 text-sm" aria-live="polite">
            {save.isPending ? 'Saving…' : dirty ? 'You have unsaved changes.' : 'All changes saved.'}
          </p>
          <Button onClick={onSave} disabled={!dirty || save.isPending} className="min-h-11">
            {save.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            Save draft
          </Button>
          <Button
            variant="default"
            onClick={onActivate}
            disabled={dirty || activate.isPending || version.conflicts.length > 0}
            className="min-h-11"
            title={version.conflicts.length > 0 ? 'Fix the teacher clashes first' : undefined}
          >
            Activate
          </Button>
          {version.conflicts.length > 0 && !dirty && (
            <p className="text-destructive w-full text-sm">
              Activation is blocked: {version.conflicts.length} teacher{' '}
              {version.conflicts.length === 1 ? 'clash' : 'clashes'} (see the cells marked “Clash”).
            </p>
          )}
        </div>
      )}

      <UnsavedChangesGuard when={dirty} />

      {editing && (
        <CellDialog
          weekday={editing.weekday}
          slotLabel={editingSlot ? `${editingSlot.label}, ${formatTime(editingSlot.start_time)}` : ''}
          cell={editingCell}
          subjects={(classSubjects.data ?? [])
            .filter((c) => c.status === 'active')
            .map((c) => ({ id: c.subject_id, name: c.subject }))}
          subjectNames={subjectNames}
          teachers={teachers.options}
          onClose={() => setEditing(null)}
          onApply={(cell) => {
            setGrid((g) => setCell(g, cellKey(editing.weekday, editing.ordinal), cell));
            setEditing(null);
          }}
        />
      )}

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this draft?"
        description="The draft and its periods are deleted. Active timetables and lessons are not affected."
        confirmLabel="Discard draft"
        destructive
        busy={discard.isPending}
        onConfirm={onDiscard}
      />

      {copying && (
        <CopyDialog
          version={version}
          onClose={() => setCopying(false)}
          onCopied={(id) => {
            setCopying(false);
            navigate(`/timetable/${id}`);
          }}
        />
      )}
    </div>
  );
}

function GridSummary({
  counts,
  conflicts,
  notInClass,
  dropped,
  dirty,
}: {
  counts: ReturnType<typeof gridCounts>;
  conflicts: number | null;
  notInClass: string[];
  dropped: number;
  dirty: boolean;
}) {
  return (
    <div className="space-y-1 text-sm" data-testid="grid-summary">
      <p>
        <strong>{counts.planned}</strong> periods planned · <strong>{counts.empty}</strong> with no lesson ·{' '}
        <strong data-testid="unassigned-count">{counts.unassignedTeacher}</strong> without a teacher
        {conflicts !== null && (
          <>
            {' '}
            · <strong data-testid="conflict-count">{conflicts}</strong> teacher{' '}
            {conflicts === 1 ? 'clash' : 'clashes'}
          </>
        )}
        {dirty && <span className="text-muted-foreground"> (clashes are checked when you save)</span>}
      </p>
      {notInClass.length > 0 && (
        <p className="flex items-start gap-2 text-amber-800 dark:text-amber-300" role="status">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Not among this class&apos;s subjects: {notInClass.join(', ')}. Saved anyway — check School setup ›
          Subjects.
        </p>
      )}
      {dropped > 0 && (
        <p className="flex items-start gap-2 text-amber-800 dark:text-amber-300" role="status">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {dropped} {dropped === 1 ? 'period is' : 'periods are'} not a period in this bell schedule and will
          be removed when you save.
        </p>
      )}
    </div>
  );
}

export function TimetableGrid({
  weekdays,
  slots,
  grid,
  conflicts,
  subjectNames,
  teacherNames,
  sectionNames,
  classSubjectIds,
  editable,
  onEdit,
}: {
  weekdays: number[];
  slots: TimetableVersion['slots'];
  grid: Grid;
  conflicts: Map<string, TimetableConflict[]>;
  subjectNames: Map<string, string>;
  teacherNames: Map<string, string>;
  sectionNames: Map<string, string>;
  classSubjectIds: Set<string>;
  editable: boolean;
  onEdit: (weekday: number, ordinal: number) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border" data-testid="timetable-grid">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <caption className="sr-only">Timetable: periods by weekday</caption>
        <thead>
          <tr className="bg-muted/50">
            <th scope="col" className="bg-muted sticky left-0 z-10 w-28 border-b p-2 text-left">
              Period
            </th>
            {weekdays.map((wd) => (
              <th key={wd} scope="col" className="border-b p-2 text-left font-medium">
                <abbr title={weekdayLong(wd)} className="no-underline">
                  {weekdayShort(wd)}
                </abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slots.map((slot) => (
            <tr key={slot.ordinal} className="border-b last:border-b-0">
              <th
                scope="row"
                className="bg-background sticky left-0 z-10 p-2 text-left align-top font-normal"
              >
                <span className="block font-medium">{slot.label}</span>
                <span className="text-muted-foreground text-xs">
                  {formatTime(slot.start_time)}–{formatTime(slot.end_time)}
                </span>
              </th>
              {slot.kind === 'break' ? (
                <td
                  colSpan={weekdays.length}
                  className="bg-muted/40 text-muted-foreground p-2 text-center text-xs"
                >
                  Break — no lessons
                </td>
              ) : (
                weekdays.map((wd) => {
                  const key = cellKey(wd, slot.ordinal);
                  const cell = grid.get(key);
                  const clashes = conflicts.get(key) ?? [];
                  return (
                    <td key={wd} className="p-1 align-top">
                      <GridCell
                        cell={cell ?? null}
                        clashes={clashes}
                        label={`${weekdayLong(wd)}, ${slot.label}`}
                        subjectName={cell ? (subjectNames.get(cell.subject_id) ?? 'Subject') : null}
                        teacherName={cell?.staff_id ? (teacherNames.get(cell.staff_id) ?? 'Teacher') : null}
                        notInClass={
                          cell ? classSubjectIds.size > 0 && !classSubjectIds.has(cell.subject_id) : false
                        }
                        sectionNames={sectionNames}
                        teacherNames={teacherNames}
                        editable={editable}
                        onEdit={() => onEdit(wd, slot.ordinal)}
                      />
                    </td>
                  );
                })
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GridCell({
  cell,
  clashes,
  label,
  subjectName,
  teacherName,
  notInClass,
  sectionNames,
  teacherNames,
  editable,
  onEdit,
}: {
  cell: Cell | null;
  clashes: TimetableConflict[];
  label: string;
  subjectName: string | null;
  teacherName: string | null;
  notInClass: boolean;
  sectionNames: Map<string, string>;
  teacherNames: Map<string, string>;
  editable: boolean;
  onEdit: () => void;
}) {
  const content = (
    <>
      {cell ? (
        <>
          <span className="block font-medium">{subjectName}</span>
          {teacherName ? (
            <span className="text-muted-foreground block text-xs">{teacherName}</span>
          ) : (
            <span className="block text-xs font-medium text-amber-800 dark:text-amber-300">Unassigned</span>
          )}
          {notInClass && (
            <span className="block text-xs text-amber-800 dark:text-amber-300">Not a class subject</span>
          )}
        </>
      ) : (
        <span className="text-muted-foreground block text-xs">No lesson</span>
      )}
      {clashes.map((c, i) => (
        <span
          key={i}
          className="text-destructive mt-1 flex items-start gap-1 text-xs font-medium"
          data-testid="cell-clash"
        >
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          Clash: {teacherNames.get(c.staff_id) ?? 'This teacher'} also teaches{' '}
          {sectionNames.get(c.clashes_with_section_id) ?? 'another section'} then
        </span>
      ))}
    </>
  );
  const base =
    'block min-h-14 w-full rounded-md border p-2 text-left' +
    (clashes.length > 0 ? ' border-destructive bg-destructive/5' : cell ? '' : ' border-dashed');
  if (!editable) {
    return (
      <div className={base} aria-label={label} data-testid="grid-cell">
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`${base} hover:bg-accent focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]`}
      aria-label={`${label}: ${cell ? `${subjectName}, ${teacherName ?? 'unassigned'}` : 'no lesson'}${clashes.length > 0 ? ', teacher clash' : ''}. Edit`}
      onClick={onEdit}
      data-testid="grid-cell"
    >
      {content}
    </button>
  );
}

const NO_TEACHER = '__none__';

function CellDialog({
  weekday,
  slotLabel,
  cell,
  subjects,
  subjectNames,
  teachers,
  onClose,
  onApply,
}: {
  weekday: number;
  slotLabel: string;
  cell: Cell | null;
  subjects: { id: string; name: string }[];
  subjectNames: Map<string, string>;
  teachers: { id: string; name: string }[];
  onClose: () => void;
  onApply: (cell: Cell | null) => void;
}) {
  const [subjectId, setSubjectId] = useState<string | null>(cell?.subject_id ?? null);
  const [chosenStaffId, setStaffId] = useState<string | null>(cell?.staff_id ?? null);
  // no subject = no lesson, so no teacher either
  const staffId = subjectId === null ? null : chosenStaffId;
  // a copied subject that is not among the class subjects stays selectable (with a note)
  const subjectOptions =
    cell && !subjects.some((s) => s.id === cell.subject_id)
      ? [
          ...subjects,
          {
            id: cell.subject_id,
            name: `${subjectNames.get(cell.subject_id) ?? 'Subject'} (not a class subject)`,
          },
        ]
      : subjects;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {weekdayLong(weekday)} · {slotLabel}
          </DialogTitle>
          <DialogDescription>Choose the subject and, if known, the teacher.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="cell-subject">Subject</Label>
            <Select value={subjectId ?? undefined} onValueChange={setSubjectId}>
              <SelectTrigger id="cell-subject" className="min-h-11 w-full">
                <SelectValue placeholder="Choose a subject" />
              </SelectTrigger>
              <SelectContent>
                {subjectOptions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {subjects.length === 0 && (
              <p className="text-muted-foreground text-sm">
                This class has no subjects yet. Add them in School setup › Subjects.
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cell-teacher">Teacher</Label>
            <Select
              value={staffId ?? NO_TEACHER}
              onValueChange={(v) => setStaffId(v === NO_TEACHER ? null : v)}
              disabled={subjectId === null}
            >
              <SelectTrigger id="cell-teacher" className="min-h-11 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TEACHER}>Unassigned</SelectItem>
                {teachers.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter className="gap-2">
          {cell && (
            <Button variant="outline" onClick={() => onApply(null)} className="sm:mr-auto">
              No lesson in this period
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => subjectId && onApply({ subject_id: subjectId, staff_id: staffId })}
            disabled={subjectId === null}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CopyDialog({
  version,
  onClose,
  onCopied,
}: {
  version: TimetableVersion;
  onClose: () => void;
  onCopied: (versionId: string) => void;
}) {
  const { options } = useSectionOptions(version.academic_year_id);
  const targets = options.filter((o) => o.id !== version.section_id);
  const snapshot = useSetupSnapshot(version.academic_year_id);
  const year = snapshot.data?.academic_years.find((y) => y.id === version.academic_year_id);
  const [target, setTarget] = useState<string | null>(null);
  const [start, setStart] = useState<string>(maxDate(version.effective_from, schoolToday()));
  const [keepTeachers, setKeepTeachers] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const copy = useCopyTimetable();
  const check = useCreateCheck();
  // the target's versions before the copy: after an uncertain failure, a new draft among them is ours
  const targetVersions = useTimetableVersions(target);
  const outOfYear = !!year && (start < year.start_date || start > year.end_date);

  const submit = () => {
    if (!target || !targetVersions.data) return;
    setError(null);
    check.reset();
    const request = {
      fromVersionId: version.timetable_version_id,
      targetSectionId: target,
      effectiveFrom: start,
      keepTeachers,
    };
    const knownIds = targetVersions.data.map((v) => v.timetable_version_id);
    copy.mutate(request, {
      onSuccess: (r) => {
        toast.success(
          r.conflicts.length > 0
            ? `Draft created with ${r.conflicts.length} teacher clashes to fix.`
            : 'Draft created.',
        );
        onCopied(r.timetable_version_id);
      },
      onError: (e) => {
        // copy_timetable has no operation id: look for the draft before allowing another copy
        if (!isUncertainFailure(e)) return setError(toAppError(e));
        check.verify(
          () => findCopiedDraft({ ...request, knownIds }),
          (draft) => {
            toast.success('Draft created. Open it to check for teacher clashes.');
            onCopied(draft.timetable_version_id);
          },
        );
      },
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !copy.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy this timetable to another section</DialogTitle>
          <DialogDescription>
            A new draft is created for the other section. Nothing changes until it is activated.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <SectionSelect
            id="copy-target"
            label="Copy to"
            value={target}
            onChange={setTarget}
            options={targets}
          />
          <div className="grid gap-1.5">
            <Label htmlFor="copy-start">Starts on</Label>
            <DateInput
              id="copy-start"
              value={start}
              onChange={setStart}
              min={year?.start_date}
              max={year?.end_date}
            />
            {outOfYear && (
              <p className="text-destructive text-sm" role="alert">
                Choose a date inside {year?.name}.
              </p>
            )}
          </div>
          <div className="flex min-h-11 items-center gap-3">
            <Switch id="copy-keep" checked={keepTeachers} onCheckedChange={setKeepTeachers} />
            <Label htmlFor="copy-keep">Keep the teachers (otherwise every period is Unassigned)</Label>
          </div>
          {targetVersions.isError && <ErrorText error={targetVersions.error} />}
          <ErrorText error={error} />
          <CreateCheckNotice check={check} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={copy.isPending}>
            Cancel
          </Button>
          <Button
            disabled={
              !target || !targetVersions.data || !start || outOfYear || copy.isPending || check.blocksRetry
            }
            onClick={submit}
          >
            Copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
