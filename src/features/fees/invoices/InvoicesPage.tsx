import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { ErrorText } from '@/components/shared/ErrorText';
import { MoneyText } from '@/components/shared/MoneyText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { LateFeesEvaluated, PreviewRow, TermIssued } from '@/contracts/fees';
import { useSetupSnapshot } from '@/features/setup/hooks';
import { formatDate, schoolToday } from '@/lib/dates';
import { toAppError, type AppError } from '@/lib/errors';
import { useCan, useCurrentYearId } from '@/lib/scope';
import { issueArgs, useEvaluateLateFees, useFeeSetup, useIssueTermInvoices, useTermPreview } from '../hooks';
import { useMoneyAction } from '../money-action';
import { UnconfirmedNotice, YearSelect } from '../parts';

// Invoicing (brief §3): preview a term (per student: lines, gross, concession, net, missing prices,
// conflicts) → issue with ONE operation id → issued / already existing / skipped WITH names and
// reasons. Skipped students are never hidden.

export type PreviewOutcome = { kind: 'issue' } | { kind: 'existing' } | { kind: 'skip'; reason: string };

/** What issue_term_invoices will do with this student (the server's order of checks). Unit-tested. */
export function previewOutcome(r: PreviewRow): PreviewOutcome {
  if (r.already_issued) return { kind: 'existing' };
  if (r.skip_reason) return { kind: 'skip', reason: r.skip_reason };
  if ((r.concession_conflicts ?? []).length > 0)
    return { kind: 'skip', reason: 'More than one concession applies to the same fee head' };
  if ((r.missing_prices ?? []).length > 0)
    return { kind: 'skip', reason: `No price set for: ${(r.missing_prices ?? []).join(', ')}` };
  if ((r.lines ?? []).length === 0)
    return { kind: 'skip', reason: 'No fee lines configured for this class/term' };
  return { kind: 'issue' };
}

export function InvoicesPage() {
  const currentYear = useCurrentYearId();
  const [yearId, setYearId] = useState<string | null>(currentYear);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Invoices"
        description="Issue term invoices, apply late fees, and bring in opening balances."
        actions={<YearSelect value={yearId} onChange={setYearId} />}
      />
      {yearId && <IssueCard key={yearId} yearId={yearId} />}
      <LateFeesCard />
      <OpeningBalancesCard />
    </div>
  );
}

