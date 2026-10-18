import { z } from 'zod';

// DTOs for the spreadsheet-import RPCs (migrations 2000 + 2100). Shapes follow the SQL exactly:
// private.imp_job_json, private.imp_row_json, get_import_template, start_import, stage_import_rows,
// update_import_row, set_import_row_removed, commit_import_chunk, close_import, list_import_jobs,
// get_import_job.

const id = z.guid();

export const IMPORT_DATASETS = ['classes_sections', 'staff', 'students_guardians', 'placements'] as const;
export type ImportDataset = (typeof IMPORT_DATASETS)[number];

/** Server filters of get_import_job. */
export const IMPORT_FILTERS = [
  'all',
  'ready',
  'will_skip',
  'needs_fixing',
  'created',
  'skipped',
  'rejected',
  'removed',
] as const;
export type ImportFilter = (typeof IMPORT_FILTERS)[number];

export const IMPORT_JOB_STATUSES = [
  'validating',
  'committing',
  'completed',
  'partially_completed',
  'cancelled',
  'failed',
] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];
const CLOSED: ReadonlySet<string> = new Set(['completed', 'partially_completed', 'cancelled', 'failed']);
export const isClosedJob = (status: string) => CLOSED.has(status);

export const templateColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  required: z.boolean(),
  example: z.string().optional(),
  max: z.number().int().optional(),
  hint: z.string().optional(),
  allowed: z.array(z.string()).optional(),
});
export type TemplateColumn = z.infer<typeof templateColumnSchema>;

export const importTemplateSchema = z.object({
  dataset: z.enum(IMPORT_DATASETS),
  columns: z.array(templateColumnSchema),
  needs_year: z.boolean(),
  max_rows: z.number().int(),
  max_rows_per_upload: z.number().int(),
  max_rows_per_commit: z.number().int(),
});
export type ImportTemplate = z.infer<typeof importTemplateSchema>;

export const importCountsSchema = z.object({
  total: z.number().int(),
  ready: z.number().int(),
  will_skip: z.number().int(),
  needs_fixing: z.number().int(),
  created: z.number().int(),
  skipped: z.number().int(),
  rejected: z.number().int(),
  removed: z.number().int(),
});
export type ImportCounts = z.infer<typeof importCountsSchema>;

export const importJobSchema = z.object({
  job_id: id,
  dataset: z.string(),
  academic_year_id: id.nullable(),
  academic_year: z.string().nullable(),
  file_name: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
  created_by: z.string().nullable(),
  updated_at: z.string(),
  counts: importCountsSchema,
});
export type ImportJob = z.infer<typeof importJobSchema>;

export const sameFileBeforeSchema = z.object({ job_id: id, created_at: z.string(), status: z.string() });

export const startImportResultSchema = importJobSchema.extend({
  replayed: z.boolean().optional(),
  same_file_before: z.array(sameFileBeforeSchema).default([]),
});
export type StartImportResult = z.infer<typeof startImportResultSchema>;

export const stageResultSchema = z.object({
  job_id: id,
  counts: importCountsSchema,
  already_committed_rows: z.array(z.number().int()),
});
export type StageResult = z.infer<typeof stageResultSchema>;

export const rowErrorSchema = z.object({ field: z.string().nullable(), message: z.string() });
export type RowError = z.infer<typeof rowErrorSchema>;

export const importRowSchema = z.object({
  row_no: z.number().int(),
  status: z.enum(['draft', 'committed', 'rejected', 'removed']),
  action: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  errors: z.array(rowErrorSchema),
  result_entity_id: id.nullable(),
  info: z.object({ note: z.string() }).nullable(),
});
export type ImportRow = z.infer<typeof importRowSchema>;

export const importJobPageSchema = z.object({
  job: importJobSchema,
  columns: z.array(templateColumnSchema),
  rows: z.array(importRowSchema),
  next_cursor: z.number().int().nullable(),
});
export type ImportJobPage = z.infer<typeof importJobPageSchema>;

export const rowChangeResultSchema = z.object({ row: importRowSchema, counts: importCountsSchema });
export type RowChangeResult = z.infer<typeof rowChangeResultSchema>;

export const processedRowSchema = z.object({
  row_no: z.number().int(),
  outcome: z.enum(['created', 'skipped', 'rejected', 'needs_fixing']),
  entity_id: id.nullable().optional(),
  error: z.string().optional(),
  errors: z.array(rowErrorSchema).optional(),
});
export type ProcessedRow = z.infer<typeof processedRowSchema>;

export const commitChunkResultSchema = z.object({
  job: importJobSchema,
  processed: z.array(processedRowSchema),
  more_ready: z.boolean(),
});
export type CommitChunkResult = z.infer<typeof commitChunkResultSchema>;
