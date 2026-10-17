import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { ErrorText } from '@/components/shared/ErrorText';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { SetupSnapshot } from '@/contracts/setup';
import type { StaffListItem, TeachingAssignment } from '@/contracts/staff';
import { addDays, compareIsoDates, formatDate, schoolToday } from '@/lib/dates';
import { handleSaveError } from '@/lib/save-feedback';
import { useCan } from '@/lib/scope';
import { useEndTeachingAssignment, useSaveTeachingAssignment } from './hooks';

export const KIND_LABEL = { class_teacher: 'Class teacher', subject: 'Subject teacher' } as const;

export function sectionOptions(snap: SetupSnapshot) {
  const classes = new Map(snap.classes.map((c) => [c.id, c]));
  return snap.sections
    .filter((s) => s.status === 'active')
    .map((s) => ({
      value: s.id,
      label: `${classes.get(s.class_id)?.name ?? '?'} ${s.name}`,
      order: (classes.get(s.class_id)?.sort_order ?? 0) * 1000 + s.sort_order,
    }))
    .sort((a, b) => a.order - b.order);
}

/** Dialog to add a class-teacher or subject-teacher assignment (timetable.manage). */
export function AssignmentDialog({
  snapshot,
  staff,
  fixedStaffId,
  fixedSectionId,
  open,
  onOpenChange,
}: {
  snapshot: SetupSnapshot;
  staff: StaffListItem[];
  fixedStaffId?: string;
  fixedSectionId?: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const save = useSaveTeachingAssignment();
  const [staffId, setStaffId] = useState(fixedStaffId ?? '');
  const [sectionId, setSectionId] = useState(fixedSectionId ?? '');
  const [kind, setKind] = useState<'class_teacher' | 'subject'>('subject');
  const [subjectId, setSubjectId] = useState('');
  const [from, setFrom] = useState(schoolToday());
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const sections = sectionOptions(snapshot);
  const problems = [
    !staffId && 'Choose a staff member.',
    !sectionId && 'Choose a section.',
    kind === 'subject' && !subjectId && 'Choose the subject.',
    !from && 'Choose the start date.',
  ].filter(Boolean) as string[];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add teaching assignment</DialogTitle>
          <DialogDescription>
            A section has one class teacher at a time — end the current one first. The same teacher can&apos;t
            be given the same subject twice for overlapping dates.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setTouched(true);
            if (problems.length > 0) return;
            setError(null);
            try {
              await save.mutateAsync({
                staff_id: staffId,
                section_id: sectionId,
                kind,
                subject_id: kind === 'subject' ? subjectId : null,
                effective_from: from,
              });
              toast.success('Teaching assignment added.');
              onOpenChange(false);
            } catch (err) {
              setError(handleSaveError(err));
            }
          }}
        >
          {!fixedStaffId && (
            <div className="space-y-1">
              <Label htmlFor="ta-staff">Staff member</Label>
              <Select value={staffId} onValueChange={setStaffId}>
                <SelectTrigger id="ta-staff" className="w-full">
                  <SelectValue placeholder="Choose…" />
                </SelectTrigger>
                <SelectContent>
                  {staff
                    .filter((s) => s.status === 'active')
                    .map((s) => (
                      <SelectItem key={s.staff_id} value={s.staff_id}>
                        {s.name} ({s.employee_no}){s.is_teaching ? '' : ' — non-teaching'}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {!fixedSectionId && (
            <div className="space-y-1">
              <Label htmlFor="ta-section">Section</Label>
              <Select value={sectionId} onValueChange={setSectionId}>
                <SelectTrigger id="ta-section" className="w-full">
                  <SelectValue placeholder="Choose…" />
                </SelectTrigger>
                <SelectContent>
                  {sections.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="ta-kind">Duty</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger id="ta-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="subject">{KIND_LABEL.subject}</SelectItem>
                <SelectItem value="class_teacher">{KIND_LABEL.class_teacher}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === 'subject' && (
            <div className="space-y-1">
              <Label htmlFor="ta-subject">Subject</Label>
              <Select value={subjectId} onValueChange={setSubjectId}>
                <SelectTrigger id="ta-subject" className="w-full">
                  <SelectValue placeholder="Choose…" />
                </SelectTrigger>
                <SelectContent>
                  {snapshot.subjects
                    .filter((s) => s.status === 'active')
                    .map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="ta-from">Starts on</Label>
            <DateInput id="ta-from" value={from} onChange={setFrom} />
          </div>
          {touched && problems.length > 0 && (
            <ul role="alert" className="text-destructive list-inside list-disc text-sm">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <ErrorText error={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Add'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** List of assignments with an "End" action (end date is exclusive: last teaching day is the day before). */
export function AssignmentList({
  query,
  show,
  emptyText,
}: {
  query: Parameters<typeof DataState<TeachingAssignment[]>>[0]['query'];
  show: 'staff' | 'section';
  emptyText: string;
}) {
  const canManage = useCan('timetable.manage');
  const end = useEndTeachingAssignment();
  const [ending, setEnding] = useState<TeachingAssignment | null>(null);
  const [endOn, setEndOn] = useState(schoolToday());
  const [error, setError] = useState<unknown>(null);
  const today = schoolToday();
  const endProblem =
    ending && compareIsoDates(endOn, ending.effective_from) <= 0
      ? `Must be after ${formatDate(ending.effective_from)}.`
      : null;

  return (
    <>
      <ErrorText error={error} />
      <DataState query={query} isEmpty={(d) => d.length === 0} emptyTitle={emptyText}>
        {(rows) => (
          <ul className="space-y-2">
            {rows.map((a) => {
              const active = !a.effective_to || compareIsoDates(a.effective_to, today) > 0;
              return (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
                >
                  <div>
                    <p className="font-medium">
                      {show === 'staff' ? a.section : a.staff}
                      {' · '}
                      {a.kind === 'class_teacher' ? KIND_LABEL.class_teacher : (a.subject ?? 'Subject')}
                    </p>
                    <p className="text-muted-foreground">
                      From {formatDate(a.effective_from)}
                      {a.effective_to ? ` to ${formatDate(addDays(a.effective_to, -1))}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {active ? <Badge>Active</Badge> : <Badge variant="outline">Ended</Badge>}
                    {canManage && active && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEndOn(today);
                          setEnding(a);
                        }}
                      >
                        End
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DataState>
      <ConfirmDialog
        open={ending !== null}
        onOpenChange={(o) => !o && setEnding(null)}
        title="End this assignment?"
        description={
          <span className="block space-y-2">
            <span className="block">
              The teacher stops having this duty from the date below (it is their first day without it).
            </span>
            <span className="block">
              <Label htmlFor="ta-end" className="mb-1 block">
                No longer from
              </Label>
              <DateInput id="ta-end" value={endOn} onChange={setEndOn} />
              {endProblem && <span className="text-destructive mt-1 block">{endProblem}</span>}
            </span>
          </span>
        }
        confirmLabel="End assignment"
        busy={end.isPending}
        onConfirm={async () => {
          if (!ending || endProblem || !endOn) return;
          setError(null);
          try {
            await end.mutateAsync({ id: ending.id, effective_to: endOn });
            toast.success('Assignment ended.');
          } catch (e) {
            setError(handleSaveError(e));
          } finally {
            setEnding(null);
          }
        }}
      />
    </>
  );
}
