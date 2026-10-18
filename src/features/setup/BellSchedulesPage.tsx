import { useState } from 'react';
import { toast } from 'sonner';
import { DataState } from '@/components/shared/DataState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { PeriodSchedule } from '@/contracts/setup';
import { compareIsoDates, formatDate, schoolToday } from '@/lib/dates';
import { handleSaveError } from '@/lib/save-feedback';
import { useCan } from '@/lib/scope';
import { SCHEDULE_KIND_LABELS, hhmm } from './bell';
import { BellScheduleEditor } from './BellScheduleEditor';
import { useSavePeriodSchedule, useSetupSnapshot } from './hooks';

function effectiveText(
  s: PeriodSchedule,
  today: string,
): { label: string; tone: 'current' | 'future' | 'past' } {
  if (compareIsoDates(s.effective_from, today) > 0)
    return { label: `Starts ${formatDate(s.effective_from)}`, tone: 'future' };
  if (s.effective_to && compareIsoDates(s.effective_to, today) <= 0)
    return { label: `Ended ${formatDate(s.effective_to)}`, tone: 'past' };
  return {
    label: `In use since ${formatDate(s.effective_from)}${s.effective_to ? ` until ${formatDate(s.effective_to)}` : ''}`,
    tone: 'current',
  };
}

export function BellSchedulesPage() {
  const query = useSetupSnapshot(null);
  const canManage = useCan('setup.manage');
  const save = useSavePeriodSchedule();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const today = schoolToday();

  return (
    <div className="space-y-4">
      {canManage && editing && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New bell schedule</CardTitle>
            <CardDescription>
              Bell schedules are versioned: saving creates a new one; old ones are kept.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BellScheduleEditor
              defaultEffectiveFrom={today}
              saving={save.isPending}
              error={error}
              onCancel={() => {
                setEditing(false);
                setError(null);
              }}
              onSave={async (draft) => {
                setError(null);
                try {
                  await save.mutateAsync(draft);
                  toast.success(`Bell schedule “${draft.name}” saved.`);
                  setEditing(false);
                } catch (e) {
                  setError(handleSaveError(e));
                }
              }}
            />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Bell schedules</CardTitle>
          {canManage && !editing && (
            <Button size="sm" onClick={() => setEditing(true)}>
              New bell schedule
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <DataState
            query={query}
            isEmpty={(d) => d.period_schedules.length === 0}
            emptyTitle="No bell schedules yet"
            emptyDescription="Lessons and half days need a bell schedule."
          >
            {(snap) => (
              <ul className="space-y-3">
                {snap.period_schedules.map((s) => {
                  const eff = effectiveText(s, today);
                  return (
                    <li key={s.id} className="rounded-md border p-3" data-testid={`schedule-${s.name}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{s.name}</span>
                        <Badge variant="secondary">{SCHEDULE_KIND_LABELS[s.kind]}</Badge>
                        <Badge variant={eff.tone === 'current' ? 'default' : 'outline'}>{eff.label}</Badge>
                      </div>
                      {s.slots.length === 0 ? (
                        <p className="text-muted-foreground mt-2 text-sm">No periods recorded.</p>
                      ) : (
                        <ol className="mt-2 grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                          {s.slots.map((slot) => (
                            <li
                              key={slot.ordinal}
                              className="bg-muted/50 flex justify-between gap-2 rounded px-2 py-1"
                            >
                              <span>
                                {slot.label}
                                {slot.kind === 'break' && (
                                  <span className="text-muted-foreground"> (break)</span>
                                )}
                              </span>
                              <span className="tabular-nums">
                                {hhmm(slot.start_time)}–{hhmm(slot.end_time)}
                              </span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </DataState>
        </CardContent>
      </Card>
    </div>
  );
}
