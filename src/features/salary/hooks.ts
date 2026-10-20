import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SalaryMonth, SalaryOverrides } from '@/contracts/salary';
import { monthEnd } from '@/lib/dates';
import {
  cancelPaidLeave,
  getSalaryCalculations,
  getSalaryMonth,
  listPaidLeave,
  previewSalary,
  recordPaidLeave,
  saveSalaryCalculation,
} from '@/lib/rpc';
import { useScopedKey } from '@/lib/scope';
import { useSessionSelector } from '@/lib/session/store';
import { applySavedToMonth } from './logic';

// Salary (SAL-01). Confidential: every query lives under its own 'salary-*' key in the
// context-scoped, memory-only cache, and the server returns nothing to roles without
// staff_finance.read. The calculator never computes money itself — it shows the server's numbers.

export function useSalaryMonth(month: string, groupId: string | null, enabled = true) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('salary-month', month, groupId),
    queryFn: ({ signal }) =>
      getSalaryMonth({ p_month: month, ...(groupId ? { p_staff_group_id: groupId } : {}) }, { signal }),
    enabled,
  });
}

/** preview_salary (managers): the live calculation, optionally with overrides. */
export function useSalaryPreview(
  staffId: string,
  month: string,
  overrides: SalaryOverrides,
  enabled: boolean,
) {
  const key = useScopedKey();
  const has = Object.keys(overrides).length > 0;
  return useQuery({
    queryKey: key('salary-preview', staffId, month, has ? JSON.stringify(overrides) : null),
    queryFn: ({ signal }) =>
      previewSalary(
        { p_staff_id: staffId, p_month: month, ...(has ? { p_overrides: overrides } : {}) },
        { signal },
      ),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useSalaryHistory(staffId: string, month: string) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('salary-history', staffId, month),
    queryFn: ({ signal }) => getSalaryCalculations({ p_staff_id: staffId, p_month: month }, { signal }),
  });
}

export function usePaidLeave(staffId: string, month: string) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('salary-paid-leave', staffId, month),
    queryFn: ({ signal }) =>
      listPaidLeave({ p_staff_id: staffId, p_from: month, p_to: monthEnd(month) }, { signal }),
  });
}

function useInvalidateSalary() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return () =>
    Promise.all(
      ['salary-month', 'salary-preview', 'salary-history', 'salary-paid-leave', 'dashboard'].map((f) =>
        qc.invalidateQueries({ queryKey: key(f) }),
      ),
    );
}

export interface SaveSalaryInput {
  staffId: string;
  month: string;
  overrides: SalaryOverrides;
  reason: string | null;
}

/** save_salary_calculation arguments (unit-tested): no overrides → none sent. */
export function saveSalaryArgs(v: SaveSalaryInput) {
  const has = Object.keys(v.overrides).length > 0;
  return {
    p_staff_id: v.staffId,
    p_month: v.month,
    ...(has ? { p_overrides: v.overrides, p_override_reason: v.reason ?? '' } : {}),
  };
}

/**
 * No operation id: the server makes a new version only when something differs from the saved one
 * and otherwise answers `replayed: true`, so pressing Save again after a lost reply is safe.
 */
export function useSaveSalary() {
  const invalidate = useInvalidateSalary();
  const key = useScopedKey();
  const qc = useQueryClient();
  const who = useSessionSelector((st) => st.account?.displayName ?? null);
  return useMutation({
    mutationFn: (v: SaveSalaryInput) => saveSalaryCalculation(saveSalaryArgs(v)),
    // the cached month shows "Saved vN" at once (never the old "Changed since saved"); then refetch
    onSuccess: (r, v) =>
      qc.setQueriesData<SalaryMonth>({ queryKey: key('salary-month') }, (old) =>
        old ? applySavedToMonth(old, v.staffId, r, v.reason, who, new Date().toISOString()) : old,
      ),
    onSettled: () => void invalidate(),
  });
}

export function useRecordPaidLeave() {
  const invalidate = useInvalidateSalary();
  return useMutation({
    mutationFn: (v: { staffId: string; date: string; fraction: 1 | 0.5; reason: string | null }) =>
      recordPaidLeave({
        p_staff_id: v.staffId,
        p_leave_date: v.date,
        p_day_fraction: v.fraction,
        ...(v.reason ? { p_reason: v.reason } : {}),
      }),
    onSettled: () => void invalidate(),
  });
}

export function useCancelPaidLeave() {
  const invalidate = useInvalidateSalary();
  return useMutation({
    mutationFn: (paidLeaveId: string) => cancelPaidLeave({ p_paid_leave_id: paidLeaveId }),
    onSettled: () => void invalidate(),
  });
}
