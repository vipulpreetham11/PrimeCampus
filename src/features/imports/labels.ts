import type { Capability } from '@/contracts/capabilities';
import type { ImportCounts, ImportDataset, ImportFilter, ImportRow } from '@/contracts/imports';

// Plain-English labels for datasets, statuses and filters. Column labels always come from the
// server template; only the identifying keys shown in the preview table are chosen here.

export interface DatasetInfo {
  label: string;
  description: string;
  /** commit_import_chunk also checks this capability for the dataset (migration 2000). */
  commitCapability: Capability;
  /** Canonical keys shown in the preview table to identify a row (2–4). */
  identifyingKeys: string[];
}

export const DATASETS: Record<ImportDataset, DatasetInfo> = {
  classes_sections: {
    label: 'Classes & sections',
    description: 'Classes for the school and their sections in one academic year.',
    commitCapability: 'setup.manage',
    identifyingKeys: ['class_name', 'section_name', 'capacity'],
  },
  staff: {
    label: 'Staff',
    description: 'Staff records. Staff groups must exist first (Staff → Staff groups).',
    commitCapability: 'staff.manage',
    identifyingKeys: ['employee_no', 'full_name', 'staff_group'],
  },
  students_guardians: {
    label: 'Students & parents',
    description: 'Students with their parents, placed in a class section of the chosen year.',
    commitCapability: 'students.manage',
    identifyingKeys: ['admission_no', 'full_name', 'class_name', 'section_name'],
  },
  placements: {
    label: 'Placements (later years)',
    description: 'Places existing students in sections of another academic year.',
    commitCapability: 'students.manage',
    identifyingKeys: ['admission_no', 'class_name', 'section_name', 'roll_no'],
  },
};

export const DATASET_ORDER: ImportDataset[] = [
  'classes_sections',
  'staff',
  'students_guardians',
  'placements',
];

export function datasetLabel(d: string): string {
  return (DATASETS as Record<string, DatasetInfo | undefined>)[d]?.label ?? d;
}

const JOB_STATUS: Record<string, string> = {
  validating: 'In preview',
  committing: 'Open — rows imported',
  completed: 'Closed — all done',
  partially_completed: 'Closed — some rows not imported',
  cancelled: 'Closed — nothing imported',
  failed: 'Failed',
};
export const jobStatusLabel = (s: string) => JOB_STATUS[s] ?? s;

export const FILTER_LABELS: Record<ImportFilter, string> = {
  all: 'All rows',
  ready: 'Ready',
  will_skip: 'Already exist',
  needs_fixing: 'Needs fixing',
  created: 'Imported',
  skipped: 'Skipped (already existed)',
  rejected: 'Not imported',
  removed: 'Removed',
};

export function filterCount(f: ImportFilter, c: ImportCounts): number | null {
  if (f === 'all') return null;
  return c[f];
}

export type RowState =
  'ready' | 'will_skip' | 'needs_fixing' | 'pending' | 'created' | 'skipped' | 'rejected' | 'removed';

/** The row's state as the server's filters define it (errors include in-file duplicates). */
export function rowState(r: ImportRow): RowState {
  if (r.status === 'removed') return 'removed';
  if (r.status === 'rejected') return 'rejected';
  if (r.status === 'pending') return 'pending';
  if (r.status === 'committed') return r.action === 'skip' ? 'skipped' : 'created';
  if (r.errors.length > 0) return 'needs_fixing';
  return r.action === 'skip' ? 'will_skip' : 'ready';
}

export const ROW_STATE_LABELS: Record<RowState, string> = {
  ready: 'Ready',
  will_skip: 'Already exists — nothing will change',
  needs_fixing: 'Needs fixing',
  pending: 'Being imported',
  created: 'Imported',
  skipped: 'Already existed — nothing changed',
  rejected: 'Not imported',
  removed: 'Removed',
};

/** Rows the server can still import or confirm as existing. */
export const pendingCount = (c: ImportCounts) => c.ready + c.will_skip;
/** Everything is settled only when nothing is ready, waiting for a fix, or rejected. */
export const allDone = (c: ImportCounts) =>
  c.ready + c.will_skip + c.needs_fixing + c.rejected === 0 && c.created + c.skipped > 0;
