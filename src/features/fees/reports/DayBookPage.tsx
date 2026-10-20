import { useState } from 'react';
import { Link } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { ErrorText } from '@/components/shared/ErrorText';
import { MoneyText } from '@/components/shared/MoneyText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  PAYMENT_METHODS,
  type CollectionRow,
  type CollectionTotals,
  type PaymentMethod,
} from '@/contracts/fees';
import { downloadBlob } from '@/features/imports/template';
import { formatDate, schoolToday } from '@/lib/dates';
import { toAppError, type AppError } from '@/lib/errors';
import { useCollectionReport, useDayBook, useFeeSetup, type DayBookFilter } from '../hooks';
import { METHOD_LABELS } from '../labels';
import { Figure } from '../parts';
import { dayBookCsv } from './csv';

// Day book (brief §8): collections by received date with filters and search (receipt no, admission
// no, transaction reference or the start of a name). Totals are the server's for exactly these
// filters (list_collections.totals, migration 2320) — never a sum of the rows loaded so far.

const ALL = '__all';

export function DayBookPage() {
  const today = schoolToday();
  const setup = useFeeSetup(null);
  const [draft, setDraft] = useState<DayBookFilter>({
    from: today,
    to: today,
    method: null,
    accountId: null,
    collectorId: null,
    search: '',
  });
  const [filter, setFilter] = useState<DayBookFilter>(draft);
  const query = useDayBook(filter);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<AppError | null>(null);
  const rows: CollectionRow[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  const rangeOk = draft.from !== '' && draft.to !== '' && draft.from <= draft.to;

  // everyone who collected money in the shown date range (get_collection_report.by_collector, 2330)
  const report = useCollectionReport(filter.from, filter.to);
  const collectors = new Map<string, string>(
    (report.data?.by_collector ?? []).map((c) => [c.collected_by, c.collector ?? 'Unknown']),
  );
  if (draft.collectorId && !collectors.has(draft.collectorId))
    collectors.set(draft.collectorId, 'Chosen collector');

  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      // every page for these filters, not just the ones loaded on screen
      let data = query.data;
      while (data && data.pages[data.pages.length - 1]?.next_cursor) {
        const r = await query.fetchNextPage({ throwOnError: true });
        data = r.data;
      }
      const all = data?.pages.flatMap((p) => p.items) ?? [];
      downloadBlob(dayBookCsv(all), `day-book-${filter.from}-to-${filter.to}.csv`, 'text/csv;charset=utf-8');
    } catch (e) {
      setExportError(toAppError(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Day book" description="Collections by the date the money was received." />
      <form
        className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (rangeOk) setFilter(draft);
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="db-from">From</Label>
          <DateInput id="db-from" value={draft.from} onChange={(v) => setDraft({ ...draft, from: v })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="db-to">To</Label>
          <DateInput id="db-to" value={draft.to} onChange={(v) => setDraft({ ...draft, to: v })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="db-method">Method</Label>
          <Select
            value={draft.method ?? ALL}
            onValueChange={(v) => setDraft({ ...draft, method: v === ALL ? null : (v as PaymentMethod) })}
          >
            <SelectTrigger id="db-method" className="w-full" aria-label="Method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All methods</SelectItem>
              {PAYMENT_METHODS.map((m) => (
                <SelectItem key={m} value={m}>
                  {METHOD_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="db-account">Account</Label>
          <Select
            value={draft.accountId ?? ALL}
            onValueChange={(v) => setDraft({ ...draft, accountId: v === ALL ? null : v })}
          >
            <SelectTrigger id="db-account" className="w-full" aria-label="Account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All accounts</SelectItem>
              {(setup.data?.receiving_accounts ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="db-collector">Collected by</Label>
          <Select
            value={draft.collectorId ?? ALL}
            onValueChange={(v) => setDraft({ ...draft, collectorId: v === ALL ? null : v })}
          >
            <SelectTrigger id="db-collector" className="w-full" aria-label="Collected by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Anyone</SelectItem>
              {[...collectors].map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="db-search">Search</Label>
          <Input
            id="db-search"
            value={draft.search}
            placeholder="Receipt, admission no, UTR, name"
            onChange={(e) => setDraft({ ...draft, search: e.target.value })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-3 lg:col-span-6">
          <Button type="submit" disabled={!rangeOk}>
            Show
          </Button>
          {!rangeOk && (
            <span className="text-destructive text-sm">Choose a valid date range (up to 400 days)</span>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => void exportCsv()}
            disabled={exporting || query.isPending || query.isError}
          >
            {exporting ? 'Preparing…' : 'Download CSV'}
          </Button>
          <ErrorText error={exportError} />
        </div>
      </form>

      <DataState
        query={query}
        isEmpty={() => rows.length === 0}
        emptyTitle="No collections for these filters"
      >
        {(d) => (
          <Card>
            <CardContent className="space-y-3 pt-6">
              {/* server totals for exactly these filters (every page), never a sum of the rows loaded so far */}
              <DayBookTotals totals={d.pages[0]!.totals} />
              <ul className="divide-y rounded-md border text-sm" data-testid="day-book-rows">
                {rows.map((r) => (
                  <li key={r.collection_id} className="space-y-0.5 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/fees/receipts/${r.receipt_id}`} className="font-medium underline">
                        {r.receipt_no}
                      </Link>
                      <span>{formatDate(r.received_on)}</span>
                      <span>{METHOD_LABELS[r.method]}</span>
                      <MoneyText paise={r.amount_paise} className="font-medium" />
                      {r.reversed_paise > 0 && (
                        <Badge variant="outline">
                          Reversed <MoneyText paise={r.reversed_paise} />
                        </Badge>
                      )}
                    </div>
                    <p>
                      <Link to={`/fees/students/${r.student_id}`} className="underline">
                        {r.name}
                      </Link>{' '}
                      <span className="text-muted-foreground break-all">{r.admission_no}</span>
                    </p>
                    <p className="text-muted-foreground break-all">
                      {r.account}
                      {r.external_ref ? ` · ${r.external_ref}` : ''} · {r.collector ?? 'Unknown'}
                    </p>
                  </li>
                ))}
              </ul>
              {query.hasNextPage && (
                <Button
                  variant="outline"
                  onClick={() => void query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </CardContent>
          </Card>
        )}
      </DataState>
    </div>
  );
}

function DayBookTotals({ totals }: { totals: CollectionTotals }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="day-book-totals">
      <Figure label="Collections">{totals.count}</Figure>
      <Figure label="Received">
        <MoneyText paise={totals.amount_paise} />
      </Figure>
      <Figure label="Reversed since">
        <MoneyText paise={totals.reversed_paise} />
      </Figure>
      <Figure label="Net">
        <MoneyText paise={totals.amount_paise - totals.reversed_paise} />
      </Figure>
    </dl>
  );
}
