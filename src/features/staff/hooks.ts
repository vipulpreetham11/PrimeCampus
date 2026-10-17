import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Json } from '@/generated/database.types';
import {
  endTeachingAssignment,
  getStaff,
  getStaffConfidential,
  listStaff,
  listStaffGroups,
  listTeachingAssignments,
  saveStaff,
  saveStaffFinance,
  saveStaffGroup,
  saveTeachingAssignment,
} from '@/lib/rpc';
import { useScopedKey } from '@/lib/scope';

// Staff data (brief §2). Confidential finance uses its own key ('staff-finance') so it is never
// cached alongside — or invalidated with — the general staff profile.

const DIRECTORY = 60_000; // TRD §18: directories one minute

export function useStaffGroups(enabled = true, includeRetired = false) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('staff-groups', includeRetired),
    queryFn: ({ signal }) => listStaffGroups({ p_include_retired: includeRetired }, { signal }),
    enabled,
    staleTime: DIRECTORY,
  });
}

export function useSaveStaffGroup() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id?: string;
      version?: number;
      name: string;
      status: 'active' | 'retired';
      default_salary_paise: number | null;
    }) =>
      saveStaffGroup({
        p_name: v.name,
        p_status: v.status,
        ...(v.default_salary_paise !== null ? { p_default_salary_paise: v.default_salary_paise } : {}),
        ...(v.id ? { p_id: v.id, p_expected_version: v.version } : {}),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: key('staff-groups') }),
  });
}

export function useStaffList(groupId: string | null, includeInactive: boolean) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('staff-list', groupId, includeInactive),
    queryFn: ({ signal }) =>
      listStaff(
        { p_include_inactive: includeInactive, ...(groupId ? { p_staff_group_id: groupId } : {}) },
        { signal },
      ),
    staleTime: DIRECTORY,
  });
}

export function useStaffRecord(staffId: string | undefined) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('staff', staffId),
    queryFn: ({ signal }) => getStaff({ p_staff_id: staffId! }, { signal }),
    enabled: !!staffId,
    staleTime: DIRECTORY,
  });
}

export interface StaffInput {
  employee_no: string;
  full_name: string;
  gender: string | null;
  phone: string | null;
  email: string | null;
  staff_group_id: string;
  designation: string | null;
  is_teaching: boolean;
  joined_on: string;
  left_on: string | null;
  status: 'active' | 'inactive';
}

export function useSaveStaff() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return useMutation({
    /** `p` holds only changed fields on edit, so fields not on the form are never overwritten. */
    mutationFn: (v: { id?: string; version?: number; p: Partial<StaffInput> }) =>
      saveStaff({ p: v.p as Json, ...(v.id ? { p_id: v.id, p_expected_version: v.version } : {}) }),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: key('staff-list') });
      void qc.invalidateQueries({ queryKey: key('staff-groups') });
      if (v.id) void qc.invalidateQueries({ queryKey: key('staff', v.id) });
    },
  });
}

/** Only call when the context has staff_finance.read — the hook is disabled otherwise. */
export function useStaffConfidential(staffId: string | undefined, enabled: boolean) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('staff-finance', staffId),
    queryFn: ({ signal }) => getStaffConfidential({ p_staff_id: staffId! }, { signal }),
    enabled: enabled && !!staffId,
    staleTime: 0,
    gcTime: 0, // confidential: don't keep it in memory after the card unmounts
  });
}

export function useSaveStaffFinance() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      staffId: string;
      salary?: { monthly_salary_paise: number; effective_from: string; reason: string | null };
      bank?: { account_holder_name: string; account_number: string; ifsc: string; bank_name: string | null };
    }) =>
      saveStaffFinance({
        p_staff_id: v.staffId,
        ...(v.salary
          ? {
              p_monthly_salary_paise: v.salary.monthly_salary_paise,
              p_effective_from: v.salary.effective_from,
              ...(v.salary.reason ? { p_reason: v.salary.reason } : {}),
            }
          : {}),
        ...(v.bank ? { p_bank: v.bank as unknown as Json } : {}),
      }),
    onSettled: (_d, _e, v) => qc.invalidateQueries({ queryKey: key('staff-finance', v.staffId) }),
  });
}

export function useTeachingAssignments(filter: {
  yearId?: string | null;
  sectionId?: string | null;
  staffId?: string | null;
  activeOn?: string | null;
}) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key(
      'teaching',
      filter.yearId ?? null,
      filter.sectionId ?? null,
      filter.staffId ?? null,
      filter.activeOn ?? null,
    ),
    queryFn: ({ signal }) =>
      listTeachingAssignments(
        {
          ...(filter.yearId ? { p_academic_year_id: filter.yearId } : {}),
          ...(filter.sectionId ? { p_section_id: filter.sectionId } : {}),
          ...(filter.staffId ? { p_staff_id: filter.staffId } : {}),
          ...(filter.activeOn ? { p_active_on: filter.activeOn } : {}),
        },
        { signal },
      ),
    staleTime: DIRECTORY,
  });
}

export function useSaveTeachingAssignment() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      section_id: string;
      staff_id: string;
      kind: 'class_teacher' | 'subject';
      subject_id: string | null;
      effective_from: string;
    }) =>
      saveTeachingAssignment({
        p_section_id: v.section_id,
        p_staff_id: v.staff_id,
        p_kind: v.kind,
        p_effective_from: v.effective_from,
        ...(v.subject_id ? { p_subject_id: v.subject_id } : {}),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: key('teaching') }),
  });
}

export function useEndTeachingAssignment() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; effective_to: string }) =>
      endTeachingAssignment({ p_teaching_assignment_id: v.id, p_effective_to: v.effective_to }),
    onSettled: () => qc.invalidateQueries({ queryKey: key('teaching') }),
  });
}
