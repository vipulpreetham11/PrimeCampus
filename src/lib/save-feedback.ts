import { toast } from 'sonner';
import { isAppError, safeMessage, toAppError, type AppError } from './errors';

/** The parts of a react-hook-form `useForm()` result needed to put a server message under a field. */
export interface FieldErrorTarget {
  // RHF's own signatures are generic over the form values; any form's methods fit these.
  setError: (
    name: never,
    error: { type: string; message: string },
    options?: { shouldFocus: boolean },
  ) => void;
  getValues: () => unknown;
}

const FIELD_ERROR_CODES: ReadonlySet<string> = new Set(['VALIDATION_ERROR', 'DUPLICATE']);

/** `details.field` of a hinted server error (migration 2310: `{field, constraint}`), or null. */
export function serverErrorField(error: unknown): string | null {
  if (!isAppError(error) || !FIELD_ERROR_CODES.has(error.code)) return null;
  const d = error.details;
  if (typeof d !== 'object' || d === null) return null;
  const field = (d as { field?: unknown }).field;
  return typeof field === 'string' && field !== '' ? field : null;
}

/**
 * Put a server error under the matching form field. The server names database columns
 * (`full_name`, `phone`); `fields` maps one to the form's own name when they differ
 * (`{ full_name: 'name' }`). Returns false when the form has no such field.
 */
export function applyServerFieldError(
  error: unknown,
  form: FieldErrorTarget,
  fields: Readonly<Record<string, string>> = {},
): boolean {
  const column = serverErrorField(error);
  if (!column || !isAppError(error)) return false;
  const name = fields[column] ?? column;
  const values = form.getValues();
  if (typeof values !== 'object' || values === null || !(name in values)) return false;
  form.setError(name as never, { type: 'server', message: error.message }, { shouldFocus: true });
  return true;
}

/**
 * Standard handling for a failed save (CLAUDE.md rules 3 and 5):
 *  - CONFLICT → reload the record (caller's `reload`) and tell the user to redo the change
 *  - a VALIDATION_ERROR / DUPLICATE naming a field the `form` has → shown under that field;
 *    returns null so the form-level error area stays empty
 *  - everything else → returned as an AppError for inline display (the form keeps the user's input)
 */
export function handleSaveError(
  error: unknown,
  options: {
    reload?: () => unknown;
    form?: FieldErrorTarget;
    fields?: Readonly<Record<string, string>>;
  } = {},
): AppError | null {
  const err = toAppError(error);
  if (err.code === 'CONFLICT') {
    void options.reload?.();
    toast.warning(err.message || safeMessage('CONFLICT'));
  }
  if (options.form && applyServerFieldError(err, options.form, options.fields)) return null;
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
