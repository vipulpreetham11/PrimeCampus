import { isAppError, safeMessage } from '@/lib/errors';

/** Inline error for forms/actions: safe message + request id. Never shows SQL. */
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const message = isAppError(error) ? error.message : safeMessage('UNKNOWN');
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border p-3 text-sm"
    >
      <p>{message}</p>
      {isAppError(error) && error.code !== 'VALIDATION_ERROR' && error.code !== 'NETWORK' && (
        <p className="mt-1 text-xs opacity-80">
          Request ID: <span className="font-mono select-all">{error.requestId}</span>
        </p>
      )}
    </div>
  );
}
