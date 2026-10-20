import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getAttendanceRegister, listAttendanceChanges } from '@/lib/rpc';
import { useScopedKey } from '@/lib/scope';

// Attendance register (one section, one month) and the correction trail (who changed which mark).

export function useAttendanceRegister(sectionId: string | null, month: string) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('attendance-register', sectionId, month),
    queryFn: ({ signal }) =>
      getAttendanceRegister({ p_section_id: sectionId as string, p_month: month }, { signal }),
    enabled: sectionId !== null,
  });
}

export interface ChangesFilter {
  kind: 'student' | 'staff';
  from: string;
  to: string;
  sectionId: string | null;
  personId: string | null;
}

/** list_attendance_changes: ≤ 400 days, keyset on the change id (newest first), 50 per page. */
export function useAttendanceChanges(f: ChangesFilter, enabled = true) {
  const key = useScopedKey();
  return useInfiniteQuery({
    queryKey: key('attendance-changes', f.kind, f.from, f.to, f.sectionId, f.personId),
    queryFn: ({ signal, pageParam }) =>
      listAttendanceChanges(
        {
          p_kind: f.kind,
          p_from: f.from,
          p_to: f.to,
          ...(f.sectionId && f.kind === 'student' ? { p_section_id: f.sectionId } : {}),
          ...(f.personId ? { p_person_id: f.personId } : {}),
          ...(pageParam !== null ? { p_before_id: pageParam } : {}),
        },
        { signal },
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled,
  });
}
