import { useState, type ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { ErrorText } from '@/components/shared/ErrorText';
import {
  CheckboxField,
  DateField,
  MoneyField,
  SelectField,
  TextField,
} from '@/components/shared/form-fields';
import { MoneyText } from '@/components/shared/MoneyText';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ConcessionPreset, FeeHead, FeeSetup, FeeTerm, ReceivingAccount } from '@/contracts/fees';
import { formatDate } from '@/lib/dates';
import { isAppError, toAppError } from '@/lib/errors';
import { formatBasisPoints, formatPaise, parsePercentToBasisPoints } from '@/lib/money';
import { changedFields, handleSaveError } from '@/lib/save-feedback';
import { z } from '@/lib/zod';
import {
  useRetireLateFeeRule,
  useSaveFeeHead,
  useSaveFeeTerm,
  useSaveLateFeeRule,
  useSavePreset,
  useSaveReceivingAccount,
} from '../hooks';
import { ACCOUNT_KIND_LABELS, HEAD_KIND_LABELS } from '../labels';

// Fee setup cards (brief §1). Forms mirror the server's checks so most mistakes are caught before
// saving; the server's readable VALIDATION_ERROR / DUPLICATE is still shown when it disagrees.

function SetupCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function FormButtons({
  busy,
  onCancel,
  label = 'Save',
}: {
  busy: boolean;
  onCancel: () => void;
  label?: string;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button type="submit" disabled={busy}>
        {busy ? 'Saving…' : label}
      </Button>
    </div>
  );
}

const statusOptions = [
  { value: 'active', label: 'Active' },
  { value: 'retired', label: 'Retired (kept for history)' },
];

/** Open-a-dialog-by-id state, keyed on the row version so a CONFLICT reload gives a fresh form. */
function useEditing<T extends { id: string; version: number }>(rows: T[]) {
  const [state, setState] = useState<{ id: string | null } | null>(null);
  const editing = state?.id ? (rows.find((r) => r.id === state.id) ?? null) : null;
  return {
    open: state !== null && (state.id === null || editing !== null),
    editing,
    key: editing ? `${editing.id}-${editing.version}` : 'new',
    start: (id: string | null) => setState({ id }),
    close: () => setState(null),
  };
}

// ------------------------------------------------------------------ fee heads
const headSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(80),
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,20}$/, '1–20 letters, digits, - or _ (for example TUITION)'),
  kind: z.enum(['regular', 'late_fee', 'other']),
  is_optional: z.boolean(),
  status: z.enum(['active', 'retired']),
});
type HeadValues = z.infer<typeof headSchema>;

