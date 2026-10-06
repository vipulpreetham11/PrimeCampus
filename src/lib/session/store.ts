import { useSyncExternalStore } from 'react';
import type { ActiveContext, AvailableContext } from '@/contracts/session';

// Plain-module session/context store (no Zustand). Memory only — nothing here is persisted.

export interface Account {
  accountId: string;
  username: string;
  displayName: string | null;
  isOperator: boolean;
}

export type SessionStatus =
  | 'loading' // checking an existing Auth session on startup
  | 'signed_out'
  | 'must_change_password' // only change-password is reachable
  | 'choosing' // signed in, no school context selected yet
  | 'ready'; // context selected; school RPCs allowed

export interface Notice {
  id: number;
  kind: 'context_changed' | 'signed_out';
  message: string;
}

export interface SessionState {
  status: SessionStatus;
  account: Account | null;
  contexts: AvailableContext[];
  context: ActiveContext | null;
  /** Increments on every context switch / logout; keys the routed UI so form drafts are discarded. */
  epoch: number;
  notice: Notice | null;
}

const initial: SessionState = {
  status: 'loading',
  account: null,
  contexts: [],
  context: null,
  epoch: 0,
  notice: null,
};

let state: SessionState = initial;
const listeners = new Set<() => void>();
let abortController = new AbortController();

export const sessionStore = {
  get: (): SessionState => state,
  set(patch: Partial<SessionState>): void {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Signal tied to the current context epoch. Aborted by `nextEpoch()`. */
  signal: (): AbortSignal => abortController.signal,
  /** Cancel every in-flight request of the old context and start a new epoch. */
  nextEpoch(): number {
    abortController.abort();
    abortController = new AbortController();
    state = { ...state, epoch: state.epoch + 1 };
    listeners.forEach((l) => l());
    return state.epoch;
  },
  /** Test helper. */
  reset(): void {
    abortController.abort();
    abortController = new AbortController();
    state = initial;
    listeners.forEach((l) => l());
  },
};

/** Revision for school RPCs (CLAUDE.md rule 2). Null while no context is selected. */
export function currentRevision(): number | null {
  return state.context?.context_revision ?? null;
}

let noticeSeq = 0;
export function showNotice(kind: Notice['kind'], message: string): void {
  sessionStore.set({ notice: { id: ++noticeSeq, kind, message } });
}

export function useSession(): SessionState {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.get, sessionStore.get);
}

export function useSessionSelector<T>(select: (s: SessionState) => T): T {
  return useSyncExternalStore(
    sessionStore.subscribe,
    () => select(sessionStore.get()),
    () => select(sessionStore.get()),
  );
}
