import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { ErrorText } from '@/components/shared/ErrorText';
import { DateInput } from '@/components/shared/DateInput';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SCHEDULE_KIND_LABELS,
  SCHEDULE_PRESETS,
  toSlotsPayload,
  validateSchedule,
  type ScheduleDraft,
  type ScheduleKind,
  type SlotDraft,
} from './bell';

export interface BellScheduleEditorProps {
  /** Default effective-from date (school-local, e.g. today). */
  defaultEffectiveFrom: string;
  saving?: boolean;
  error?: unknown;
  onSave: (draft: ScheduleDraft & { slots: ReturnType<typeof toSlotsPayload> }) => void;
  onCancel: () => void;
}

const EMPTY_SLOT: SlotDraft = { label: '', kind: 'period', start_time: '', end_time: '' };

/**
 * New bell schedule. Presets only prefill the form; nothing is saved until "Save schedule".
 * Client checks (overlaps, inside the day, end after start) block saving; the server re-checks.
 */
export function BellScheduleEditor({
  defaultEffectiveFrom,
  saving,
  error,
  onSave,
  onCancel,
}: BellScheduleEditorProps) {
  const [draft, setDraft] = useState<ScheduleDraft>({
    name: '',
    kind: 'regular',
    day_start: '08:00',
    day_end: '14:00',
    effective_from: defaultEffectiveFrom,
    slots: [{ ...EMPTY_SLOT, label: 'Period 1' }],
  });
  const [touched, setTouched] = useState(false);
  const issues = useMemo(() => validateSchedule(draft), [draft]);
  const general = issues.filter((i) => i.slot === null);
  const bySlot = (i: number) => issues.filter((x) => x.slot === i);

  const setSlot = (i: number, patch: Partial<SlotDraft>) =>
    setDraft((d) => ({ ...d, slots: d.slots.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));

  const addSlot = (kind: 'period' | 'break') =>
    setDraft((d) => {
      const last = d.slots.at(-1);
      const periods = d.slots.filter((s) => s.kind === 'period').length;
      return {
        ...d,
        slots: [
          ...d.slots,
          {
            label: kind === 'period' ? `Period ${periods + 1}` : 'Break',
            kind,
            start_time: last?.end_time ?? d.day_start,
            end_time: '',
          },
        ],
      };
    });

  return (
    <form
      className="space-y-5"
      noValidate
      aria-label="New bell schedule"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (issues.length === 0)
          onSave({ ...draft, name: draft.name.trim(), slots: toSlotsPayload(draft.slots) });
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-sm">Start from a preset:</span>
        {SCHEDULE_PRESETS.map((p) => (
          <Button
            key={p.id}
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setDraft(p.apply(draft.effective_from || defaultEffectiveFrom))}
          >
            {p.label}
          </Button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="bs-name">Name</Label>
          <Input
            id="bs-name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="bs-kind">Kind</Label>
          <Select value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v as ScheduleKind })}>
            <SelectTrigger id="bs-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SCHEDULE_KIND_LABELS) as ScheduleKind[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {SCHEDULE_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="bs-from">Effective from</Label>
          <DateInput
            id="bs-from"
            value={draft.effective_from}
            onChange={(v) => setDraft({ ...draft, effective_from: v })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="bs-start">School day starts</Label>
          <Input
            id="bs-start"
            type="time"
            value={draft.day_start}
            onChange={(e) => setDraft({ ...draft, day_start: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="bs-end">School day ends</Label>
          <Input
            id="bs-end"
            type="time"
            value={draft.day_end}
            onChange={(e) => setDraft({ ...draft, day_end: e.target.value })}
          />
        </div>
      </div>
      {draft.kind === 'regular' && (
        <p className="text-muted-foreground text-sm">
          A new regular schedule ends the previous regular one on its start date. Lessons already created keep
          their old times.
        </p>
      )}

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Periods and breaks</legend>
        <ol className="space-y-2">
          {draft.slots.map((s, i) => {
            const slotIssues = touched
              ? bySlot(i)
              : bySlot(i).filter((x) => /Overlaps|inside|Ends before/.test(x.message));
            return (
              <li key={i} className="rounded-md border p-2" data-testid={`slot-row-${i}`}>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_8rem_7rem_7rem_auto] sm:items-end">
                  <div className="col-span-2 space-y-1 sm:col-span-1">
                    <Label htmlFor={`slot-${i}-label`} className="text-xs">
                      Label
                    </Label>
                    <Input
                      id={`slot-${i}-label`}
                      value={s.label}
                      onChange={(e) => setSlot(i, { label: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`slot-${i}-kind`} className="text-xs">
                      Type
                    </Label>
                    <Select
                      value={s.kind}
                      onValueChange={(v) => setSlot(i, { kind: v as SlotDraft['kind'] })}
                    >
                      <SelectTrigger id={`slot-${i}-kind`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="period">Period</SelectItem>
                        <SelectItem value="break">Break</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`slot-${i}-start`} className="text-xs">
                      Starts
                    </Label>
                    <Input
                      id={`slot-${i}-start`}
                      type="time"
                      value={s.start_time}
                      onChange={(e) => setSlot(i, { start_time: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`slot-${i}-end`} className="text-xs">
                      Ends
                    </Label>
                    <Input
                      id={`slot-${i}-end`}
                      type="time"
                      value={s.end_time}
                      onChange={(e) => setSlot(i, { end_time: e.target.value })}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${s.label || `row ${i + 1}`}`}
                    onClick={() => setDraft((d) => ({ ...d, slots: d.slots.filter((_, k) => k !== i) }))}
                  >
                    <Trash2 />
                  </Button>
                </div>
                {slotIssues.length > 0 && (
                  <ul className="text-destructive mt-1 text-sm">
                    {slotIssues.map((x) => (
                      <li key={x.message}>{x.message}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => addSlot('period')}>
            <Plus /> Add period
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => addSlot('break')}>
            <Plus /> Add break
          </Button>
        </div>
      </fieldset>

      {touched && general.length > 0 && (
        <ul role="alert" className="text-destructive list-inside list-disc text-sm">
          {general.map((x) => (
            <li key={x.message}>{x.message}</li>
          ))}
        </ul>
      )}
      <ErrorText error={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save schedule'}
        </Button>
      </div>
    </form>
  );
}
