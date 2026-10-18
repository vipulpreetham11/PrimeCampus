import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { Json } from '@/generated/database.types';
import {
  getGuardian,
  getStudentProfile,
  listStudents,
  movePlacements,
  saveGuardian,
  saveStudentSensitive,
  searchGuardians,
  updateStudent,
} from '@/lib/rpc';
import { routeId } from '@/lib/errors';
import { useScopedKey } from '@/lib/scope';

// Students & guardians (brief §4). The directory uses the server's keyset cursor (after_name,
// after_id) — never "fetch everything".

export const PAGE_SIZE = 50;

export interface StudentFilter {
  search: string;
  classId: string | null;
  sectionId: string | null;
}

export function useStudentDirectory(f: StudentFilter) {
  const key = useScopedKey();
  const search = f.search.trim();
  return useInfiniteQuery({
    queryKey: key('students', search, f.classId, f.sectionId),
    initialPageParam: null as { after_name: string; after_id: string } | null,
    queryFn: ({ pageParam, signal }) =>
      listStudents(
        {
          p_limit: PAGE_SIZE,
          ...(search ? { p_search: search } : {}),
          ...(f.classId ? { p_class_id: f.classId } : {}),
          ...(f.sectionId ? { p_section_id: f.sectionId } : {}),
          ...(pageParam ? { p_after_name: pageParam.after_name, p_after_id: pageParam.after_id } : {}),
        },
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function useStudentProfile(studentId: string | undefined) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('student', studentId),
    queryFn: ({ signal }) => getStudentProfile({ p_student_id: routeId(studentId) }, { signal }),
    enabled: !!studentId,
    staleTime: 30_000,
  });
}

function useInvalidateStudent() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return (studentId?: string) => {
    void qc.invalidateQueries({ queryKey: key('student', ...(studentId ? [studentId] : [])) });
    void qc.invalidateQueries({ queryKey: key('students') });
  };
}

export function useUpdateStudent() {
  const invalidate = useInvalidateStudent();
  return useMutation({
    /** `p` holds only changed fields. */
    mutationFn: (v: { studentId: string; version: number; p: Record<string, unknown> }) =>
      updateStudent({ p_student_id: v.studentId, p: v.p as Json, p_expected_version: v.version }),
    onSettled: (_d, _e, v) => invalidate(v.studentId),
  });
}

export function useSaveSensitive() {
  const invalidate = useInvalidateStudent();
  return useMutation({
    mutationFn: (v: { studentId: string; p: Record<string, unknown> }) =>
      saveStudentSensitive({ p_student_id: v.studentId, p: v.p as Json }),
    onSettled: (_d, _e, v) => invalidate(v.studentId),
  });
}

export function useGuardian(guardianId: string | undefined) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('guardian', guardianId),
    queryFn: ({ signal }) => getGuardian({ p_guardian_id: guardianId! }, { signal }),
    enabled: !!guardianId,
    staleTime: 30_000,
  });
}

/** search_guardians requires ≥3 characters (or a phone number); the hook stays idle below that. */
export function useGuardianSearch(query: string) {
  const key = useScopedKey();
  const q = query.trim();
  return useQuery({
    queryKey: key('guardian-search', q),
    queryFn: ({ signal }) => searchGuardians({ p_query: q }, { signal }),
    enabled: q.length >= 3,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export interface GuardianFields {
  full_name: string;
  phone: string | null;
  alt_phone: string | null;
  email: string | null;
  occupation: string | null;
  address_line: string | null;
  status?: 'active' | 'inactive';
}

export function useSaveGuardian() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      guardianId?: string;
      version?: number;
      p: Partial<GuardianFields>;
      link?: { studentId: string; relationship: string; isPrimary: boolean; portalAccess: boolean };
    }) =>
      saveGuardian({
        p: v.p as Json,
        ...(v.guardianId ? { p_guardian_id: v.guardianId, p_expected_version: v.version } : {}),
        ...(v.link
          ? {
              p_link_student_id: v.link.studentId,
              p_relationship: v.link.relationship,
              p_is_primary: v.link.isPrimary,
              p_portal_access: v.link.portalAccess,
            }
          : {}),
      }),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: key('student') });
      void qc.invalidateQueries({ queryKey: key('guardian-search') });
      if (v.guardianId) void qc.invalidateQueries({ queryKey: key('guardian', v.guardianId) });
    },
  });
}

export function useMovePlacements() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      operationId: string;
      preview: boolean;
      effectiveFrom: string;
      reason: string;
      moves: { student_id: string; section_id: string; roll_no: string | null }[];
    }) =>
      movePlacements({
        p_operation_id: v.operationId,
        p_preview: v.preview,
        p_effective_from: v.effectiveFrom,
        p_reason: v.reason,
        p_moves: v.moves.map((m) => ({
          student_id: m.student_id,
          section_id: m.section_id,
          ...(m.roll_no ? { roll_no: m.roll_no } : {}),
        })) as unknown as Json,
      }),
    onSuccess: (res) => {
      if (!res.preview) {
        void qc.invalidateQueries({ queryKey: key('students') });
        void qc.invalidateQueries({ queryKey: key('student') });
      }
    },
  });
}
