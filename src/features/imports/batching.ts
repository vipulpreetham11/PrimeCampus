import type { StageRow } from './mapping';

/** stage_import_rows accepts 1–500 rows per call. */
export const STAGE_MAX_ROWS = 500;
/**
 * The server refuses more than 1 MB of row data per call; stay well under it (approved plan:
 * ~900 KB of JSON text per batch).
 */
export const STAGE_MAX_BYTES = 900_000;

const encoder = new TextEncoder();

/** Split rows into upload batches of ≤ maxRows rows and ≤ maxBytes of JSON, keeping row order. */
export function batchRows(
  rows: StageRow[],
  maxRows: number = STAGE_MAX_ROWS,
  maxBytes: number = STAGE_MAX_BYTES,
): StageRow[][] {
  const batches: StageRow[][] = [];
  let current: StageRow[] = [];
  let bytes = 2; // "[]"
  for (const row of rows) {
    const size = encoder.encode(JSON.stringify(row)).length + 1; // + comma
    if (current.length > 0 && (current.length >= maxRows || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 2;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
