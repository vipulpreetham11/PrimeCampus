import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { FeeSetup, OptionalRosterRow } from '@/contracts/fees';
import { useSetupSnapshot } from '@/features/setup/hooks';
import { setOptionalArgs, useOptionalRoster, useSetOptionalFees } from '../hooks';
import { useMoneyAction } from '../money-action';
import { UnconfirmedNotice } from '../parts';

// Optional fees (brief §1): head + section → roster with checkboxes → set_optional_fees with ONE
// operation id per Save, sending only the rows that changed.

/** Rows whose checkbox differs from the server value. Unit-tested. */
export function optionalChanges(rows: OptionalRosterRow[], draft: Record<string, boolean>) {
  return rows
    .filter((r) => draft[r.student_id] !== undefined && draft[r.student_id] !== r.enabled)
    .map((r) => ({ student_id: r.student_id, enabled: draft[r.student_id]! }));
}

export function OptionalFeesCard({
  setup,
  yearId,
  canManage,
}: {
  setup: FeeSetup;
  yearId: string | null;
  canManage: boolean;
}) {
  const snapshot = useSetupSnapshot(yearId);
  const heads = setup.fee_heads.filter((h) => h.is_optional && h.status === 'active');
  const [headId, setHeadId] = useState<string | null>(null);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const classes = new Map((snapshot.data?.classes ?? []).map((c) => [c.id, c.name]));
  const sections = (snapshot.data?.sections ?? []).filter((s) => s.status === 'active');
  const roster = useOptionalRoster(yearId, headId, sectionId);
  return (
    <Card>
      <CardHeader className="space-y-3">
        <CardTitle className="text-base">Optional fees</CardTitle>
        {heads.length === 0 ? (
          <p className="text-sm">
            No optional fee heads. Mark a fee head as optional (for example Transport) first.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="opt-head">Fee head</Label>
              <Select value={headId ?? ''} onValueChange={setHeadId}>
                <SelectTrigger id="opt-head" className="w-full" aria-label="Optional fee head">
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  {heads.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="opt-section">Section</Label>
              <Select value={sectionId ?? ''} onValueChange={setSectionId}>
                <SelectTrigger id="opt-section" className="w-full" aria-label="Section">
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  {sections.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {classes.get(s.class_id) ?? ''} {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {headId && sectionId && yearId && (
          <DataState
            query={roster}
            isEmpty={(r) => r.length === 0}
            emptyTitle="No students in this section today"
          >
            {(rows) => (
              <OptionalRoster
                key={`${headId}-${sectionId}-${JSON.stringify(rows.map((r) => r.enabled))}`}
                rows={rows}
                yearId={yearId}
                headId={headId}
                canManage={canManage}
              />
            )}
          </DataState>
        )}
      </CardContent>
    </Card>
  );
}

function OptionalRoster({
  rows,
  yearId,
  headId,
  canManage,
}: {
  rows: OptionalRosterRow[];
  yearId: string;
  headId: string;
  canManage: boolean;
}) {
  const mut = useSetOptionalFees();
  const send = useCallback(
    (operationId: string, changes: { student_id: string; enabled: boolean }[]) =>
      mut.mutateAsync(setOptionalArgs(operationId, yearId, headId, changes)),
    [mut, yearId, headId],
  );
  const action = useMoneyAction(send);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const changes = optionalChanges(rows, draft);
  const locked = action.state.kind === 'saving' || action.state.kind === 'unconfirmed';
  const done = (r: { enabled: number; disabled: number; note: string | null; replayed?: boolean } | null) => {
    if (!r) return;
    toast.success(
      r.replayed
        ? 'These changes were already saved.'
        : `Saved: ${r.enabled} added, ${r.disabled} removed. ${r.note ?? ''}`,
    );
    setDraft({});
  };
  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-md border" data-testid="optional-roster">
        {rows.map((r) => {
          const checked = draft[r.student_id] ?? r.enabled;
          return (
            <li key={r.student_id} className="flex items-center gap-3 p-2 text-sm">
              <Checkbox
                id={`opt-${r.student_id}`}
                checked={checked}
                disabled={!canManage || locked}
                onCheckedChange={(c) => setDraft((d) => ({ ...d, [r.student_id]: c === true }))}
              />
              <Label htmlFor={`opt-${r.student_id}`} className="min-w-0 font-normal">
                <span className="block">
                  {r.roll_no ? `${r.roll_no}. ` : ''}
                  {r.name}
                </span>
                <span className="text-muted-foreground block text-xs break-all">
                  {r.admission_no} · {checked ? 'Opted in' : 'Not opted in'}
                  {checked !== r.enabled ? ' (unsaved)' : ''}
                </span>
              </Label>
            </li>
          );
        })}
      </ul>
      {canManage && (
        <>
          {action.state.kind === 'failed' && <ErrorText error={action.state.error} />}
          {action.state.kind === 'unconfirmed' ? (
            <UnconfirmedNotice
              what="change"
              error={action.state.error}
              busy={false}
              onRetry={() => void action.retry().then(done)}
              onDiscard={action.discard}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={changes.length === 0 || locked}
                onClick={() => void action.run(changes).then(done)}
              >
                {action.state.kind === 'saving'
                  ? 'Saving…'
                  : `Save ${changes.length} change${changes.length === 1 ? '' : 's'}`}
              </Button>
              <span className="text-muted-foreground text-xs">Applies to invoices issued from now on.</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
