import { useState } from 'react';
import { Link } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { MoneyText } from '@/components/shared/MoneyText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { DuesRow } from '@/contracts/fees';
import { downloadBlob } from '@/features/imports/template';
import { useSetupSnapshot } from '@/features/setup/hooks';
import { useCurrentYearId } from '@/lib/scope';
import { useDues, useFeeSetup, type DuesFilter } from '../hooks';
import { YearSelect } from '../parts';
import { duesCsv, duesTotals } from './csv';

// Dues (brief §8): one row per student with any invoice in the year, students without a class too
// ("Class not set"). The year is always sent. The totals row is the sum of the rows shown.

const ALL = '__all';

export function DuesPage() {
  const currentYear = useCurrentYearId();
  const [filter, setFilter] = useState<Omit<DuesFilter, 'yearId'> & { yearId: string | null }>({
    yearId: currentYear,
    classId: null,
    sectionId: null,
    termId: null,
    onlyOverdue: false,
    onlyWithBalance: true,
  });
  const snapshot = useSetupSnapshot(filter.yearId);
  const setup = useFeeSetup(filter.yearId);
  const query = useDues(filter.yearId ? { ...filter, yearId: filter.yearId } : null);
  const classes = (snapshot.data?.classes ?? []).filter((c) => c.status === 'active');
  const sections = (snapshot.data?.sections ?? []).filter(
    (s) => !filter.classId || s.class_id === filter.classId,
  );
  const className = new Map(classes.map((c) => [c.id, c.name]));
  const set = (patch: Partial<typeof filter>) => setFilter((f) => ({ ...f, ...patch }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dues"
        actions={
          <Button
            variant="outline"
            disabled={!query.isSuccess}
            onClick={() =>
              query.data && downloadBlob(duesCsv(query.data), 'dues.csv', 'text/csv;charset=utf-8')
            }
          >
            Download CSV
          </Button>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <YearSelect
          value={filter.yearId}
          onChange={(y) => set({ yearId: y, classId: null, sectionId: null, termId: null })}
        />
        <div className="space-y-1">
          <Label htmlFor="dues-class">Class</Label>
          <Select
            value={filter.classId ?? ALL}
            onValueChange={(v) => set({ classId: v === ALL ? null : v, sectionId: null })}
          >
            <SelectTrigger id="dues-class" className="w-full" aria-label="Class">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All classes</SelectItem>
              {classes.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="dues-section">Section</Label>
          <Select
            value={filter.sectionId ?? ALL}
            onValueChange={(v) => set({ sectionId: v === ALL ? null : v })}
          >
            <SelectTrigger id="dues-section" className="w-full" aria-label="Section">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sections</SelectItem>
              {sections.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {className.get(s.class_id) ?? ''} {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="dues-term">Term</Label>
          <Select value={filter.termId ?? ALL} onValueChange={(v) => set({ termId: v === ALL ? null : v })}>
            <SelectTrigger id="dues-term" className="w-full" aria-label="Term">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All invoices</SelectItem>
              {(setup.data?.terms ?? []).map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="dues-overdue"
            checked={filter.onlyOverdue}
            onCheckedChange={(c) => set({ onlyOverdue: c === true })}
          />
          <Label htmlFor="dues-overdue" className="font-normal">
            Only overdue
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="dues-balance"
            checked={filter.onlyWithBalance}
            onCheckedChange={(c) => set({ onlyWithBalance: c === true })}
          />
          <Label htmlFor="dues-balance" className="font-normal">
            Only students who owe money
          </Label>
        </div>
      </div>
      {!filter.yearId ? (
        <p className="text-sm">Choose an academic year.</p>
      ) : (
        <DataState
          query={query}
          isEmpty={(rows) => rows.length === 0}
          emptyTitle="Nobody matches these filters"
        >
          {(rows) => <DuesTable rows={rows} />}
        </DataState>
      )}
    </div>
  );
}

function DuesTable({ rows }: { rows: DuesRow[] }) {
  const t = duesTotals(rows);
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[42rem] text-sm" data-testid="dues-table">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-2">Student</th>
                <th className="p-2">Class</th>
                <th className="p-2 text-right">Charged</th>
                <th className="p-2 text-right">Paid</th>
                <th className="p-2 text-right">Balance</th>
                <th className="p-2 text-right">Overdue</th>
                <th className="p-2 text-right">Pending cheques</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.student_id} className="border-t" data-testid={`dues-${r.admission_no}`}>
                  <td className="p-2">
                    <Link to={`/fees/students/${r.student_id}`} className="font-medium underline">
                      {r.name}
                    </Link>
                    <span className="text-muted-foreground block text-xs break-all">{r.admission_no}</span>
                  </td>
                  <td className="p-2">{r.class_section ?? <span className="italic">Class not set</span>}</td>
                  <td className="p-2 text-right">
                    <MoneyText paise={r.charged_paise} missing="No issued invoices" />
                  </td>
                  <td className="p-2 text-right">
                    <MoneyText paise={r.paid_paise} />
                  </td>
                  <td className="p-2 text-right font-medium">
                    <MoneyText paise={r.balance_paise} />
                  </td>
                  <td className="p-2 text-right">
                    <MoneyText paise={r.overdue_paise} />
                  </td>
                  <td className="p-2 text-right">
                    {r.pending_cheque_paise > 0 ? <MoneyText paise={r.pending_cheque_paise} /> : 'None'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-muted/50 border-t font-semibold" data-testid="dues-totals">
                <td className="p-2">Total ({t.students} students)</td>
                <td className="p-2" />
                <td className="p-2 text-right">
                  <MoneyText paise={t.charged} />
                </td>
                <td className="p-2 text-right">
                  <MoneyText paise={t.paid} />
                </td>
                <td className="p-2 text-right">
                  <MoneyText paise={t.balance} />
                </td>
                <td className="p-2 text-right">
                  <MoneyText paise={t.overdue} />
                </td>
                <td className="p-2 text-right">
                  <MoneyText paise={t.pendingCheques} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
