import { useCallback, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { ErrorText } from '@/components/shared/ErrorText';
import { MoneyInput } from '@/components/shared/MoneyInput';
import { MoneyText } from '@/components/shared/MoneyText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { PaymentMethod, ReceivingAccount, Statement } from '@/contracts/fees';
import { formatDate, schoolToday } from '@/lib/dates';
import { isAppError } from '@/lib/errors';
import { formatPaise } from '@/lib/money';
import {
  chequePayload,
  collectionPayload,
  useFeeSetup,
  usePostCollection,
  useRecordCheque,
  useStatement,
  type ChequePayload,
  type CollectionPayload,
} from '../hooks';
import { ACCOUNT_KINDS_FOR, ACCOUNT_KIND_LABELS, METHOD_LABELS } from '../labels';
import { useMoneyAction } from '../money-action';
import { StudentPicker, UnconfirmedNotice } from '../parts';
import { StudentHeading } from '../statement/StatementView';
import {
  allocationList,
  checkAllocation,
  oldestFirst,
  openInvoices,
  totalCap,
  type Allocations,
} from './allocation';
import { ExceptionDialog } from './ExceptionDialog';

// Collect payment (brief §4): the accountant's main screen. Find student → open invoices → method,
// amount, allocation (oldest due first, editable; must add up exactly) → post_collection /
// record_cheque with ONE operation id per payment → receipt.

export function CollectPage() {
  const [params, setParams] = useSearchParams();
  const studentId = params.get('student');
  const statement = useStatement(studentId);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Collect payment"
        description="Cash, UPI, bank transfer or cheque, for one student at a time."
      />
      <Card>
        <CardContent className="pt-6">
          <StudentPicker
            autoFocus={!studentId}
            label={studentId ? 'Another student' : 'Find student'}
            onPick={(s) => setParams({ student: s.student_id })}
          />
        </CardContent>
      </Card>
      {studentId && (
        <DataState query={statement}>
          {(st) => <CollectForm key={studentId} studentId={studentId} statement={st} />}
        </DataState>
      )}
    </div>
  );
}

const NO_DESK = '__none';

