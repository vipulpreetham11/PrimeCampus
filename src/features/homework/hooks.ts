import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Correction, HomeworkListItem } from '@/contracts/academic';
import {
  getHomeworkRoster,
  getStudentHomework,
  listHomework,
  markHomeworkChecks,
  saveHomework,
} from '@/lib/rpc';
import { useScopedKey } from '@/lib/scope';

// Homework (brief §7): set from a lesson, edit/cancel with the version, list with progress, and the
// classroom checking roster. Unchecked is its own state — never "not completed".

function useInvalidateHomework() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [
        'homework-list',
        'homework-roster',
        'teacher-today',
        'schedule',
        'student-homework',
        'diary-entry',
      ].map((f) => qc.invalidateQueries({ queryKey: key(f) })),
    );
}

export type HomeworkSave =
  | { kind: 'create'; lessonId: number; dueOn: string; description: string }
  | { kind: 'edit'; assignmentId: string; version: number; dueOn: string; description: string }
  | { kind: 'cancel'; assignmentId: string; version: number };

/** The exact save_homework arguments (unit-tested). */
export function homeworkArgs(v: HomeworkSave) {
  if (v.kind === 'create') {
    return { p_lesson_session_id: v.lessonId, p_due_on: v.dueOn, p_description: v.description };
  }
  if (v.kind === 'edit') {
    return {
      p_assignment_id: v.assignmentId,
      p_due_on: v.dueOn,
      p_description: v.description,
      p_expected_version: v.version,
    };
  }
  return { p_assignment_id: v.assignmentId, p_status: 'cancelled', p_expected_version: v.version };
}

export function useSaveHomework() {
  const invalidate = useInvalidateHomework();
  return useMutation({
    mutationFn: (v: HomeworkSave) => saveHomework(homeworkArgs(v)),
    // not awaited: after an uncertain create the dialog says "checking" at once, not after the refresh
    onSettled: () => void invalidate(),
  });
}

/**
 * After an uncertain failure of a create (save_homework has no operation id): the lesson's active
 * homework with this description that wasn't there before (`knownIds`), or null. Reads the same
 * list_homework the lesson page shows (its date and section).
 */
export async function findCreatedHomework(v: {
  lessonId: number;
  date: string;
  sectionId: string;
  description: string;
  knownIds: readonly string[];
}): Promise<HomeworkListItem | null> {
  const known = new Set(v.knownIds);
  let cursor: { before_date: string; before_id: string } | null = null;
  // one lesson's day in one section: a single page in practice; a few pages at most
  for (let page = 0; page < 10; page += 1) {
    const res = await listHomework({
      p_from: v.date,
      p_to: v.date,
      p_section_id: v.sectionId,
      p_status: 'active',
      ...(cursor ? { p_before_date: cursor.before_date, p_before_id: cursor.before_id } : {}),
    });
    const hit = res.items.find(
      (h) =>
        h.lesson_session_id === v.lessonId && h.description === v.description && !known.has(h.assignment_id),
    );
    if (hit) return hit;
    if (!res.next_cursor) return null;
    cursor = res.next_cursor;
  }
  return null;
}

export interface HomeworkFilter {
  from: string;
  to: string;
  sectionId: string | null;
  subjectId: string | null;
  staffId: string | null;
  status: 'active' | 'cancelled' | 'all';
}

/** list_homework: ≤ 400 days, keyset (assigned_on, id) descending, 50 per page. */
export function useHomeworkList(f: HomeworkFilter, enabled = true) {
  const key = useScopedKey();
  return useInfiniteQuery({
    queryKey: key('homework-list', f.from, f.to, f.sectionId, f.subjectId, f.staffId, f.status),
    queryFn: ({ signal, pageParam }) =>
      listHomework(
        {
          p_from: f.from,
          p_to: f.to,
          p_status: f.status,
          ...(f.sectionId ? { p_section_id: f.sectionId } : {}),
          ...(f.subjectId ? { p_subject_id: f.subjectId } : {}),
          ...(f.staffId ? { p_staff_id: f.staffId } : {}),
          ...(pageParam ? { p_before_date: pageParam.before_date, p_before_id: pageParam.before_id } : {}),
        },
        { signal },
      ),
    initialPageParam: null as { before_date: string; before_id: string } | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled,
  });
}

export function useHomeworkRoster(assignmentId: string | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('homework-roster', assignmentId),
    queryFn: ({ signal }) => getHomeworkRoster({ p_assignment_id: assignmentId as string }, { signal }),
    enabled: assignmentId !== null,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
}

export interface CheckValue {
  completion: 'completed' | 'not_completed';
  correction: Correction;
  /** only for completed homework, between the assigned date and the checked date */
  completed_on: string | null;
  comment: string | null;
}

export interface HomeworkCheck extends CheckValue {
  student_id: string;
  expected_version: number | null;
}

/** The exact mark_homework_checks arguments (unit-tested). */
export function checkArgs(
  assignmentId: string,
  observedOn: string,
  operationId: string,
  checks: HomeworkCheck[],
) {
  return {
    p_operation_id: operationId,
    p_assignment_id: assignmentId,
    p_observed_on: observedOn,
    p_checks: checks.map((c) => ({
      student_id: c.student_id,
      completion: c.completion,
      correction: c.correction,
      completed_on: c.completion === 'completed' ? c.completed_on : null,
      comment: c.comment,
      expected_version: c.expected_version,
    })),
  };
}

export function sendHomeworkChecks(
  assignmentId: string,
  observedOn: string,
  operationId: string,
  checks: HomeworkCheck[],
) {
  return markHomeworkChecks(checkArgs(assignmentId, observedOn, operationId, checks));
}

export function useInvalidateHomeworkChecks() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return () =>
    Promise.all(
      ['homework-list', 'teacher-today', 'student-homework'].map((f) =>
        qc.invalidateQueries({ queryKey: key(f) }),
      ),
    );
}

/** get_student_homework: ≤ 400 days. */
export function useStudentHomework(studentId: string | null, from: string, to: string) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('student-homework', studentId, from, to),
    queryFn: ({ signal }) =>
      getStudentHomework({ p_student_id: studentId as string, p_from: from, p_to: to }, { signal }),
    enabled: studentId !== null,
  });
}
