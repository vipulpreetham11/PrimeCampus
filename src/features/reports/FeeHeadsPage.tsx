import { useState } from 'react';
import { Download } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { MoneyText } from '@/components/shared/MoneyText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { FeeHeadReport } from '@/contracts/reports';
import { useFeeSetup } from '@/features/fees/hooks';
import { YearSelect } from '@/features/fees/parts';
import { downloadCsv } from '@/lib/csv';
import { useCurrentYearId } from '@/lib/scope';
import { useFeeHeadReport } from './hooks';
import { chargedDifference, feeHeadCsv, headKindText, headNet, headSums } from './logic';

// Fee-head totals (FEE-06): what was charged per head — gross, concession, adjustments, net — for a
// year or one term. Payments are allocated to invoices, not heads, so collections are shown as
// totals only (the server's note says so).

const ALL = '__all__';

export function FeeHeadsPage() {
  const current = useCurrentYearId();
  const [yearId, setYearId] = useState<string | null>(current);
  const [termId, setTermId] = useState<string | null>(null);
  const setup = useFeeSetup(yearId);
  const terms = setup.data?.terms ?? [];
  const query = useFeeHeadReport(yearId, termId);
  const termName = termId ? (terms.find((t) => t.id === termId)?.name ?? 'Term') : 'Whole year';

  return (
    <div className="space-y-4">
      <PageHeader
        title="Fee-head totals"
        description="Charged per fee head, with concessions and adjustments."
        actions={
          <Button
            variant="outline"
            disabled={!query.data}
            onClick={() => query.data && downloadCsv(feeHeadCsv(query.data, termName), 'fee-head-totals.csv')}
          >
            <Download aria-hidden="true" /> Export CSV
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <YearSelect
          value={yearId}
          onChange={(y) => {
            setYearId(y);
            setTermId(null);
          }}
        />
        <div className="space-y-1">
          <Label htmlFor="heads-term">Term</Label>
          <Select value={termId ?? ALL} onValueChange={(v) => setTermId(v === ALL ? null : v)}>
            <SelectTrigger id="heads-term" className="w-full sm:w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Whole year</SelectItem>
              {terms.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {yearId === null ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
          Choose an academic year.
        </p>
      ) : (
        <DataState query={query}>{(r) => <HeadsView r={r} />}</DataState>
      )}
    </div>
  );
}

function HeadsView({ r }: { r: FeeHeadReport }) {
  const s = headSums(r.heads);
  const diff = chargedDifference(r);
  return (
    <div className="space-y-4" data-testid="fee-heads">
      <dl className="grid grid-cols-1 gap-3 rounded-lg border p-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground text-xs">Charged (issued invoices, incl. adjustments)</dt>
          <dd className="text-base font-semibold" data-testid="heads-charged">
            <MoneyText paise={r.totals.charged_paise} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Paid</dt>
          <dd className="text-base font-semibold" data-testid="heads-paid">
            <MoneyText paise={r.totals.paid_paise} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Balance</dt>
          <dd className="text-base font-semibold" data-testid="heads-balance">
            <MoneyText paise={r.totals.balance_paise} />
          </dd>
        </div>
      </dl>
      <p className="text-muted-foreground text-xs" role="note">
        {r.note}
      </p>
      {r.heads.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
          No issued invoices for this period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm" data-testid="fee-heads-table">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2 pr-3 font-medium">Head</th>
                <th className="py-2 pr-3 text-right font-medium">Invoices</th>
                <th className="py-2 pr-3 text-right font-medium">Gross</th>
                <th className="py-2 pr-3 text-right font-medium">Concession</th>
                <th className="py-2 pr-3 text-right font-medium">Adjustments</th>
                <th className="py-2 pr-3 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody>
              {r.heads.map((h) => (
                <tr key={h.fee_head_id} className="border-b" data-testid="fee-head-row">
                  <td className="py-2 pr-3">
                    <span className="font-medium">{h.name}</span>
                    <span className="text-muted-foreground block text-xs">
                      {h.code} · {headKindText(h.kind)}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{h.invoices}</td>
                  <td className="py-2 pr-3 text-right">
                    <MoneyText paise={h.gross_paise} />
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <MoneyText paise={h.concession_paise} />
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <MoneyText paise={h.adjustments_paise} />
                  </td>
                  <td className="py-2 pr-3 text-right font-medium">
                    <MoneyText paise={headNet(h)} />
                  </td>
                </tr>
              ))}
              {r.adjustments_without_head_paise !== 0 && (
                <tr className="border-b">
                  <td className="py-2 pr-3" colSpan={4}>
                    Adjustments not linked to a head
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <MoneyText paise={r.adjustments_without_head_paise} />
                  </td>
                  <td className="py-2 pr-3 text-right font-medium">
                    <MoneyText paise={r.adjustments_without_head_paise} />
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="font-medium">
                <td className="py-2 pr-3">Total of heads</td>
                <td />
                <td className="py-2 pr-3 text-right">
                  <MoneyText paise={s.gross} />
                </td>
                <td className="py-2 pr-3 text-right">
                  <MoneyText paise={s.concession} />
                </td>
                <td className="py-2 pr-3 text-right">
                  <MoneyText paise={s.adjustments} />
                </td>
                <td className="py-2 pr-3 text-right" data-testid="heads-net-total">
                  <MoneyText paise={s.net + r.adjustments_without_head_paise} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {diff !== 0 && (
        <p className="rounded-md border border-amber-500 p-2 text-sm" role="note">
          The heads add up to <MoneyText paise={s.net + r.adjustments_without_head_paise} />, which differs
          from the charged total by <MoneyText paise={diff} /> (for example invoices whose lines have no
          head).
        </p>
      )}
    </div>
  );
}
