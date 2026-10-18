import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { PageHeader } from '@/components/shared/PageHeader';
import { ProgressBar } from '@/components/shared/ProgressBar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  IMPORT_FILTERS,
  isClosedJob,
  type ImportCounts,
  type ImportDataset,
  type ImportFilter,
  type ImportJob,
  type ImportRow,
  type TemplateColumn,
} from '@/contracts/imports';
import { formatDateTime } from '@/lib/dates';
import { toAppError } from '@/lib/errors';
import { useCan } from '@/lib/scope';
import { commitChunk, useCloseImport, useImportJob, useRefreshAfterCommit, useSetRowRemoved } from './hooks';
import {
  DATASETS,
  FILTER_LABELS,
  allDone,
  datasetLabel,
  filterCount,
  pendingCount,
  rowState,
} from './labels';
import { CountTiles, JobStatusBadge, RowStateBadge } from './parts';
import { RowEditDialog } from './RowEditDialog';
import { runCommitLoop, type CommitOutcome, type CommitTally } from './runners';

// Preview → fix → import → results (brief §3–5). Every number shown comes from the server's
// counts; the page never claims "all imported" unless the counts prove it.

function isFilter(v: string | null): v is ImportFilter {
  return v !== null && (IMPORT_FILTERS as readonly string[]).includes(v);
}

// ------------------------------------------------------------------ record links
function useRecordLink(job: ImportJob) {
  const canStudents = useCan('students.read_all');
  const canStaff = useCan('staff.read');
  const canSetup = useCan('setup.manage');
  return (row: ImportRow): { to: string; label: string } | null => {
    const id = row.result_entity_id;
    if (!id || row.status !== 'committed') return null;
    const verb = row.action === 'skip' ? 'Open existing' : 'Open';
    if ((job.dataset === 'students_guardians' || job.dataset === 'placements') && canStudents) {
      return { to: `/students/${id}`, label: `${verb} student` };
    }
    if (job.dataset === 'staff' && canStaff) return { to: `/staff/${id}`, label: `${verb} staff profile` };
    if (job.dataset === 'classes_sections' && canSetup) {
      return {
        to: `/setup/classes${job.academic_year_id ? `?year=${job.academic_year_id}` : ''}`,
        label: 'Open classes in Setup',
      };
    }
    return null;
  };
}

