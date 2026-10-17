import { useState } from 'react';
import { toast } from 'sonner';
import { DateInput } from '@/components/shared/DateInput';
import { ErrorText } from '@/components/shared/ErrorText';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { SetupSnapshot } from '@/contracts/setup';
import type { MovePlacementsResult, StudentListItem } from '@/contracts/students';
import { schoolToday } from '@/lib/dates';
import { useOperationId } from '@/lib/operation';
import { handleSaveError } from '@/lib/save-feedback';
import { useMovePlacements } from './hooks';

/**
 * Batch placement move (brief §4.5): preview first (p_preview = true), show the server's preview,
 * then commit with the SAME operation id. The id is renewed only after a successful commit.
 * Changing any input invalidates the preview.
 */
export function MovePlacementsDialog({
  students,
  snapshot,
  open,
  onOpenChange,
  onDone,
}: {
  students: StudentListItem[];
  snapshot: SetupSnapshot;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const move = useMovePlacements();
  const { operationId, reset } = useOperationId();
  const [sectionId, setSectionId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(schoolToday());
  const [reason, setReason] = useState('');
  const [rolls, setRolls] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Extract<MovePlacementsResult, { preview: true }> | null>(null);
  const [error, setError] = useState<unknown>(null);

  const classes = new Map(snapshot.classes.map((c) => [c.id, c.name]));
  const sectionName = (id: string | null) => {
    const s = snapshot.sections.find((x) => x.id === id);
    return s ? `${classes.get(s.class_id) ?? ''} ${s.name}` : 'none';
  };
  const badRoll = Object.values(rolls).some(
    (r) => r.trim() !== '' && !/^[A-Za-z0-9/-]{1,12}$/.test(r.trim()),
  );
  const ready = sectionId && effectiveFrom && reason.trim() && !badRoll;
  const edit =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setPreview(null); // inputs changed: the previous preview no longer applies
    };
  const moves = () =>
    students.map((s) => ({
      student_id: s.student_id,
      section_id: sectionId,
      roll_no: rolls[s.student_id]?.trim() || null,
    }));

  const run = async (commit: boolean) => {
    setError(null);
    try {
      const res = await move.mutateAsync({
        operationId,
        preview: !commit,
        effectiveFrom,
        reason: reason.trim(),
        moves: moves(),
      });
      if (res.preview) {
        setPreview(res);
      } else {
        toast.success(`${res.moved} student${res.moved === 1 ? '' : 's'} moved.`);
        reset();
        onDone();
      }
    } catch (e) {
      setError(handleSaveError(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Move {students.length} student{students.length === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>
            Preview first. Past attendance stays with the old section; existing invoices are not recalculated.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="move-section">Move to section</Label>
            <Select value={sectionId} onValueChange={edit(setSectionId)}>
              <SelectTrigger id="move-section" className="w-full">
                <SelectValue placeholder="Choose…" />
              </SelectTrigger>
              <SelectContent>
                {snapshot.sections
                  .filter((s) => s.status === 'active')
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {classes.get(s.class_id)} {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="move-date">From date</Label>
            <DateInput id="move-date" value={effectiveFrom} onChange={edit(setEffectiveFrom)} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="move-reason">Reason (required)</Label>
            <Textarea id="move-reason" value={reason} onChange={(e) => edit(setReason)(e.target.value)} />
          </div>
        </div>
        <ul className="divide-y rounded-md border text-sm">
          {students.map((s) => {
            const row = preview?.rows.find((r) => r.student_id === s.student_id);
            return (
              <li key={s.student_id} className="space-y-1 p-2" data-testid={`move-row-${s.admission_no}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{s.name}</span>{' '}
                    <span className="text-muted-foreground">
                      ({s.class ? `${s.class} ${s.section}` : 'no section'})
                    </span>
                  </span>
                  <label className="flex items-center gap-2">
                    Roll no.
                    <Input
                      className="w-20"
                      value={rolls[s.student_id] ?? ''}
                      onChange={(e) =>
                        edit((v: string) => setRolls((r) => ({ ...r, [s.student_id]: v })))(e.target.value)
                      }
                    />
                  </label>
                </div>
                {row && (
                  <div className="text-xs">
                    {row.errors.length > 0 ? (
                      <ul className="text-destructive">
                        {row.errors.map((er) => (
                          <li key={er}>✕ {er}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>
                        ✓ {sectionName(row.from_section_id)} → {sectionName(row.to_section_id)}
                        {row.class_changes && (
                          <Badge variant="outline" className="ml-2">
                            Class changes
                          </Badge>
                        )}
                      </p>
                    )}
                    {row.marks_after_move_in_old_section > 0 && (
                      <p className="text-amber-700">
                        {row.marks_after_move_in_old_section} attendance mark(s) after this date stay in the
                        old section.
                      </p>
                    )}
                    {row.class_changes && <p className="text-muted-foreground">{row.fee_note}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {badRoll && (
          <p className="text-destructive text-sm">Roll numbers are up to 12 letters, digits, / or -.</p>
        )}
        {preview && (
          <p role="status" className={preview.can_apply ? 'text-sm' : 'text-destructive text-sm'}>
            {preview.can_apply
              ? 'Preview OK — nothing has been moved yet.'
              : 'Fix the problems above before moving.'}
          </p>
        )}
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {!preview?.can_apply ? (
            <Button disabled={!ready || move.isPending} onClick={() => void run(false)}>
              {move.isPending ? 'Checking…' : 'Preview'}
            </Button>
          ) : (
            <Button disabled={move.isPending} onClick={() => void run(true)}>
              {move.isPending ? 'Moving…' : `Move ${students.length}`}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
