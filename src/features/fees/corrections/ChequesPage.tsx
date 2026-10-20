import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { ErrorText } from '@/components/shared/ErrorText';
import { MoneyInput } from '@/components/shared/MoneyInput';
import { MoneyText } from '@/components/shared/MoneyText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CHEQUE_STATUSES, type ChequeRow, type ChequeStatus } from '@/contracts/fees';
import { formatDate, schoolToday } from '@/lib/dates';
import { toAppError, type AppError } from '@/lib/errors';
import { formatPaise } from '@/lib/money';
import { useCan } from '@/lib/scope';
import { checkAllocation, openInvoices, type Allocations } from '../collect/allocation';
import { useBounceCheque, useCancelCheque, useCheques, useClearCheque, useStatement } from '../hooks';
import { CHEQUE_STATUS_LABELS } from '../labels';

// Cheques register (brief §7): pending cheques never reduce dues. Clear → a receipt is made (the
// planned allocations, or changed ones that add up to the cheque); bounce → a cleared cheque's
// payment is reversed and the dues reopen; cancel a pending cheque (with its version).

type Action = { kind: 'clear' | 'bounce' | 'cancel'; cheque: ChequeRow } | null;

export function ChequesPage() {
  const canManage = useCan('fees.manage');
  const [status, setStatus] = useState<ChequeStatus | 'all'>('pending');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = useCheques({ status: status === 'all' ? null : status, from: from || null, to: to || null });
  const [action, setAction] = useState<Action>(null);
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Cheques"
        description="A pending cheque is not counted as paid until it is cleared."
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="cheque-status">Status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as ChequeStatus | 'all')}>
            <SelectTrigger id="cheque-status" className="w-full" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHEQUE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {CHEQUE_STATUS_LABELS[s]}
                </SelectItem>
              ))}
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cheque-from">Received from</Label>
          <DateInput id="cheque-from" value={from} onChange={setFrom} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cheque-to">Received to</Label>
          <DateInput id="cheque-to" value={to} onChange={setTo} />
        </div>
      </div>
      <DataState query={query} isEmpty={() => rows.length === 0} emptyTitle="No cheques for this filter">
        {() => (
          <Card>
            <CardContent className="pt-6">
              <ul className="divide-y rounded-md border text-sm" data-testid="cheque-rows">
                {rows.map((c) => (
                  <li key={c.cheque_id} className="space-y-1 p-3" data-testid={`cheque-${c.cheque_no}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">Cheque {c.cheque_no}</span>
                      <span>{c.bank_name}</span>
                      <MoneyText paise={c.amount_paise} className="font-medium" />
                      <Badge
                        variant={c.status === 'bounced' ? 'destructive' : 'outline'}
                        data-testid="cheque-status"
                      >
                        {CHEQUE_STATUS_LABELS[c.status]}
                      </Badge>
                    </div>
                    <p>
                      <Link to={`/fees/students/${c.student_id}`} className="underline">
                        {c.name}
                      </Link>{' '}
                      <span className="text-muted-foreground break-all">{c.admission_no}</span> · dated{' '}
                      {formatDate(c.cheque_date)} · received {formatDate(c.received_on)}
                      {c.account ? ` · into ${c.account}` : ''}
                    </p>
                    <p className="text-muted-foreground">
                      Planned for:{' '}
                      {c.planned_allocations.map((a, i) => (
                        <span key={a.invoice_id}>
                          {i > 0 && ', '}
                          {a.invoice_no} <MoneyText paise={a.amount_paise} />
                        </span>
                      ))}
                    </p>
                    {c.cleared_on && (
                      <p>
                        Cleared {formatDate(c.cleared_on)}
                        {c.receipt_no ? ` · receipt ${c.receipt_no}` : ''}
                      </p>
                    )}
                    {c.bounced_on && (
                      <p>
                        Bounced {formatDate(c.bounced_on)}
                        {c.bounce_reason ? ` — ${c.bounce_reason}` : ''}
                      </p>
                    )}
                    {c.status === 'cancelled' && c.bounce_reason && <p>{c.bounce_reason}</p>}
                    {canManage && (c.status === 'pending' || c.status === 'cleared') && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {c.status === 'pending' && (
                          <Button size="sm" onClick={() => setAction({ kind: 'clear', cheque: c })}>
                            Clear
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setAction({ kind: 'bounce', cheque: c })}
                        >
                          Bounced
                        </Button>
                        {c.status === 'pending' && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setAction({ kind: 'cancel', cheque: c })}
                          >
                            Cancel cheque
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {query.hasNextPage && (
                <Button
                  variant="outline"
                  className="mt-3"
                  onClick={() => void query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </CardContent>
          </Card>
        )}
      </DataState>
      {action?.kind === 'clear' && <ClearDialog cheque={action.cheque} onClose={() => setAction(null)} />}
      {action?.kind === 'bounce' && <BounceDialog cheque={action.cheque} onClose={() => setAction(null)} />}
      {action?.kind === 'cancel' && (
        <CancelChequeDialog cheque={action.cheque} onClose={() => setAction(null)} />
      )}
    </div>
  );
}

function ShellDialog({
  title,
  description,
  busy,
  onClose,
  children,
}: {
  title: string;
  description: string;
  busy: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function Buttons({
  busy,
  label,
  onClose,
  destructive,
}: {
  busy: boolean;
  label: string;
  onClose: () => void;
  destructive?: boolean;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={busy}>
        {busy ? 'Saving…' : label}
      </Button>
    </div>
  );
}

function ClearDialog({ cheque, onClose }: { cheque: ChequeRow; onClose: () => void }) {
  const mut = useClearCheque();
  const today = schoolToday();
  const [date, setDate] = useState(today);
  const [change, setChange] = useState(false);
  const [alloc, setAlloc] = useState<Allocations>({});
  const [error, setError] = useState<AppError | null>(null);
  const statement = useStatement(change ? cheque.student_id : null);
  const invoices = useMemo(
    () => (statement.data ? openInvoices(statement.data, false) : []),
    [statement.data],
  );
  const check = checkAllocation(cheque.amount_paise, invoices, alloc);
  return (
    <ShellDialog
      title={`Clear cheque ${cheque.cheque_no}`}
      description={`${formatPaise(cheque.amount_paise)} from ${cheque.name}. Clearing makes the receipt and reduces the dues.`}
      busy={mut.isPending}
      onClose={onClose}
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!date || date > today || (change && !check.ok)) return;
          setError(null);
          mut
            .mutateAsync({
              chequeId: cheque.cheque_id,
              clearedOn: date,
              allocations: change
                ? invoices
                    .filter((i) => (alloc[i.invoice_id] ?? 0) > 0)
                    .map((i) => ({ invoice_id: i.invoice_id, amount_paise: alloc[i.invoice_id]! }))
                : null,
            })
            .then((r) => {
              toast.success(
                r.replayed
                  ? 'This cheque was already cleared.'
                  : `Cheque cleared${r.receipt_no ? ` — receipt ${r.receipt_no}` : ''}.`,
              );
              onClose();
            })
            .catch((err: unknown) => setError(toAppError(err)));
        }}
      >
        <fieldset disabled={mut.isPending} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="clear-date">Cleared on</Label>
            <DateInput id="clear-date" value={date} max={today} onChange={setDate} />
          </div>
          <div className="flex items-center gap-2 text-sm">
            <input
              id="clear-change"
              type="checkbox"
              checked={change}
              onChange={(e) => setChange(e.target.checked)}
            />
            <Label htmlFor="clear-change" className="font-normal">
              Allocate differently from the plan
            </Label>
          </div>
          {!change ? (
            <p className="text-sm">
              Planned:{' '}
              {cheque.planned_allocations.map((a, i) => (
                <span key={a.invoice_id}>
                  {i > 0 && ', '}
                  {a.invoice_no} <MoneyText paise={a.amount_paise} />
                </span>
              ))}
            </p>
          ) : statement.isPending ? (
            <p className="text-muted-foreground text-sm">Loading the student&apos;s invoices…</p>
          ) : statement.isError ? (
            <ErrorText error={statement.error} />
          ) : (
            <div className="space-y-2">
              <ul className="divide-y rounded-md border text-sm">
                {invoices.map((inv) => (
                  <li key={inv.invoice_id} className="grid grid-cols-[1fr_9rem] items-center gap-2 p-2">
                    <Label htmlFor={`clear-alloc-${inv.invoice_id}`} className="font-normal">
                      <span className="sr-only">Amount for </span>
                      {inv.invoice_no} · balance <MoneyText paise={inv.balance_paise} />
                    </Label>
                    <MoneyInput
                      id={`clear-alloc-${inv.invoice_id}`}
                      value={alloc[inv.invoice_id] ?? 0}
                      onChange={(p) => setAlloc((a) => ({ ...a, [inv.invoice_id]: p ?? 0 }))}
                      invalid={!!check.rowErrors[inv.invoice_id]}
                    />
                  </li>
                ))}
              </ul>
              <p className="text-sm">
                Allocated <MoneyText paise={check.sum} /> of <MoneyText paise={cheque.amount_paise} />
                {check.message ? ` · ${check.message}` : ' · adds up exactly'}
              </p>
            </div>
          )}
        </fieldset>
        <ErrorText error={error} />
        <Buttons busy={mut.isPending} label="Clear cheque" onClose={onClose} />
      </form>
    </ShellDialog>
  );
}

function ReasonDialog({
  title,
  description,
  label,
  destructive,
  withDate,
  onSend,
  onClose,
}: {
  title: string;
  description: string;
  label: string;
  destructive?: boolean;
  withDate?: boolean;
  onSend: (reason: string, date: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const today = schoolToday();
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  return (
    <ShellDialog title={title} description={description} busy={busy} onClose={onClose}>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (reason.trim() === '' || (withDate && (!date || date > today))) return;
          setBusy(true);
          setError(null);
          onSend(reason.trim(), date)
            .then(onClose)
            .catch((err: unknown) => setError(toAppError(err)))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={busy} className="space-y-4">
          {withDate && (
            <div className="space-y-1">
              <Label htmlFor="reason-date">Date</Label>
              <DateInput id="reason-date" value={date} max={today} onChange={setDate} />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="reason-text">Reason</Label>
            <Textarea
              id="reason-text"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
            {touched && reason.trim() === '' && (
              <p className="text-destructive text-sm">A reason is required</p>
            )}
          </div>
        </fieldset>
        <ErrorText error={error} />
        <Buttons busy={busy} label={label} onClose={onClose} destructive={destructive} />
      </form>
    </ShellDialog>
  );
}

function BounceDialog({ cheque, onClose }: { cheque: ChequeRow; onClose: () => void }) {
  const mut = useBounceCheque();
  return (
    <ReasonDialog
      title={`Cheque ${cheque.cheque_no} bounced?`}
      description={
        cheque.status === 'cleared'
          ? 'Its payment is reversed and the dues reopen. The receipt stays, with the reversal listed under it.'
          : 'The cheque is marked bounced. It never reduced the dues.'
      }
      label="Mark bounced"
      destructive
      withDate
      onSend={(reason, date) =>
        mut.mutateAsync({ chequeId: cheque.cheque_id, bouncedOn: date, reason }).then((r) => {
          toast.success(
            r.replayed
              ? 'Already marked bounced.'
              : r.was_cleared
                ? 'Bounced — the dues are reopened.'
                : 'Marked bounced.',
          );
        })
      }
      onClose={onClose}
    />
  );
}

function CancelChequeDialog({ cheque, onClose }: { cheque: ChequeRow; onClose: () => void }) {
  const mut = useCancelCheque();
  return (
    <ReasonDialog
      title={`Cancel cheque ${cheque.cheque_no}?`}
      description="For a cheque recorded by mistake or returned to the payer. It never reduced the dues."
      label="Cancel cheque"
      destructive
      onSend={(reason) =>
        mut.mutateAsync({ chequeId: cheque.cheque_id, reason, version: cheque.version }).then((r) => {
          toast.success(r.replayed ? 'Already cancelled.' : 'Cheque cancelled.');
        })
      }
      onClose={onClose}
    />
  );
}
