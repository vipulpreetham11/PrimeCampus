import { useCallback, useId, useState } from 'react';
import { toast } from 'sonner';
import { ErrorText } from '@/components/shared/ErrorText';
import { MoneyInput } from '@/components/shared/MoneyInput';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { exceptionPayload, useRecordException, type ExceptionInput } from '../hooks';
import { useMoneyAction } from '../money-action';
import { UnconfirmedNotice } from '../parts';

/**
 * Money that can't be credited to dues (over-payment, unidentified transfer) is recorded as a payment
 * exception — never as a payment (AC-25). One operation id per recording (record_payment_exception).
 */
export function ExceptionDialog({
  open,
  onOpenChange,
  studentId,
  studentName,
  initialAmount,
  initialReference,
  collectionId,
  kind: fixedKind,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  studentId: string | null;
  studentName?: string | null;
  initialAmount: number | null;
  initialReference?: string | null;
  collectionId?: string | null;
  kind?: ExceptionInput['kind'];
}) {
  const record = useRecordException();
  const send = useCallback(
    (operationId: string, payload: ReturnType<typeof exceptionPayload>) =>
      record.mutateAsync({ operationId, payload }),
    [record],
  );
  const action = useMoneyAction(send);
  const [kind, setKind] = useState<ExceptionInput['kind']>(
    fixedKind ?? (studentId ? 'overpayment' : 'unidentified'),
  );
  const [amount, setAmount] = useState<number | null>(initialAmount);
  const [reference, setReference] = useState(initialReference ?? '');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const ids = { amount: useId(), ref: useId(), note: useId(), kind: useId() };
  const frozen = action.state.kind === 'unconfirmed' || action.state.kind === 'saving';
  const noteError =
    touched && note.trim() === '' ? 'Add a note: where the money came from and what should happen' : null;
  const amountError = touched && (amount === null || amount <= 0) ? 'Enter an amount greater than ₹0' : null;

  const submit = async () => {
    setTouched(true);
    if (amount === null || amount <= 0 || note.trim() === '') return;
    const result = await action.run(
      exceptionPayload({
        kind,
        amount,
        note: note.trim(),
        studentId,
        collectionId: collectionId ?? null,
        reference: reference.trim() || null,
      }),
    );
    if (result) {
      toast.success(result.replayed ? 'This exception was already recorded.' : 'Payment exception recorded.');
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !frozen && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a payment exception</DialogTitle>
          <DialogDescription>
            The money is recorded for follow-up (refund or later use). It does <strong>not</strong> reduce any
            dues.
            {studentName ? ` Student: ${studentName}.` : ''}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={frozen} className="space-y-4">
            {!fixedKind && (
              <div className="space-y-1">
                <Label htmlFor={ids.kind}>Type</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as ExceptionInput['kind'])}>
                  <SelectTrigger id={ids.kind} className="w-full" aria-label="Type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {studentId && <SelectItem value="overpayment">Over-payment</SelectItem>}
                    <SelectItem value="unidentified">Unidentified money</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor={ids.amount}>Amount</Label>
              <MoneyInput
                id={ids.amount}
                value={amount}
                allowZero={false}
                onChange={(p) => setAmount(p)}
                invalid={!!amountError}
              />
              {amountError && <p className="text-destructive text-sm">{amountError}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor={ids.ref}>Reference (optional)</Label>
              <Input
                id={ids.ref}
                value={reference}
                maxLength={120}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={ids.note}>Note</Label>
              <Textarea
                id={ids.note}
                value={note}
                maxLength={1000}
                onChange={(e) => setNote(e.target.value)}
                aria-invalid={!!noteError || undefined}
              />
              {noteError && <p className="text-destructive text-sm">{noteError}</p>}
            </div>
          </fieldset>
          {action.state.kind === 'failed' && <ErrorText error={action.state.error} />}
          {action.state.kind === 'unconfirmed' ? (
            <UnconfirmedNotice
              what="exception"
              error={action.state.error}
              busy={false}
              onRetry={() => void action.retry().then((r) => r && onOpenChange(false))}
              onDiscard={action.discard}
            />
          ) : (
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={frozen}>
                Cancel
              </Button>
              <Button type="submit" disabled={frozen}>
                {action.state.kind === 'saving' ? 'Saving…' : 'Record exception'}
              </Button>
            </div>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
