import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { ErrorText } from '@/components/shared/ErrorText';
import { MoneyText } from '@/components/shared/MoneyText';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import type { PaidLeave } from '@/contracts/salary';
import { isUncertainFailure } from '@/lib/create-check';
import { formatDateTime, formatDayShort, formatMonth, isIsoDate, monthEnd } from '@/lib/dates';
import { toAppError, type AppError } from '@/lib/errors';
import { useCancelPaidLeave, usePaidLeave, useRecordPaidLeave, useSalaryHistory } from './hooks';
import { formatDays } from './logic';

// Paid leave used in the month (recorded by Admin; no leave-request portal in V1) and the saved
// versions of the calculation (final / superseded, who and when).

export function PaidLeaveCard({
  staffId,
  month,
  canManage,
}: {
  staffId: string;
  month: string;
  canManage: boolean;
}) {
  const query = usePaidLeave(staffId, month);
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState<PaidLeave | null>(null);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Paid leave — {formatMonth(month)}</CardTitle>
        {canManage && (
          <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setAdding(true)}>
            Add paid leave
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <DataState
          query={query}
          isEmpty={(rows) => rows.length === 0}
          emptyTitle="No paid leave recorded"
          emptyDescription="Paid leave counts as paid days. Unmarked days are not leave."
        >
          {(rows) => {
            const active = rows.filter((r) => r.status === 'active');
            const cancelled = rows.filter((r) => r.status === 'cancelled');
            return (
              <div className="space-y-2" data-testid="paid-leave">
                {active.length === 0 && (
                  <p className="text-muted-foreground text-sm">No active paid leave.</p>
                )}
                <ul className="space-y-1">
                  {active.map((r) => (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
                    >
                      <span className="font-medium">{formatDayShort(r.leave_date)}</span>
                      <Badge variant="outline">{r.day_fraction === 0.5 ? 'Half day' : 'Full day'}</Badge>
                      {r.reason && (
                        <span className="text-muted-foreground min-w-0 break-words">{r.reason}</span>
                      )}
                      <span className="text-muted-foreground ml-auto text-xs">
                        {r.recorded_by ? `by ${r.recorded_by}` : ''}
                      </span>
                      {canManage && (
                        <Button variant="ghost" size="sm" onClick={() => setCancelling(r)}>
                          Cancel
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                {cancelled.length > 0 && (
                  <details className="text-sm">
                    <summary className="cursor-pointer">Cancelled ({cancelled.length})</summary>
                    <ul className="mt-1 space-y-1">
                      {cancelled.map((r) => (
                        <li key={r.id} className="text-muted-foreground">
                          <s>{formatDayShort(r.leave_date)}</s> ·{' '}
                          {r.day_fraction === 0.5 ? 'half day' : 'full day'} — cancelled
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            );
          }}
        </DataState>
      </CardContent>
      {adding && <AddPaidLeaveDialog staffId={staffId} month={month} onClose={() => setAdding(false)} />}
      {cancelling && <CancelPaidLeaveDialog leave={cancelling} onClose={() => setCancelling(null)} />}
    </Card>
  );
}

function AddPaidLeaveDialog({
  staffId,
  month,
  onClose,
}: {
  staffId: string;
  month: string;
  onClose: () => void;
}) {
  const [date, setDate] = useState('');
  const [fraction, setFraction] = useState<1 | 0.5>(1);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<AppError | null>(null);
  const record = useRecordPaidLeave();
  const last = monthEnd(month);
  const inMonth = isIsoDate(date) && date >= month && date <= last;
  return (
    <Dialog open onOpenChange={(o) => !o && !record.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add paid leave</DialogTitle>
          <DialogDescription>
            Approved paid leave used on a working day of {formatMonth(month)}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="leave-date">Date</Label>
            <DateInput id="leave-date" value={date} min={month} max={last} onChange={(v) => setDate(v)} />
            {date && !inMonth && (
              <p className="text-destructive text-sm" role="alert">
                Choose a date in {formatMonth(month)}.
              </p>
            )}
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="text-sm font-medium">Length</legend>
            <div className="flex gap-4">
              {(
                [
                  [1, 'Full day'],
                  [0.5, 'Half day'],
                ] as const
              ).map(([v, label]) => (
                <label key={v} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="leave-fraction"
                    checked={fraction === v}
                    onChange={() => setFraction(v)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-1.5">
            <Label htmlFor="leave-reason">Reason (optional)</Label>
            <Textarea
              id="leave-reason"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        {error &&
          (isUncertainFailure(error) ? (
            <p role="alert" className="rounded-md border border-amber-600 p-2 text-sm">
              Not confirmed — check the list after closing. Adding the same day again is safe: the server
              refuses a second paid leave on one day.
            </p>
          ) : (
            <ErrorText error={error} />
          ))}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={record.isPending}>
            Cancel
          </Button>
          <Button
            disabled={!inMonth || record.isPending}
            onClick={() => {
              setError(null);
              record.mutate(
                { staffId, date, fraction, reason: reason.trim() || null },
                {
                  onSuccess: (r) => {
                    if (r.note) toast.warning(`Paid leave recorded. ${r.note}.`);
                    else toast.success('Paid leave recorded.');
                    onClose();
                  },
                  onError: (e) => setError(toAppError(e)),
                },
              );
            }}
          >
            Add paid leave
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelPaidLeaveDialog({ leave, onClose }: { leave: PaidLeave; onClose: () => void }) {
  const cancel = useCancelPaidLeave();
  const [error, setError] = useState<AppError | null>(null);
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Cancel this paid leave?"
      description={
        <>
          {formatDayShort(leave.leave_date)} · {leave.day_fraction === 0.5 ? 'half day' : 'full day'}. A saved
          salary is not changed until it is saved again.
          {error && (
            <span className="text-destructive mt-2 block" role="alert">
              {error.message}
            </span>
          )}
        </>
      }
      confirmLabel="Cancel paid leave"
      cancelLabel="Keep it"
      destructive
      busy={cancel.isPending}
      onConfirm={() =>
        cancel.mutate(leave.id, {
          onSuccess: () => {
            toast.success('Paid leave cancelled.');
            onClose();
          },
          onError: (e) => {
            const err = toAppError(e);
            if (err.code === 'CONFLICT') {
              toast.warning('This paid leave was already cancelled. The list has been reloaded.');
              onClose();
              return;
            }
            setError(err);
          },
        })
      }
    />
  );
}

export function SalaryHistoryCard({ staffId, month }: { staffId: string; month: string }) {
  const query = useSalaryHistory(staffId, month);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Saved versions</CardTitle>
      </CardHeader>
      <CardContent>
        <DataState
          query={query}
          isEmpty={(rows) => rows.length === 0}
          emptyTitle="Nothing saved for this month yet"
        >
          {(rows) => (
            <ol className="space-y-2" data-testid="salary-history">
              {rows.map((v) => (
                <li key={v.id} className="rounded-md border p-2 text-sm" data-testid="salary-version">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">Version {v.version_no}</span>
                    <Badge variant={v.status === 'final' ? 'secondary' : 'outline'}>
                      {v.status === 'final' ? 'Final' : 'Superseded'}
                    </Badge>
                    <MoneyText paise={v.payable_paise} className="font-medium" />
                  </div>
                  <p className="text-muted-foreground">
                    Working {formatDays(v.working_days)} · attended {formatDays(v.attended_days)} · paid leave{' '}
                    {formatDays(v.paid_leave_days)} · unpaid {formatDays(v.unpaid_days)} · salary{' '}
                    <MoneyText paise={v.monthly_salary_paise} />
                  </p>
                  {Object.keys(v.overrides).length > 0 && (
                    <p>
                      Overrides: {Object.keys(v.overrides).join(', ').replace(/_/g, ' ')}
                      {v.override_reason ? ` — ${v.override_reason}` : ''}
                    </p>
                  )}
                  <p className="text-muted-foreground text-xs">
                    Saved {formatDateTime(v.created_at)}
                    {v.calculated_by ? ` by ${v.calculated_by}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}
