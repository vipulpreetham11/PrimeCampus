import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { MoneyText } from '@/components/shared/MoneyText';
import { DateField, MoneyField, TextField } from '@/components/shared/form-fields';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form } from '@/components/ui/form';
import type { StaffConfidential } from '@/contracts/staff';
import { formatDate, schoolToday } from '@/lib/dates';
import { handleSaveError } from '@/lib/save-feedback';
import { useCan } from '@/lib/scope';
import { useSaveStaffFinance, useStaffConfidential } from './hooks';

// Confidential salary & bank details (brief §2.3). The parent renders this card only with
// staff_finance.read; edit forms additionally need staff_finance.manage. Its data is fetched
// under its own query key and dropped from memory when the card unmounts (gcTime 0).

const salarySchema = z.object({
  monthly_salary_paise: z
    .number()
    .nullable()
    .refine((v) => Boolean(v !== null), 'Enter the monthly salary')
    .refine((v) => v === null || (v >= 0 && v <= 100000000000), 'Amount is too large'),
  effective_from: z.string().min(1, 'Choose the date it starts'),
  reason: z.string().trim().max(500),
});
type SalaryValues = z.infer<typeof salarySchema>;

const bankSchema = z.object({
  account_holder_name: z.string().trim().min(1, 'Enter the account holder name').max(200),
  account_number: z
    .string()
    .trim()
    .regex(/^[0-9]{6,20}$/, '6–20 digits'),
  ifsc: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, 'IFSC looks like SBIN0001234'),
  bank_name: z.string().trim().max(120),
});
type BankValues = z.infer<typeof bankSchema>;

function mask(n: string): string {
  return n.length <= 4 ? n : `${'•'.repeat(n.length - 4)}${n.slice(-4)}`;
}

function SalaryForm({ staffId }: { staffId: string }) {
  const save = useSaveStaffFinance();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<SalaryValues>({
    resolver: zodResolver(salarySchema),
    defaultValues: { monthly_salary_paise: null, effective_from: schoolToday(), reason: '' },
  });
  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={form.handleSubmit(async (v) => {
          setError(null);
          try {
            await save.mutateAsync({
              staffId,
              salary: {
                monthly_salary_paise: v.monthly_salary_paise!,
                effective_from: v.effective_from,
                reason: v.reason || null,
              },
            });
            toast.success('Salary rate saved.');
            form.reset({ monthly_salary_paise: null, effective_from: schoolToday(), reason: '' });
          } catch (e) {
            setError(handleSaveError(e));
          }
        })}
      >
        <MoneyField control={form.control} name="monthly_salary_paise" label="New monthly salary" />
        <DateField control={form.control} name="effective_from" label="Effective from" />
        <TextField control={form.control} name="reason" label="Reason (optional)" className="sm:col-span-2" />
        <div className="space-y-2 sm:col-span-2">
          <ErrorText error={error} />
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Add salary rate'}
          </Button>
        </div>
      </form>
    </Form>
  );
}

function BankForm({ staffId, current }: { staffId: string; current: StaffConfidential['bank'] }) {
  const save = useSaveStaffFinance();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<BankValues>({
    resolver: zodResolver(bankSchema),
    defaultValues: {
      account_holder_name: current?.account_holder_name ?? '',
      account_number: '',
      ifsc: current?.ifsc ?? '',
      bank_name: current?.bank_name ?? '',
    },
  });
  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={form.handleSubmit(async (v) => {
          setError(null);
          try {
            await save.mutateAsync({
              staffId,
              bank: { ...v, ifsc: v.ifsc.toUpperCase(), bank_name: v.bank_name || null },
            });
            toast.success('Bank details saved.');
            form.resetField('account_number', { defaultValue: '' });
          } catch (e) {
            setError(handleSaveError(e));
          }
        })}
      >
        <TextField control={form.control} name="account_holder_name" label="Account holder" />
        <TextField
          control={form.control}
          name="account_number"
          label="Account number"
          inputMode="numeric"
          description={current ? 'Re-enter the full number to change it.' : undefined}
        />
        <TextField control={form.control} name="ifsc" label="IFSC" />
        <TextField control={form.control} name="bank_name" label="Bank name (optional)" />
        <div className="space-y-2 sm:col-span-2">
          <ErrorText error={error} />
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save bank details'}
          </Button>
        </div>
      </form>
    </Form>
  );
}

export function StaffFinanceCard({ staffId }: { staffId: string }) {
  const canRead = useCan('staff_finance.read');
  const canManage = useCan('staff_finance.manage');
  const query = useStaffConfidential(staffId, canRead);
  const [showNumber, setShowNumber] = useState(false);
  if (!canRead) return null;

  return (
    <Card data-testid="staff-finance-card">
      <CardHeader>
        <CardTitle className="text-base">Salary &amp; bank (confidential)</CardTitle>
        <CardDescription>Visible only to roles allowed to see staff finance.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <DataState query={query}>
          {(fin) => (
            <>
              <section>
                <h3 className="mb-1 font-medium">Salary history</h3>
                {fin.salary_rates.length === 0 ? (
                  <p className="text-muted-foreground">
                    No salary rate recorded (the group default applies, if set).
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {fin.salary_rates.map((r) => (
                      <li
                        key={r.effective_from}
                        className="bg-muted/50 flex flex-wrap justify-between gap-2 rounded px-2 py-1"
                      >
                        <span>
                          <MoneyText paise={r.monthly_salary_paise} /> / month
                        </span>
                        <span className="text-muted-foreground">
                          from {formatDate(r.effective_from)}
                          {r.reason ? ` — ${r.reason}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <h3 className="mb-1 font-medium">Bank account</h3>
                {fin.bank ? (
                  <dl className="grid grid-cols-[8rem_1fr] gap-1">
                    <dt className="text-muted-foreground">Holder</dt>
                    <dd>{fin.bank.account_holder_name}</dd>
                    <dt className="text-muted-foreground">Account</dt>
                    <dd className="flex items-center gap-2 font-mono">
                      {showNumber ? fin.bank.account_number : mask(fin.bank.account_number)}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setShowNumber((s) => !s)}
                      >
                        {showNumber ? 'Hide' : 'Show'}
                      </Button>
                    </dd>
                    <dt className="text-muted-foreground">IFSC</dt>
                    <dd className="font-mono">{fin.bank.ifsc}</dd>
                    <dt className="text-muted-foreground">Bank</dt>
                    <dd>{fin.bank.bank_name ?? '—'}</dd>
                  </dl>
                ) : (
                  <p className="text-muted-foreground">No bank details recorded.</p>
                )}
              </section>
              {canManage && (
                <>
                  <section className="border-t pt-4">
                    <h3 className="mb-2 font-medium">Add a salary rate</h3>
                    <SalaryForm staffId={staffId} />
                  </section>
                  <section className="border-t pt-4">
                    <h3 className="mb-2 font-medium">
                      {fin.bank ? 'Change bank details' : 'Add bank details'}
                    </h3>
                    <BankForm staffId={staffId} current={fin.bank} />
                  </section>
                </>
              )}
            </>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}
