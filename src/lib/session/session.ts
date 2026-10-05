import type { AvailableContext } from '@/contracts/session';
import { roleLabel } from '@/contracts/roles';
import { deviceClass } from '@/lib/device';
import { invokeAccounts } from '@/lib/edge';
import { env } from '@/lib/env';
import { AppError, isAppError, newRequestId, setGlobalErrorHandler, toAppError } from '@/lib/errors';
import { queryClient } from '@/lib/query-client';
import { bootstrapAccount, endAppSession, getContext, selectContext } from '@/lib/rpc';
import { supabase } from '@/lib/supabase';
import { flushTelemetry } from '@/lib/telemetry';
import { sessionStore, showNotice } from './store';

// Session lifecycle (TRD §6–§7, CLAUDE.md rules 9 and 12).

export const GENERIC_SIGN_IN_ERROR = 'The username or password is incorrect.';
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,62}$/;

/** Canonical lowercase username, or null if it can't be a valid username. */
export function normalizeUsername(raw: string): string | null {
  const u = raw.trim().toLowerCase();
  return USERNAME_PATTERN.test(u) ? u : null;
}

/** Internal Auth identifier. Never displayed in the UI. */
export function aliasEmail(username: string): string {
  return `${username}@${env.loginEmailDomain}`;
}

// ---------------------------------------------------------------------------- cross-tab
type TabMessage = { type: 'logout' } | { type: 'context'; revision: number } | { type: 'signed_in' };
const CHANNEL_NAME = 'primecampus-session';
let channel: BroadcastChannel | null = null;

function broadcast(message: TabMessage): void {
  try {
    channel?.postMessage(message);
  } catch {
    /* tab sync is best effort */
  }
}

async function onTabMessage(message: TabMessage): Promise<void> {
  const s = sessionStore.get();
  if (message.type === 'logout') {
    if (s.status !== 'signed_out') await localSignOut('You were signed out in another tab.');
  } else if (message.type === 'context') {
    if (s.status === 'ready' && s.context?.context_revision === message.revision) return;
    if (s.status === 'ready' || s.status === 'choosing') await refreshContext('another_tab');
  } else if (message.type === 'signed_in') {
    if (s.status === 'signed_out') await initSession();
  }
}

// ---------------------------------------------------------------------------- core helpers
/** Cancel in-flight requests, drop every cached response and start a new UI epoch (drafts reset). */
export function clearClientState(): void {
  sessionStore.nextEpoch();
  void queryClient.cancelQueries();
  queryClient.clear();
}

async function localSignOut(message?: string): Promise<void> {
  clearClientState();
  sessionStore.set({ status: 'signed_out', account: null, contexts: [], context: null });
  if (message) showNotice('signed_out', message);
  await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
}

type Choice = { membershipId: string; studentId?: string } | { operatorSchoolId: string };

/** Single-context users enter directly (PRD ACCESS-02). */
export function automaticChoice(contexts: AvailableContext[], isOperator: boolean): Choice | null {
  if (isOperator || contexts.length !== 1) return null;
  const only = contexts[0]!;
  if (only.role === 'parent') {
    const children = only.children ?? [];
    return children.length === 1 ? { membershipId: only.membership_id, studentId: children[0]!.student_id } : null;
  }
  return { membershipId: only.membership_id };
}

async function loadBootstrap(): Promise<void> {
  const b = await bootstrapAccount(
    { p_device_class: deviceClass(), p_user_agent: navigator.userAgent.slice(0, 400) },
    { detached: true, silent: true },
  );
  const account = {
    accountId: b.account_id,
    username: b.username,
    displayName: b.display_name,
    isOperator: b.is_operator,
  };
  if (b.must_change_password) {
    sessionStore.set({ status: 'must_change_password', account, contexts: [], context: null });
    return;
  }
  sessionStore.set({ account, contexts: b.contexts });

  // Resume the context the server already holds for this session (page reload, second tab).
  const sel = b.selected;
  if (sel && (sel.membership_id || sel.operator_school_id)) {
    try {
      const context = await getContext({ detached: true, silent: true });
      sessionStore.set({ status: 'ready', context });
      return;
    } catch (e) {
      if (!isAppError(e) || e.code !== 'UNAUTHENTICATED') throw e;
      // the held membership was disabled/ended — fall through to choosing
    }
  }
  const auto = automaticChoice(b.contexts, b.is_operator);
  if (auto) {
    await chooseContext(auto);
    return;
  }
  sessionStore.set({ status: 'choosing', context: null });
}

// ---------------------------------------------------------------------------- public API
let initialized = false;

