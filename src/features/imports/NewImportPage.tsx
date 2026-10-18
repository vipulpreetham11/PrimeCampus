import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useBlocker } from 'react-router';
import { Download, FileSpreadsheet, TriangleAlert } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { PageHeader } from '@/components/shared/PageHeader';
import { ProgressBar } from '@/components/shared/ProgressBar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ImportDataset, ImportTemplate, StageResult, StartImportResult } from '@/contracts/imports';
import type { Json } from '@/generated/database.types';
import { formatDateTime } from '@/lib/dates';
import { toAppError, type AppError } from '@/lib/errors';
import { useOperationTracker } from '@/lib/operation';
import { useCan, useCurrentYearId } from '@/lib/scope';
import { useSetupSnapshot } from '@/features/setup/hooks';
import { YearSelect } from '@/features/setup/year';
import { batchRows } from './batching';
import { sha256Hex } from './fingerprint';
import { startImportJob, stageRows, useImportTemplate, useRefreshJob } from './hooks';
import { DATASETS, DATASET_ORDER } from './labels';
import { runStaging } from './runners';
import {
  autoMap,
  buildStageRows,
  mappingProblems,
  mappingRecord,
  sampleValues,
  type Mapping,
  type StageRow,
} from './mapping';
import { parseFile } from './parse/client';
import { loadExcelJs } from './parse/libs';
import { PARSE_LIMITS, precheckFile, type ParsedSheet } from './parse/sheet';
import { DATASET_FILE_NAMES, buildTemplateCsv, buildTemplateXlsx, downloadBlob, helpRow } from './template';

// New import wizard (brief §2). Parsed rows live only in this component's state: never in
// browser storage, the query cache or telemetry. A context switch remounts the page (RootLayout
// is keyed by the session epoch), which throws all of it away.

const NONE = '__none__';

interface LoadedFile {
  name: string;
  size: number;
  fingerprint: string;
  sheet: ParsedSheet;
}

type FileState =
  | { kind: 'empty' }
  | { kind: 'reading'; name: string }
  | { kind: 'error'; name: string; message: string }
  | { kind: 'loaded'; file: LoadedFile };

type Upload =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'start-failed'; error: AppError }
  | {
      kind: 'staging' | 'stage-failed' | 'done';
      job: StartImportResult;
      batches: StageRow[][];
      batchesDone: number;
      rowsDone: number;
      error?: AppError;
      resumable?: boolean;
      last?: StageResult | null;
    };

