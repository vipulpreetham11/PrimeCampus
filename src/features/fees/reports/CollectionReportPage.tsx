import { useState } from 'react';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { MoneyText } from '@/components/shared/MoneyText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CollectionReport } from '@/contracts/fees';
import { formatDate, monthStart, schoolToday } from '@/lib/dates';
import { useCollectionReport } from '../hooks';
import { METHOD_LABELS } from '../labels';
import { Figure } from '../parts';

// Collection report (brief §8): posted money by day and method, collector, account; reversals
// (counted by the date they were made); pending and bounced cheques; concessions and waivers.

export function CollectionReportPage() {
  const today = schoolToday();
  const [draft, setDraft] = useState({ from: monthStart(today), to: today });
  const [range, setRange] = useState(draft);
  const query = useCollectionReport(range.from, range.to);
  const ok = draft.from !== '' && draft.to !== '' && draft.from <= draft.to;
  return (
    <div className="space-y-4">
      <PageHeader title="Collection report" />
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) setRange(draft);
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="cr-from">From</Label>
          <DateInput id="cr-from" value={draft.from} onChange={(v) => setDraft({ ...draft, from: v })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cr-to">To</Label>
          <DateInput id="cr-to" value={draft.to} onChange={(v) => setDraft({ ...draft, to: v })} />
        </div>
        <Button type="submit" disabled={!ok}>
          Show
        </Button>
      </form>
      <DataState query={query}>{(r) => <Report r={r} />}</DataState>
    </div>
  );
}

function Report({ r }: { r: CollectionReport }) {
  return (
    <div className="space-y-4" data-testid="collection-report">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {formatDate(r.from)} – {formatDate(r.to)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Figure label="Posted (received in range)" testId="report-posted">
              <MoneyText paise={r.gross_posted_paise} />
            </Figure>
            <Figure label="Reversed (reversals made in range)" testId="report-reversed">
              <MoneyText paise={r.reversed_paise} />
            </Figure>
            <Figure label="Pending cheques now (not counted)">
              {r.pending_cheques.count} · <MoneyText paise={r.pending_cheques.amount_paise} />
            </Figure>
            <Figure label="Cheques bounced in range">{r.bounced_cheques_in_range}</Figure>
            <Figure label="Concessions on invoices issued in range">
              <MoneyText paise={r.concessions_paise} />
            </Figure>
            <Figure label="Discounts and late-fee waivers in range">
              <MoneyText paise={r.waivers_paise} />
            </Figure>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">By day and method</CardTitle>
        </CardHeader>
        <CardContent>
          {r.by_day_method.length === 0 ? (
            <p className="text-muted-foreground text-sm">No collections in this range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.by_day_method.map((d) => (
                  <TableRow key={`${d.date}-${d.method}`}>
                    <TableCell>{formatDate(d.date)}</TableCell>
                    <TableCell>{METHOD_LABELS[d.method]}</TableCell>
                    <TableCell className="text-right">{d.count}</TableCell>
                    <TableCell className="text-right">
                      <MoneyText paise={d.amount_paise} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Breakdown
          title="By collector"
          rows={r.by_collector.map((c) => ({ label: c.collector ?? 'Unknown', amount: c.amount_paise }))}
        />
        <Breakdown
          title="By account"
          rows={r.by_account.map((a) => ({ label: a.account, amount: a.amount_paise }))}
        />
      </div>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: { label: string; amount: number }[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">No collections in this range.</p>
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((x, i) => (
              <li key={i} className="flex justify-between gap-2 py-1.5">
                <span>{x.label}</span>
                <MoneyText paise={x.amount} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
