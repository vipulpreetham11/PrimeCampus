// Bulk roster state shared by student attendance, staff attendance and homework checking (M2).
//
// Each row holds what the server last said (`server`, null = Unmarked / Unchecked) and the user's
// unsaved change (`draft`). A row is in exactly one state:
//   unmarked  — nothing recorded and nothing chosen (never shown as present/absent or "not completed")
//   marked    — recorded on the server, no local change
//   changed   — the user chose a value that is not saved yet
//   conflict  — the server refused the change because someone else changed the row first
//
// Optimistic concurrency (CLAUDE.md rule 5): a draft remembers the version the user saw when they
// started changing the row (`baseVersion`). That version — not a newer one picked up by a refetch —
// is what the save sends, so another person's change is always reported as a conflict instead of
// being silently overwritten. Nothing here touches browser storage (rule 12).

export type RowState = 'unmarked' | 'marked' | 'changed' | 'conflict';

export interface ServerValue<V> {
  value: V | null;
  version: number | null;
}

export interface RosterRow<V> {
  id: string;
  server: ServerValue<V>;
  draft: V | null;
  /** Version the draft was based on (null = the row was unmarked when the user changed it). */
  baseVersion: number | null;
  /** Set when the last save was refused for this row: the value someone else saved. */
  conflict: { value: V | null; version: number | null } | null;
}

export interface Roster<V> {
  order: string[];
  rows: Record<string, RosterRow<V>>;
}

export type Equals<V> = (a: V | null, b: V | null) => boolean;

export const strictEquals: Equals<unknown> = (a, b) => a === b;

export function rowState<V>(row: RosterRow<V>): RowState {
  if (row.conflict) return 'conflict';
  if (row.draft !== null) return 'changed';
  return row.server.value === null ? 'unmarked' : 'marked';
}

/** The value to show: the draft if there is one, else the server's. */
export function shownValue<V>(row: RosterRow<V>): V | null {
  return row.draft ?? row.server.value;
}

export function emptyRoster<V>(): Roster<V> {
  return { order: [], rows: {} };
}

/**
 * Merge a fresh server read. Drafts survive a reload (a failed save never drops marks); a draft
 * that now equals the server's value is done and is dropped, unless it is part of a conflict the
 * user has not resolved yet.
 */
export function loadRoster<V>(
  previous: Roster<V>,
  serverRows: { id: string; value: V | null; version: number | null }[],
  equals: Equals<V>,
): Roster<V> {
  const rows: Record<string, RosterRow<V>> = {};
  for (const s of serverRows) {
    const old = previous.rows[s.id];
    const server = { value: s.value, version: s.version };
    if (!old || (old.draft === null && !old.conflict)) {
      rows[s.id] = { id: s.id, server, draft: null, baseVersion: null, conflict: null };
      continue;
    }
    if (old.conflict) {
      // keep the conflict visible with the latest value someone else saved
      rows[s.id] = { ...old, server, conflict: { value: s.value, version: s.version } };
      continue;
    }
    if (equals(old.draft, s.value)) {
      rows[s.id] = { id: s.id, server, draft: null, baseVersion: null, conflict: null };
      continue;
    }
    rows[s.id] = { ...old, server };
  }
  return { order: serverRows.map((r) => r.id), rows };
}

/** The user picks a value for one row. Picking the saved value again clears the change. */
export function setValue<V>(roster: Roster<V>, id: string, value: V, equals: Equals<V>): Roster<V> {
  const row = roster.rows[id];
  if (!row) return roster;
  let next: RosterRow<V>;
  if (row.conflict) {
    // still a conflict: the user is choosing what to re-apply
    next = { ...row, draft: value };
  } else if (equals(value, row.server.value)) {
    next = { ...row, draft: null, baseVersion: null };
  } else {
    next = { ...row, draft: value, baseVersion: row.draft !== null ? row.baseVersion : row.server.version };
  }
  return { ...roster, rows: { ...roster.rows, [id]: next } };
}

/** "Mark remaining present": every row with nothing recorded and nothing chosen gets `value`. */
export function fillUnmarked<V>(roster: Roster<V>, value: V): Roster<V> {
  const rows = { ...roster.rows };
  for (const id of roster.order) {
    const row = rows[id];
    if (row && rowState(row) === 'unmarked') rows[id] = { ...row, draft: value, baseVersion: null };
  }
  return { ...roster, rows };
}

/** Discard every unsaved change (conflicts included). */
export function discardChanges<V>(roster: Roster<V>): Roster<V> {
  const rows: Record<string, RosterRow<V>> = {};
  for (const id of roster.order) {
    const row = roster.rows[id];
    if (row) rows[id] = { ...row, draft: null, baseVersion: null, conflict: null };
  }
  return { ...roster, rows };
}

/** Conflict resolution: apply my value over theirs (sent with their version on the next save). */
export function reapplyMine<V>(roster: Roster<V>, id: string): Roster<V> {
  const row = roster.rows[id];
  if (!row?.conflict) return roster;
  const next: RosterRow<V> = { ...row, baseVersion: row.conflict.version, conflict: null };
  return { ...roster, rows: { ...roster.rows, [id]: next } };
}

/** Conflict resolution: keep what the other person saved. */
export function keepTheirs<V>(roster: Roster<V>, id: string): Roster<V> {
  const row = roster.rows[id];
  if (!row?.conflict) return roster;
  const next: RosterRow<V> = {
    ...row,
    server: { value: row.conflict.value, version: row.conflict.version },
    draft: null,
    baseVersion: null,
    conflict: null,
  };
  return { ...roster, rows: { ...roster.rows, [id]: next } };
}

/** Rows with an unsaved change that can be sent (conflicts wait for the user's decision). */
export function pendingRows<V>(roster: Roster<V>): RosterRow<V>[] {
  return roster.order
    .map((id) => roster.rows[id])
    .filter((r): r is RosterRow<V> => r !== undefined && r.draft !== null && r.conflict === null);
}

export function countStates<V>(roster: Roster<V>): Record<RowState, number> {
  const counts: Record<RowState, number> = { unmarked: 0, marked: 0, changed: 0, conflict: 0 };
  for (const id of roster.order) {
    const row = roster.rows[id];
    if (row) counts[rowState(row)] += 1;
  }
  return counts;
}

export function hasUnsaved<V>(roster: Roster<V>): boolean {
  return roster.order.some((id) => {
    const row = roster.rows[id];
    return row !== undefined && (row.draft !== null || row.conflict !== null);
  });
}

/**
 * Record the server's answer to a save of `sent` rows: conflicted rows keep the draft and show the
 * other person's value; the rest are saved (the server value becomes the draft, version unknown
 * until the reload that follows).
 */
export function applySaveResult<V>(
  roster: Roster<V>,
  sentIds: string[],
  conflicts: { id: string; value: V | null; version: number | null }[],
): Roster<V> {
  const rows = { ...roster.rows };
  const conflicted = new Map(conflicts.map((c) => [c.id, c]));
  for (const id of sentIds) {
    const row = rows[id];
    if (!row) continue;
    const c = conflicted.get(id);
    if (c) {
      rows[id] = { ...row, conflict: { value: c.value, version: c.version } };
    } else if (row.draft !== null) {
      rows[id] = {
        ...row,
        server: { value: row.draft, version: row.server.version },
        draft: null,
        baseVersion: null,
      };
    }
  }
  return { ...roster, rows };
}

/** Split into batches of at most `size` (the RPCs accept 100 students / 200 staff per call). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
