import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountKeys } from '@/contracts/query-keys';
import { addDays } from '@/lib/dates';
import {
  opFindAccount,
  opGetAuditEvents,
  opGetAuthEvents,
  opGetMaintenance,
  opGetUsage,
  opRunRetentionCleanup,
} from '@/lib/rpc';
import { useSessionSelector } from '@/lib/session/store';

// Operator console (LOG-01…03). Account-level queries (no school context, no context revision);
// the server checks the live Operator grant on every call. Raw logs never reach school roles.

/** A school day as an instant: the start of `date` in IST ('2026-10-20T00:00:00+05:30'). */
export function istStart(date: string): string {
  return `${date}T00:00:00+05:30`;
}

/** Inclusive date range → [from, to) instants in IST (the RPCs' p_to is exclusive). */
export function istRange(from: string | null, to: string | null) {
  return {
    ...(from ? { p_from: istStart(from) } : {}),
    ...(to ? { p_to: istStart(addDays(to, 1)) } : {}),
  };
}

function useAccountId() {
  return useSessionSelector((s) => s.account?.accountId ?? '');
}

export interface AuditFilter {
  schoolId: string | null;
  actorId: string | null;
  actionPrefix: string | null;
  entityId: string | null;
  from: string | null;
  to: string | null;
}

/** op_get_audit_events arguments (unit-tested). */
export function auditArgs(f: AuditFilter, beforeId: number | null) {
  return {
    ...(f.schoolId ? { p_school_id: f.schoolId } : {}),
    ...(f.actorId ? { p_actor_id: f.actorId } : {}),
    ...(f.actionPrefix ? { p_action_prefix: f.actionPrefix } : {}),
    ...(f.entityId ? { p_entity_id: f.entityId } : {}),
    ...istRange(f.from, f.to),
    ...(beforeId !== null ? { p_before_id: beforeId } : {}),
  };
}

export function useAuditEvents(f: AuditFilter, enabled: boolean) {
  const accountId = useAccountId();
  return useInfiniteQuery({
    queryKey: accountKeys.operator(accountId, 'audit', f),
    queryFn: ({ signal, pageParam }) => opGetAuditEvents(auditArgs(f, pageParam), { signal }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_before_id,
    enabled: enabled && accountId !== '',
  });
}

export interface AuthFilter {
  accountId: string | null;
  schoolId: string | null;
  from: string | null;
  to: string | null;
}

export function useAuthEvents(f: AuthFilter, enabled: boolean) {
  const accountId = useAccountId();
  return useInfiniteQuery({
    queryKey: accountKeys.operator(accountId, 'auth', f),
    queryFn: ({ signal, pageParam }) =>
      opGetAuthEvents(
        {
          ...(f.accountId ? { p_account_id: f.accountId } : {}),
          ...(f.schoolId ? { p_school_id: f.schoolId } : {}),
          ...istRange(f.from, f.to),
          ...(pageParam !== null ? { p_before_id: pageParam } : {}),
        },
        { signal },
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_before_id,
    enabled: enabled && accountId !== '',
  });
}

export function useUsage(from: string, to: string, schoolId: string | null, enabled: boolean) {
  const accountId = useAccountId();
  return useQuery({
    queryKey: accountKeys.operator(accountId, 'usage', from, to, schoolId),
    queryFn: ({ signal }) =>
      opGetUsage({ p_from: from, p_to: to, ...(schoolId ? { p_school_id: schoolId } : {}) }, { signal }),
    enabled: enabled && accountId !== '',
  });
}

export function useMaintenance(enabled: boolean) {
  const accountId = useAccountId();
  return useQuery({
    queryKey: accountKeys.operator(accountId, 'maintenance'),
    queryFn: ({ signal }) => opGetMaintenance({ signal }),
    enabled: enabled && accountId !== '',
  });
}

export function useRunCleanup() {
  const accountId = useAccountId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => opRunRetentionCleanup(),
    onSettled: () => qc.invalidateQueries({ queryKey: accountKeys.operator(accountId) }),
  });
}

/** Username → account id (op_find_account); null when there is no such account. */
export async function findAccountId(username: string): Promise<string | null> {
  const found = await opFindAccount({ p_username: username });
  return found?.account_id ?? null;
}
