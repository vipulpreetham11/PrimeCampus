import { useCallback, useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { DateInput } from '@/components/shared/DateInput';
import { ErrorText } from '@/components/shared/ErrorText';
import { MoneyInput } from '@/components/shared/MoneyInput';
import { MoneyText } from '@/components/shared/MoneyText';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ConcessionGranted, StatementCollection, StatementInvoice } from '@/contracts/fees';
import { toAppError, type AppError } from '@/lib/errors';
import { formatBasisPoints, formatPaise } from '@/lib/money';
import {
  adjustmentArgs,
  grantArgs,
  reverseArgs,
  useAddAdjustment,
  useCancelInvoice,
  useFeeSetup,
  useGrantConcession,
  useIssueOpeningBalance,
  useReverseCollection,
  type AdjustmentKind,
  type GrantInput,
} from '../hooks';
import { useMoneyAction } from '../money-action';
import { UnconfirmedNotice } from '../parts';

// Statement actions (fees.manage). Money actions with an operation id use useMoneyAction (same id
// after an uncertain failure); actions the server makes safe to repeat by state send none.

function DialogShell({
  open,
  onOpenChange,
  title,
  description,
  locked,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  locked?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !locked && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function ReasonField({
  value,
  onChange,
  error,
  label = 'Reason',
}: {
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  label?: string;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        maxLength={500}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error || undefined}
      />
      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}

function Footer({
  onCancel,
  busy,
  label,
  disabled,
  destructive,
}: {
  onCancel: () => void;
  busy: boolean;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={busy || disabled}>
        {busy ? 'Saving…' : label}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ adjustment
export function AdjustmentDialog({ invoice, onClose }: { invoice: StatementInvoice; onClose: () => void }) {
  const mut = useAddAdjustment();
  const send = useCallback(
    (operationId: string, p: Omit<Parameters<typeof adjustmentArgs>[1], never>) =>
      mut.mutateAsync(adjustmentArgs(operationId, p)),
    [mut],
  );
  const action = useMoneyAction(send);
  const [kind, setKind] = useState<AdjustmentKind>('discount');
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const kindId = useId();
  const amountId = useId();
  const locked = action.state.kind === 'saving' || action.state.kind === 'unconfirmed';
  const over = kind === 'discount' && amount !== null && amount > invoice.balance_paise;
  const done = (r: { replayed?: boolean } | null) => {
    if (!r) return;
    toast.success(r.replayed ? 'This adjustment was already saved.' : 'Adjustment saved.');
    onClose();
  };
  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Adjust ${invoice.invoice_no}`}
      description={
        <>
          Balance now <MoneyText paise={invoice.balance_paise} />. A discount lowers it; an extra charge
          raises it.
        </>
      }
      locked={locked}
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (amount === null || amount <= 0 || reason.trim() === '' || over) return;
          void action.run({ invoiceId: invoice.invoice_id, kind, amount, reason: reason.trim() }).then(done);
        }}
      >
        <fieldset disabled={locked} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor={kindId}>Type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as AdjustmentKind)}>
              <SelectTrigger id={kindId} className="w-full" aria-label="Type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="discount">Discount (lowers the amount due)</SelectItem>
                <SelectItem value="additional_charge">Extra charge (raises the amount due)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={amountId}>Amount</Label>
            <MoneyInput id={amountId} value={amount} allowZero={false} onChange={(p) => setAmount(p)} />
            {touched && (amount === null || amount <= 0) && (
              <p className="text-destructive text-sm">Enter an amount greater than ₹0</p>
            )}
            {over && (
              <p className="text-destructive text-sm">
                A discount can be at most the balance ({formatPaise(invoice.balance_paise)})
              </p>
            )}
          </div>
          <ReasonField
            value={reason}
            onChange={setReason}
            error={touched && reason.trim() === '' ? 'A reason is required' : null}
          />
        </fieldset>
        {action.state.kind === 'failed' && <ErrorText error={action.state.error} />}
        {action.state.kind === 'unconfirmed' ? (
          <UnconfirmedNotice
            what="adjustment"
            error={action.state.error}
            busy={false}
            onRetry={() => void action.retry().then(done)}
            onDiscard={action.discard}
          />
        ) : (
          <Footer onCancel={onClose} busy={action.state.kind === 'saving'} label="Save adjustment" />
        )}
      </form>
    </DialogShell>
  );
}

// ------------------------------------------------------------------ waive late fee / cancel invoice
/** One reason → one call. `send` gets the reason (and may close over an operation id). */
export function ReasonActionDialog({
  title,
  description,
  confirmLabel,
  destructive,
  onSend,
  onClose,
  successMessage,
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onSend: (reason: string) => Promise<{ note?: string | null; replayed?: boolean }>;
  onClose: () => void;
  successMessage: (r: { note?: string | null; replayed?: boolean }) => string;
}) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={description}
      locked={busy}
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (reason.trim() === '' || busy) return;
          setBusy(true);
          setError(null);
          onSend(reason.trim())
            .then((r) => {
              toast.success(successMessage(r));
              onClose();
            })
            .catch((err: unknown) => setError(toAppError(err)))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={busy}>
          <ReasonField
            value={reason}
            onChange={setReason}
            error={touched && reason.trim() === '' ? 'A reason is required' : null}
          />
        </fieldset>
        <ErrorText error={error} />
        <Footer onCancel={onClose} busy={busy} label={confirmLabel} destructive={destructive} />
      </form>
    </DialogShell>
  );
}

/** cancel_invoice takes an operation id (logged by the server); a repeat of a cancelled invoice is a replay. */
export function CancelInvoiceDialog({
  invoice,
  onClose,
}: {
  invoice: StatementInvoice;
  onClose: () => void;
}) {
  const mut = useCancelInvoice();
  const [operationId] = useState(() => crypto.randomUUID());
  return (
    <ReasonActionDialog
      title={`Cancel ${invoice.invoice_no}?`}
      description="Only an invoice with nothing paid and no pending cheque can be cancelled; the server says why otherwise. A cancelled invoice stays on the statement."
      confirmLabel="Cancel invoice"
      destructive
      onSend={(reason) => mut.mutateAsync({ operationId, invoiceId: invoice.invoice_id, reason })}
      onClose={onClose}
      successMessage={(r) =>
        r.replayed
          ? 'This invoice was already cancelled.'
          : `Invoice cancelled.${r.note ? ` ${r.note}.` : ''}`
      }
    />
  );
}

// ------------------------------------------------------------------ reverse a collection
export function ReverseDialog({
  collection,
  onClose,
}: {
  collection: StatementCollection;
  onClose: () => void;
}) {
  const mut = useReverseCollection();
  const send = useCallback(
    (operationId: string, p: { collectionId: string; reason: string; amount: number | null }) =>
      mut.mutateAsync(reverseArgs(operationId, p)),
    [mut],
  );
  const action = useMoneyAction(send);
  const reversible = collection.amount_paise - collection.reversed_paise;
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const amountId = useId();
  const locked = action.state.kind === 'saving' || action.state.kind === 'unconfirmed';
  const tooMuch = amount !== null && amount > reversible;
  const done = (r: { replayed?: boolean; still_reversible_paise?: number } | null) => {
    if (!r) return;
    toast.success(
      r.replayed
        ? 'This reversal was already saved.'
        : `Reversed. Still reversible: ${formatPaise(r.still_reversible_paise ?? 0)}.`,
    );
    onClose();
  };
  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Reverse ${collection.receipt_no}`}
      description={
        <>
          Still reversible: <MoneyText paise={reversible} />. The receipt stays printable; the reversal is
          listed under it and the dues reopen (newest invoice first).
        </>
      }
      locked={locked}
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (reason.trim() === '' || tooMuch || (amount !== null && amount <= 0)) return;
          void action
            .run({ collectionId: collection.collection_id, reason: reason.trim(), amount })
            .then(done);
        }}
      >
        <fieldset disabled={locked} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor={amountId}>
              Amount to reverse (leave empty for all {formatPaise(reversible)})
            </Label>
            <MoneyInput id={amountId} value={amount} allowZero={false} onChange={(p) => setAmount(p)} />
            {tooMuch && <p className="text-destructive text-sm">At most {formatPaise(reversible)}</p>}
          </div>
          <ReasonField
            value={reason}
            onChange={setReason}
            error={touched && reason.trim() === '' ? 'A reason is required' : null}
          />
        </fieldset>
        {action.state.kind === 'failed' && <ErrorText error={action.state.error} />}
        {action.state.kind === 'unconfirmed' ? (
          <UnconfirmedNotice
            what="reversal"
            error={action.state.error}
            busy={false}
            onRetry={() => void action.retry().then(done)}
            onDiscard={action.discard}
          />
        ) : (
          <Footer onCancel={onClose} busy={action.state.kind === 'saving'} label="Reverse" destructive />
        )}
      </form>
    </DialogShell>
  );
}

