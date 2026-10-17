import { useCallback } from 'react';
import type { Capability } from '@/contracts/capabilities';
import { scopedKey, type ContextScope } from '@/contracts/query-keys';
import { useSessionSelector } from '@/lib/session/store';

// Context scope for query keys and capability checks (CLAUDE.md rules 11–12).

export function useContextScope(): ContextScope | null {
  const accountId = useSessionSelector((s) => s.account?.accountId ?? null);
  const ctx = useSessionSelector((s) => s.context);
  if (!accountId || !ctx) return null;
  return {
    accountId,
    revision: ctx.context_revision,
    schoolId: ctx.school_id,
    role: ctx.role,
    studentId: ctx.student_id,
  };
}

/** Builds a scoped query key for a feature: ['ctx', account, revision, school, role, child, feature, ...params]. */
export function useScopedKey() {
  const scope = useContextScope();
  return useCallback(
    (feature: string, ...params: unknown[]) =>
      scope ? scopedKey(scope, feature, ...params) : (['no-context', feature, ...params] as const),
    // scope fields are primitives; key the callback on them
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope?.accountId, scope?.revision, scope?.schoolId, scope?.role, scope?.studentId],
  );
}

export function useCan(cap: Capability): boolean {
  return useSessionSelector((s) => s.context?.capabilities.includes(cap) ?? false);
}

export function useCanAny(...caps: Capability[]): boolean {
  return useSessionSelector((s) => caps.some((c) => s.context?.capabilities.includes(c) ?? false));
}

/** The school's current academic year (from get_context), used as the default year selection. */
export function useCurrentYearId(): string | null {
  return useSessionSelector((s) => s.context?.current_year?.id ?? null);
}
