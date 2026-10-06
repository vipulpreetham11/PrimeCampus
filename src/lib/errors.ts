// Public error contract (CLAUDE.md rule 3, TRD §17). The app maps on PostgREST `error.hint`
// (or the Edge Function's `code`). Raw SQL/driver text is never shown to the user.

export const SERVER_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'STALE_CONTEXT',
  'VALIDATION_ERROR',
  'CONFLICT',
  'DUPLICATE',
  'LIMIT_REACHED',
  'NOT_FOUND',
  'TEMPORARILY_UNAVAILABLE',
] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];
/** NETWORK = request never reached/returned from the server; CANCELLED = aborted by a context switch. */
export type AppErrorCode = ServerErrorCode | 'NETWORK' | 'CANCELLED' | 'UNKNOWN';

const SAFE_MESSAGES: Record<AppErrorCode, string> = {
  UNAUTHENTICATED: 'Your session has ended. Please sign in again.',
  FORBIDDEN: 'You do not have permission to do this.',
  STALE_CONTEXT: 'Your role/school changed. The page has been refreshed to the current selection.',
  VALIDATION_ERROR: 'Please check the details and try again.',
  CONFLICT: 'Someone else changed this record. It has been reloaded — please redo your change.',
  DUPLICATE: 'This already exists.',
  LIMIT_REACHED: 'A limit was reached. Please try again later.',
  NOT_FOUND: 'That record was not found.',
  TEMPORARILY_UNAVAILABLE: 'The service is temporarily unavailable. Please try again.',
  NETWORK: 'You appear to be offline or the server could not be reached. Nothing was changed on this screen.',
  CANCELLED: 'The request was cancelled.',
  UNKNOWN: 'Something went wrong.',
};

/** Codes whose server `message` is written for end users and may be shown as-is. */
const SHOW_SERVER_MESSAGE: ReadonlySet<AppErrorCode> = new Set([
  'VALIDATION_ERROR',
  'DUPLICATE',
  'LIMIT_REACHED',
  'NOT_FOUND',
  'FORBIDDEN',
]);

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly requestId: string;

  constructor(code: AppErrorCode, message: string, requestId: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.requestId = requestId;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function safeMessage(code: AppErrorCode): string {
  return SAFE_MESSAGES[code];
}

function isServerCode(v: unknown): v is ServerErrorCode {
  return typeof v === 'string' && (SERVER_ERROR_CODES as readonly string[]).includes(v);
}

const NETWORK_PATTERN = /failed to fetch|networkerror|network request failed|load failed|fetch failed/i;

interface ErrorLike {
  code?: unknown;
  hint?: unknown;
  message?: unknown;
  name?: unknown;
}

/**
 * Map anything thrown by supabase-js / fetch / Edge into an AppError.
 * `serverCode` lets the Edge caller pass the function's `code` field.
 */
export function toAppError(err: unknown, requestId: string = newRequestId(), serverCode?: unknown): AppError {
  if (err instanceof AppError) return err;
  const e = (typeof err === 'object' && err !== null ? err : {}) as ErrorLike;
  const message = typeof e.message === 'string' ? e.message : '';

  if (e.name === 'AbortError' || /aborted/i.test(message)) {
    return new AppError('CANCELLED', SAFE_MESSAGES.CANCELLED, requestId);
  }

  const code = isServerCode(serverCode) ? serverCode : isServerCode(e.hint) ? e.hint : undefined;
  if (code) {
    const text = SHOW_SERVER_MESSAGE.has(code) && message ? message : SAFE_MESSAGES[code];
    return new AppError(code, text, requestId);
  }

  // PostgREST JWT problems (expired / invalid token) are authentication failures.
  if (e.code === 'PGRST301' || e.code === 'PGRST302' || /jwt expired|invalid jwt/i.test(message)) {
    return new AppError('UNAUTHENTICATED', SAFE_MESSAGES.UNAUTHENTICATED, requestId);
  }

  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (offline || NETWORK_PATTERN.test(message) || e.name === 'FunctionsFetchError') {
    return new AppError('NETWORK', SAFE_MESSAGES.NETWORK, requestId);
  }

  return new AppError('UNKNOWN', SAFE_MESSAGES.UNKNOWN, requestId);
}

// ---------------------------------------------------------------------------
// Global handlers. The session layer registers these once; the RPC/Edge layers
// call `reportGlobalError` for every failure so UNAUTHENTICATED and STALE_CONTEXT
// are handled the same way everywhere.
type Handler = (error: AppError) => void;
const handlers: Partial<Record<'UNAUTHENTICATED' | 'STALE_CONTEXT', Handler>> = {};

export function setGlobalErrorHandler(
  code: 'UNAUTHENTICATED' | 'STALE_CONTEXT',
  handler: Handler | undefined,
) {
  handlers[code] = handler;
}

export function reportGlobalError(error: AppError): void {
  if (error.code === 'UNAUTHENTICATED' || error.code === 'STALE_CONTEXT') handlers[error.code]?.(error);
}

/** Retry policy for reads (TRD §17): transient failures only, never permission/validation/conflict. */
export function isTransient(error: unknown): boolean {
  return isAppError(error) && (error.code === 'NETWORK' || error.code === 'TEMPORARILY_UNAVAILABLE');
}
