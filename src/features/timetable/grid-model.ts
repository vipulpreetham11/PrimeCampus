import type { TimetableConflict, TimetableEntry } from '@/contracts/timetable';
import type { DraftEntry } from './hooks';

// The timetable grid as plain data: one cell per (weekday, period). A cell without a subject has
// no lesson planned; a cell with a subject but no teacher is "Unassigned" (never a holiday).

export interface Cell {
  subject_id: string;
  staff_id: string | null;
}

export type Grid = ReadonlyMap<string, Cell>;

export function cellKey(weekday: number, slotOrdinal: number): string {
  return `${weekday}:${slotOrdinal}`;
}

export function gridFromEntries(
  entries: Pick<TimetableEntry, 'weekday' | 'slot_ordinal' | 'subject_id' | 'staff_id'>[],
): Grid {
  return new Map(
    entries.map((e) => [
      cellKey(e.weekday, e.slot_ordinal),
      { subject_id: e.subject_id, staff_id: e.staff_id },
    ]),
  );
}

/** Save payload entries, keeping only cells on period slots of the chosen bell schedule. */
export function entriesFromGrid(grid: Grid, periodOrdinals: ReadonlySet<number>): DraftEntry[] {
  const out: DraftEntry[] = [];
  for (const [key, cell] of grid) {
    const [wd, ord] = key.split(':').map(Number) as [number, number];
    if (!periodOrdinals.has(ord)) continue;
    out.push({ weekday: wd, slot_ordinal: ord, subject_id: cell.subject_id, staff_id: cell.staff_id });
  }
  return out.sort((a, b) => a.weekday - b.weekday || a.slot_ordinal - b.slot_ordinal);
}

/** Cells that would be dropped because their period is a break / missing in the chosen schedule. */
export function cellsOffSchedule(grid: Grid, periodOrdinals: ReadonlySet<number>): number {
  let n = 0;
  for (const key of grid.keys()) {
    const ord = Number(key.split(':')[1]);
    if (!periodOrdinals.has(ord)) n += 1;
  }
  return n;
}

export function setCell(grid: Grid, key: string, cell: Cell | null): Grid {
  const next = new Map(grid);
  if (cell) next.set(key, cell);
  else next.delete(key);
  return next;
}

export function sameGrid(a: Grid, b: Grid): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.subject_id !== v.subject_id || w.staff_id !== v.staff_id) return false;
  }
  return true;
}

/** Server conflicts grouped by cell. */
export function conflictsByCell(conflicts: TimetableConflict[]): Map<string, TimetableConflict[]> {
  const map = new Map<string, TimetableConflict[]>();
  for (const c of conflicts) {
    const key = cellKey(c.weekday, c.slot_ordinal);
    map.set(key, [...(map.get(key) ?? []), c]);
  }
  return map;
}

export interface GridCounts {
  /** weekday × period cells with no lesson planned */
  empty: number;
  /** lessons without a teacher */
  unassignedTeacher: number;
  planned: number;
}

export function gridCounts(grid: Grid, weekdays: number[], periodOrdinals: number[]): GridCounts {
  let empty = 0;
  let unassignedTeacher = 0;
  let planned = 0;
  for (const wd of weekdays) {
    for (const ord of periodOrdinals) {
      const cell = grid.get(cellKey(wd, ord));
      if (!cell) empty += 1;
      else {
        planned += 1;
        if (cell.staff_id === null) unassignedTeacher += 1;
      }
    }
  }
  return { empty, unassignedTeacher, planned };
}
