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
  /**
   * Structured details a hinted server error carries (`private.fail(code, message, details)`), e.g. the
   * double-booked periods of activate_timetable or the absent/overlap flags of assign_substitute.
   * Data for the UI to interpret — never shown as text.
   */
  readonly details: unknown;

  constructor(code: AppErrorCode, message: string, requestId: string, details: unknown = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.requestId = requestId;
    this.details = details;
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

// Constraint violations a user can cause and fix (duplicate value, overlapping dates, a rule check).
// Other raw SQLSTATEs (not-null, foreign key, bad cast, too long, bad date) mean the client sent
// something it should not have — our bug — so they stay UNKNOWN: "Something went wrong" + request id.
const CONSTRAINT_MESSAGES: Record<string, [AppErrorCode, string]> = {
  '23505': [
    'DUPLICATE',
    'This already exists (for example the same name, code or number). Use a different value.',
  ],
  '23P01': ['VALIDATION_ERROR', 'These dates overlap an existing record. Choose dates that do not overlap.'],
  '23514': ['VALIDATION_ERROR', 'Some values are not allowed. Check the highlighted rules and try again.'],
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An id taken from the URL. A malformed one (e.g. /students/abc) is reported as NOT_FOUND and never
 * sent to the server, where it would fail as a raw cast error.
 */
export function routeId(id: string | undefined): string {
  if (!id || !UUID_PATTERN.test(id)) throw new AppError('NOT_FOUND', SAFE_MESSAGES.NOT_FOUND, newRequestId());
  return id;
}

const NETWORK_PATTERN = /failed to fetch|networkerror|network request failed|load failed|fetch failed/i;

interface ErrorLike {
  code?: unknown;
  hint?: unknown;
  message?: unknown;
  name?: unknown;
  details?: unknown;
}

/** PostgREST `details` of a hinted error: the JSON `private.fail` put there, or null. */
function parseDetails(details: unknown): unknown {
  if (typeof details !== 'string' || details === '') return null;
  try {
    return JSON.parse(details) as unknown;
  } catch {
    return null;
  }
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
    return new AppError(code, text, requestId, parseDetails(e.details));
  }

  // PostgREST JWT problems (expired / invalid token) are authentication failures.
  if (e.code === 'PGRST301' || e.code === 'PGRST302' || /jwt expired|invalid jwt/i.test(message)) {
    return new AppError('UNAUTHENTICATED', SAFE_MESSAGES.UNAUTHENTICATED, requestId);
  }

  // Some invoker RPCs let table constraints raise directly (no hint). Map the SQLSTATE class to a
  // safe, fixed message; the database text itself is never shown.
  const sqlState = typeof e.code === 'string' ? e.code : '';
  const constraintMessage = CONSTRAINT_MESSAGES[sqlState];
  if (constraintMessage) return new AppError(constraintMessage[0], constraintMessage[1], requestId);

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
