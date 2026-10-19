import { useCallback, useRef, useState } from 'react';
import { isAppError, toAppError } from './errors';

// Creates that carry no operation id (save_homework create, copy_timetable, a new timetable draft):
// after an uncertain failure the server may have made the row anyway. Since migration 2310 the
// server refuses the same create a second time as DUPLICATE with the existing row's id, so the
// check simply sends the same request again: created now, or DUPLICATE → the earlier attempt
// worked; a request that fails uncertainly again → still unconfirmed, and the user can check again.

const UNCERTAIN: ReadonlySet<string> = new Set(['NETWORK', 'UNKNOWN', 'TEMPORARILY_UNAVAILABLE']);

/** The request may or may not have been applied (offline, timeout, unexpected reply). */
export function isUncertainFailure(error: unknown): boolean {
  return UNCERTAIN.has(toAppError(error).code);
}

/** The id a 2310 DUPLICATE names in `details[key]` (e.g. timetable_version_id, assignment_id), or null. */
export function duplicateIdOf(error: unknown, key: string): string | null {
  if (!isAppError(error) || error.code !== 'DUPLICATE') return null;
  const d = error.details;
  if (typeof d !== 'object' || d === null) return null;
  const v = (d as Record<string, unknown>)[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

export type CreatedOrExisting<R> =
  { created: R; existingId?: never } | { created?: never; existingId: string };

/** Send a create; a DUPLICATE naming the existing row (`details[key]`) resolves to that row's id. */
export async function createOrExisting<R>(
  send: () => Promise<R>,
  key: string,
): Promise<CreatedOrExisting<R>> {
  try {
    return { created: await send() };
  } catch (e) {
    const existingId = duplicateIdOf(toAppError(e), key);
    if (existingId) return { existingId };
    throw e;
  }
}

export type CreateCheckState = 'idle' | 'checking' | 'not_saved' | 'unconfirmed';

export interface CreateCheck {
  state: CreateCheckState;
  /** Save must stay disabled: we don't know yet whether the last attempt made the row. */
  blocksRetry: boolean;
  /**
   * Start looking for the row the failed request may have made. `find` failing with a definite
   * refusal (not an uncertain failure) ends the check and goes to `onRefused` when given.
   */
  verify: <R>(
    find: () => Promise<R | null>,
    onFound: (row: R) => void,
    onRefused?: (error: unknown) => void,
  ) => void;
  /** Run the last look-up again (after it failed too). */
  checkAgain: () => void;
  reset: () => void;
}

export function useCreateCheck(): CreateCheck {
  const [state, setState] = useState<CreateCheckState>('idle');
  const last = useRef<(() => Promise<void>) | null>(null);

  const verify = useCallback(
    <R>(find: () => Promise<R | null>, onFound: (row: R) => void, onRefused?: (error: unknown) => void) => {
      const attempt = async () => {
        setState('checking');
        try {
          const row = await find();
          last.current = null;
          if (row === null) {
            setState('not_saved');
          } else {
            setState('idle');
            onFound(row);
          }
        } catch (e) {
          if (onRefused && !isUncertainFailure(e)) {
            last.current = null;
            setState('idle');
            onRefused(e);
          } else {
            setState('unconfirmed');
          }
        }
      };
      last.current = attempt;
      void attempt();
    },
    [],
  );

  const checkAgain = useCallback(() => void last.current?.(), []);
  const reset = useCallback(() => {
    last.current = null;
    setState('idle');
  }, []);

  return {
    state,
    blocksRetry: state === 'checking' || state === 'unconfirmed',
    verify,
    checkAgain,
    reset,
  };
}
