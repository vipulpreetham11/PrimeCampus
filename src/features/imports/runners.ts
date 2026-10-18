import type { CommitChunkResult, ImportJob, StageResult } from '@/contracts/imports';
import { toAppError, type AppError } from '@/lib/errors';
import type { StageRow } from './mapping';

// Upload (stage) and commit loops, kept free of React so they can be unit-tested (brief §2.5, §4).

/** The call may have reached the server: the user is offered "Continue", which is always safe. */
export function isUncertain(e: AppError): boolean {
  return (
    e.code === 'NETWORK' ||
    e.code === 'UNKNOWN' ||
    e.code === 'TEMPORARILY_UNAVAILABLE' ||
    e.code === 'CANCELLED'
  );
}

// ------------------------------------------------------------------ staging
export interface StageProgress {
  batchesDone: number;
  rowsDone: number;
}

export type StageOutcome =
  | { kind: 'done'; last: StageResult | null }
  | { kind: 'failed'; error: AppError; failedBatch: number; resumable: boolean };

/**
 * Send batches[from..] in order. Re-staging a batch replaces its draft rows, so "Continue" after
 * a failure re-sends from the failed batch.
 */
export async function runStaging(
  batches: StageRow[][],
  from: number,
  stage: (rows: StageRow[]) => Promise<StageResult>,
  onProgress: (p: StageProgress) => void,
): Promise<StageOutcome> {
  let last: StageResult | null = null;
  let rowsDone = batches.slice(0, from).reduce((n, b) => n + b.length, 0);
  for (let i = from; i < batches.length; i += 1) {
    const batch = batches[i]!;
    try {
      last = await stage(batch);
    } catch (e) {
      const error = toAppError(e);
      return { kind: 'failed', error, failedBatch: i, resumable: isUncertain(error) };
    }
    rowsDone += batch.length;
    onProgress({ batchesDone: i + 1, rowsDone });
  }
  return { kind: 'done', last };
}

// ------------------------------------------------------------------ commit
export interface CommitTally {
  created: number;
  skipped: number;
  rejected: number;
  needsFixing: number;
}

export const emptyTally = (): CommitTally => ({ created: 0, skipped: 0, rejected: 0, needsFixing: 0 });

export type CommitOutcome =
  /** No ready rows left. */
  | { kind: 'finished'; job: ImportJob; tally: CommitTally }
  /** The server still reports ready rows but a chunk processed none: stop instead of looping. */
  | { kind: 'stalled'; job: ImportJob; tally: CommitTally }
  /** The call may have committed rows: "Some rows may already be imported — Continue to resume". */
  | { kind: 'uncertain'; error: AppError; tally: CommitTally; job: ImportJob | null }
  /** A definite refusal (permission, closed import, …). */
  | { kind: 'failed'; error: AppError; tally: CommitTally; job: ImportJob | null };

/** 10,000 rows / 100 per chunk = 100 chunks; anything beyond that is treated as no progress. */
const MAX_CHUNKS = 150;

/**
 * Call commit_import_chunk while `more_ready`. Committing again never duplicates anything, so a
 * resumed loop simply continues where the server is.
 */
export async function runCommitLoop(
  commit: () => Promise<CommitChunkResult>,
  onChunk: (tally: CommitTally, result: CommitChunkResult) => void,
  maxChunks: number = MAX_CHUNKS,
): Promise<CommitOutcome> {
  const tally = emptyTally();
  let job: ImportJob | null = null;
  for (let i = 0; i < maxChunks; i += 1) {
    let r: CommitChunkResult;
    try {
      r = await commit();
    } catch (e) {
      const error = toAppError(e);
      return isUncertain(error)
        ? { kind: 'uncertain', error, tally, job }
        : { kind: 'failed', error, tally, job };
    }
    job = r.job;
    for (const p of r.processed) {
      if (p.outcome === 'created') tally.created += 1;
      else if (p.outcome === 'skipped') tally.skipped += 1;
      else if (p.outcome === 'rejected') tally.rejected += 1;
      else tally.needsFixing += 1;
    }
    onChunk({ ...tally }, r);
    if (!r.more_ready) return { kind: 'finished', job, tally };
    if (r.processed.length === 0) return { kind: 'stalled', job, tally };
  }
  return { kind: 'stalled', job: job!, tally };
}