// ------------------------------------------------------------------ concessions
export function GrantConcessionDialog({
  studentId,
  studentName,
  yearId,
  onClose,
}: {
  studentId: string;
  studentName: string | null;
  yearId: string;
  onClose: () => void;
}) {
  const setup = useFeeSetup(yearId);
  const mut = useGrantConcession();
  const send = useCallback(
    (operationId: string, v: GrantInput) => mut.mutateAsync(grantArgs(operationId, v)),
    [mut],
  );
  const action = useMoneyAction(send);
  const [presetId, setPresetId] = useState('');
  const [termId, setTermId] = useState('__year');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [granted, setGranted] = useState<ConcessionGranted | null>(null);
  const ids = { preset: useId(), term: useId() };
  const locked = action.state.kind === 'saving' || action.state.kind === 'unconfirmed';
  const presets = (setup.data?.concession_presets ?? []).filter((p) => p.status === 'active');
  const terms = (setup.data?.terms ?? []).filter((t) => t.status === 'active');
  const heads = new Map((setup.data?.fee_heads ?? []).map((h) => [h.id, h.name]));
  const done = (r: ConcessionGranted | null) => {
    if (!r) return;
    if (r.issued_invoices_not_changed.length === 0) {
      toast.success(r.replayed ? 'This concession was already granted.' : 'Concession granted.');
      onClose();
    } else setGranted(r);
  };

  if (granted) {
    return (
      <DialogShell open onOpenChange={(o) => !o && onClose()} title="Concession granted">
        <div className="space-y-3 text-sm" role="status" data-testid="invoices-not-changed">
          <p>
            Already-issued invoices aren&apos;t changed:{' '}
            {granted.issued_invoices_not_changed.map((i, n) => (
              <span key={i.invoice_id}>
                {n > 0 && ', '}
                <Link
                  className="underline"
                  to={`/fees/students/${studentId}#invoice-${i.invoice_id}`}
                  onClick={onClose}
                >
                  {i.invoice_no}
                </Link>
                {i.term ? ` (${i.term})` : ''}
              </span>
            ))}{' '}
            — add an adjustment if needed.
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      </DialogShell>
    );
  }

  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && onClose()}
      title="Grant a concession"
      description={`${studentName ?? 'This student'}: applies to invoices issued from now on.`}
      locked={locked}
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!presetId || reason.trim() === '') return;
          void action
            .run({
              studentId,
              yearId,
              presetId,
              reason: reason.trim(),
              termId: termId === '__year' ? null : termId,
            })
            .then(done);
        }}
      >
        <fieldset disabled={locked} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor={ids.preset}>Concession</Label>
            <Select value={presetId} onValueChange={setPresetId}>
              <SelectTrigger id={ids.preset} className="w-full" aria-label="Concession">
                <SelectValue
                  placeholder={presets.length ? 'Choose' : 'No active concessions — add one in Fee setup'}
                />
              </SelectTrigger>
              <SelectContent>
                {presets.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} —{' '}
                    {p.kind === 'percent'
                      ? formatBasisPoints(p.percent_bp ?? 0)
                      : formatPaise(p.fixed_paise ?? 0)}{' '}
                    of {p.fee_head_ids.map((h) => heads.get(h) ?? 'a fee').join(', ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {touched && !presetId && <p className="text-destructive text-sm">Choose a concession</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor={ids.term}>For</Label>
            <Select value={termId} onValueChange={setTermId}>
              <SelectTrigger id={ids.term} className="w-full" aria-label="For">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__year">The whole year</SelectItem>
                {terms.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} only
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ReasonField
            value={reason}
            onChange={setReason}
            error={touched && reason.trim() === '' ? 'A reason is required' : null}
          />
        </fieldset>
        {action.state.kind === 'failed' && <ErrorText error={action.state.error} />}
        {action.state.kind === 'unconfirmed' ? (
          <UnconfirmedNotice
            what="concession"
            error={action.state.error}
            busy={false}
            onRetry={() => void action.retry().then(done)}
            onDiscard={action.discard}
          />
        ) : (
          <Footer onCancel={onClose} busy={action.state.kind === 'saving'} label="Grant" />
        )}
      </form>
    </DialogShell>
  );
}

