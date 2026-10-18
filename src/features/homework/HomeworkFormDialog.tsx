import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { DateInput } from '@/components/shared/DateInput';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { addDays, compareIsoDates, formatDate } from '@/lib/dates';
import { toAppError, type AppError } from '@/lib/errors';
import { isConflict } from '@/lib/save-feedback';
import { useSaveHomework } from './hooks';

// Set homework from a lesson, or edit / cancel it (with the version the teacher saw).

export const MAX_HOMEWORK_TEXT = 4000;

export interface EditableHomework {
  assignment_id: string;
  version: number;
  assigned_on: string;
  due_on: string;
  description: string;
}

export function HomeworkFormDialog({
  lesson,
  homework,
  title,
  onClose,
}: {
  /** Create: the lesson the homework is set in. */
  lesson?: { lesson_session_id: number; date: string };
  /** Edit: the homework as displayed. */
  homework?: EditableHomework;
  title: string;
  onClose: () => void;
}) {
  const minDate = homework?.assigned_on ?? lesson?.date ?? '';
  const [dueOn, setDueOn] = useState<string>(homework?.due_on ?? (lesson ? addDays(lesson.date, 1) : ''));
  const [text, setText] = useState(homework?.description ?? '');
  const [error, setError] = useState<AppError | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const save = useSaveHomework();

  const onConflict = () => {
    toast.warning(
      'This homework changed since you opened it. It has been reloaded — please redo your change.',
    );
    onClose();
  };
  const fail = (e: unknown) => {
    const err = toAppError(e);
    if (isConflict(err)) return onConflict();
    setError(err);
  };

  const submit = () => {
    setError(null);
    const trimmed = text.trim();
    if (!trimmed) return setProblem('Describe the homework.');
    if (trimmed.length > MAX_HOMEWORK_TEXT) return setProblem(`At most ${MAX_HOMEWORK_TEXT} characters.`);
    if (!dueOn) return setProblem('Choose a due date.');
    if (minDate && compareIsoDates(dueOn, minDate) < 0)
      return setProblem(`The due date can't be before ${formatDate(minDate)}.`);
    setProblem(null);
    if (homework) {
      save.mutate(
        {
          kind: 'edit',
          assignmentId: homework.assignment_id,
          version: homework.version,
          dueOn,
          description: trimmed,
        },
        {
          onSuccess: () => {
            toast.success('Homework updated.');
            onClose();
          },
          onError: fail,
        },
      );
    } else if (lesson) {
      save.mutate(
        { kind: 'create', lessonId: lesson.lesson_session_id, dueOn, description: trimmed },
        {
          onSuccess: () => {
            toast.success('Homework set.');
            onClose();
          },
          onError: fail,
        },
      );
    }
  };

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>Students and parents see the description and the due date.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-1.5">
              <Label htmlFor="hw-text">Homework</Label>
              <Textarea
                id="hw-text"
                rows={5}
                value={text}
                maxLength={MAX_HOMEWORK_TEXT}
                onChange={(e) => setText(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                {text.length} / {MAX_HOMEWORK_TEXT}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="hw-due">Due on</Label>
              <DateInput id="hw-due" value={dueOn} onChange={setDueOn} min={minDate || undefined} />
            </div>
            {problem && (
              <p role="alert" className="text-destructive text-sm">
                {problem}
              </p>
            )}
            <ErrorText error={error} />
          </div>
          <DialogFooter className="gap-2">
            {homework && (
              <Button
                variant="outline"
                className="sm:mr-auto"
                onClick={() => setConfirmCancel(true)}
                disabled={save.isPending}
              >
                Cancel this homework
              </Button>
            )}
            <Button variant="outline" onClick={onClose} disabled={save.isPending}>
              Close
            </Button>
            <Button onClick={submit} disabled={save.isPending}>
              {homework ? 'Save changes' : 'Set homework'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {homework && (
        <ConfirmDialog
          open={confirmCancel}
          onOpenChange={setConfirmCancel}
          title="Cancel this homework?"
          description="It disappears for students and parents. Checks already recorded are kept."
          confirmLabel="Cancel homework"
          cancelLabel="Keep it"
          destructive
          busy={save.isPending}
          onConfirm={() =>
            save.mutate(
              { kind: 'cancel', assignmentId: homework.assignment_id, version: homework.version },
              {
                onSuccess: () => {
                  toast.success('Homework cancelled.');
                  setConfirmCancel(false);
                  onClose();
                },
                onError: (e) => {
                  setConfirmCancel(false);
                  fail(e);
                },
              },
            )
          }
        />
      )}
    </>
  );
}
