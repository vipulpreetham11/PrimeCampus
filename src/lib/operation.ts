import { useCallback, useState } from 'react';

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