function HeadDialog({
  head,
  onClose,
  onReload,
}: {
  head: FeeHead | null;
  onClose: () => void;
  onReload: () => void;
}) {
  const save = useSaveFeeHead();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<HeadValues>({
    resolver: zodResolver(headSchema),
    defaultValues: head
      ? {
          name: head.name,
          code: head.code,
          kind: head.kind,
          is_optional: head.is_optional,
          status: head.status,
        }
      : { name: '', code: '', kind: 'regular', is_optional: false, status: 'active' },
  });
  const kind = useWatch({ control: form.control, name: 'kind' });
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await save.mutateAsync({
        ...v,
        is_optional: v.kind === 'late_fee' ? false : v.is_optional,
        ...(head ? { id: head.id, version: head.version } : {}),
      });
      toast.success(head ? 'Fee head updated.' : 'Fee head created.');
      onClose();
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'DUPLICATE')
        form.setError('code', { type: 'server', message: 'This code is already used' });
      else setError(handleSaveError(err, { reload: onReload, form }));
    }
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{head ? `Edit ${head.name}` : 'New fee head'}</DialogTitle>
          <DialogDescription>
            The kind can&apos;t change after the head is created. Retired heads stay in history.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            <TextField control={form.control} name="name" label="Name" placeholder="Tuition fee" />
            <TextField control={form.control} name="code" label="Code" placeholder="TUITION" />
            <SelectField
              control={form.control}
              name="kind"
              label="Kind"
              disabled={!!head}
              options={[
                { value: 'regular', label: 'Regular' },
                { value: 'late_fee', label: 'Late fee' },
                { value: 'other', label: 'Other' },
              ]}
            />
            {kind !== 'late_fee' && (
              <CheckboxField
                control={form.control}
                name="is_optional"
                label="Optional (only for students who opt in, e.g. transport)"
              />
            )}
            {head && (
              <SelectField control={form.control} name="status" label="Status" options={statusOptions} />
            )}
            <ErrorText error={error} />
            <FormButtons busy={save.isPending} onCancel={onClose} />
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function HeadsCard({
  setup,
  canManage,
  onReload,
}: {
  setup: FeeSetup;
  canManage: boolean;
  onReload: () => void;
}) {
  const ed = useEditing(setup.fee_heads);
  return (
    <SetupCard
      title="Fee heads"
      action={
        canManage && (
          <Button size="sm" onClick={() => ed.start(null)}>
            New fee head
          </Button>
        )
      }
    >
      {setup.fee_heads.length === 0 ? (
        <p className="text-muted-foreground text-sm">No fee heads yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {setup.fee_heads.map((h) => (
              <TableRow key={h.id} data-testid={`head-${h.code}`}>
                <TableCell className="font-medium">{h.name}</TableCell>
                <TableCell className="font-mono">{h.code}</TableCell>
                <TableCell>
                  {HEAD_KIND_LABELS[h.kind]}
                  {h.is_optional ? ' · optional' : ''}
                </TableCell>
                <TableCell>
                  {h.status === 'active' ? 'Active' : <Badge variant="outline">Retired</Badge>}
                </TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => ed.start(h.id)}>
                      Edit
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {ed.open && <HeadDialog key={ed.key} head={ed.editing} onClose={ed.close} onReload={onReload} />}
    </SetupCard>
  );
}

// ------------------------------------------------------------------ receiving accounts
const accountSchema = z
  .object({
    label: z.string().trim().min(1, 'Enter a name').max(80),
    kind: z.enum(['cash_desk', 'bank', 'upi']),
    bank_name: z.string().trim().max(120),
    account_last4: z
      .string()
      .trim()
      .regex(/^([0-9]{4})?$/, 'Only the last 4 digits'),
    ifsc: z
      .string()
      .trim()
      .regex(/^([A-Za-z]{4}0[A-Za-z0-9]{6})?$/, 'IFSC looks like SBIN0001234 (11 characters)'),
    upi_id: z
      .string()
      .trim()
      .regex(/^([A-Za-z0-9._-]{2,64}@[A-Za-z]{2,32})?$/, 'UPI ID looks like schoolname@okaxis'),
    status: z.enum(['active', 'retired']),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'bank' && v.bank_name === '')
      ctx.addIssue({
        code: 'custom',
        path: ['bank_name'],
        message: 'Bank name is required for a bank account',
      });
    if (v.kind === 'upi' && v.upi_id === '')
      ctx.addIssue({ code: 'custom', path: ['upi_id'], message: 'UPI ID is required for a UPI account' });
  });
type AccountValues = z.infer<typeof accountSchema>;

function accountValues(a: ReceivingAccount | null): AccountValues {
  return {
    label: a?.label ?? '',
    kind: a?.kind ?? 'bank',
    bank_name: a?.bank_name ?? '',
    account_last4: a?.account_last4 ?? '',
    ifsc: a?.ifsc ?? '',
    upi_id: a?.upi_id ?? '',
    status: a?.status ?? 'active',
  };
}

/** Edit sends only changed keys; an empty string clears a field (save_receiving_account contract). */
export function accountPayload(original: ReceivingAccount | null, v: AccountValues): Record<string, string> {
  const next = { ...v, ifsc: v.ifsc.toUpperCase() };
  if (!original) {
    const out: Record<string, string> = { label: next.label, kind: next.kind };
    for (const k of ['bank_name', 'account_last4', 'ifsc', 'upi_id'] as const)
      if (next[k] !== '') out[k] = next[k];
    return out;
  }
  const { kind: _kind, ...rest } = next;
  const changed = changedFields(accountValues(original), { ...rest, kind: original.kind });
  delete (changed as Partial<AccountValues>).kind;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(changed)) out[k] = (val as string | null) ?? '';
  return out;
}

function AccountDialog({
  account,
  onClose,
  onReload,
}: {
  account: ReceivingAccount | null;
  onClose: () => void;
  onReload: () => void;
}) {
  const save = useSaveReceivingAccount();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<AccountValues>({
    resolver: zodResolver(accountSchema),
    defaultValues: accountValues(account),
  });
  const kind = useWatch({ control: form.control, name: 'kind' });
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const p = accountPayload(account, v);
    if (account && Object.keys(p).length === 0) {
      onClose();
      return;
    }
    try {
      await save.mutateAsync({ p, ...(account ? { id: account.id, version: account.version } : {}) });
      toast.success(account ? 'Account updated.' : 'Account added.');
      onClose();
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'DUPLICATE') form.setError('label', { type: 'server', message: err.message });
      else setError(handleSaveError(err, { reload: onReload, form }));
    }
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{account ? `Edit ${account.label}` : 'New receiving account'}</DialogTitle>
          <DialogDescription>
            Where money is received: a cash desk, a bank account or a UPI ID.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            <SelectField
              control={form.control}
              name="kind"
              label="Type"
              disabled={!!account}
              options={(['cash_desk', 'bank', 'upi'] as const).map((k) => ({
                value: k,
                label: ACCOUNT_KIND_LABELS[k],
              }))}
            />
            <TextField control={form.control} name="label" label="Name" placeholder="SBI current account" />
            {kind !== 'cash_desk' && (
              <>
                <TextField
                  control={form.control}
                  name="bank_name"
                  label={kind === 'bank' ? 'Bank name' : 'Bank name (optional)'}
                />
                <TextField
                  control={form.control}
                  name="account_last4"
                  label="Account number — last 4 digits (optional)"
                  inputMode="numeric"
                />
                <TextField control={form.control} name="ifsc" label="IFSC (optional)" />
              </>
            )}
            {kind === 'upi' && (
              <TextField control={form.control} name="upi_id" label="UPI ID" placeholder="school@okaxis" />
            )}
            {account && (
              <SelectField control={form.control} name="status" label="Status" options={statusOptions} />
            )}
            <ErrorText error={error} />
            <FormButtons busy={save.isPending} onCancel={onClose} />
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function AccountsCard({
  setup,
  canManage,
  onReload,
}: {
  setup: FeeSetup;
  canManage: boolean;
  onReload: () => void;
}) {
  const ed = useEditing(setup.receiving_accounts);
  return (
    <SetupCard
      title="Receiving accounts"
      action={
        canManage && (
          <Button size="sm" onClick={() => ed.start(null)}>
            New account
          </Button>
        )
      }
    >
      {setup.receiving_accounts.length === 0 ? (
        <p className="text-muted-foreground text-sm">No accounts yet. Cash can be collected without one.</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {setup.receiving_accounts.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-2 p-3"
              data-testid={`account-${a.label}`}
            >
              <span className="font-medium">{a.label}</span>
              <span>{ACCOUNT_KIND_LABELS[a.kind]}</span>
              {a.status === 'retired' && <Badge variant="outline">Retired</Badge>}
              <span className="text-muted-foreground basis-full break-all">
                {[a.bank_name, a.account_last4 ? `••••${a.account_last4}` : null, a.ifsc, a.upi_id]
                  .filter(Boolean)
                  .join(' · ') || 'No details'}
              </span>
              {canManage && (
                <Button size="sm" variant="outline" onClick={() => ed.start(a.id)}>
                  Edit
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {ed.open && <AccountDialog key={ed.key} account={ed.editing} onClose={ed.close} onReload={onReload} />}
    </SetupCard>
  );
}

// ------------------------------------------------------------------ terms
const termSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(60),
  sort_order: z
    .string()
    .trim()
    .regex(/^[0-9]{1,2}$/, 'A number from 1 to 99')
    .refine((s) => Number(s) >= 1, 'A number from 1 to 99'),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the due date'),
});
type TermValues = z.infer<typeof termSchema>;

function TermDialog({
  term,
  yearId,
  nextOrder,
  onClose,
  onReload,
}: {
  term: FeeTerm | null;
  yearId: string;
  nextOrder: number;
  onClose: () => void;
  onReload: () => void;
}) {
  const save = useSaveFeeTerm();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<TermValues>({
    resolver: zodResolver(termSchema),
    defaultValues: term
      ? { name: term.name, sort_order: String(term.sort_order), due_date: term.due_date }
      : { name: '', sort_order: String(nextOrder), due_date: '' },
  });
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const r = await save.mutateAsync({
        yearId,
        name: v.name,
        sort_order: Number(v.sort_order),
        due_date: v.due_date,
        ...(term ? { id: term.id, version: term.version } : {}),
      });
      toast.success(`${term ? 'Term updated.' : 'Term created.'}${r.note ? ` ${r.note}.` : ''}`);
      onClose();
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'DUPLICATE') form.setError('name', { type: 'server', message: err.message });
      else setError(handleSaveError(err, { reload: onReload, form }));
    }
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{term ? `Edit ${term.name}` : 'New term'}</DialogTitle>
          <DialogDescription>
            {term && term.invoices_issued > 0
              ? `${term.invoices_issued} invoices are already issued for this term; they keep their due date and amounts.`
              : 'Invoices for a term are issued from Fees → Invoices.'}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            <TextField control={form.control} name="name" label="Name" placeholder="Term 1" />
            <TextField control={form.control} name="sort_order" label="Order" inputMode="numeric" />
            <DateField control={form.control} name="due_date" label="Due date" />
            <ErrorText error={error} />
            <FormButtons busy={save.isPending} onCancel={onClose} />
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function TermsCard({
  setup,
  yearId,
  canManage,
  onReload,
}: {
  setup: FeeSetup;
  yearId: string | null;
  canManage: boolean;
  onReload: () => void;
}) {
  const ed = useEditing(setup.terms);
  const save = useSaveFeeTerm();
  const [retiring, setRetiring] = useState<FeeTerm | null>(null);
  const [retireError, setRetireError] = useState<unknown>(null);
  const nextOrder = Math.min(99, Math.max(0, ...setup.terms.map((t) => t.sort_order)) + 1);
  return (
    <SetupCard
      title="Terms"
      action={
        canManage &&
        yearId && (
          <Button size="sm" onClick={() => ed.start(null)}>
            New term
          </Button>
        )
      }
    >
      {!yearId ? (
        <p className="text-sm">Choose an academic year.</p>
      ) : setup.terms.length === 0 ? (
        <p className="text-muted-foreground text-sm">No terms in this year yet.</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {setup.terms.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2 p-3" data-testid={`term-${t.name}`}>
              <span className="font-medium">
                {t.sort_order}. {t.name}
              </span>
              <span>Due {formatDate(t.due_date)}</span>
              <span className="text-muted-foreground">{t.invoices_issued} invoices issued</span>
              {t.status === 'retired' && <Badge variant="outline">Retired</Badge>}
              {canManage && t.status === 'active' && (
                <span className="ml-auto flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => ed.start(t.id)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setRetiring(t)}>
                    Retire
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={retireError} />
      {ed.open && yearId && (
        <TermDialog
          key={ed.key}
          term={ed.editing}
          yearId={yearId}
          nextOrder={nextOrder}
          onClose={ed.close}
          onReload={onReload}
        />
      )}
      {retiring && yearId && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setRetiring(null)}
          title={`Retire ${retiring.name}?`}
          description="No more invoices can be issued for a retired term. Invoices already issued are not changed."
          confirmLabel="Retire term"
          busy={save.isPending}
          onConfirm={() => {
            setRetireError(null);
            save
              .mutateAsync({
                id: retiring.id,
                version: retiring.version,
                yearId,
                name: retiring.name,
                sort_order: retiring.sort_order,
                due_date: retiring.due_date,
                status: 'retired',
              })
              .then(() => toast.success('Term retired.'))
              .catch((e: unknown) => setRetireError(handleSaveError(e, { reload: onReload })))
              .finally(() => setRetiring(null));
          }}
        />
      )}
    </SetupCard>
  );
}

// ------------------------------------------------------------------ concession presets
const presetSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name').max(80),
    kind: z.enum(['fixed', 'percent']),
    percent: z.string(),
    fixed_paise: z.number().int().nullable(),
    status: z.enum(['active', 'retired']),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'percent') {
      const r = parsePercentToBasisPoints(v.percent);
      if (!r.ok) ctx.addIssue({ code: 'custom', path: ['percent'], message: r.error });
    } else if (v.fixed_paise === null || v.fixed_paise <= 0) {
      ctx.addIssue({ code: 'custom', path: ['fixed_paise'], message: 'Enter an amount greater than ₹0' });
    }
  });
type PresetValues = z.infer<typeof presetSchema>;

function PresetDialog({
  preset,
  heads,
  onClose,
  onReload,
}: {
  preset: ConcessionPreset | null;
  heads: FeeHead[];
  onClose: () => void;
  onReload: () => void;
}) {
  const save = useSavePreset();
  const [error, setError] = useState<unknown>(null);
  const [headIds, setHeadIds] = useState<string[]>(preset?.fee_head_ids ?? []);
  const [headsError, setHeadsError] = useState<string | null>(null);
  const form = useForm<PresetValues>({
    resolver: zodResolver(presetSchema),
    defaultValues: preset
      ? {
          name: preset.name,
          kind: preset.kind,
          percent: preset.percent_bp !== null ? formatBasisPoints(preset.percent_bp).replace('%', '') : '',
          fixed_paise: preset.fixed_paise,
          status: preset.status,
        }
      : { name: '', kind: 'percent', percent: '', fixed_paise: null, status: 'active' },
  });
  const kind = useWatch({ control: form.control, name: 'kind' });
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    if (headIds.length === 0) {
      setHeadsError('Choose the fee heads this concession applies to');
      return;
    }
    const bp = v.kind === 'percent' ? parsePercentToBasisPoints(v.percent) : null;
    try {
      const r = await save.mutateAsync({
        name: v.name,
        kind: v.kind,
        percent_bp: bp && bp.ok ? bp.bp : null,
        fixed_paise: v.kind === 'fixed' ? v.fixed_paise : null,
        fee_head_ids: headIds,
        status: v.status,
        ...(preset ? { id: preset.id, version: preset.version } : {}),
      });
      toast.success(`${preset ? 'Concession updated.' : 'Concession created.'} ${r.note ?? ''}`);
      onClose();
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'DUPLICATE') form.setError('name', { type: 'server', message: err.message });
      else setError(handleSaveError(err, { reload: onReload, form }));
    }
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{preset ? `Edit ${preset.name}` : 'New concession'}</DialogTitle>
          <DialogDescription>
            A percent applies to each chosen fee; a fixed amount is taken once per invoice, spread over the
            chosen fees. Changes apply to invoices issued from now on.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            <TextField control={form.control} name="name" label="Name" placeholder="Sibling 10%" />
            <SelectField
              control={form.control}
              name="kind"
              label="Type"
              options={[
                { value: 'percent', label: 'Percent of the fee' },
                { value: 'fixed', label: 'Fixed amount' },
              ]}
            />
            {kind === 'percent' ? (
              <TextField
                control={form.control}
                name="percent"
                label="Percent"
                inputMode="decimal"
                placeholder="10"
              />
            ) : (
              <MoneyField control={form.control} name="fixed_paise" label="Amount" />
            )}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Applies to</legend>
              {heads.map((h) => (
                <div key={h.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`preset-head-${h.id}`}
                    checked={headIds.includes(h.id)}
                    onCheckedChange={(c) => {
                      setHeadsError(null);
                      setHeadIds((ids) => (c === true ? [...ids, h.id] : ids.filter((x) => x !== h.id)));
                    }}
                  />
                  <Label htmlFor={`preset-head-${h.id}`} className="font-normal">
                    {h.name} ({h.code})
                  </Label>
                </div>
              ))}
              {headsError && <p className="text-destructive text-sm">{headsError}</p>}
            </fieldset>
            {preset && (
              <SelectField control={form.control} name="status" label="Status" options={statusOptions} />
            )}
            <ErrorText error={error} />
            <FormButtons busy={save.isPending} onCancel={onClose} />
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function PresetsCard({
  setup,
  canManage,
  onReload,
}: {
  setup: FeeSetup;
  canManage: boolean;
  onReload: () => void;
}) {
  const ed = useEditing(setup.concession_presets);
  const heads = setup.fee_heads.filter((h) => h.kind !== 'late_fee' && h.status === 'active');
  const names = new Map(setup.fee_heads.map((h) => [h.id, h.name]));
  return (
    <SetupCard
      title="Concession presets"
      action={
        canManage && (
          <Button size="sm" onClick={() => ed.start(null)}>
            New concession
          </Button>
        )
      }
    >
      {setup.concession_presets.length === 0 ? (
        <p className="text-muted-foreground text-sm">No concessions yet.</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {setup.concession_presets.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 p-3" data-testid={`preset-${p.name}`}>
              <span className="font-medium">{p.name}</span>
              <span>
                {p.kind === 'percent'
                  ? formatBasisPoints(p.percent_bp ?? 0)
                  : formatPaise(p.fixed_paise ?? 0)}
              </span>
              <span className="text-muted-foreground">
                of {p.fee_head_ids.map((h) => names.get(h) ?? 'a fee').join(', ')}
              </span>
              {p.status === 'retired' && <Badge variant="outline">Retired</Badge>}
              {canManage && (
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => ed.start(p.id)}>
                  Edit
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {ed.open && (
        <PresetDialog key={ed.key} preset={ed.editing} heads={heads} onClose={ed.close} onReload={onReload} />
      )}
    </SetupCard>
  );
}

// ------------------------------------------------------------------ late-fee rule
const lateSchema = z.object({
  head_id: z.string().min(1, 'Choose a late-fee head'),
  amount: z
    .number()
    .int()
    .nullable()
    .refine((v) => v !== null && v >= 1 && v <= 10_000_000, 'From ₹0.01 to ₹1,00,000'),
  grace_days: z
    .string()
    .trim()
    .regex(/^[0-9]{1,3}$/, '0–120 days')
    .refine((s) => Number(s) <= 120, '0–120 days'),
});
type LateValues = z.infer<typeof lateSchema>;

export function LateFeeCard({
  setup,
  yearId,
  canManage,
}: {
  setup: FeeSetup;
  yearId: string | null;
  canManage: boolean;
}) {
  const save = useSaveLateFeeRule();
  const retire = useRetireLateFeeRule();
  const [error, setError] = useState<unknown>(null);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const rule = setup.late_fee_rule;
  const heads = setup.fee_heads.filter((h) => h.kind === 'late_fee' && h.status === 'active');
  const form = useForm<LateValues>({
    resolver: zodResolver(lateSchema),
    defaultValues: {
      head_id: rule?.fee_head_id ?? heads[0]?.id ?? '',
      amount: rule?.amount_paise ?? null,
      grace_days: String(rule?.grace_days ?? 0),
    },
  });
  const headName = (id: string) => setup.fee_heads.find((h) => h.id === id)?.name ?? 'Late fee';
  const onSubmit = form.handleSubmit(async (v) => {
    if (!yearId || v.amount === null) return;
    setError(null);
    try {
      const r = await save.mutateAsync({
        yearId,
        headId: v.head_id,
        amount: v.amount,
        graceDays: Number(v.grace_days),
      });
      toast.success(`Late-fee rule saved. ${r.note ?? ''}`);
    } catch (e) {
      setError(handleSaveError(e, { form }));
    }
  });
  return (
    <SetupCard title="Late-fee rule for this year">
      <div className="space-y-4">
        <p className="text-sm" data-testid="late-fee-rule">
          {rule ? (
            <>
              Current rule: {headName(rule.fee_head_id)} <MoneyText paise={rule.amount_paise} /> once per term
              invoice, {rule.grace_days} day{rule.grace_days === 1 ? '' : 's'} after the due date.
            </>
          ) : (
            'No late-fee rule: no late fees are added this year.'
          )}
        </p>
        {canManage && yearId && (
          <>
            {heads.length === 0 ? (
              <p className="text-sm">Create a fee head of kind “Late fee” first.</p>
            ) : (
              <Form {...form}>
                <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-3">
                  <SelectField
                    control={form.control}
                    name="head_id"
                    label="Late-fee head"
                    options={heads.map((h) => ({ value: h.id, label: `${h.name} (${h.code})` }))}
                  />
                  <MoneyField control={form.control} name="amount" label="Amount" />
                  <TextField
                    control={form.control}
                    name="grace_days"
                    label="Grace days after the due date"
                    inputMode="numeric"
                  />
                  <div className="space-y-2 sm:col-span-3">
                    <ErrorText error={error} />
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" disabled={save.isPending}>
                        {save.isPending ? 'Saving…' : rule ? 'Replace rule' : 'Save rule'}
                      </Button>
                      {rule && (
                        <Button type="button" variant="outline" onClick={() => setConfirmRetire(true)}>
                          Stop late fees (retire rule)
                        </Button>
                      )}
                    </div>
                    <p className="text-muted-foreground text-xs">
                      Late fees already added to invoices are not changed.
                    </p>
                  </div>
                </form>
              </Form>
            )}
          </>
        )}
      </div>
      {confirmRetire && yearId && (
        <ConfirmDialog
          open
          onOpenChange={setConfirmRetire}
          title="Retire the late-fee rule?"
          description="No new late fees are added this year. Late fees already added stay."
          confirmLabel="Retire rule"
          busy={retire.isPending}
          onConfirm={() =>
            retire
              .mutateAsync(yearId)
              .then(() => toast.success('Late-fee rule retired.'))
              .catch((e: unknown) => setError(isAppError(e) ? e : toAppError(e)))
              .finally(() => setConfirmRetire(false))
          }
        />
      )}
    </SetupCard>
  );
}
