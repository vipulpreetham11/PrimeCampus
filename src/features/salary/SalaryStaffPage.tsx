import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, CloudOff } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { MonthPicker } from '@/components/shared/MonthPicker';
import { MoneyText } from '@/components/shared/MoneyText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { SalaryComputation, SalaryMonthRow, SalaryOverrides } from '@/contracts/salary';
import { isUncertainFailure } from '@/lib/create-check';
import {
  formatDate,
  formatDateTime,
  formatDayShort,
  formatMonth,
  monthStart,
  schoolToday,
} from '@/lib/dates';
import { toAppError, type AppError } from '@/lib/errors';
import { serverErrorField } from '@/lib/save-feedback';
import { useCan } from '@/lib/scope';
import { cn } from '@/lib/utils';
import { useSalaryMonth, useSalaryPreview, useSaveSalary } from './hooks';
import {
  buildOverrides,
  deductionPaise,
  defaultSalaryMonth,
  EMPTY_OVERRIDES,
  formatDays,
  formFieldForServer,
  formFromOverrides,
  formulaText,
  issueText,
  monthParam,
  parseMonthParam,
  requiredOverride,
  sameOverrides,
  type OverrideForm,
  type OverrideFormField,
} from './logic';
import { ConfidentialNote, SalaryStatusChip } from './parts';
import { PaidLeaveCard, SalaryHistoryCard } from './StaffCards';

// One staff member's month (SAL-01). Managers get the live calculator (preview_salary) with
// overrides and Save (save_salary_calculation); readers (Owner) get the saved result only.
// Every number and the formula come from the server; overrides are validated before sending and
// the server's own field errors are shown under the field.

export function SalaryStaffPage() {
  const { staffId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const today = schoolToday();
  const thisMonth = monthStart(today);
  const parsed = parseMonthParam(params.get('month'));
  const month = parsed && parsed <= thisMonth ? parsed : defaultSalaryMonth(today);
  const manage = useCan('staff_finance.manage');
  const monthQuery = useSalaryMonth(month, null);
  const row = monthQuery.data?.rows.find((r) => r.staff_id === staffId) ?? null;

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" className="-ml-3">
        <Link to={`/salary?month=${monthParam(month)}`}>
          <ArrowLeft aria-hidden="true" /> All staff
        </Link>
      </Button>
      <PageHeader
        title={row ? `Salary — ${row.name}` : 'Salary'}
        description={
          row
            ? `${row.employee_no}${row.group ? ` · ${row.group}` : ''} · ${formatMonth(month)}`
            : formatMonth(month)
        }
      />
      <ConfidentialNote />
      <MonthPicker
        id="staff-salary-month"
        month={month}
        max={thisMonth}
        onChange={(m) => setParams({ month: monthParam(m) }, { replace: true })}
      />
      <DataState
        query={monthQuery}
        isEmpty={() => row === null}
        emptyTitle="Not employed in this month"
        emptyDescription="This staff member was not employed during this month, so there is no salary to calculate."
      >
        {() =>
          row && (
            <div className="space-y-4">
              <StatusLine row={row} />
              {manage ? (
                <Calculator key={`${staffId}:${month}`} staffId={staffId} month={month} row={row} />
              ) : (
                <SavedResult row={row} month={month} />
              )}
              <PaidLeaveCard staffId={staffId} month={month} canManage={manage} />
              <SalaryHistoryCard staffId={staffId} month={month} />
            </div>
          )
        }
      </DataState>
    </div>
  );
}

