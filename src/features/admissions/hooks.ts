import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { Json } from '@/generated/database.types';
import { admitStudent, getFollowupsDue, getLead, listLeads, recordLeadFollowup, saveLead } from '@/lib/rpc';
import { useScopedKey } from '@/lib/scope';

// Admissions (brief §5, capability admissions.manage). Enquiries are keyset-paged on
// (created_at, id) — p_before_created_at + p_before_id (migration 1900).

export function useLeads(stage: string | null, search: string) {
  const key = useScopedKey();
  const q = search.trim();
  return useInfiniteQuery({
    queryKey: key('leads', stage, q),
    initialPageParam: null as { before_created_at: string; before_id: string } | null,
    queryFn: ({ pageParam, signal }) =>
      listLeads(
        {
          p_limit: 50,
          ...(stage ? { p_stage: stage } : {}),
          ...(q ? { p_search: q } : {}),
          ...(pageParam
            ? { p_before_created_at: pageParam.before_created_at, p_before_id: pageParam.before_id }
            : {}),
        },
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useFollowupsDue(daysAhead = 7) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('followups-due', daysAhead),
    queryFn: ({ signal }) => getFollowupsDue({ p_days_ahead: daysAhead }, { signal }),
    staleTime: 30_000,
  });
}

export function useLead(leadId: string | undefined) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('lead', leadId),
    queryFn: ({ signal }) => getLead({ p_lead_id: leadId! }, { signal }),
    enabled: !!leadId,
    staleTime: 30_000,
  });
}

function useInvalidateLeads() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return (leadId?: string) => {
    void qc.invalidateQueries({ queryKey: key('leads') });
    void qc.invalidateQueries({ queryKey: key('followups-due') });
    if (leadId) void qc.invalidateQueries({ queryKey: key('lead', leadId) });
  };
}

export function useSaveLead() {
  const invalidate = useInvalidateLeads();
  return useMutation({
    mutationFn: (v: { leadId?: string; version?: number; lead: Record<string, unknown> }) =>
      saveLead({
        p_lead: v.lead as Json,
        ...(v.leadId ? { p_lead_id: v.leadId, p_expected_version: v.version } : {}),
      }),
    onSettled: (d, _e, v) => invalidate(v.leadId ?? d?.lead_id),
  });
}

export function useRecordFollowup() {
  const invalidate = useInvalidateLeads();
  return useMutation({
    mutationFn: (v: {
      leadId: string;
      channel: string;
      outcome: string;
      note: string | null;
      nextFollowUpOn: string | null;
      stage: string | null;
      lostReason: string | null;
    }) =>
      recordLeadFollowup({
        p_lead_id: v.leadId,
        p_channel: v.channel,
        p_outcome: v.outcome,
        ...(v.note ? { p_note: v.note } : {}),
        ...(v.nextFollowUpOn ? { p_next_follow_up_on: v.nextFollowUpOn } : {}),
        ...(v.stage ? { p_stage: v.stage } : {}),
        ...(v.lostReason ? { p_lost_reason: v.lostReason } : {}),
      }),
    onSettled: (_d, _e, v) => invalidate(v.leadId),
  });
}

export interface AdmitInput {
  operationId: string;
  leadId: string | null;
  student: Record<string, unknown>;
  guardians: Record<string, unknown>[];
  sectionId: string;
  joinedOn: string;
  rollNo: string | null;
  sensitive: Record<string, unknown> | null;
}

export function useAdmitStudent() {
  const key = useScopedKey();
  const qc = useQueryClient();
  const invalidate = useInvalidateLeads();
  return useMutation({
    mutationFn: (v: AdmitInput) =>
      admitStudent({
        p_operation_id: v.operationId,
        p_student: v.student as Json,
        p_guardians: v.guardians as unknown as Json,
        p_section_id: v.sectionId,
        p_joined_on: v.joinedOn,
        ...(v.rollNo ? { p_roll_no: v.rollNo } : {}),
        ...(v.leadId ? { p_lead_id: v.leadId } : {}),
        ...(v.sensitive ? { p_sensitive: v.sensitive as Json } : {}),
      }),
    onSuccess: (_d, v) => {
      invalidate(v.leadId ?? undefined);
      void qc.invalidateQueries({ queryKey: key('students') });
      void qc.invalidateQueries({ queryKey: key('guardian-search') });
    },
  });
}