function Step({
  n,
  title,
  description,
  children,
}: {
  n: number;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          <span className="text-muted-foreground mr-1">{n}.</span>
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ step 1
function DatasetStep({
  dataset,
  onDataset,
  locked,
}: {
  dataset: ImportDataset | null;
  onDataset: (d: ImportDataset) => void;
  locked: boolean;
}) {
  const canSetup = useCan('setup.manage');
  const canStaff = useCan('staff.manage');
  const canStudents = useCan('students.manage');
  const allowed: Record<string, boolean> = {
    'setup.manage': canSetup,
    'staff.manage': canStaff,
    'students.manage': canStudents,
  };
  return (
    <fieldset className="space-y-2" disabled={locked}>
      <legend className="sr-only">What are you importing?</legend>
      {DATASET_ORDER.map((d) => {
        const info = DATASETS[d];
        const ok = allowed[info.commitCapability] ?? false;
        return (
          <label
            key={d}
            className="has-[:checked]:border-primary has-[:checked]:bg-muted/40 flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
          >
            <input
              type="radio"
              name="dataset"
              value={d}
              checked={dataset === d}
              disabled={!ok}
              onChange={() => onDataset(d)}
              className="mt-1"
            />
            <span>
              <span className="block font-medium">{info.label}</span>
              <span className="text-muted-foreground block text-sm">{info.description}</span>
              {!ok && <span className="block text-sm">Your role can&apos;t import these records.</span>}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

// ------------------------------------------------------------------ step 2
function TemplateStep({ template }: { template: ImportTemplate }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `primecampus-${DATASET_FILE_NAMES[template.dataset] ?? template.dataset}-template`;
  const xlsx = async () => {
    setBusy(true);
    setError(null);
    try {
      const bytes = await buildTemplateXlsx(template, await loadExcelJs());
      downloadBlob(
        bytes,
        `${base}.xlsx`,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    } catch {
      setError('The Excel template could not be made. Try the CSV template instead.');
    } finally {
      setBusy(false);
    }
  };
  const csv = () => downloadBlob(buildTemplateCsv(template), `${base}.csv`, 'text/csv;charset=utf-8');
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => void xlsx()} disabled={busy}>
          <Download aria-hidden="true" />
          {busy ? 'Preparing…' : 'Download template (.xlsx)'}
        </Button>
        <Button type="button" variant="outline" onClick={csv}>
          <Download aria-hidden="true" />
          Download template (.csv)
        </Button>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <details className="rounded-md border p-3 text-sm">
        <summary className="cursor-pointer font-medium">Columns in this template</summary>
        <p className="text-muted-foreground mt-2">
          The Excel template has the same help on its second sheet. Required columns must be filled in on
          every row.
        </p>
        <ul className="mt-2 divide-y" aria-label="Template columns">
          {template.columns.map((c) => {
            const [label, required, example, allowed, notes] = helpRow(c);
            return (
              <li key={c.key} className="py-2">
                <span className="font-medium">{label}</span>{' '}
                <span className="text-muted-foreground">
                  {required === 'Yes' ? '(required)' : '(optional)'}
                </span>
                {example && <span className="block">Example: {example}</span>}
                {allowed && <span className="block">Allowed: {allowed}</span>}
                {notes && <span className="text-muted-foreground block">{notes}</span>}
              </li>
            );
          })}
        </ul>
      </details>
    </>
  );
}

// ------------------------------------------------------------------ step 3
function UploadStep({
  state,
  onFile,
  locked,
}: {
  state: FileState;
  onFile: (f: File) => void;
  locked: boolean;
}) {
  const inputId = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>Spreadsheet file (.xlsx or .csv)</Label>
      <input
        id={inputId}
        type="file"
        accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        disabled={locked}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
        className="file:bg-muted block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-2"
      />
      <p className="text-muted-foreground text-sm">
        Up to 5 MB and {PARSE_LIMITS.maxDataRows.toLocaleString('en-IN')} rows. Excel: only the first sheet is
        read. The first non-empty row must be the column headings.
      </p>
      {state.kind === 'reading' && (
        <p role="status" className="text-sm">
          Reading {state.name}…
        </p>
      )}
      {state.kind === 'error' && (
        <div role="alert" className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm">
          <p className="font-medium">{state.name} can&apos;t be used</p>
          <p>{state.message}</p>
        </div>
      )}
      {state.kind === 'loaded' && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <FileSpreadsheet aria-hidden="true" className="size-4" />
          <span className="break-all">
            {state.file.name}: {state.file.sheet.rows.length.toLocaleString('en-IN')} data row
            {state.file.sheet.rows.length === 1 ? '' : 's'}, {state.file.sheet.headers.length} column
            {state.file.sheet.headers.length === 1 ? '' : 's'} (headings on row {state.file.sheet.headerRowNo}
            ).
          </span>
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ step 4
function MappingStep({
  sheet,
  template,
  mapping,
  onChange,
  locked,
}: {
  sheet: ParsedSheet;
  template: ImportTemplate;
  mapping: Mapping;
  onChange: (m: Mapping) => void;
  locked: boolean;
}) {
  const problems = mappingProblems(mapping, template.columns);
  const mapped = new Set(mapping.filter(Boolean));
  const unusedOptional = template.columns.filter((c) => !c.required && !mapped.has(c.key));
  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-md border" aria-label="Column mapping">
        {sheet.headers.map((h, i) => {
          const samples = sampleValues(sheet, i);
          const selectId = `map-${i}`;
          return (
            <li key={i} className="grid gap-2 p-3 sm:grid-cols-[1fr_16rem] sm:items-center">
              <div className="min-w-0">
                <Label htmlFor={selectId} className="break-words">
                  {h}
                </Label>
                <p className="text-muted-foreground truncate text-xs" title={samples.join(' · ')}>
                  {samples.length > 0 ? samples.join(' · ') : 'No values'}
                </p>
              </div>
              <Select
                value={mapping[i] ?? NONE}
                disabled={locked}
                onValueChange={(v) => {
                  const next = [...mapping];
                  next[i] = v === NONE ? null : v;
                  onChange(next);
                }}
              >
                <SelectTrigger id={selectId} className="w-full" aria-label={`Import "${h}" as`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Don&apos;t import this column</SelectItem>
                  {template.columns.map((c) => (
                    <SelectItem key={c.key} value={c.key}>
                      {c.label}
                      {c.required ? ' (required)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </li>
          );
        })}
      </ul>
      {problems.length > 0 ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 space-y-1 rounded-md border p-3 text-sm"
        >
          {problems.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      ) : (
        <p role="status" className="text-sm">
          All required columns are matched.
        </p>
      )}
      {unusedOptional.length > 0 && (
        <p className="text-muted-foreground text-sm">
          Not in your file (left empty): {unusedOptional.map((c) => c.label).join(', ')}.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ page
export function NewImportPage() {
  const currentYear = useCurrentYearId();
  const snapshot = useSetupSnapshot(null);
  const [dataset, setDataset] = useState<ImportDataset | null>(null);
  const [yearId, setYearId] = useState<string | null>(currentYear);
  const [fileState, setFileState] = useState<FileState>({ kind: 'empty' });
  const [edited, setEdited] = useState<{
    file: LoadedFile;
    template: ImportTemplate;
    mapping: Mapping;
  } | null>(null);
  const [upload, setUpload] = useState<Upload>({ kind: 'idle' });
  const tracker = useOperationTracker();
  const refreshJob = useRefreshJob();
  const template = useImportTemplate(dataset);

  const file = fileState.kind === 'loaded' ? fileState.file : null;
  const needsYear = template.data?.needs_year ?? dataset !== 'staff';
  const locked = upload.kind !== 'idle' && upload.kind !== 'start-failed';
  const uploading = upload.kind === 'starting' || upload.kind === 'staging';
  const unfinished = uploading || upload.kind === 'stage-failed';

  // Columns are auto-matched for each (file, template) pair; the user's changes apply to that pair only.
  const templateData = template.data;
  const auto = useMemo(
    () => (file && templateData ? autoMap(file.sheet.headers, templateData.columns) : []),
    [file, templateData],
  );
  const mapping: Mapping =
    edited && edited.file === file && edited.template === templateData ? edited.mapping : auto;
  const setMapping = (m: Mapping) => {
    if (file && templateData) setEdited({ file, template: templateData, mapping: m });
  };

  // Leaving mid-upload: rows sent so far stay in the import (it is listed in the history).
  const blocker = useBlocker(unfinished);
  useEffect(() => {
    if (!unfinished) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [unfinished]);

  const onFile = async (f: File) => {
    const problem = precheckFile(f.name, f.size);
    if (problem) {
      setFileState({ kind: 'error', name: f.name, message: problem });
      return;
    }
    setFileState({ kind: 'reading', name: f.name });
    try {
      const bytes = await f.arrayBuffer();
      const fingerprint = await sha256Hex(bytes);
      const result = await parseFile(f.name, bytes);
      if (!result.ok) setFileState({ kind: 'error', name: f.name, message: result.message });
      else
        setFileState({
          kind: 'loaded',
          file: { name: f.name, size: f.size, fingerprint, sheet: result.sheet },
        });
    } catch {
      setFileState({ kind: 'error', name: f.name, message: 'This file could not be read.' });
    }
  };

  const problems = templateData ? mappingProblems(mapping, templateData.columns) : ['Loading the template…'];
  const yearOk = !needsYear || !!yearId;
  const canStart = !!dataset && !!file && !!templateData && problems.length === 0 && yearOk && !locked;

  const stageFrom = async (job: StartImportResult, batches: StageRow[][], from: number) => {
    const rowsBefore = (i: number) => batches.slice(0, i).reduce((n, b) => n + b.length, 0);
    setUpload({ kind: 'staging', job, batches, batchesDone: from, rowsDone: rowsBefore(from) });
    const out = await runStaging(
      batches,
      from,
      (rows) => stageRows(job.job_id, rows),
      (p) => setUpload({ kind: 'staging', job, batches, ...p }),
    );
    void refreshJob(job.job_id);
    if (out.kind === 'done') {
      setUpload({
        kind: 'done',
        job,
        batches,
        batchesDone: batches.length,
        rowsDone: rowsBefore(batches.length),
        last: out.last,
      });
    } else if (out.error.code !== 'CANCELLED') {
      setUpload({
        kind: 'stage-failed',
        job,
        batches,
        batchesDone: out.failedBatch,
        rowsDone: rowsBefore(out.failedBatch),
        error: out.error,
        resumable: out.resumable,
      });
    }
  };

  const start = async () => {
    if (!canStart || !dataset || !file || !templateData) return;
    const payload = {
      dataset,
      yearId: needsYear ? yearId : null,
      fileName: file.name,
      fingerprint: file.fingerprint,
      mapping: mappingRecord(file.sheet.headers, mapping) as unknown as Json,
    };
    const operationId = tracker.idFor(payload);
    setUpload({ kind: 'starting' });
    let job: StartImportResult;
    try {
      job = await startImportJob({ operationId, ...payload });
      tracker.succeeded();
    } catch (e) {
      tracker.failed(e);
      const error = toAppError(e);
      if (error.code !== 'CANCELLED') setUpload({ kind: 'start-failed', error });
      return;
    }
    await stageFrom(job, batchRows(buildStageRows(file.sheet, mapping)), 0);
  };

  const resume = () => {
    if (upload.kind !== 'stage-failed') return;
    void stageFrom(upload.job, upload.batches, upload.batchesDone);
  };

  const startOver = () => {
    setUpload({ kind: 'idle' });
    setFileState({ kind: 'empty' });
    setEdited(null);
  };

  const years = useMemo(() => snapshot.data?.academic_years ?? [], [snapshot.data]);
  const totalRows = file?.sheet.rows.length ?? 0;
  const job = 'job' in upload ? upload.job : null;
  const earlier = job?.same_file_before[0];

  return (
    <div className="space-y-4">
      <PageHeader
        title="New import"
        description="Nothing is added to the school's records until you review the rows and choose Import."
        actions={
          <Button variant="outline" asChild>
            <Link to="/imports">Back to imports</Link>
          </Button>
        }
      />

      <Step n={1} title="Choose what to import">
        <DatasetStep dataset={dataset} onDataset={setDataset} locked={locked} />
        {dataset && needsYear && (
          <DataState query={snapshot}>
            {() =>
              years.length === 0 ? (
                <p className="text-sm">Create an academic year in School setup first.</p>
              ) : (
                <div className={locked ? 'pointer-events-none opacity-60' : undefined}>
                  <YearSelect years={years} value={yearId} onChange={setYearId} />
                </div>
              )
            }
          </DataState>
        )}
      </Step>

      {dataset && (
        <Step
          n={2}
          title="Get the template (optional)"
          description="Use it for a new file, or match your own file's columns in step 4."
        >
          <DataState query={template}>{(t) => <TemplateStep template={t} />}</DataState>
        </Step>
      )}

      {dataset && (
        <Step n={3} title="Upload your file">
          <UploadStep state={fileState} onFile={(f) => void onFile(f)} locked={locked} />
        </Step>
      )}

      {dataset && file && templateData && (
        <Step
          n={4}
          title="Match the columns"
          description="Columns are matched by their heading. Change any that are wrong; columns set to “Don't import” are ignored."
        >
          <MappingStep
            sheet={file.sheet}
            template={templateData}
            mapping={mapping}
            onChange={setMapping}
            locked={locked}
          />
        </Step>
      )}

      {dataset && file && templateData && (
        <Step
          n={5}
          title="Check the rows"
          description="The rows are uploaded and checked. Nothing is imported yet."
        >
          {upload.kind === 'idle' || upload.kind === 'start-failed' || upload.kind === 'starting' ? (
            <div className="space-y-3">
              <p className="text-sm">
                {totalRows.toLocaleString('en-IN')} row{totalRows === 1 ? '' : 's'} will be checked
                {needsYear && yearId
                  ? ` for ${years.find((y) => y.id === yearId)?.name ?? 'the chosen year'}`
                  : ''}
                .
              </p>
              {upload.kind === 'start-failed' && <ErrorText error={upload.error} />}
              <Button onClick={() => void start()} disabled={!canStart}>
                {upload.kind === 'starting'
                  ? 'Starting…'
                  : upload.kind === 'start-failed'
                    ? 'Try again'
                    : 'Upload rows for checking'}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {earlier && (
                <div
                  role="status"
                  className="flex gap-2 rounded-md border border-amber-600/50 bg-amber-50 p-3 text-sm dark:bg-amber-950/30"
                >
                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <p>
                    This file was imported on {formatDateTime(earlier.created_at)}. Importing again won&apos;t
                    create duplicates.
                  </p>
                </div>
              )}
              <ProgressBar
                value={upload.rowsDone}
                max={totalRows}
                label={`Uploaded ${upload.rowsDone.toLocaleString('en-IN')} of ${totalRows.toLocaleString('en-IN')} rows`}
              />
              {upload.kind === 'stage-failed' && (
                <div className="space-y-2">
                  <ErrorText error={upload.error} />
                  {upload.resumable ? (
                    <Button onClick={resume}>Continue uploading</Button>
                  ) : (
                    <Button variant="outline" onClick={startOver}>
                      Start over
                    </Button>
                  )}
                </div>
              )}
              {upload.kind === 'done' && (
                <div className="space-y-3">
                  <p role="status" className="text-sm font-medium">
                    All {totalRows.toLocaleString('en-IN')} rows are uploaded and checked.
                    {upload.last &&
                      ` ${upload.last.counts.ready} ready, ${upload.last.counts.will_skip} already exist, ${upload.last.counts.needs_fixing} need fixing.`}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild>
                      <Link to={`/imports/${upload.job.job_id}`}>Review rows</Link>
                    </Button>
                    <Button variant="outline" onClick={startOver}>
                      Import another file
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </Step>
      )}

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(o) => !o && blocker.reset?.()}
        title="Leave before the upload finishes?"
        description="The rows uploaded so far stay in this import (it is listed under Imports), but the rest of your file will not be uploaded."
        confirmLabel="Leave"
        cancelLabel="Stay"
        onConfirm={() => blocker.proceed?.()}
      />
    </div>
  );
}