function IssueCard({ yearId }: { yearId: string }) {
  const setup = useFeeSetup(yearId);
  const snapshot = useSetupSnapshot(yearId);
  const [termId, setTermId] = useState<string | null>(null);
  const [sectionId, setSectionId] = useState<string>('__all');
  const [run, setRun] = useState(0);
  const [result, setResult] = useState<TermIssued | null>(null);
  const terms = (setup.data?.terms ?? []).filter((t) => t.status === 'active');
  const classes = new Map((snapshot.data?.classes ?? []).map((c) => [c.id, c.name]));
  const sections = (snapshot.data?.sections ?? []).filter((s) => s.status === 'active');
  const section = sectionId === '__all' ? null : sectionId;
  const preview = useTermPreview(termId, section, run);
  const mut = useIssueTermInvoices();
  const send = useCallback(
    (operationId: string, p: { termId: string; sectionId: string | null }) =>
      mut.mutateAsync(issueArgs(operationId, p.termId, p.sectionId)),
    [mut],
  );
  const action = useMoneyAction(send);
  const locked = action.state.kind === 'saving' || action.state.kind === 'unconfirmed';
  const choose = (fn: () => void) => {
    fn();
    setRun(0);
    setResult(null);
    action.reset();
  };
  const done = (r: TermIssued | null) => {
    if (r) setResult(r);
  };

  return (
    <Card>
      <CardHeader className="space-y-3">
        <CardTitle className="text-base">Issue term invoices</CardTitle>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="issue-term">Term</Label>
            <Select value={termId ?? ''} onValueChange={(v) => choose(() => setTermId(v))} disabled={locked}>
              <SelectTrigger id="issue-term" className="w-full" aria-label="Term">
                <SelectValue placeholder={terms.length ? 'Choose a term' : 'No active terms'} />
              </SelectTrigger>
              <SelectContent>
                {terms.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} (due {formatDate(t.due_date)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="issue-section">Students</Label>
            <Select value={sectionId} onValueChange={(v) => choose(() => setSectionId(v))} disabled={locked}>
              <SelectTrigger id="issue-section" className="w-full" aria-label="Students">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">Whole school</SelectItem>
                {sections.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {classes.get(s.class_id) ?? ''} {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button
              variant="outline"
              disabled={!termId || locked}
              onClick={() => {
                setResult(null);
                action.reset();
                setRun((n) => n + 1);
              }}
            >
              {run > 0 ? 'Preview again' : 'Preview'}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {result && <IssueResult result={result} />}
        {termId && run > 0 && !result && (
          <DataState
            query={preview}
            isEmpty={(rows) => rows.length === 0}
            emptyTitle="No students are enrolled for this choice"
          >
            {(rows) => {
              const outcomes = rows.map((r) => ({ r, o: previewOutcome(r) }));
              const toIssue = outcomes.filter((x) => x.o.kind === 'issue');
              const existing = outcomes.filter((x) => x.o.kind === 'existing').length;
              const skipped = outcomes.filter((x) => x.o.kind === 'skip').length;
              const total = toIssue.reduce((s, x) => s + (x.r.net_paise ?? 0), 0);
              return (
                <div className="space-y-3">
                  <p className="text-sm" role="status" data-testid="preview-summary">
                    {toIssue.length} to issue (<MoneyText paise={total} /> in total) · {existing} already
                    issued · {skipped} will be skipped
                  </p>
                  <ul className="divide-y rounded-md border text-sm" data-testid="preview-rows">
                    {outcomes.map(({ r, o }) => (
                      <PreviewItem key={r.student_id} r={r} o={o} />
                    ))}
                  </ul>
                  {action.state.kind === 'failed' && <ErrorText error={action.state.error} />}
                  {action.state.kind === 'unconfirmed' ? (
                    <UnconfirmedNotice
                      what="request"
                      error={action.state.error}
                      busy={false}
                      onRetry={() => void action.retry().then(done)}
                      onDiscard={action.discard}
                    />
                  ) : (
                    <Button
                      disabled={toIssue.length === 0 || locked}
                      onClick={() => void action.run({ termId, sectionId: section }).then(done)}
                    >
                      {action.state.kind === 'saving'
                        ? 'Issuing…'
                        : `Issue ${toIssue.length} invoice${toIssue.length === 1 ? '' : 's'}`}
                    </Button>
                  )}
                </div>
              );
            }}
          </DataState>
        )}
      </CardContent>
    </Card>
  );
}

function PreviewItem({ r, o }: { r: PreviewRow; o: PreviewOutcome }) {
  return (
    <li className="space-y-1 p-3" data-testid={`preview-${r.admission_no}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{r.name}</span>
        <span className="text-muted-foreground break-all">{r.admission_no}</span>
        {r.class && (
          <span className="text-muted-foreground">
            {r.class} {r.section ?? ''}
          </span>
        )}
        {o.kind === 'issue' && <Badge>Will be issued</Badge>}
        {o.kind === 'existing' && <Badge variant="secondary">Already issued</Badge>}
        {o.kind === 'skip' && <Badge variant="destructive">Will be skipped</Badge>}
      </div>
      {o.kind === 'skip' && <p className="text-destructive">{o.reason}</p>}
      {o.kind !== 'skip' && (r.lines ?? []).length > 0 && (
        <p className="text-muted-foreground">
          {(r.lines ?? []).map((l, i) => (
            <span key={l.fee_head_id}>
              {i > 0 && ' · '}
              {l.label} <MoneyText paise={l.gross_paise} />
              {l.concession_paise > 0 && (
                <>
                  {' '}
                  − {l.concession_name ?? 'concession'} <MoneyText paise={l.concession_paise} />
                </>
              )}
            </span>
          ))}{' '}
          → net <MoneyText paise={r.net_paise} className="text-foreground font-medium" />
        </p>
      )}
    </li>
  );
}

function IssueResult({ result }: { result: TermIssued }) {
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm" role="status" data-testid="issue-result">
      <p className="font-medium">
        {result.replayed ? 'This request was already done. ' : ''}Issued {result.issued} · already existed{' '}
        {result.already_existing} · skipped {result.skipped.length}
      </p>
      {result.skipped.length > 0 && (
        <div>
          <p>Skipped students (fix the reason, then issue again — nothing is issued twice):</p>
          <ul className="list-disc pl-5" data-testid="issue-skipped">
            {result.skipped.map((s) => (
              <li key={s.student_id}>
                {s.name} ({s.admission_no}) — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function LateFeesCard() {
  const mut = useEvaluateLateFees();
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<LateFeesEvaluated | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const today = schoolToday();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Late fees</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          Adds the year&apos;s late fee once to each overdue term invoice (after the grace days). Running it
          again never adds a second late fee. Invoices with a pending cheque are not charged.
        </p>
        <Button variant="outline" onClick={() => setConfirm(true)} disabled={mut.isPending}>
          Apply late fees (as of {formatDate(today)})
        </Button>
        <ErrorText error={error} />
        {result && (
          <p role="status" data-testid="late-fee-result">
            Late fees added: {result.late_fees_added}. Invoices with a pending cheque (not charged):{' '}
            {result.skipped_pending_cheque.length}.
          </p>
        )}
      </CardContent>
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={setConfirm}
          title="Apply late fees now?"
          description={`Late fees are added to term invoices still unpaid after their due date plus the grace days, as of ${formatDate(today)}.`}
          confirmLabel="Apply late fees"
          busy={mut.isPending}
          onConfirm={() => {
            setError(null);
            mut
              .mutateAsync(today)
              .then(setResult)
              .catch((e: unknown) => setError(toAppError(e)))
              .finally(() => setConfirm(false));
          }}
        />
      )}
    </Card>
  );
}

function OpeningBalancesCard() {
  const canImport = useCan('imports.manage');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Opening balances</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p>
          Money owed from before PrimeCampus. Add one on a student&apos;s fee statement (“Add opening
          balance”), or many at once from a spreadsheet.
        </p>
        {canImport ? (
          <Button asChild variant="outline">
            <Link to="/imports/new?dataset=opening_balances">Import opening balances</Link>
          </Button>
        ) : (
          <p className="text-muted-foreground">Importing from a spreadsheet is done by an Admin.</p>
        )}
      </CardContent>
    </Card>
  );
}
