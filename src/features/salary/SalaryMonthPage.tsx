import { Link, useSearchParams } from 'react-router';
import { Download } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { MonthPicker } from '@/components/shared/MonthPicker';
import { MoneyText } from '@/components/shared/MoneyText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { SalaryMonth, SalaryMonthRow } from '@/contracts/salary';
import { useStaffGroups } from '@/features/staff/hooks';
import { downloadCsv } from '@/lib/csv';
import { formatMonth, monthStart, schoolToday } from '@/lib/dates';
import { useSalaryMonth } from './hooks';
import { defaultSalaryMonth, monthParam, parseMonthParam, salaryMonthCsv } from './logic';
import { ConfidentialNote, DaysText, SalaryStatusChip } from './parts';

// Salary month view (SAL-01): every staff member employed in the month with the saved result and,
// for managers, the live calculation next to it. The Owner (staff_finance.read only) sees saved
// results and statuses, no live numbers and no buttons. Totals come from the server.

const ALL = '__all__';

export function SalaryMonthPage() {
  const [params, setParams] = useSearchParams();
  const today = schoolToday();
  const thisMonth = monthStart(today);
  const parsed = parseMonthParam(params.get('month'));
  const month = parsed && parsed <= thisMonth ? parsed : defaultSalaryMonth(today);
  const groupId = params.get('group');
  const groups = useStaffGroups();
  const query = useSalaryMonth(month, groupId);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Salary"
        description="Monthly salary from the staff calendar and staff attendance."
        actions={
          <Button
            variant="outline"
            disabled={!query.data}
            onClick={() =>
              query.data &&
              downloadCsv(salaryMonthCsv(query.data), `salary-${monthParam(query.data.month)}.csv`)
            }
          >
            <Download aria-hidden="true" /> Export CSV
          </Button>
        }
      />
      <ConfidentialNote />
      <div className="flex flex-wrap items-end gap-4">
        <MonthPicker
          id="salary-month"
          month={month}
          max={thisMonth}
          onChange={(m) => update({ month: monthParam(m) })}
        />
        <div className="grid gap-1.5">
          <Label htmlFor="salary-group">Staff group</Label>
          <Select value={groupId ?? ALL} onValueChange={(v) => update({ group: v === ALL ? null : v })}>
            <SelectTrigger id="salary-group" className="min-h-11 w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All groups</SelectItem>
              {(groups.data ?? []).map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <DataState
        query={query}
        isEmpty={(d) => d.rows.length === 0}
        emptyTitle="No staff in this month"
        emptyDescription="Nobody in this group was employed during this month."
      >
        {(d) => <MonthView data={d} />}
      </DataState>
    </div>
  );
}

