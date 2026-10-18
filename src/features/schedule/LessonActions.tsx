import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  substituteConflictDetailsSchema,
  type ScheduleLesson,
  type SubstituteSuggestion,
} from '@/contracts/timetable';
import { useClassSubjects, useSetupSnapshot } from '@/features/setup/hooks';
import { formatDayShort, formatTime } from '@/lib/dates';
import { toAppError, type AppError } from '@/lib/errors';
import { isConflict } from '@/lib/save-feedback';
import { useAssignSubstitute, useRemoveSubstitute, useSubstituteSuggestions, useUpdateLesson } from './hooks';

// Lesson actions for timetable.manage (brief §2): cancel (reason required), restore, change subject
// (class subjects only; the server refuses once attendance/diary/homework exists), substitutes.
// Every change sends the lesson version the user saw; CONFLICT reloads the day.

type Open = 'cancel' | 'restore' | 'subject' | 'substitute' | 'remove' | null;

export function LessonActions({ lesson, date }: { lesson: ScheduleLesson; date: string }) {
  const [open, setOpen] = useState<Open>(null);
  const cancelled = lesson.status === 'cancelled';
  const close = () => setOpen(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-11 sm:size-9"
            aria-label={`Actions for ${lesson.slot_label}, ${lesson.subject}`}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!cancelled && (
            <DropdownMenuItem onSelect={() => setOpen('substitute')}>Find a substitute</DropdownMenuItem>
          )}
          {!cancelled && lesson.is_substituted && (
            <DropdownMenuItem onSelect={() => setOpen('remove')}>Remove substitute</DropdownMenuItem>
          )}
          {!cancelled && (
            <DropdownMenuItem onSelect={() => setOpen('subject')}>Change subject</DropdownMenuItem>
          )}
          {!cancelled && (
            <DropdownMenuItem onSelect={() => setOpen('cancel')}>Cancel lesson</DropdownMenuItem>
          )}
          {cancelled && (
            <DropdownMenuItem onSelect={() => setOpen('restore')}>Restore lesson</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {open === 'cancel' && <CancelDialog lesson={lesson} date={date} onClose={close} />}
      {open === 'restore' && <RestoreDialog lesson={lesson} onClose={close} />}
      {open === 'subject' && <ChangeSubjectDialog lesson={lesson} onClose={close} />}
      {open === 'substitute' && <SubstituteDialog lesson={lesson} date={date} onClose={close} />}
      {open === 'remove' && <RemoveSubstituteDialog lesson={lesson} onClose={close} />}
    </>
  );
}

function lessonTitle(lesson: ScheduleLesson, date?: string) {
  return `${date ? `${formatDayShort(date)} · ` : ''}${lesson.slot_label} (${formatTime(lesson.start_time)}) · ${lesson.section} · ${lesson.subject}`;
}

function onLessonError(e: unknown, setError: (e: AppError) => void, close: () => void) {
  const err = toAppError(e);
  if (isConflict(err)) {
    toast.warning(
      'This lesson changed since you opened it. The day has been reloaded — please check and try again.',
    );
    close();
    return;
  }
  setError(err);
}

function CancelDialog({
  lesson,
  date,
  onClose,
}: {
  lesson: ScheduleLesson;
  date: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<AppError | null>(null);
  const update = useUpdateLesson();
  const trimmed = reason.trim();
  return (
    <Dialog open onOpenChange={(o) => !o && !update.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this lesson?</DialogTitle>
          <DialogDescription>{lessonTitle(lesson, date)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="cancel-reason">Reason (required)</Label>
          <Textarea
            id="cancel-reason"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">Parents and teachers see this reason.</p>
        </div>
        <ErrorText error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            Keep the lesson
          </Button>
          <Button
            variant="destructive"
            disabled={!trimmed || update.isPending}
            onClick={() =>
              update.mutate(
                {
                  lessonId: lesson.lesson_session_id,
                  version: lesson.version,
                  action: 'cancel',
                  reason: trimmed,
                },
                {
                  onSuccess: () => {
                    toast.success('Lesson cancelled.');
                    onClose();
                  },
                  onError: (e) => onLessonError(e, setError, onClose),
                },
              )
            }
          >
            Cancel lesson
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RestoreDialog({ lesson, onClose }: { lesson: ScheduleLesson; onClose: () => void }) {
  const [error, setError] = useState<AppError | null>(null);
  const update = useUpdateLesson();
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Restore this lesson?"
      description={
        <>
          {lessonTitle(lesson)}
          {error && (
            <span className="text-destructive mt-2 block" role="alert">
              {error.message}
            </span>
          )}
        </>
      }
      confirmLabel="Restore lesson"
      busy={update.isPending}
      onConfirm={() =>
        update.mutate(
          { lessonId: lesson.lesson_session_id, version: lesson.version, action: 'restore' },
          {
            onSuccess: () => {
              toast.success('Lesson restored.');
              onClose();
            },
            onError: (e) => onLessonError(e, setError, onClose),
          },
        )
      }
    />
  );
}

function ChangeSubjectDialog({ lesson, onClose }: { lesson: ScheduleLesson; onClose: () => void }) {
  const snapshot = useSetupSnapshot(null);
  const section = snapshot.data?.sections.find((s) => s.id === lesson.section_id);
  const subjects = useClassSubjects(section?.academic_year_id ?? null, section?.class_id ?? null);
  const options = (subjects.data ?? []).filter(
    (s) => s.status === 'active' && s.subject_id !== lesson.subject_id,
  );
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const update = useUpdateLesson();
  return (
    <Dialog open onOpenChange={(o) => !o && !update.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change the subject of this lesson</DialogTitle>
          <DialogDescription>
            {lessonTitle(lesson)}. Only this one lesson changes; the timetable stays the same.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="change-subject">New subject</Label>
          <Select value={subjectId ?? undefined} onValueChange={setSubjectId}>
            <SelectTrigger id="change-subject" className="min-h-11 w-full">
              <SelectValue placeholder="Choose a subject of this class" />
            </SelectTrigger>
            <SelectContent>
              {options.map((s) => (
                <SelectItem key={s.subject_id} value={s.subject_id}>
                  {s.subject}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!section && snapshot.data && (
            <p className="text-muted-foreground text-sm">This section is not in the current year.</p>
          )}
        </div>
        <ErrorText error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button
            disabled={!subjectId || update.isPending}
            onClick={() =>
              subjectId &&
              update.mutate(
                {
                  lessonId: lesson.lesson_session_id,
                  version: lesson.version,
                  action: 'change_subject',
                  subjectId,
                },
                {
                  onSuccess: () => {
                    toast.success('Subject changed.');
                    onClose();
                  },
                  onError: (e) => onLessonError(e, setError, onClose),
                },
              )
            }
          >
            Change subject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const AVAILABILITY_TEXT: Record<SubstituteSuggestion['availability'], string> = {
  present: 'Present',
  absent: 'Absent',
  half_day: 'Half day',
  unmarked: 'Attendance not marked',
};

/** The override question the server asks for (CONFLICT on assign_substitute). */
export function overrideQuestion(error: AppError): string {
  const parsed = substituteConflictDetailsSchema.safeParse(error.details);
  if (parsed.success) {
    const parts = [
      parsed.data.is_absent ? 'This teacher is marked absent that day' : null,
      parsed.data.has_conflict ? 'This teacher has another lesson at the same time' : null,
    ].filter(Boolean);
    if (parts.length > 0) return `${parts.join(', and ')}. Give a reason to assign anyway.`;
  }
  return 'This teacher is absent or busy at that time. Give a reason to assign anyway.';
}

function SubstituteDialog({
  lesson,
  date,
  onClose,
}: {
  lesson: ScheduleLesson;
  date: string;
  onClose: () => void;
}) {
  const suggestions = useSubstituteSuggestions(lesson.lesson_session_id);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState<{ staffId: string; question: string } | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [error, setError] = useState<AppError | null>(null);
  const assign = useAssignSubstitute();
  const needsOverride = override !== null && override.staffId === staffId;

  const submit = () => {
    if (!staffId) return;
    setError(null);
    assign.mutate(
      {
        lessonId: lesson.lesson_session_id,
        staffId,
        reason: reason.trim() || null,
        overrideReason: needsOverride ? overrideReason.trim() : null,
      },
      {
        onSuccess: (r) => {
          toast.success(
            r.conflict_overridden ? 'Substitute assigned (override recorded).' : 'Substitute assigned.',
          );
          onClose();
        },
        onError: (e) => {
          const err = toAppError(e);
          if (isConflict(err)) {
            setOverride({ staffId, question: overrideQuestion(err) });
            return;
          }
          setError(err);
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !assign.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Find a substitute</DialogTitle>
          <DialogDescription>
            {lessonTitle(lesson, date)} · planned teacher: {lesson.planned_staff ?? 'unassigned'}
          </DialogDescription>
        </DialogHeader>
        <DataState
          query={suggestions}
          isEmpty={(s) => s.length === 0}
          emptyTitle="No other teaching staff"
          emptyDescription="There is no other active teaching staff employed on this date."
        >
          {(list) => (
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Teachers</legend>
              <ul className="space-y-1" aria-label="Suggested substitutes">
                {list.map((s) => (
                  <li key={s.staff_id}>
                    <label className="hover:bg-accent flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-2">
                      <input
                        type="radio"
                        name="substitute"
                        className="mt-1"
                        checked={staffId === s.staff_id}
                        onChange={() => setStaffId(s.staff_id)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{s.name}</span>
                        <span className="text-muted-foreground block text-xs">
                          {AVAILABILITY_TEXT[s.availability]}
                          {s.has_conflict ? ' · Has another lesson then' : ' · Free then'}
                          {s.teaches_subject_in_section && ' · Teaches this subject here'}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
        </DataState>
        <div className="grid gap-1.5">
          <Label htmlFor="sub-reason">Note (optional)</Label>
          <Textarea
            id="sub-reason"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {needsOverride && (
          <div className="grid gap-1.5 rounded-md border border-amber-500 p-3" role="alert">
            <p className="text-sm font-medium">{override.question}</p>
            <Label htmlFor="sub-override">Reason to assign anyway</Label>
            <Textarea
              id="sub-override"
              value={overrideReason}
              maxLength={500}
              onChange={(e) => setOverrideReason(e.target.value)}
            />
          </div>
        )}
        <ErrorText error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={assign.isPending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!staffId || assign.isPending || (needsOverride && !overrideReason.trim())}
          >
            {needsOverride ? 'Assign anyway' : 'Assign substitute'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveSubstituteDialog({ lesson, onClose }: { lesson: ScheduleLesson; onClose: () => void }) {
  const remove = useRemoveSubstitute();
  const [error, setError] = useState<AppError | null>(null);
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Remove the substitute?"
      description={
        <>
          {lesson.actual_staff} will no longer take this lesson; it returns to{' '}
          {lesson.planned_staff ?? 'no teacher'}.
          {error && (
            <span className="text-destructive mt-2 block" role="alert">
              {error.message}
            </span>
          )}
        </>
      }
      confirmLabel="Remove substitute"
      busy={remove.isPending}
      onConfirm={() =>
        remove.mutate(lesson.lesson_session_id, {
          onSuccess: () => {
            toast.success('Substitute removed.');
            onClose();
          },
          onError: (e) => setError(toAppError(e)),
        })
      }
    />
  );
}