/** Called once at app start: wires global handlers + tab sync, then resumes any Auth session. */
export async function initSession(): Promise<void> {
  if (!initialized) {
    initialized = true;
    setGlobalErrorHandler('UNAUTHENTICATED', () => {
      void localSignOut('Your session has ended. Please sign in again.');
    });
    setGlobalErrorHandler('STALE_CONTEXT', () => {
      void refreshContext('stale');
    });
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (ev: MessageEvent<TabMessage>) => void onTabMessage(ev.data);
    }
    supabase.auth.onAuthStateChange((event) => {
      // auth-js also syncs sign-out across tabs through storage.
      if (event === 'SIGNED_OUT' && sessionStore.get().status !== 'signed_out') {
        void localSignOut('You have been signed out.');
      }
    });
  }
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    sessionStore.set({ status: 'signed_out' });
    return;
  }
  try {
    await loadBootstrap();
  } catch (e) {
    const err = toAppError(e);
    if (err.code === 'NETWORK') {
      sessionStore.set({ status: 'signed_out' });
      showNotice('signed_out', 'Could not reach PrimeCampus. Check your connection and sign in again.');
      return;
    }
    await localSignOut(err.code === 'FORBIDDEN' ? err.message : undefined);
  }
}

export async function signIn(rawUsername: string, password: string): Promise<void> {
  const requestId = newRequestId();
  const username = normalizeUsername(rawUsername);
  // Same message for malformed, unknown and wrong-password cases: never reveal whether a user exists.
  if (!username || !password) throw new AppError('VALIDATION_ERROR', GENERIC_SIGN_IN_ERROR, requestId);

  clearClientState();
  const { error } = await supabase.auth.signInWithPassword({ email: aliasEmail(username), password });
  if (error) {
    if (error.status === 429) {
      throw new AppError('LIMIT_REACHED', 'Too many sign-in attempts. Wait a few minutes and try again.', requestId);
    }
    const mapped = toAppError(error, requestId);
    if (mapped.code === 'NETWORK') throw mapped;
    throw new AppError('VALIDATION_ERROR', GENERIC_SIGN_IN_ERROR, requestId);
  }
  try {
    await loadBootstrap();
  } catch (e) {
    const err = toAppError(e, requestId);
    await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
    sessionStore.set({ status: 'signed_out', account: null, contexts: [], context: null });
    // FORBIDDEN here = inactive account; only shown after a correct password.
    throw err.code === 'FORBIDDEN' || err.code === 'NETWORK'
      ? err
      : new AppError('UNKNOWN', 'Something went wrong while signing in.', err.requestId);
  }
  broadcast({ type: 'signed_in' });
}

/** Select role/school/child (or an Operator's support school). Clears everything first. */
export async function chooseContext(choice: Choice): Promise<void> {
  clearClientState();
  sessionStore.set({ context: null, status: 'choosing' });
  const args =
    'operatorSchoolId' in choice
      ? { p_operator_school_id: choice.operatorSchoolId }
      : { p_membership_id: choice.membershipId, ...(choice.studentId ? { p_student_id: choice.studentId } : {}) };
  await selectContext(args, { detached: true });
  const context = await getContext({ detached: true, silent: true });
  sessionStore.set({ status: 'ready', context });
  broadcast({ type: 'context', revision: context.context_revision });
}

let refreshing: Promise<void> | null = null;

/**
 * The server's context differs from ours (STALE_CONTEXT, or another tab switched).
 * Drop everything, adopt the server's current context and tell the user.
 */
export function refreshContext(reason: 'stale' | 'another_tab'): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    clearClientState();
    try {
      const context = await getContext({ detached: true, silent: true });
      sessionStore.set({ status: 'ready', context });
      const where = `${roleLabel(context.role)} — ${context.school_name}`;
      showNotice(
        'context_changed',
        reason === 'stale'
          ? `Your role/school changed. You are now viewing ${where}.`
          : `Your role/school was changed in another tab. You are now viewing ${where}.`,
      );
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'UNAUTHENTICATED') {
        // No usable context any more (e.g. membership disabled) — back to the chooser or sign-in.
        try {
          sessionStore.set({ context: null });
          await loadBootstrap();
          showNotice('context_changed', 'Your role/school changed. Please choose where to continue.');
        } catch {
          await localSignOut('Your session has ended. Please sign in again.');
        }
      } else {
        sessionStore.set({ status: 'choosing', context: null });
        showNotice('context_changed', 'Your role/school changed. Please choose where to continue.');
      }
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function logout(): Promise<void> {
  await flushTelemetry().catch(() => undefined);
  clearClientState();
  try {
    await endAppSession({ detached: true, silent: true });
  } catch {
    /* the Auth sign-out below still ends this device's session */
  }
  await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
  sessionStore.set({ status: 'signed_out', account: null, contexts: [], context: null, notice: null });
  broadcast({ type: 'logout' });
}

/**
 * Change own password via the Edge Function. The server clears must_change_password only after
 * Auth accepted the new password. If Auth revoked this session as part of the change, sign in
 * again with the new password so the user isn't bounced to the sign-in page.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const username = sessionStore.get().account?.username;
  await invokeAccounts('change_password', { current_password: currentPassword, new_password: newPassword });
  try {
    await loadBootstrap();
  } catch (e) {
    const err = toAppError(e);
    if (err.code !== 'UNAUTHENTICATED' || !username) throw err;
    const { error } = await supabase.auth.signInWithPassword({ email: aliasEmail(username), password: newPassword });
    if (error) {
      await localSignOut('Your password was changed. Please sign in with the new password.');
      return;
    }
    await loadBootstrap();
  }
}
