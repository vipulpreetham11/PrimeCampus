import { useCallback, useRef, useState } from 'react';
import { toAppError } from './errors';

// Creates that carry no operation id (save_homework create, copy_timetable): after an uncertain
// failure the server may have made the row anyway, so pressing Save again could make a second one.
// Instead the screen looks for the row first: found → it was saved; not found → the user may try
// again; the look-up itself failing → still unconfirmed, and the user can only check again.

const UNCERTAIN: ReadonlySet<string> = new Set(['NETWORK', 'UNKNOWN', 'TEMPORARILY_UNAVAILABLE']);

/** The request may or may not have been applied (offline, timeout, unexpected reply). */
export function isUncertainFailure(error: unknown): boolean {
  return UNCERTAIN.has(toAppError(error).code);
}

export type CreateCheckState = 'idle' | 'checking' | 'not_saved' | 'unconfirmed';

export interface CreateCheck {
  state: CreateCheckState;
  /** Save must stay disabled: we don't know yet whether the last attempt made the row. */
  blocksRetry: boolean;
  /** Start looking for the row the failed request may have made. */
  verify: <R>(find: () => Promise<R | null>, onFound: (row: R) => void) => void;
  /** Run the last look-up again (after it failed too). */
  checkAgain: () => void;
  reset: () => void;
}

export function useCreateCheck(): CreateCheck {
  const [state, setState] = useState<CreateCheckState>('idle');
  const last = useRef<(() => Promise<void>) | null>(null);

  const verify = useCallback(<R>(find: () => Promise<R | null>, onFound: (row: R) => void) => {
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
      } catch {
        setState('unconfirmed');
      }
    };
    last.current = attempt;
    void attempt();
  }, []);

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
