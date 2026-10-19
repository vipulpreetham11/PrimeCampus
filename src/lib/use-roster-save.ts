import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { isDefiniteRefusal, OperationTracker } from './operation';
import { toAppError, type AppError } from './errors';
import {
  applySaveResult,
  chunk,
  emptyRoster,
  loadRoster,
  pendingRows,
  type Equals,
  type Roster,
  type RosterRow,
} from './roster';

// Saving a roster (attendance, staff attendance, homework checks). One operation id per save action
// and batch (CLAUDE.md rule 4): an uncertain failure (offline, timeout, unknown) keeps the id and
// the unsaved marks, so "Retry" resends exactly the same request; only success or a definite
// refusal starts a new id. Marks are never dropped on failure and never written to storage.
// A batch's tracker is keyed by the batch's row ids, not its position: once earlier batches have
// saved, the retry of a failed batch is the first batch, and it must still get its own id back.

export type SavePhase = 'idle' | 'saving' | 'saved' | 'not_saved' | 'refused';

export interface RosterConflict<V> {
  id: string;
  value: V | null;
  version: number | null;
}

export interface RosterSaveOptions<V> {
  setRoster: Dispatch<SetStateAction<Roster<V>>>;
  /** Server batch limit (100 students / 200 staff). */
  batchSize: number;
  /** Send one batch with its operation id; resolve with the rows the server refused as conflicts. */
  send: (rows: RosterRow<V>[], operationId: string) => Promise<{ conflicts: RosterConflict<V>[] }>;
  /** The request body of a batch, used to recognise a retry of the same action. */
  payloadOf: (rows: RosterRow<V>[]) => unknown;
  /** Re-read the roster after a save (success or not), so versions and others' changes are current. */
  reload: () => Promise<unknown>;
}

export interface RosterSave<V> {
  phase: SavePhase;
  error: AppError | null;
  /** Rows refused as conflicts in the last save. */
  conflictCount: number;
  save: (roster: Roster<V>) => Promise<void>;
  /** Clear the "saved" / error banner (e.g. after the user changes something). */
  acknowledge: () => void;
}

export function useRosterSave<V>(options: RosterSaveOptions<V>): RosterSave<V> {
  const { setRoster, batchSize, send, payloadOf, reload } = options;
  const trackers = useRef(new Map<string, OperationTracker>());
  const [phase, setPhase] = useState<SavePhase>('idle');
  const [error, setError] = useState<AppError | null>(null);
  const [conflictCount, setConflictCount] = useState(0);

  const save = useCallback(
    async (roster: Roster<V>) => {
      const batches = chunk(pendingRows(roster), batchSize);
      if (batches.length === 0) return;
      setPhase('saving');
      setError(null);
      let conflicts = 0;
      let failure: AppError | null = null;
      for (const batch of batches) {
        const key = batchKey(batch);
        let tracker = trackers.current.get(key);
        if (!tracker) trackers.current.set(key, (tracker = new OperationTracker()));
        const operationId = tracker.idFor(payloadOf(batch));
        try {
          const result = await send(batch, operationId);
          tracker.succeeded();
          trackers.current.delete(key);
          conflicts += result.conflicts.length;
          setRoster((r) =>
            applySaveResult(
              r,
              batch.map((row) => row.id),
              result.conflicts,
            ),
          );
        } catch (e) {
          tracker.failed(e);
          failure = toAppError(e);
          break;
        }
      }
      setConflictCount(conflicts);
      await reload().catch(() => undefined);
      if (failure) {
        setError(failure);
        setPhase(isDefiniteRefusal(failure) ? 'refused' : 'not_saved');
      } else {
        setPhase('saved');
      }
    },
    [batchSize, payloadOf, reload, send, setRoster],
  );

  const acknowledge = useCallback(() => {
    setPhase((p) => (p === 'saving' ? p : 'idle'));
    setError(null);
  }, []);

  return { phase, error, conflictCount, save, acknowledge };
}

/** A batch's identity: its row ids, sorted and joined. */
export function batchKey(rows: { id: string }[]): string {
  return rows
    .map((r) => r.id)
    .sort()
    .join(',');
}

/**
 * Roster state that merges every new server read (`source` = the query data object) into the
 * user's unsaved changes, during render (no effect, no extra paint with stale rows).
 */
export function useServerRoster<V, S>(
  source: S,
  toRows: (source: S) => { id: string; value: V | null; version: number | null }[],
  equals: Equals<V>,
): [Roster<V>, Dispatch<SetStateAction<Roster<V>>>] {
  const [roster, setRoster] = useState<Roster<V>>(emptyRoster);
  const [synced, setSynced] = useState<S | null>(null);
  if (synced !== source) {
    setSynced(source);
    setRoster((r) => loadRoster(r, toRows(source), equals));
  }
  return [roster, setRoster];
}
