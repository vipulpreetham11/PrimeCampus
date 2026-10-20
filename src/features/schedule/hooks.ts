import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addExtraLesson,
  assignSubstitute,
  getDateSchedule,
  getScheduleRange,
  listSubstitutions,
  removeSubstitute,
  suggestSubstitutes,
  updateLessonSession,
} from '@/lib/rpc';
import { useScopedKey } from '@/lib/scope';
import { useInvalidateLessons } from '@/features/timetable/hooks';

// Dated lessons (brief §2): day and week views, lesson actions and substitutions. All lesson
// mutations invalidate every screen built from lessons (schedule, Today, rosters, diary lists).

export interface ScheduleFilter {
  sectionId: string | null;
  staffId: string | null;
}

function filterArgs(f: ScheduleFilter) {
  return {
    ...(f.sectionId ? { p_section_id: f.sectionId } : {}),
    ...(f.staffId ? { p_staff_id: f.staffId } : {}),
  };
}

export function useDateSchedule(date: string, f: ScheduleFilter, enabled = true) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('schedule', 'day', date, f.sectionId, f.staffId),
    queryFn: ({ signal }) => getDateSchedule({ p_date: date, ...filterArgs(f) }, { signal }),
    enabled,
  });
}

/** get_schedule_range: at most 7 days. */
export function useScheduleRange(from: string, to: string, f: ScheduleFilter, enabled = true) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('schedule', 'range', from, to, f.sectionId, f.staffId),
    queryFn: ({ signal }) => getScheduleRange({ p_from: from, p_to: to, ...filterArgs(f) }, { signal }),
    enabled,
  });
}

export type LessonAction =
  | { action: 'cancel'; reason: string }
  | { action: 'restore' }
  | { action: 'change_subject'; subjectId: string }
  | { action: 'change_time'; startTime: string; endTime: string; reason: string | null };

/** The exact update_lesson_session arguments (unit-tested). Times are 'HH:MM' wall-clock school time. */
export function lessonActionArgs(v: { lessonId: number; version: number } & LessonAction) {
  return {
    p_lesson_session_id: v.lessonId,
    p_action: v.action,
    p_expected_version: v.version,
    ...(v.action === 'cancel' ? { p_reason: v.reason } : {}),
    ...(v.action === 'change_subject' ? { p_subject_id: v.subjectId } : {}),
    ...(v.action === 'change_time'
      ? { p_start_time: v.startTime, p_end_time: v.endTime, ...(v.reason ? { p_reason: v.reason } : {}) }
      : {}),
  };
}

export function useUpdateLesson() {
  const invalidate = useInvalidateLessons();
  return useMutation({
    mutationFn: (v: { lessonId: number; version: number } & LessonAction) =>
      updateLessonSession(lessonActionArgs(v)),
    onSettled: invalidate,
  });
}

export interface ExtraLessonInput {
  sectionId: string;
  date: string;
  startTime: string;
  endTime: string;
  subjectId: string;
  staffId: string | null;
  label: string | null;
  reason: string | null;
}

/** add_extra_lesson arguments (unit-tested): optional fields are left out when empty. */
export function extraLessonArgs(v: ExtraLessonInput) {
  return {
    p_section_id: v.sectionId,
    p_date: v.date,
    p_start_time: v.startTime,
    p_end_time: v.endTime,
    p_subject_id: v.subjectId,
    ...(v.staffId ? { p_staff_id: v.staffId } : {}),
    ...(v.label ? { p_label: v.label } : {}),
    ...(v.reason ? { p_reason: v.reason } : {}),
  };
}

/** No operation id: a repeat of the same extra lesson is refused as DUPLICATE with its id. */
export function useAddExtraLesson() {
  const invalidate = useInvalidateLessons();
  return useMutation({
    mutationFn: (v: ExtraLessonInput) => addExtraLesson(extraLessonArgs(v)),
    onSettled: () => void invalidate(),
  });
}

export function useSubstituteSuggestions(lessonId: number | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('substitute-suggestions', lessonId),
    queryFn: ({ signal }) => suggestSubstitutes({ p_lesson_session_id: lessonId as number }, { signal }),
    enabled: lessonId !== null,
    staleTime: 0,
  });
}

function useInvalidateSubstitutions() {
  const key = useScopedKey();
  const qc = useQueryClient();
  const lessons = useInvalidateLessons();
  return () =>
    Promise.all([
      lessons(),
      qc.invalidateQueries({ queryKey: key('substitutions') }),
      qc.invalidateQueries({ queryKey: key('substitute-suggestions') }),
    ]);
}

export function useAssignSubstitute() {
  const invalidate = useInvalidateSubstitutions();
  return useMutation({
    mutationFn: (v: {
      lessonId: number;
      staffId: string;
      reason: string | null;
      overrideReason: string | null;
    }) =>
      assignSubstitute({
        p_lesson_session_id: v.lessonId,
        p_staff_id: v.staffId,
        ...(v.reason ? { p_reason: v.reason } : {}),
        ...(v.overrideReason ? { p_conflict_reason: v.overrideReason } : {}),
      }),
    onSettled: invalidate,
  });
}

export function useRemoveSubstitute() {
  const invalidate = useInvalidateSubstitutions();
  return useMutation({
    mutationFn: (lessonId: number) => removeSubstitute({ p_lesson_session_id: lessonId }),
    onSettled: invalidate,
  });
}

export function useSubstitutions(from: string, to: string, staffId: string | null, enabled = true) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('substitutions', from, to, staffId),
    queryFn: ({ signal }) =>
      listSubstitutions({ p_from: from, p_to: to, ...(staffId ? { p_staff_id: staffId } : {}) }, { signal }),
    enabled,
  });
}
