import { useCallback, useState } from 'react';
import { isAppError } from './errors';

// Idempotency keys (CLAUDE.md rule 4): ONE uuid per user action. Create it when the
// form/action starts, reuse it for every retry of that action, reset it only after success.

export function newOperationId(): string {
  return crypto.randomUUID();
}

export interface OperationId {
  /** Stable across re-renders and retries until `reset()` is called. */
  operationId: string;
  /** Call after the server confirmed success (or when the user starts a genuinely new action). */
  reset: () => void;
}

export function useOperationId(): OperationId {
  const [operationId, setOperationId] = useState(newOperationId);
  const reset = useCallback(() => setOperationId(newOperationId()), []);
  return { operationId, reset };
}

/**
 * Errors after which the server certainly did not perform this action (or refused this id): the next
 * attempt is a new action with a new id. Anything else (UNKNOWN, NETWORK, TEMPORARILY_UNAVAILABLE, …)
 * may have been applied, so the id is kept and a retry of the same payload resumes it.
 */
const DEFINITE_REFUSALS: ReadonlySet<string> = new Set([
  'VALIDATION_ERROR',
  'FORBIDDEN',
  'DUPLICATE',
  'NOT_FOUND',
  'CONFLICT',
  'LIMIT_REACHED',
]);

export function isDefiniteRefusal(error: unknown): boolean {
  return isAppError(error) && DEFINITE_REFUSALS.has(error.code);
}

/**
 * Operation id for one user action whose outcome may be uncertain (provision, admit, placement move).
 *  - `idFor(payload)` returns the id to send. After an uncertain failure, the same payload gets the same
 *    id (the server resumes or replays); a changed payload gets a new id (it is a different action).
 *  - `succeeded()` / `failed(error)` record the outcome; only success or a definite refusal renews the id.
 * Plain mutable object: keep one per form (useOperationTracker) or lift it to a parent that outlives
 * the form when the form can be closed and reopened.
 */
export class OperationTracker {
  private id = newOperationId();
  private payloadKey: string | null = null;

  idFor(payload: unknown): string {
    const key = JSON.stringify(payload);
    if (this.payloadKey !== null && this.payloadKey !== key) this.id = newOperationId();
    this.payloadKey = key;
    return this.id;
  }

  succeeded(): void {
    this.renew();
  }

  /**
   * `keep` lists codes that are NOT a refusal for this particular call, e.g. post_collection's CONFLICT
   * ("this payment is already being saved" = the same id is still in flight): the id must survive.
   */
  failed(error: unknown, options: { keep?: readonly string[] } = {}): void {
    if (isAppError(error) && options.keep?.includes(error.code)) return;
    if (isDefiniteRefusal(error)) this.renew();
  }

  /** The id a retry of the last payload will use (for display/tests; does not change anything). */
  get currentId(): string {
    return this.id;
  }

  /** The user abandons an unconfirmed action (after checking it did not happen): start fresh. */
  discard(): void {
    this.renew();
  }

  private renew(): void {
    this.id = newOperationId();
    this.payloadKey = null;
  }
}

export function useOperationTracker(): OperationTracker {
  const [tracker] = useState(() => new OperationTracker());
  return tracker;
}
