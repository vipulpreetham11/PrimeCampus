import { useCallback, useRef, useState } from 'react';
import { isUncertainFailure } from '@/lib/create-check';
import { isAppError, toAppError, type AppError } from '@/lib/errors';
import { useOperationTracker } from '@/lib/operation';

// One money action with an operation id (CLAUDE.md rule 4, brief "money rules"):
//  - the id comes from an OperationTracker: the same payload after an uncertain failure gets the same
//    id (the server replays or resumes it); success or a definite refusal renews it;
//  - an uncertain failure (offline, timeout, unexpected reply — and any code in `keep`, e.g.
//    post_collection's CONFLICT "already being saved") freezes the payload: "Not confirmed". The only
//    ways on are "Try again" (the identical payload, so the identical id) or "Discard", which the
//    user chooses after checking the statement;
//  - nothing is retried automatically.

export type MoneyActionState<R> =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'unconfirmed'; error: AppError }
  | { kind: 'failed'; error: AppError }
  | { kind: 'done'; result: R };

export interface MoneyAction<P, R> {
  state: MoneyActionState<R>;
  /** Send a payload (ignored while saving or while an earlier payload is unconfirmed). */
  run: (payload: P) => Promise<R | null>;
  /** Re-send the frozen payload with the same operation id. */
  retry: () => Promise<R | null>;
  /** Abandon the unconfirmed payload (after checking it did not happen); the next run gets a new id. */
  discard: () => void;
  /** Back to idle after a definite failure or after a success was shown. */
  reset: () => void;
  /** The frozen payload of an unconfirmed attempt. */
  pending: P | null;
}

export function useMoneyAction<P, R>(
  send: (operationId: string, payload: P) => Promise<R>,
  options: { keep?: readonly string[] } = {},
): MoneyAction<P, R> {
  const tracker = useOperationTracker();
  const [state, setState] = useState<MoneyActionState<R>>({ kind: 'idle' });
  const [pending, setPending] = useState<P | null>(null);
  const busy = useRef(false);
  const keep = options.keep;

  const attempt = useCallback(
    async (payload: P): Promise<R | null> => {
      if (busy.current) return null;
      busy.current = true;
      setState({ kind: 'saving' });
      const operationId = tracker.idFor(payload);
      try {
        const result = await send(operationId, payload);
        tracker.succeeded();
        setPending(null);
        setState({ kind: 'done', result });
        return result;
      } catch (e) {
        const error = toAppError(e);
        tracker.failed(error, { keep });
        const uncertain =
          isUncertainFailure(error) || (isAppError(error) && (keep ?? []).includes(error.code));
        if (uncertain) {
          setPending(payload);
          setState({ kind: 'unconfirmed', error });
        } else {
          setPending(null);
          setState({ kind: 'failed', error });
        }
        return null;
      } finally {
        busy.current = false;
      }
    },
    [send, tracker, keep],
  );

  const run = useCallback(
    (payload: P) => (pending !== null ? Promise.resolve(null) : attempt(payload)),
    [attempt, pending],
  );
  const retry = useCallback(
    () => (pending === null ? Promise.resolve(null) : attempt(pending)),
    [attempt, pending],
  );
  const discard = useCallback(() => {
    tracker.discard();
    setPending(null);
    setState({ kind: 'idle' });
  }, [tracker]);
  const reset = useCallback(() => {
    if (pending === null) setState({ kind: 'idle' });
  }, [pending]);

  return { state, run, retry, discard, reset, pending };
}
