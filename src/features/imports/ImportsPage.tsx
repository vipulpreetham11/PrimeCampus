import { Link } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ImportJob } from '@/contracts/imports';
import { formatDateTime } from '@/lib/dates';
import { useImportJobs } from './hooks';
import { DATASETS, DATASET_ORDER, datasetLabel } from './labels';
import { JobStatusBadge } from './parts';

function countsLine(j: ImportJob): string {
  const c = j.counts;
  const parts = [
    c.created > 0 && `${c.created} imported`,
    c.will_skip + c.skipped > 0 && `${c.will_skip + c.skipped} already existed`,
    c.rejected > 0 && `${c.rejected} not imported`,
    c.needs_fixing > 0 && `${c.needs_fixing} need fixing`,
    c.ready > 0 && `${c.ready} ready`,
    c.removed > 0 && `${c.removed} removed`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'No rows';
}

export function ImportsPage() {
  const jobs = useImportJobs();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Imports"
        description="Bring existing records in from a spreadsheet (Excel .xlsx or CSV). Existing records are never changed by an import."
        actions={
          <Button asChild>
            <Link to="/imports/new">New import</Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recommended order</CardTitle>
          <CardDescription>Each import needs the records of the steps before it.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-1 pl-5 text-sm" aria-label="Recommended import order">
            {DATASET_ORDER.map((d) => (
              <li key={d}>
                <span className="font-medium">{DATASETS[d].label}</span>
                {d === 'staff' && (
                  <span className="text-muted-foreground"> — staff groups must exist first</span>
                )}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <section aria-labelledby="import-history" className="space-y-3">
        <h2 id="import-history" className="text-lg font-semibold">
          Import history
        </h2>
        <DataState
          query={jobs}
          isEmpty={(d) => d.length === 0}
          emptyTitle="No imports yet"
          emptyDescription="Start with Classes & sections."
        >
          {(list) => (
            <ul className="bg-background divide-y rounded-md border" aria-label="Imports">
              {list.map((j) => (
                <li key={j.job_id} data-testid={`import-job-${j.job_id}`}>
                  <Link to={`/imports/${j.job_id}`} className="hover:bg-muted/50 flex flex-col gap-1 p-3">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{datasetLabel(j.dataset)}</span>
                      <JobStatusBadge status={j.status} />
                    </span>
                    <span className="text-sm break-all">
                      {j.file_name ?? 'Unnamed file'}
                      {j.academic_year ? ` · ${j.academic_year}` : ''}
                    </span>
                    <span className="text-muted-foreground text-sm">{countsLine(j)}</span>
                    <span className="text-muted-foreground text-xs">
                      {j.created_by ?? 'Unknown user'} · {formatDateTime(j.created_at)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </DataState>
      </section>
    </div>
  );
}
