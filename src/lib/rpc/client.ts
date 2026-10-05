import type { z } from 'zod';
import type { Database } from '@/generated/database.types';
import { RPC_RESULT_SCHEMAS, type RpcWithSchema } from '@/contracts/rpc-results';
import { AppError, newRequestId, reportGlobalError, toAppError } from '@/lib/errors';
import { currentRevision, sessionStore } from '@/lib/session/store';
import { supabase } from '@/lib/supabase';

type Fns = Database['public']['Functions'];

/** Every function in `public` except the service-role-only `svc_*` Edge entry points. */
export type BrowserRpc = Exclude<keyof Fns, `svc_${string}`>;
export type RpcArgs<F extends BrowserRpc> = Fns[F]['Args'];
/** Args of a school RPC without `p_ctx_rev` — the layer injects it from the context store. */
export type SchoolArgs<F extends BrowserRpc> = Omit<Fns[F]['Args'], 'p_ctx_rev'>;
export type RpcResult<F extends BrowserRpc> = F extends RpcWithSchema
  ? z.output<(typeof RPC_RESULT_SCHEMAS)[F]>
  : Fns[F]['Returns'];

export interface RpcOptions {
  signal?: AbortSignal;
  /**
   * Not tied to the current context epoch: not aborted by a switch/logout and the response is
   * accepted even if the epoch changed. Only for the session RPCs that *perform* the switch.
   */
  detached?: boolean;
  /** Do not trigger the global UNAUTHENTICATED/STALE_CONTEXT handlers (the caller handles them). */
  silent?: boolean;
}

interface RpcBuilder {
  abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: unknown }>;
}
type LooseRpc = (fn: string, args?: Record<string, unknown>) => RpcBuilder;

function combine(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const c = new AbortController();
  const abort = () => c.abort();
  if (a.aborted || b.aborted) c.abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return c.signal;
}

function fail(error: AppError, silent = false): never {
  if (!silent && error.code !== 'CANCELLED') reportGlobalError(error);
  throw error;
}

/** Low-level typed call. Components never use this — they use hooks that call the wrappers. */
export async function callRpc<F extends BrowserRpc>(
  fn: F,
  args?: RpcArgs<F>,
  options: RpcOptions = {},
): Promise<RpcResult<F>> {
  const requestId = newRequestId();
  const epoch = sessionStore.get().epoch;
  const signal = options.detached
    ? (options.signal ?? new AbortController().signal)
    : combine(sessionStore.signal(), options.signal);

  let response: { data: unknown; error: unknown };
  try {
    const rpc = supabase.rpc.bind(supabase) as unknown as LooseRpc;
    const builder = args === undefined ? rpc(fn) : rpc(fn, args as Record<string, unknown>);
    response = await builder.abortSignal(signal);
  } catch (e) {
    return fail(toAppError(e, requestId), options.silent);
  }

  // An old context's response must never populate the new view (TRD §7.1).
  if (!options.detached && sessionStore.get().epoch !== epoch) {
    throw new AppError('CANCELLED', 'The request was cancelled.', requestId);
  }
  if (response.error) return fail(toAppError(response.error, requestId), options.silent);

  const schema = (RPC_RESULT_SCHEMAS as Record<string, z.ZodType>)[fn];
  if (!schema) return response.data as RpcResult<F>;
  const parsed = schema.safeParse(response.data);
  if (!parsed.success) {
    if (import.meta.env.DEV) console.error(`[rpc] ${fn} returned an unexpected shape`, parsed.error.issues);
    return fail(new AppError('UNKNOWN', 'Something went wrong.', requestId), options.silent);
  }
  return parsed.data as RpcResult<F>;
}

/** School RPC: injects the current context revision as `p_ctx_rev` (CLAUDE.md rule 2). */
export function schoolRpc<F extends BrowserRpc>(
  fn: F,
  args: SchoolArgs<F>,
  options?: RpcOptions,
): Promise<RpcResult<F>> {
  const revision = currentRevision();
  if (revision === null) {
    return Promise.reject(new AppError('FORBIDDEN', 'Choose a school and role first.', newRequestId()));
  }
  return callRpc(fn, { ...args, p_ctx_rev: revision } as unknown as RpcArgs<F>, options);
}