// ------------------------------------------------------------------ opening balance
/**
 * issue_opening_balance has no operation id: the reference (old ledger page/number) is the key.
 * Same student + fee head + reference + amount again → the same invoice (replayed); a different
 * amount → DUPLICATE, shown with the existing invoice number.
 */
export function OpeningBalanceDialog({
  studentId,
  yearId,
  onClose,
}: {
  studentId: string;
  yearId: string;
  onClose: () => void;
}) {
  const setup = useFeeSetup(yearId);
  const mut = useIssueOpeningBalance();
  const [headId, setHeadId] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [origin, setOrigin] = useState('');
  const [reference, setReference] = useState('');
  const [dueDate, setDueDate] = useState<string>('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const ids = { head: useId(), amount: useId(), origin: useId(), ref: useId(), due: useId() };
  const heads = (setup.data?.fee_heads ?? []).filter((h) => h.status === 'active' && h.kind !== 'late_fee');
  const busy = mut.isPending;
  const dupInvoice =
    error?.code === 'DUPLICATE' && typeof error.details === 'object' && error.details !== null
      ? ((error.details as { invoice_no?: unknown }).invoice_no as string | undefined)
      : undefined;
  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add an opening balance"
      description="Money owed from before PrimeCampus (for example the old ledger). It becomes an invoice on this statement."
      locked={busy}
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!headId || amount === null || amount <= 0 || origin.trim() === '' || reference.trim() === '')
            return;
          setError(null);
          mut
            .mutateAsync({
              studentId,
              yearId,
              headId,
              amount,
              origin: origin.trim(),
              reference: reference.trim(),
              dueDate: dueDate || null,
            })
            .then((r) => {
              toast.success(
                r.replayed
                  ? `Already recorded as ${r.invoice_no}.`
                  : `Opening balance added: ${r.invoice_no}.`,
              );
              onClose();
            })
            .catch((err: unknown) => setError(toAppError(err)));
        }}
      >
        <fieldset disabled={busy} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor={ids.head}>Fee head</Label>
            <Select value={headId} onValueChange={setHeadId}>
              <SelectTrigger id={ids.head} className="w-full" aria-label="Fee head">
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {heads.map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    {h.name} ({h.code})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {touched && !headId && <p className="text-destructive text-sm">Choose a fee head</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor={ids.amount}>Amount due</Label>
            <MoneyInput id={ids.amount} value={amount} allowZero={false} onChange={(p) => setAmount(p)} />
            {touched && (amount === null || amount <= 0) && (
              <p className="text-destructive text-sm">Enter an amount greater than ₹0</p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor={ids.origin}>What it is for</Label>
            <Input
              id={ids.origin}
              value={origin}
              maxLength={120}
              placeholder="Balance from 2025-26"
              onChange={(e) => setOrigin(e.target.value)}
            />
            {touched && origin.trim() === '' && (
              <p className="text-destructive text-sm">Say what the balance is for</p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor={ids.ref}>Old reference (ledger page / number)</Label>
            <Input
              id={ids.ref}
              value={reference}
              maxLength={60}
              placeholder="LEDGER-2025-118"
              onChange={(e) => setReference(e.target.value)}
            />
            {touched && reference.trim() === '' && (
              <p className="text-destructive text-sm">A reference is required</p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor={ids.due}>Due date (optional — defaults to the year start)</Label>
            <DateInput id={ids.due} value={dueDate} onChange={setDueDate} />
          </div>
        </fieldset>
        {error && (
          <div className="space-y-1">
            <ErrorText error={error} />
            {dupInvoice && <p className="text-sm">Existing invoice: {dupInvoice}</p>}
          </div>
        )}
        <Footer onCancel={onClose} busy={busy} label="Add opening balance" />
      </form>
    </DialogShell>
  );
}