function CollectForm({ studentId, statement }: { studentId: string; statement: Statement }) {
  const navigate = useNavigate();
  const setup = useFeeSetup(null);
  const postMut = usePostCollection();
  const chequeMut = useRecordCheque();
  const sendPost = useCallback(
    (operationId: string, payload: CollectionPayload) => postMut.mutateAsync({ operationId, payload }),
    [postMut],
  );
  const sendCheque = useCallback(
    (operationId: string, payload: ChequePayload) => chequeMut.mutateAsync({ operationId, payload }),
    [chequeMut],
  );
  // CONFLICT from post_collection = "already being saved" (the same id is in flight): keep the id
  const post = useMoneyAction(sendPost, { keep: ['CONFLICT'] });
  const cheque = useMoneyAction(sendCheque);

  const today = schoolToday();
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState<number | null>(null);
  const [amountKey, setAmountKey] = useState(0);
  const [receivedOn, setReceivedOn] = useState<string>(today);
  const [accountId, setAccountId] = useState<string>(NO_DESK);
  const [reference, setReference] = useState('');
  const [payer, setPayer] = useState('');
  const [notes, setNotes] = useState('');
  const [chequeNo, setChequeNo] = useState('');
  const [bankName, setBankName] = useState('');
  const [chequeDate, setChequeDate] = useState<string>(today);
  const [manual, setManual] = useState<Allocations | null>(null);
  // bumps whenever the oldest-first default is recomputed, so the row inputs show the new values
  const [allocGen, setAllocGen] = useState(0);
  const [invalidRows, setInvalidRows] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState(false);
  const [exceptionOpen, setExceptionOpen] = useState(false);
  const [chequeDone, setChequeDone] = useState<{ replayed: boolean } | null>(null);
  const ids = {
    method: useId(),
    amount: useId(),
    date: useId(),
    account: useId(),
    ref: useId(),
    payer: useId(),
    notes: useId(),
    chequeNo: useId(),
    bank: useId(),
    chequeDate: useId(),
  };

  const isCheque = method === 'cheque';
  const invoices = useMemo(() => openInvoices(statement, isCheque), [statement, isCheque]);
  const alloc = manual ?? oldestFirst(invoices, amount ?? 0);
  const check = checkAllocation(amount, invoices, alloc, invalidRows);
  const accounts: ReceivingAccount[] = (setup.data?.receiving_accounts ?? []).filter(
    (a) => a.status === 'active' && ACCOUNT_KINDS_FOR[method].includes(a.kind),
  );
  const action = isCheque ? cheque : post;
  const frozen = action.state.kind === 'unconfirmed' || action.state.kind === 'saving';

  const needsAccount = method !== 'cash';
  const needsRef = method === 'upi' || method === 'bank_transfer';
  const accountOk = !needsAccount || (accountId !== NO_DESK && accounts.some((a) => a.id === accountId));
  const refOk = !needsRef || /[A-Za-z0-9].*[A-Za-z0-9].*[A-Za-z0-9]/.test(reference);
  const chequeOk =
    !isCheque || (/^[0-9]{6,10}$/.test(chequeNo) && bankName.trim() !== '' && chequeDate !== '');
  const dateOk = receivedOn !== '' && receivedOn <= today;
  const canSave = check.ok && accountOk && refOk && chequeOk && dateOk && !frozen;

  const changeMethod = (m: PaymentMethod) => {
    setMethod(m);
    setAccountId(NO_DESK);
    setManual(null);
    setAllocGen((g) => g + 1);
    setInvalidRows(new Set());
    post.reset();
    cheque.reset();
  };

  const submit = async () => {
    setTouched(true);
    if (!canSave || amount === null) return;
    const allocations = allocationList(invoices, alloc);
    if (isCheque) {
      const r = await cheque.run(
        chequePayload({
          studentId,
          chequeNo,
          bankName: bankName.trim(),
          chequeDate,
          amount,
          accountId,
          receivedOn,
          allocations,
        }),
      );
      if (r) setChequeDone({ replayed: r.replayed === true });
      return;
    }
    const r = await post.run(
      collectionPayload({
        studentId,
        method: method as Exclude<PaymentMethod, 'cheque'>,
        amount,
        receivedOn,
        accountId: accountId === NO_DESK ? null : accountId,
        reference: needsRef ? reference.trim() : null,
        payer: payer.trim() || null,
        notes: notes.trim() || null,
        allocations,
      }),
    );
    if (r)
      navigate(`/fees/receipts/${r.receipt_id}`, { state: { posted: true, replayed: r.replayed === true } });
  };

  const retry = async () => {
    const r = await action.retry();
    if (!r) return;
    if ('receipt_id' in r) {
      navigate(`/fees/receipts/${r.receipt_id}`, { state: { posted: true, replayed: r.replayed === true } });
    } else setChequeDone({ replayed: r.replayed === true });
  };

  if (chequeDone) {
    return (
      <Card>
        <CardContent className="space-y-3 pt-6" role="status" data-testid="cheque-recorded">
          <p className="font-medium">
            {chequeDone.replayed ? 'This cheque was already recorded.' : 'Cheque recorded — pending.'}
          </p>
          <p className="text-sm">
            A pending cheque does <strong>not</strong> reduce the dues. It counts as paid only when it is
            cleared in the Cheques register; the receipt is made then.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/fees/cheques">Cheques register</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={`/fees/students/${studentId}`}>Student statement</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const failure = action.state.kind === 'failed' ? action.state.error : null;
  const duplicateReceipt =
    failure && failure.code === 'DUPLICATE' && typeof failure.details === 'object' && failure.details !== null
      ? ((failure.details as { receipt_no?: unknown }).receipt_no as string | undefined)
      : undefined;
  const serverRow =
    failure && isAppError(failure) && typeof failure.details === 'object' && failure.details !== null
      ? ((failure.details as { invoice_id?: unknown }).invoice_id as string | undefined)
      : undefined;

  return (
    <Card>
      <CardHeader>
        <StudentHeading statement={statement} />
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>
            Total due: <MoneyText paise={statement.total_due_paise} className="font-semibold" />
          </span>
          {statement.pending_cheques.length > 0 && (
            <span>
              Pending cheques:{' '}
              <MoneyText paise={statement.pending_cheques.reduce((s, c) => s + c.amount_paise, 0)} /> (not
              counted as paid)
            </span>
          )}
          <Link to={`/fees/students/${studentId}`} className="underline">
            Full statement
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={frozen} className="space-y-5">
            <legend className="sr-only">Payment</legend>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor={ids.method}>Method</Label>
                <Select value={method} onValueChange={(v) => changeMethod(v as PaymentMethod)}>
                  <SelectTrigger id={ids.method} className="w-full" aria-label="Method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(METHOD_LABELS) as PaymentMethod[]).map((m) => (
                      <SelectItem key={m} value={m}>
                        {METHOD_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={ids.amount}>Amount received</Label>
                <MoneyInput
                  key={amountKey}
                  id={ids.amount}
                  value={amount}
                  allowZero={false}
                  onChange={(p) => {
                    setAmount(p);
                    setManual(null);
                    setAllocGen((g) => g + 1);
                    setInvalidRows(new Set());
                  }}
                  invalid={touched && (amount === null || check.extra > 0)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={ids.date}>{isCheque ? 'Cheque received on' : 'Received on'}</Label>
                <DateInput
                  id={ids.date}
                  value={receivedOn}
                  max={today}
                  onChange={setReceivedOn}
                  invalid={!dateOk}
                />
                {!dateOk && <p className="text-destructive text-sm">Today or an earlier date</p>}
              </div>
            </div>

            {(needsAccount || accounts.length > 0) && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={ids.account}>
                    {isCheque
                      ? 'Deposit into (bank account)'
                      : needsAccount
                        ? 'Received into'
                        : 'Cash desk (optional)'}
                  </Label>
                  <Select value={accountId} onValueChange={setAccountId}>
                    <SelectTrigger
                      id={ids.account}
                      className="w-full"
                      aria-label={isCheque ? 'Deposit into' : 'Received into'}
                    >
                      <SelectValue placeholder="Choose an account" />
                    </SelectTrigger>
                    <SelectContent>
                      {!needsAccount && <SelectItem value={NO_DESK}>No cash desk</SelectItem>}
                      {needsAccount && accountId === NO_DESK && (
                        <SelectItem value={NO_DESK} disabled>
                          Choose an account
                        </SelectItem>
                      )}
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.label} ({ACCOUNT_KIND_LABELS[a.kind]})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {needsAccount && accounts.length === 0 && setup.isSuccess && (
                    <p className="text-sm">
                      No active account for {METHOD_LABELS[method]}. Add one in Fee setup.
                    </p>
                  )}
                  {touched && !accountOk && <p className="text-destructive text-sm">Choose the account</p>}
                </div>
                {needsRef && (
                  <div className="space-y-1">
                    <Label htmlFor={ids.ref}>Transaction reference (UTR)</Label>
                    <Input
                      id={ids.ref}
                      value={reference}
                      maxLength={80}
                      autoComplete="off"
                      onChange={(e) => setReference(e.target.value)}
                    />
                    {touched && !refOk && (
                      <p className="text-destructive text-sm">At least 3 letters or digits</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {isCheque && (
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor={ids.chequeNo}>Cheque number</Label>
                  <Input
                    id={ids.chequeNo}
                    value={chequeNo}
                    inputMode="numeric"
                    maxLength={10}
                    onChange={(e) => setChequeNo(e.target.value.trim())}
                  />
                  {touched && !/^[0-9]{6,10}$/.test(chequeNo) && (
                    <p className="text-destructive text-sm">6–10 digits</p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={ids.bank}>Bank (of the cheque)</Label>
                  <Input
                    id={ids.bank}
                    value={bankName}
                    maxLength={120}
                    onChange={(e) => setBankName(e.target.value)}
                  />
                  {touched && bankName.trim() === '' && (
                    <p className="text-destructive text-sm">Enter the bank name</p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={ids.chequeDate}>Cheque date</Label>
                  <DateInput id={ids.chequeDate} value={chequeDate} onChange={setChequeDate} />
                </div>
              </div>
            )}

            {!isCheque && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={ids.payer}>Paid by (optional)</Label>
                  <Input
                    id={ids.payer}
                    value={payer}
                    maxLength={200}
                    onChange={(e) => setPayer(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={ids.notes}>Notes (optional)</Label>
                  <Input
                    id={ids.notes}
                    value={notes}
                    maxLength={1000}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>
              </div>
            )}

            <AllocationTable
              invoices={invoices}
              alloc={alloc}
              manual={manual !== null}
              allocGen={allocGen}
              rowErrors={check.rowErrors}
              serverRow={serverRow}
              onChange={(id, v, bad) => {
                setManual({ ...alloc, [id]: v });
                setInvalidRows((s) => {
                  const n = new Set(s);
                  if (bad) n.add(id);
                  else n.delete(id);
                  return n;
                });
              }}
              onReset={() => {
                setManual(null);
                setAllocGen((g) => g + 1);
                setInvalidRows(new Set());
              }}
            />
          </fieldset>

          <div aria-live="polite" className="space-y-2">
            <p className="text-sm" data-testid="allocation-status">
              Allocated <MoneyText paise={check.sum} /> of <MoneyText paise={amount} missing="—" />
              {check.message ? ` · ${check.message}` : ' · adds up exactly'}
            </p>
            {check.extra > 0 && amount !== null && (
              <div
                className="space-y-2 rounded-md border border-amber-600/50 p-3 text-sm"
                data-testid="overpayment"
              >
                <p>
                  The amount is <strong>{formatPaise(check.extra)}</strong> more than this student&apos;s dues
                  {isCheque ? ' (after other pending cheques)' : ''}. Money above the dues is never credited.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setAmount(totalCap(invoices));
                      setAmountKey((k) => k + 1);
                      setManual(null);
                      setAllocGen((g) => g + 1);
                    }}
                  >
                    Collect only the dues ({formatPaise(totalCap(invoices))})
                  </Button>
                  {!isCheque && (
                    <Button type="button" size="sm" variant="outline" onClick={() => setExceptionOpen(true)}>
                      Record the extra as a payment exception
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>

          {failure && (
            <div className="space-y-1">
              <ErrorText error={failure} />
              {duplicateReceipt && (
                <p className="text-sm" data-testid="duplicate-receipt">
                  Already posted on receipt <strong>{duplicateReceipt}</strong>. Check the Day book before
                  collecting again.
                </p>
              )}
            </div>
          )}
          {action.state.kind === 'unconfirmed' ? (
            <UnconfirmedNotice
              what={isCheque ? 'cheque' : 'payment'}
              error={action.state.error}
              busy={false}
              onRetry={() => void retry()}
              onDiscard={action.discard}
            >
              <p>
                <Link to={`/fees/students/${studentId}`} target="_blank" className="underline">
                  Open the statement in a new tab
                </Link>{' '}
                to check.
              </p>
            </UnconfirmedNotice>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={!canSave} data-testid="save-payment">
                {action.state.kind === 'saving'
                  ? 'Saving…'
                  : isCheque
                    ? 'Record cheque (pending)'
                    : 'Save payment'}
              </Button>
              {!canSave && touched && !frozen && (
                <span className="text-muted-foreground text-sm">Fix the highlighted items first.</span>
              )}
            </div>
          )}
        </form>
      </CardContent>
      {exceptionOpen && (
        <ExceptionDialog
          open
          onOpenChange={setExceptionOpen}
          studentId={studentId}
          studentName={statement.student.name}
          initialAmount={check.extra}
          initialReference={reference.trim() || null}
          kind="overpayment"
        />
      )}
    </Card>
  );
}

function AllocationTable({
  invoices,
  alloc,
  manual,
  allocGen,
  rowErrors,
  serverRow,
  onChange,
  onReset,
}: {
  invoices: ReturnType<typeof openInvoices>;
  alloc: Allocations;
  manual: boolean;
  allocGen: number;
  rowErrors: Record<string, string>;
  serverRow: string | undefined;
  onChange: (invoiceId: string, paise: number, invalid: boolean) => void;
  onReset: () => void;
}) {
  if (invoices.length === 0) {
    return (
      <p className="bg-muted rounded-md p-3 text-sm" role="status">
        Nothing is due for this student. To record money anyway, use Payment exceptions.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Allocate to invoices (oldest due first)</h3>
        {manual && (
          <Button type="button" size="sm" variant="ghost" onClick={onReset}>
            Reset to oldest first
          </Button>
        )}
      </div>
      <ul className="divide-y rounded-md border" data-testid="allocation-rows">
        {invoices.map((inv) => (
          <li key={inv.invoice_id} className="grid gap-2 p-3 sm:grid-cols-[1fr_12rem] sm:items-center">
            <div className="min-w-0 text-sm">
              <span className="font-medium">{inv.label}</span>{' '}
              <span className="text-muted-foreground break-all">{inv.invoice_no}</span>
              <span className="block">
                Due {formatDate(inv.due_date)} · balance <MoneyText paise={inv.balance_paise} />{' '}
                {inv.overdue && <Badge variant="destructive">Overdue</Badge>}
              </span>
              {inv.planned_paise > 0 && (
                <span className="text-muted-foreground block text-xs">
                  Pending cheques plan <MoneyText paise={inv.planned_paise} /> on this invoice
                </span>
              )}
            </div>
            <div>
              <Label className="sr-only" htmlFor={`alloc-${inv.invoice_id}`}>
                Amount for {inv.invoice_no}
              </Label>
              <MoneyInput
                key={`${inv.invoice_id}-${allocGen}`}
                id={`alloc-${inv.invoice_id}`}
                value={alloc[inv.invoice_id] ?? 0}
                onChange={(p, err) => onChange(inv.invoice_id, p ?? 0, err !== null)}
                invalid={!!rowErrors[inv.invoice_id] || serverRow === inv.invoice_id}
              />
              {rowErrors[inv.invoice_id] && (
                <p className="text-destructive mt-1 text-xs">{rowErrors[inv.invoice_id]}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
