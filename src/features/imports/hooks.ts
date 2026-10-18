import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImportDataset, ImportFilter } from '@/contracts/imports';
import type { Json } from '@/generated/database.types';
import {
  closeImport,
  commitImportChunk,
  getImportJob,
  getImportTemplate,
  listImportJobs,
  setImportRowRemoved,
  stageImportRows,
  startImport,
  updateImportRow,
} from '@/lib/rpc';
import { routeId } from '@/lib/errors';
import { useScopedKey } from '@/lib/scope';
import type { StageRow } from './mapping';

// Spreadsheet imports (brief M1b). Only server responses are cached (memory-only, scoped keys);
// parsed file rows live in the wizard's component state and never enter the query cache.

export const JOB_PAGE_SIZE = 100;
export const COMMIT_CHUNK = 100;

export function useImportJobs() {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('import-jobs'),
    queryFn: ({ signal }) => listImportJobs({ p_limit: 50 }, { signal }),
    staleTime: 0,
  });
}

export function useImportTemplate(dataset: ImportDataset | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('import-template', dataset),
    queryFn: ({ signal }) => getImportTemplate({ p_dataset: dataset! }, { signal }),
    enabled: dataset !== null,
    staleTime: 5 * 60_000,
  });
}

/** One job's rows for a filter, keyset-paged on row_no ("Load more"). */
export function useImportJob(jobId: string | undefined, filter: ImportFilter) {
  const key = useScopedKey();
  return useInfiniteQuery({
    queryKey: key('import-job', jobId, filter),
    initialPageParam: null as number | null,
    queryFn: ({ pageParam, signal }) =>
      getImportJob(
        {
          p_job_id: routeId(jobId),
          p_filter: filter,
          p_limit: JOB_PAGE_SIZE,
          ...(pageParam !== null ? { p_after_row_no: pageParam } : {}),
        },
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    staleTime: 0,
  });
}

// ------------------------------------------------------------------ wizard calls
// Plain async calls (not cached): the wizard tracks their progress and the operation id itself.

export function startImportJob(v: {
  operationId: string;
  dataset: ImportDataset;
  yearId: string | null;
  fileName: string;
  fingerprint: string;
  mapping: Json;
}) {
  return startImport({
    p_operation_id: v.operationId,
    p_dataset: v.dataset,
    // Staff imports have no academic year; the SQL takes null (generated type says string).
    p_academic_year_id: v.yearId as string,
    p_file_name: v.fileName,
    p_source_fingerprint: v.fingerprint,
    p_mapping: v.mapping,
  });
}

export function stageRows(jobId: string, rows: StageRow[]) {
  return stageImportRows({ p_job_id: jobId, p_rows: rows as unknown as Json });
}

export function commitChunk(jobId: string) {
  return commitImportChunk({ p_job_id: jobId, p_limit: COMMIT_CHUNK });
}

// ------------------------------------------------------------------ invalidation
/** After rows change: the job (every filter) and the history list. */
export function useRefreshJob() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return (jobId: string) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: key('import-job', jobId) }),
      qc.invalidateQueries({ queryKey: key('import-jobs') }),
    ]);
}

/** After any commit (brief §6): school records may have been created. */
export function useRefreshAfterCommit() {
  const key = useScopedKey();
  const qc = useQueryClient();
  const refreshJob = useRefreshJob();
  return (jobId: string) =>
    Promise.all([
      refreshJob(jobId),
      ...['setup', 'students', 'student', 'staff-list', 'staff', 'guardian', 'guardian-search'].map((f) =>
        qc.invalidateQueries({ queryKey: key(f) }),
      ),
    ]);
}

export function useUpdateImportRow(jobId: string) {
  const refresh = useRefreshJob();
  return useMutation({
    mutationFn: (v: { rowNo: number; data: Record<string, string> }) =>
      updateImportRow({ p_job_id: jobId, p_row_no: v.rowNo, p_data: v.data }),
    onSettled: () => refresh(jobId),
  });
}

export function useSetRowRemoved(jobId: string) {
  const refresh = useRefreshJob();
  return useMutation({
    mutationFn: (v: { rowNo: number; removed: boolean }) =>
      setImportRowRemoved({ p_job_id: jobId, p_row_no: v.rowNo, p_removed: v.removed }),
    onSettled: () => refresh(jobId),
  });
}

export function useCloseImport(jobId: string) {
  const refresh = useRefreshJob();
  return useMutation({
    mutationFn: () => closeImport({ p_job_id: jobId }),
    onSettled: () => refresh(jobId),
  });
}
