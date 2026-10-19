import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDiaryEntry, getStudentDiary, listDiaryEntries, saveDiaryEntry } from '@/lib/rpc';
import { useScopedKey } from '@/lib/scope';

// Diary (brief §6). get_diary_entry also carries the lesson's details (date, period, section,
// subject, teacher), so lesson pages and rosters use it as "the lesson".

export function useDiaryEntry(lessonId: number | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('diary-entry', lessonId),
    queryFn: ({ signal }) => getDiaryEntry({ p_lesson_session_id: lessonId as number }, { signal }),
    enabled: lessonId !== null,
    refetchOnWindowFocus: false,
  });
}

export function useSaveDiary() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { lessonId: number; body: string; expectedVersion: number | null }) =>
      saveDiaryEntry({
        p_lesson_session_id: v.lessonId,
        p_body: v.body,
        ...(v.expectedVersion !== null ? { p_expected_version: v.expectedVersion } : {}),
      }),
    onSettled: (_d, _e, v) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: key('diary-entry', v.lessonId) }),
        ...['diary-list', 'teacher-today', 'schedule', 'student-diary'].map((f) =>
          qc.invalidateQueries({ queryKey: key(f) }),
        ),
      ]),
  });
}

export interface DiaryFilter {
  from: string;
  to: string;
  sectionId: string | null;
  staffId: string | null;
  onlyMissing: boolean;
}

/** list_diary_entries: ≤ 63 days, keyset (date, lesson id) descending, 50 per page. */
export function useDiaryList(f: DiaryFilter, enabled = true) {
  const key = useScopedKey();
  return useInfiniteQuery({
    queryKey: key('diary-list', f.from, f.to, f.sectionId, f.staffId, f.onlyMissing),
    queryFn: ({ signal, pageParam }) =>
      listDiaryEntries(
        {
          p_from: f.from,
          p_to: f.to,
          p_only_missing: f.onlyMissing,
          ...(f.sectionId ? { p_section_id: f.sectionId } : {}),
          ...(f.staffId ? { p_staff_id: f.staffId } : {}),
          ...(pageParam ? { p_before_date: pageParam.before_date, p_before_id: pageParam.before_id } : {}),
        },
        { signal },
      ),
    initialPageParam: null as { before_date: string; before_id: number } | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled,
  });
}

export function useStudentDiary(studentId: string | null, from: string, to: string) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('student-diary', studentId, from, to),
    queryFn: ({ signal }) =>
      getStudentDiary({ p_student_id: studentId as string, p_from: from, p_to: to }, { signal }),
    enabled: studentId !== null,
  });
}