// ------------------------------------------------------------------ one row
function RowItem({
  row,
  job,
  columns,
  open,
  onEdit,
  onRemove,
  onRestore,
  restoring,
}: {
  row: ImportRow;
  job: ImportJob;
  columns: TemplateColumn[];
  open: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onRestore: () => void;
  restoring: boolean;
}) {
  const recordLink = useRecordLink(job);
  const state = rowState(row);
  const info = (DATASETS as Record<string, (typeof DATASETS)[ImportDataset] | undefined>)[job.dataset];
  const idKeys = (info?.identifyingKeys ?? []).filter((k) => columns.some((c) => c.key === k));
  const label = (k: string) => columns.find((c) => c.key === k)?.label ?? k;
  const errorsFor = (k: string) => row.errors.filter((e) => e.field === k);
  const otherErrors = row.errors.filter((e) => !e.field || !idKeys.includes(e.field));
  const link = recordLink(row);
  const editable = open && (row.status === 'draft' || row.status === 'rejected');

  return (
    <li className="space-y-2 p-3" data-testid={`import-row-${row.row_no}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Row {row.row_no}</span>
        <RowStateBadge state={state} />
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {idKeys.map((k) => {
          const v = row.data[k];
          const errs = errorsFor(k);
          return (
            <div key={k} className="min-w-0">
              <dt className="text-muted-foreground text-xs">{label(k)}</dt>
              <dd className="break-words">{v === undefined || v === null || v === '' ? '—' : String(v)}</dd>
              {errs.map((e, i) => (
                <dd key={i} className="text-destructive text-xs">
                  {e.message}
                </dd>
              ))}
            </div>
          );
        })}
      </dl>
      {otherErrors.length > 0 && (
        <ul className="text-destructive space-y-0.5 text-sm" aria-label={`Problems in row ${row.row_no}`}>
          {otherErrors.map((e, i) => (
            <li key={i}>
              {e.field ? <span className="font-medium">{label(e.field)}: </span> : null}
              {e.message}
            </li>
          ))}
        </ul>
      )}
      {row.info?.note && state === 'will_skip' && (
        <p className="text-muted-foreground text-sm">{row.info.note}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {editable && (
          <Button size="sm" variant="outline" onClick={onEdit}>
            Edit
          </Button>
        )}
        {editable && (
          <Button size="sm" variant="outline" onClick={onRemove}>
            Remove
          </Button>
        )}
        {open && row.status === 'removed' && (
          <Button size="sm" variant="outline" onClick={onRestore} disabled={restoring}>
            {restoring ? 'Restoring…' : 'Restore'}
          </Button>
        )}
        {link && (
          <Button size="sm" variant="link" className="px-0" asChild>
            <Link to={link.to}>{link.label}</Link>
          </Button>
        )}
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ import panel
type CommitState =
  | { kind: 'idle' }
  | { kind: 'running'; total: number; tally: CommitTally }
  | { kind: 'ended'; outcome: CommitOutcome };

function tallyText(t: CommitTally): string {
  return (
    `${t.created} imported, ${t.skipped} already existed (nothing changed), ` +
    `${t.rejected} not imported, ${t.needsFixing} need fixing`
  );
}

function ImportPanel({ job }: { job: ImportJob }) {
  const [state, setState] = useState<CommitState>({ kind: 'idle' });
  const refreshAfterCommit = useRefreshAfterCommit();
  const counts = job.counts;
  const pending = pendingCount(counts);
  const running = state.kind === 'running';

  const run = async () => {
    const total = pendingCount(counts);
    setState({ kind: 'running', total, tally: { created: 0, skipped: 0, rejected: 0, needsFixing: 0 } });
    const outcome = await runCommitLoop(
      () => commitChunk(job.job_id),
      (tally) => setState({ kind: 'running', total, tally }),
    );
    void refreshAfterCommit(job.job_id);
    if (outcome.kind !== 'finished' && outcome.kind !== 'stalled' && outcome.error.code === 'CANCELLED')
      return;
    setState({ kind: 'ended', outcome });
  };

  const label =
    counts.ready > 0
      ? `Import ${counts.ready.toLocaleString('en-IN')} row${counts.ready === 1 ? '' : 's'}`
      : counts.will_skip > 0
        ? `Confirm ${counts.will_skip.toLocaleString('en-IN')} existing row${counts.will_skip === 1 ? '' : 's'}`
        : 'Import 0 rows';

  return (
    <div className="space-y-3">
      {state.kind !== 'running' && !allDone(counts) && (
        <div className="space-y-1">
          <Button onClick={() => void run()} disabled={pending === 0 || running}>
            {state.kind === 'ended' &&
            (state.outcome.kind === 'uncertain' || state.outcome.kind === 'stalled')
              ? 'Continue'
              : label}
          </Button>
          <p className="text-muted-foreground text-sm">
            {counts.ready > 0 && counts.will_skip > 0
              ? `${counts.will_skip} row${counts.will_skip === 1 ? '' : 's'} that already exist will be skipped — nothing about them changes.`
              : counts.ready === 0 && counts.will_skip > 0
                ? 'Every remaining row already exists: nothing will be created or changed.'
                : pending === 0
                  ? 'No rows are ready. Fix or restore rows first.'
                  : 'Each row is imported on its own; rows with problems are listed afterwards.'}
          </p>
        </div>
      )}
      {state.kind === 'running' && (
        <div className="space-y-2" aria-live="polite">
          <ProgressBar
            value={state.tally.created + state.tally.skipped + state.tally.rejected + state.tally.needsFixing}
            max={state.total}
            label="Importing rows…"
          />
          <p className="text-sm">So far: {tallyText(state.tally)}.</p>
        </div>
      )}
      {state.kind === 'ended' && <CommitResult outcome={state.outcome} counts={counts} />}
    </div>
  );
}

function CommitResult({ outcome, counts }: { outcome: CommitOutcome; counts: ImportCounts }) {
  if (outcome.kind === 'uncertain') {
    return (
      <div role="alert" className="space-y-2 rounded-md border border-amber-600/50 p-3 text-sm">
        <p className="font-medium">Some rows may already be imported — choose Continue to resume.</p>
        <p>Continuing is safe: rows already imported are never imported twice.</p>
        <p>Before the problem: {tallyText(outcome.tally)}.</p>
        <ErrorText error={outcome.error} />
      </div>
    );
  }
  if (outcome.kind === 'failed') {
    return (
      <div className="space-y-2 text-sm">
        <ErrorText error={outcome.error} />
        <p>Before the problem: {tallyText(outcome.tally)}.</p>
      </div>
    );
  }
  const done = allDone(counts);
  return (
    <div role="status" className="space-y-1 rounded-md border p-3 text-sm">
      <p className="font-medium">
        {outcome.kind === 'stalled'
          ? 'The import stopped because no more rows could be processed.'
          : done
            ? 'All rows in this import are done.'
            : 'The import run has finished.'}
      </p>
      <p>This run: {tallyText(outcome.tally)}.</p>
      {(counts.needs_fixing > 0 || counts.rejected > 0) && (
        <p>
          Still to do: {counts.needs_fixing} need fixing, {counts.rejected} not imported. Fix them below, then
          import again.
        </p>
      )}
      {outcome.kind === 'stalled' && (
        <p>Fix or remove the rows marked “Same record as row …”, then choose Continue.</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ page
export function ImportJobPage() {
  const { jobId } = useParams();
  const [params, setParams] = useSearchParams();
  const raw = params.get('filter');
  const filter: ImportFilter = isFilter(raw) ? raw : 'all';
  const query = useImportJob(jobId, filter);
  const remove = useSetRowRemoved(jobId ?? '');
  const close = useCloseImport(jobId ?? '');
  const [editing, setEditing] = useState<ImportRow | null>(null);
  const [removing, setRemoving] = useState<ImportRow | null>(null);
  const [closing, setClosing] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const setFilter = (f: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (f === 'all') n.delete('filter');
        else n.set('filter', f);
        return n;
      },
      { replace: true },
    );

  const setRemoved = async (row: ImportRow, removed: boolean) => {
    setActionError(null);
    try {
      await remove.mutateAsync({ rowNo: row.row_no, removed });
      toast.success(removed ? `Row ${row.row_no} removed from this import.` : `Row ${row.row_no} restored.`);
    } catch (e) {
      setActionError(toAppError(e));
    } finally {
      setRemoving(null);
    }
  };

  const doClose = async () => {
    setActionError(null);
    try {
      await close.mutateAsync();
      toast.success('Import closed.');
    } catch (e) {
      setActionError(toAppError(e));
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="space-y-4">
      <DataState query={query}>
        {(data) => {
          const first = data.pages[0]!;
          const job = first.job;
          const columns = first.columns;
          const rows = data.pages.flatMap((p) => p.rows);
          const open = !isClosedJob(job.status);
          return (
            <>
              <PageHeader
                title={`${datasetLabel(job.dataset)} import`}
                description={
                  <span className="space-y-0.5">
                    <span className="block break-all">
                      {job.file_name ?? 'Unnamed file'}
                      {job.academic_year ? ` · ${job.academic_year}` : ''}
                    </span>
                    <span className="block text-xs">
                      Started by {job.created_by ?? 'unknown user'} on {formatDateTime(job.created_at)}
                    </span>
                  </span>
                }
                actions={
                  <>
                    <JobStatusBadge status={job.status} />
                    <Button variant="outline" size="sm" asChild>
                      <Link to="/imports">All imports</Link>
                    </Button>
                  </>
                }
              />
              <CountTiles counts={job.counts} />

              {open ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Import</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <ImportPanel key={job.job_id} job={job} />
                    <div className="border-t pt-3">
                      <Button variant="outline" size="sm" onClick={() => setClosing(true)}>
                        Close import
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <p role="status" className="bg-muted rounded-md p-3 text-sm">
                  This import is closed and read-only. Rows that were not imported stay listed with their
                  reasons. To import them, start a new import.
                </p>
              )}
              <ErrorText error={actionError} />

              <Tabs value={filter} onValueChange={setFilter}>
                <TabsList aria-label="Show rows">
                  {IMPORT_FILTERS.map((f) => {
                    const n = filterCount(f, job.counts);
                    return (
                      <TabsTrigger key={f} value={f}>
                        {FILTER_LABELS[f]}
                        {n !== null ? ` (${n})` : ''}
                      </TabsTrigger>
                    );
                  })}
                </TabsList>
              </Tabs>

              {rows.length === 0 ? (
                <p
                  role="status"
                  className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm"
                >
                  No rows {filter === 'all' ? 'in this import' : `under “${FILTER_LABELS[filter]}”`}.
                </p>
              ) : (
                <ul className="bg-background divide-y rounded-md border" aria-label="Rows">
                  {rows.map((r) => (
                    <RowItem
                      key={r.row_no}
                      row={r}
                      job={job}
                      columns={columns}
                      open={open}
                      onEdit={() => setEditing(r)}
                      onRemove={() => setRemoving(r)}
                      onRestore={() => void setRemoved(r, false)}
                      restoring={remove.isPending && remove.variables?.rowNo === r.row_no}
                    />
                  ))}
                </ul>
              )}
              <div className="text-muted-foreground flex items-center justify-between text-sm">
                <span role="status">
                  Showing {rows.length} row{rows.length === 1 ? '' : 's'}
                  {query.hasNextPage ? ' — more available' : ''}
                </span>
                {query.hasNextPage && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void query.fetchNextPage()}
                    disabled={query.isFetchingNextPage}
                  >
                    {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </Button>
                )}
              </div>

              {editing && (
                <RowEditDialog
                  key={editing.row_no}
                  jobId={job.job_id}
                  row={editing}
                  columns={columns}
                  open
                  onOpenChange={(o) => !o && setEditing(null)}
                />
              )}
            </>
          );
        }}
      </DataState>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove row ${removing?.row_no ?? ''} from this import?`}
        description="The row will not be imported. Removing a row never deletes a school record. You can restore it later from “Removed”."
        confirmLabel="Remove row"
        busy={remove.isPending}
        onConfirm={() => removing && void setRemoved(removing, true)}
      />
      <ConfirmDialog
        open={closing}
        onOpenChange={setClosing}
        title="Close this import?"
        description="Rows that were not imported stay listed with their errors — nothing is deleted, and records already imported stay. After closing you can't edit or import rows here; start a new import for them."
        confirmLabel="Close import"
        busy={close.isPending}
        onConfirm={() => void doClose()}
      />
    </div>
  );
}
