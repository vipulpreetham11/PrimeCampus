import { toast } from 'sonner';
import { isAppError, safeMessage, toAppError, type AppError } from './errors';

/**
 * Standard handling for a failed save (CLAUDE.md rules 3 and 5):
 *  - CONFLICT → reload the record (caller's `reload`) and tell the user to redo the change
 *  - everything else → returned as an AppError for inline display (the form keeps the user's input)
 */
export function handleSaveError(error: unknown, options: { reload?: () => unknown } = {}): AppError {
  const err = toAppError(error);
  if (err.code === 'CONFLICT') {
    void options.reload?.();
    toast.warning(err.message || safeMessage('CONFLICT'));
  }
  return err;
}

export function isConflict(error: unknown): boolean {
  return isAppError(error) && error.code === 'CONFLICT';
}

/** '' / whitespace → null; otherwise trimmed. For optional text columns. */
export function blankToNull(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

/**
 * Keys of `next` whose value differs from `original` (null/'' treated alike). Lets edit forms send
 * only what the user changed, so fields the form doesn't show are never overwritten.
 */
export function changedFields<T extends object>(original: Partial<T>, next: T): Partial<T> {
  const out: Partial<T> = {};
  const norm = (v: unknown) => (v === '' || v === undefined ? null : v);
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (JSON.stringify(norm(original[key])) !== JSON.stringify(norm(next[key]))) out[key] = next[key];
  }
  return out;
}
