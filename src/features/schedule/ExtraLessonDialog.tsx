import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { CreateCheckNotice } from '@/components/shared/CreateCheckNotice';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useClassSubjects } from '@/features/setup/hooks';
import { SectionSelect, useSectionOptions, useTeacherOptions } from '@/features/timetable/pickers';
import { useCreateCheck, isUncertainFailure } from '@/lib/create-check';
import { formatDateLong, formatTime, isIsoDate } from '@/lib/dates';
import { isAppError, toAppError, type AppError } from '@/lib/errors';
import { addExtraLesson } from '@/lib/rpc';
import { extraLessonArgs, useAddExtraLesson, type ExtraLessonInput } from './hooks';
import { timeRangeProblem } from './LessonActions';

// TIME-02: an extra lesson for one section on one date (timetable.manage). It then behaves like any
// lesson (attendance, diary, homework, substitutes). The RPC has no operation id: the same extra
// lesson again (section, date, start, subject) is refused as DUPLICATE naming the existing lesson,
// so "Already added" opens it, and after an uncertain failure the same request is simply re-sent.

const NO_TEACHER = '__none__';

/** The lesson id a DUPLICATE from add_extra_lesson names in `details.lesson_session_id`, or null. */
export function extraLessonDuplicateId(error: unknown): number | null {
  if (!isAppError(error) || error.code !== 'DUPLICATE') return null;
  const d = error.details;
  if (typeof d !== 'object' || d === null) return null;
  const v = (d as Record<string, unknown>).lesson_session_id;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
}

export function ExtraLessonDialog({
  date: initialDate,
  sectionId: initialSection,
  onClose,
}: {
  date: string;
  sectionId: string | null;
  onClose: () => void;
}) {
  const { options: sections } = useSectionOptions();
  const { options: teachers } = useTeacherOptions();
  const [sectionId, setSectionId] = useState<string | null>(initialSection);
  const [date, setDate] = useState(initialDate);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<AppError | null>(null);
  const [existing, setExisting] = useState<number | null>(null);
  const navigate = useNavigate();
  const add = useAddExtraLesson();
  const check = useCreateCheck();
  const section = sections.find((s) => s.id === sectionId);
  const subjects = useClassSubjects(section?.yearId ?? null, section?.classId ?? null);
  const subjectOptions = (subjects.data ?? []).filter((s) => s.status === 'active');
  const timeProblem = start && end ? timeRangeProblem(start, end) : null;
  const ready =
    sectionId !== null &&
    isIsoDate(date) &&
    subjectId !== null &&
    start !== '' &&
    end !== '' &&
    timeProblem === null;
  const busy = add.isPending || check.state === 'checking';

  const input = (): ExtraLessonInput | null =>
    ready
      ? {
          sectionId,
          date,
          startTime: start,
          endTime: end,
          subjectId,
          staffId,
          label: label.trim() || null,
          reason: reason.trim() || null,
        }
      : null;

  const done = (lessonId: number, text: string) => {
    toast.success(text, {
      action: { label: 'Open lesson', onClick: () => void navigate(`/lessons/${lessonId}`) },
    });
    onClose();
  };

  const submit = () => {
    const v = input();
    if (!v) return;
    setError(null);
    setExisting(null);
    check.reset();
    add.mutate(v, {
      onSuccess: (r) => done(r.lesson_session_id, 'Extra lesson added.'),
      onError: (e) => {
        const err = toAppError(e);
        const dup = extraLessonDuplicateId(err);
        if (dup !== null) {
          setExisting(dup);
          return;
        }
        if (isUncertainFailure(err)) {
          // the same request again: added now, or DUPLICATE = the first attempt worked
          check.verify(
            async () => {
              try {
                return (await addExtraLesson(extraLessonArgs(v))).lesson_session_id;
              } catch (again) {
                const id = extraLessonDuplicateId(toAppError(again));
                if (id !== null) return id;
                throw again;
              }
            },
            (id) => done(id, 'Extra lesson added.'),
            (refused) => setError(toAppError(refused)),
          );
          return;
        }
        setError(err);
      },
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add an extra lesson</DialogTitle>
          <DialogDescription>
            One lesson on one date, outside the timetable. It works like any other lesson: attendance, diary,
            homework and substitutes.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <SectionSelect
            id="extra-section"
            value={sectionId}
            onChange={(v) => {
              setSectionId(v);
              setSubjectId(null);
            }}
            options={sections}
          />
          <div className="grid gap-1.5">
            <Label htmlFor="extra-date">Date</Label>
            <DateInput id="extra-date" value={date} onChange={(v) => setDate(v)} />
            {isIsoDate(date) && <p className="text-muted-foreground text-xs">{formatDateLong(date)}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="extra-start">Starts at</Label>
              <Input
                id="extra-start"
                type="time"
                className="min-h-11"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="extra-end">Ends at</Label>
              <Input
                id="extra-end"
                type="time"
                className="min-h-11"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>
          {timeProblem && (
            <p className="text-destructive text-sm" role="alert">
              {timeProblem}
            </p>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="extra-subject">Subject</Label>
            <Select value={subjectId ?? undefined} onValueChange={setSubjectId} disabled={!section}>
              <SelectTrigger id="extra-subject" className="min-h-11 w-full">
                <SelectValue
                  placeholder={section ? 'Choose a subject of this class' : 'Choose a section first'}
                />
              </SelectTrigger>
              <SelectContent>
                {subjectOptions.map((s) => (
                  <SelectItem key={s.subject_id} value={s.subject_id}>
                    {s.subject}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="extra-teacher">Teacher (optional)</Label>
            <Select
              value={staffId ?? NO_TEACHER}
              onValueChange={(v) => setStaffId(v === NO_TEACHER ? null : v)}
            >
              <SelectTrigger id="extra-teacher" className="min-h-11 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TEACHER}>No teacher yet</SelectItem>
                {teachers.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="extra-label">Label (optional)</Label>
            <Input
              id="extra-label"
              className="min-h-11"
              value={label}
              maxLength={40}
              placeholder="Extra"
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="extra-reason">Reason (optional)</Label>
            <Textarea
              id="extra-reason"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        {existing !== null && (
          <div
            role="alert"
            className="rounded-md border border-amber-500 p-3 text-sm"
            data-testid="extra-exists"
          >
            <p className="font-medium">Already added</p>
            <p>
              This section already has this extra lesson
              {start ? ` at ${formatTime(start)}` : ''} on {isIsoDate(date) ? formatDateLong(date) : date}.
            </p>
            <Button asChild size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8">
              <Link to={`/lessons/${existing}`}>Open it</Link>
            </Button>
          </div>
        )}
        <CreateCheckNotice check={check} />
        <ErrorText error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!ready || busy || check.blocksRetry}>
            Add extra lesson
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