function MonthView({ data }: { data: SalaryMonth }) {
  const t = data.totals;
  const manage = data.can_manage;
  return (
    <div className="space-y-4" data-testid="salary-month">
      <dl className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
        <Summary label="Staff" value={t.staff} />
        <Summary label="Saved" value={t.saved} testId="total-saved" />
        <Summary label="Changed since saved" value={t.changed} />
        <Summary label="Not calculated" value={t.not_saved} />
        <Summary label="Needs manual resolution" value={t.needs_resolution} />
        <div>
          <dt className="text-muted-foreground text-xs">Saved payable — {formatMonth(data.month)}</dt>
          <dd className="font-semibold" data-testid="total-saved-payable">
            <MoneyText paise={t.saved_payable_paise} />
          </dd>
        </div>
      </dl>
      <p className="text-muted-foreground text-xs">
        {manage
          ? 'Days are the saved result where one exists; "Payable now" is today’s calculation from the calendar and attendance.'
          : 'Saved results only. Days and amounts change only when Admin saves a new version.'}
      </p>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[56rem] text-sm" data-testid="salary-table">
          <thead>
            <tr className="border-b text-left">
              <th className="py-2 pr-3 font-medium">Staff</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 pr-3 text-right font-medium">Saved payable</th>
              {manage && <th className="py-2 pr-3 text-right font-medium">Payable now</th>}
              <th className="py-2 pr-3 text-right font-medium">Working</th>
              <th className="py-2 pr-3 text-right font-medium">Attended</th>
              <th className="py-2 pr-3 text-right font-medium">Paid leave</th>
              <th className="py-2 pr-3 text-right font-medium">Unpaid</th>
              {manage && <th className="py-2 pr-3 text-right font-medium">Unmarked</th>}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const days = r.saved ?? r.live;
              return (
                <tr key={r.staff_id} className="border-b align-top" data-testid="salary-row">
                  <td className="py-2 pr-3">
                    <StaffCell row={r} month={data.month} />
                  </td>
                  <td className="py-2 pr-3">
                    <SalaryStatusChip status={r.status} versionNo={r.saved?.version_no ?? null} />
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <MoneyText paise={r.saved?.payable_paise} missing="Not saved" />
                  </td>
                  {manage && (
                    <td className="py-2 pr-3 text-right">
                      <MoneyText paise={r.live?.payable_paise} missing="Can't calculate" />
                    </td>
                  )}
                  <td className="py-2 pr-3 text-right">
                    <DaysText days={days?.working_days} />
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <DaysText days={days?.attended_days} />
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <DaysText days={days?.paid_leave_days} />
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <DaysText days={days?.unpaid_days} />
                  </td>
                  {manage && (
                    <td className="py-2 pr-3 text-right">
                      {r.live && r.live.unmarked_count > 0 ? (
                        <span className="font-medium text-amber-800 dark:text-amber-300">
                          {r.live.unmarked_count} unmarked
                        </span>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <td className="py-2 pr-3">Total ({t.saved} saved)</td>
              <td />
              <td className="py-2 pr-3 text-right">
                <MoneyText paise={t.saved_payable_paise} />
              </td>
              <td colSpan={manage ? 6 : 4} />
            </tr>
          </tfoot>
        </table>
      </div>
      <ul className="space-y-2 md:hidden" aria-label="Staff salary">
        {data.rows.map((r) => {
          const days = r.saved ?? r.live;
          return (
            <li key={r.staff_id} className="rounded-lg border p-3" data-testid="salary-card">
              <div className="flex items-start justify-between gap-2">
                <StaffCell row={r} month={data.month} />
                <SalaryStatusChip status={r.status} versionNo={r.saved?.version_no ?? null} />
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Saved payable</dt>
                <dd className="text-right">
                  <MoneyText paise={r.saved?.payable_paise} missing="Not saved" />
                </dd>
                {manage && (
                  <>
                    <dt className="text-muted-foreground">Payable now</dt>
                    <dd className="text-right">
                      <MoneyText paise={r.live?.payable_paise} missing="Can't calculate" />
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">Working / attended</dt>
                <dd className="text-right">
                  <DaysText days={days?.working_days} /> / <DaysText days={days?.attended_days} />
                </dd>
                <dt className="text-muted-foreground">Paid leave / unpaid</dt>
                <dd className="text-right">
                  <DaysText days={days?.paid_leave_days} /> / <DaysText days={days?.unpaid_days} />
                </dd>
                {manage && r.live && r.live.unmarked_count > 0 && (
                  <>
                    <dt className="text-muted-foreground">Unmarked days</dt>
                    <dd className="text-right font-medium text-amber-800 dark:text-amber-300">
                      {r.live.unmarked_count}
                    </dd>
                  </>
                )}
              </dl>
            </li>
          );
        })}
        <li className="rounded-lg border p-3 text-sm font-medium">
          Total saved payable ({t.saved} saved): <MoneyText paise={t.saved_payable_paise} />
        </li>
      </ul>
    </div>
  );
}

function StaffCell({ row, month }: { row: SalaryMonthRow; month: string }) {
  return (
    <div className="min-w-0">
      <Link
        to={`/salary/${row.staff_id}?month=${monthParam(month)}`}
        className="font-medium underline-offset-2 hover:underline"
      >
        {row.name}
      </Link>
      <p className="text-muted-foreground text-xs">
        {row.employee_no}
        {row.group ? ` · ${row.group}` : ''}
      </p>
      {row.partial_month && (
        <Badge variant="outline" className="mt-1">
          Partial month
        </Badge>
      )}
    </div>
  );
}

function Summary({ label, value, testId }: { label: string; value: number; testId?: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-semibold tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
