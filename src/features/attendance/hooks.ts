import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AttendanceStatus, RosterKind } from '@/contracts/attendance';
import {
  getAttendanceOverview,
  getMarkingRoster,
  getStudentAttendanceRecords,
  getStudentAttendanceSummary,
  markStudentAttendance,
} from '@/lib/rpc';
import { useScopedKey } from '@/lib/scope';

// Student attendance (brief §4). Rosters are never refetched in the background (the teacher's
// unsaved marks stay put); after a save the roster and everything that counts marks is refreshed.

export type RosterTarget =
  { kind: 'period'; lessonId: number } | { kind: 'daily'; sectionId: string; date: string };

function rosterParams(t: RosterTarget) {
  return t.kind === 'period' ? ['period', t.lessonId] : ['daily', t.sectionId, t.date];
}

export function useMarkingRoster(target: RosterTarget | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('roster', ...(target ? rosterParams(target) : [])),
    queryFn: ({ signal }) => {
      if (!target) throw new Error('no roster target');
      return getMarkingRoster(
        target.kind === 'period'
          ? { p_kind: 'period', p_lesson_session_id: target.lessonId }
          : { p_kind: 'daily', p_section_id: target.sectionId, p_date: target.date },
        { signal },
      );
    },
    enabled: target !== null,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
}

export interface StudentMark {
  student_id: string;
  status: AttendanceStatus;
  /** the version the teacher saw; null when the student was unmarked */
  expected_version: number | null;
}

/** The exact mark_student_attendance arguments (unit-tested). */
export function markArgs(target: RosterTarget, operationId: string, marks: StudentMark[]) {
  return {
    p_operation_id: operationId,
    p_kind: target.kind as RosterKind,
    p_marks: marks.map((m) => ({
      student_id: m.student_id,
      status: m.status,
      expected_version: m.expected_version,
    })),
    ...(target.kind === 'period'
      ? { p_lesson_session_id: target.lessonId }
      : { p_section_id: target.sectionId, p_date: target.date }),
  };
}

export function sendStudentMarks(target: RosterTarget, operationId: string, marks: StudentMark[]) {
  return markStudentAttendance(markArgs(target, operationId, marks));
}

/** After a save: counts on Today, the overview, schedules and student summaries change. */
export function useInvalidateAttendance() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [
        'teacher-today',
        'attendance-overview',
        'attendance-summary',
        'attendance-records',
        'attendance-register',
        'attendance-changes',
        'academic-coverage',
        'dashboard',
      ].map((f) => qc.invalidateQueries({ queryKey: key(f) })),
    );
}

export function useAttendanceOverview(date: string) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('attendance-overview', date),
    queryFn: ({ signal }) => getAttendanceOverview({ p_date: date }, { signal }),
  });
}

export function useAttendanceSummary(studentId: string | null, from: string, to: string) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('attendance-summary', studentId, from, to),
    queryFn: ({ signal }) =>
      getStudentAttendanceSummary({ p_student_id: studentId as string, p_from: from, p_to: to }, { signal }),
    enabled: studentId !== null,
  });
}

/** get_student_attendance_records: at most 63 days per call (the UI pages by month). */
export function useAttendanceRecords(studentId: string | null, from: string, to: string) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('attendance-records', studentId, from, to),
    queryFn: ({ signal }) =>
      getStudentAttendanceRecords({ p_student_id: studentId as string, p_from: from, p_to: to }, { signal }),
    enabled: studentId !== null,
  });
}