function StatusLine({ row }: { row: SalaryMonthRow }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <SalaryStatusChip status={row.status} versionNo={row.saved?.version_no ?? null} />
      {row.partial_month && (
        <Badge variant="outline">
          Partial month (joined {formatDate(row.joined_on)}
          {row.left_on ? `, left ${formatDate(row.left_on)}` : ''})
        </Badge>
      )}
      {row.saved && (
        <span className="text-muted-foreground">
          Version {row.saved.version_no} saved {formatDateTime(row.saved.created_at)}
          {row.saved.calculated_by ? ` by ${row.saved.calculated_by}` : ''}
        </span>
      )}
      {row.status === 'changed' && (
        <p className="w-full rounded-md border border-amber-500 p-2" role="note">
          Attendance, the calendar, paid leave or the salary rate changed after version{' '}
          {row.saved?.version_no} was saved. The saved result stays as it is until it is saved again.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ result display

interface ResultNumbers {
  monthly_salary_paise: number | null;
  working_days: number;
  attended_days: number;
  paid_leave_days: number;
  unpaid_days: number;
  payable_paise: number | null;
}

export function ResultFigures({
  c,
  overridden = {},
  testId,
}: {
  c: ResultNumbers;
  overridden?: SalaryOverrides;
  testId?: string;
}) {
  const formula = formulaText(c);
  const mark = (k: keyof SalaryOverrides) =>
    overridden[k] !== undefined ? <span className="text-muted-foreground text-xs"> (override)</span> : null;
  return (
    <div className="space-y-3" data-testid={testId}>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Fig label="Monthly salary">
          <MoneyText paise={c.monthly_salary_paise} missing="No salary rate" />
          {mark('monthly_salary_paise')}
        </Fig>
        <Fig label="Working days">
          {formatDays(c.working_days)}
          {mark('working_days')}
        </Fig>
        <Fig label="Attended days">
          {formatDays(c.attended_days)}
          {mark('attended_days')}
        </Fig>
        <Fig label="Paid leave days">
          {formatDays(c.paid_leave_days)}
          {mark('paid_leave_days')}
        </Fig>
        <Fig label="Unpaid days">{formatDays(c.unpaid_days)}</Fig>
        <Fig label="Deduction">
          <MoneyText paise={deductionPaise(c)} />
        </Fig>
        <Fig label="Payable" strong>
          <span data-testid="salary-payable">
            <MoneyText paise={c.payable_paise} missing="Can't calculate" />
          </span>
        </Fig>
      </dl>
      {formula ? (
        <p className="bg-muted/50 rounded-md p-2 font-mono text-sm break-words" data-testid="salary-formula">
          {formula}
          <span className="text-muted-foreground block font-sans text-xs">
            Salary × (attended + paid leave) / working days, rounded to the paisa.
          </span>
        </p>
      ) : (
        <p className="text-sm" data-testid="salary-formula">
          No payable amount yet — the salary, the working days or the paid days need attention.
        </p>
      )}
    </div>
  );
}

function Fig({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={cn('tabular-nums', strong ? 'text-base font-semibold' : 'font-medium')}>{children}</dd>
    </div>
  );
}

function SavedResult({ row, month }: { row: SalaryMonthRow; month: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Saved result</CardTitle>
      </CardHeader>
      <CardContent>
        {row.saved ? (
          <div className="space-y-2">
            <ResultFigures c={row.saved} overridden={row.saved.overrides} testId="saved-result" />
            {row.saved.override_reason && (
              <p className="text-sm">
                <span className="text-muted-foreground">Override reason:</span> {row.saved.override_reason}
              </p>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm" data-testid="saved-result">
            Not calculated yet for {formatMonth(month)}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ calculator (managers)

type SaveOutcome = { kind: 'saved'; version: number } | { kind: 'replayed'; version: number };

function Calculator({ staffId, month, row }: { staffId: string; month: string; row: SalaryMonthRow }) {
  const initial = row.saved
    ? formFromOverrides(row.saved.overrides, row.saved.override_reason)
    : EMPTY_OVERRIDES;
  const [form, setForm] = useState<OverrideForm>(initial);
  const [applied, setApplied] = useState<{ overrides: SalaryOverrides; reason: string | null }>({
    overrides: row.saved?.overrides ?? {},
    reason: row.saved?.override_reason ?? null,
  });
  const [errors, setErrors] = useState<Partial<Record<OverrideFormField, string>>>({});
  const [adjusting, setAdjusting] = useState(Object.keys(row.saved?.overrides ?? {}).length > 0);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const preview = useSalaryPreview(staffId, month, applied.overrides, true);
  const save = useSaveSalary();
  const required = requiredOverride(row.live?.resolution_reason ?? null);
  const calculated = row.live
    ? {
        working_days: row.live.working_days,
        attended_days: row.live.attended_days,
        paid_leave_days: row.live.paid_leave_days,
      }
    : null;

  const set = (k: OverrideFormField, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
    setOutcome(null);
  };

  const built = buildOverrides(form, calculated, required);
  const dirty =
    !built.ok ||
    !sameOverrides(built.overrides, applied.overrides) ||
    (built.reason ?? null) !== (applied.reason ?? null);

  const applyForm = () => {
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setApplied({ overrides: built.overrides, reason: built.reason });
  };

  const clear = () => {
    setForm(EMPTY_OVERRIDES);
    setErrors({});
    setApplied({ overrides: {}, reason: null });
    setOutcome(null);
  };

  const c = preview.data;
  const canSave =
    !!c &&
    !preview.isPlaceholderData &&
    !preview.isError &&
    !dirty &&
    c.payable_paise !== null &&
    !c.needs_manual_resolution &&
    !save.isPending;

  const onSave = () => {
    setSaveError(null);
    setOutcome(null);
    save.mutate(
      { staffId, month, overrides: applied.overrides, reason: applied.reason },
      {
        onSuccess: (r) =>
          setOutcome(
            r.replayed
              ? { kind: 'replayed', version: r.version_no }
              : { kind: 'saved', version: r.version_no },
          ),
        onError: (e) => {
          const err = toAppError(e);
          const field = serverErrorField(err);
          const formField = field ? formFieldForServer(field) : null;
          if (formField) {
            setAdjusting(true);
            setErrors({ [formField]: err.message });
            return;
          }
          setSaveError(err);
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Calculator</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataState query={preview}>
          {(p) => <CalculationView c={p} groupId={row.staff_group_id} overridden={applied.overrides} />}
        </DataState>

        <div className="space-y-3 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Adjust values</h3>
            {!adjusting && (
              <Button variant="outline" size="sm" onClick={() => setAdjusting(true)}>
                Override values
              </Button>
            )}
          </div>
          {adjusting ? (
            <OverrideFields
              form={form}
              errors={errors}
              set={set}
              placeholders={calculated}
              required={required}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              Use the calendar and attendance as they are, or override working days, attended days, paid leave
              or the monthly salary with a reason.
            </p>
          )}
          {adjusting && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={applyForm} disabled={!dirty}>
                Preview with these values
              </Button>
              <Button variant="ghost" onClick={clear}>
                Clear overrides
              </Button>
            </div>
          )}
        </div>

        {dirty && adjusting && (
          <p className="text-sm" role="status">
            Preview the changed values before saving.
          </p>
        )}
        {outcome?.kind === 'replayed' && (
          <p role="status" className="rounded-md border p-2 text-sm" data-testid="salary-save-result">
            Already saved — no new version (version {outcome.version} is unchanged).
          </p>
        )}
        {outcome?.kind === 'saved' && (
          <p
            role="status"
            className="rounded-md border border-emerald-600 p-2 text-sm"
            data-testid="salary-save-result"
          >
            Saved as version {outcome.version}.
          </p>
        )}
        {saveError &&
          (isUncertainFailure(saveError) ? (
            <div
              role="alert"
              className="rounded-md border border-amber-600 p-3 text-sm"
              data-testid="unconfirmed"
            >
              <p className="flex items-start gap-2 font-medium">
                <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> Not confirmed
              </p>
              <p>
                We don&apos;t know whether this was saved. Check the history below. Saving again is safe: if
                it was saved, the server makes no new version.
              </p>
            </div>
          ) : (
            <ErrorText error={saveError} />
          ))}
        <Button onClick={onSave} disabled={!canSave} className="min-h-11">
          {save.isPending ? 'Saving…' : 'Save calculation'}
        </Button>
      </CardContent>
    </Card>
  );
}

function CalculationView({
  c,
  groupId,
  overridden,
}: {
  c: SalaryComputation;
  groupId: string | null;
  overridden: SalaryOverrides;
}) {
  const m = c.marked_days;
  const staffLink = (d: string) => `/staff-attendance?date=${d}${groupId ? `&group=${groupId}` : ''}`;
  return (
    <div className="space-y-3" data-testid="salary-calculation">
      {c.needs_manual_resolution && (
        <div role="alert" className="border-destructive rounded-md border p-3 text-sm">
          <p className="font-medium">Can&apos;t calculate yet: {c.resolution_reason}.</p>
          <p>
            {requiredOverride(c.resolution_reason) === 'monthly_salary_paise'
              ? 'Enter the monthly salary under “Override values” with a reason, then save.'
              : 'Enter the working days under “Override values” with a reason, then save.'}
          </p>
        </div>
      )}
      <ResultFigures c={c} overridden={overridden} />
      <p className="text-sm" data-testid="marked-days">
        Marked: present {m.present} · late {m.late} · half day {m.half_day} · absent {m.absent} ·{' '}
        <span className={c.unmarked_working_dates.length > 0 ? 'font-medium' : ''}>
          unmarked {c.unmarked_working_dates.length}
        </span>
      </p>
      {c.unmarked_working_dates.length > 0 && (
        <div className="rounded-md border border-amber-500 p-3 text-sm" data-testid="unmarked-dates">
          <p className="font-medium">
            {c.unmarked_working_dates.length} working{' '}
            {c.unmarked_working_dates.length === 1 ? 'day has' : 'days have'} no attendance mark
          </p>
          <p className="text-muted-foreground">
            Unmarked days are not counted as attended. Mark them in the staff register or override.
          </p>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {c.unmarked_working_dates.map((d) => (
              <li key={d}>
                <Link to={staffLink(d)} className="underline">
                  {formatDayShort(d)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {c.discrepancies.length > 0 && (
        <div className="rounded-md border p-3 text-sm" data-testid="discrepancies">
          <p className="font-medium">Please review</p>
          <ul className="mt-1 space-y-1">
            {c.discrepancies.map((d, i) => (
              <li key={`${d.date}-${d.issue}-${i}`}>
                <Link to={staffLink(d.date)} className="underline">
                  {formatDayShort(d.date)}
                </Link>
                : {issueText(d.issue)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const DAY_FIELDS: { key: 'working_days' | 'attended_days' | 'paid_leave_days'; label: string }[] = [
  { key: 'working_days', label: 'Working days' },
  { key: 'attended_days', label: 'Attended days' },
  { key: 'paid_leave_days', label: 'Paid leave days' },
];

function OverrideFields({
  form,
  errors,
  set,
  placeholders,
  required,
}: {
  form: OverrideForm;
  errors: Partial<Record<OverrideFormField, string>>;
  set: (k: OverrideFormField, v: string) => void;
  placeholders: { working_days: number; attended_days: number; paid_leave_days: number } | null;
  required: string | null;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {DAY_FIELDS.map((f) => (
        <FieldBox
          key={f.key}
          id={`ov-${f.key}`}
          label={`${f.label} (0–31, steps of 0.5)`}
          error={errors[f.key]}
        >
          <Input
            id={`ov-${f.key}`}
            inputMode="decimal"
            autoComplete="off"
            className="min-h-11"
            value={form[f.key]}
            placeholder={placeholders ? `Calculated: ${formatDays(placeholders[f.key])}` : 'Calculated'}
            aria-invalid={errors[f.key] ? true : undefined}
            aria-describedby={errors[f.key] ? `ov-${f.key}-error` : undefined}
            onChange={(e) => set(f.key, e.target.value)}
          />
        </FieldBox>
      ))}
      <FieldBox
        id="ov-monthly_salary"
        label={required === 'monthly_salary_paise' ? 'Monthly salary (₹, required)' : 'Monthly salary (₹)'}
        error={errors.monthly_salary}
      >
        <div className="relative">
          <span
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
          >
            ₹
          </span>
          <Input
            id="ov-monthly_salary"
            inputMode="decimal"
            autoComplete="off"
            className="min-h-11 pl-7 tabular-nums"
            value={form.monthly_salary}
            placeholder="Use the recorded rate"
            aria-invalid={errors.monthly_salary ? true : undefined}
            aria-describedby={errors.monthly_salary ? 'ov-monthly_salary-error' : undefined}
            onChange={(e) => set('monthly_salary', e.target.value)}
          />
        </div>
      </FieldBox>
      <FieldBox
        id="ov-reason"
        label="Reason for the overrides"
        error={errors.reason}
        className="sm:col-span-2"
      >
        <Textarea
          id="ov-reason"
          value={form.reason}
          maxLength={500}
          aria-invalid={errors.reason ? true : undefined}
          aria-describedby={errors.reason ? 'ov-reason-error' : undefined}
          onChange={(e) => set('reason', e.target.value)}
        />
      </FieldBox>
    </div>
  );
}

function FieldBox({
  id,
  label,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <p id={`${id}-error`} className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
