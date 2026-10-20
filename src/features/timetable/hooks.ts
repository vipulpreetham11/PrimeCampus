import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateTimetable,
  copyTimetable,
  discardTimetableDraft,
  generateLessonSessions,
  getTimetableVersion,
  listTimetableVersions,
  saveTimetableDraft,
} from '@/lib/rpc';
import { useScopedKey } from '@/lib/scope';

// Timetable versions and lesson generation (brief §1). Reads: list_timetable_versions /
// get_timetable_version. Every key carries the context scope; saving a draft or activating
// invalidates the timetable keys, generating lessons invalidates everything built from lessons.

export function useTimetableVersions(sectionId: string | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('timetable-versions', sectionId),
    queryFn: ({ signal }) => listTimetableVersions({ p_section_id: sectionId as string }, { signal }),
    enabled: sectionId !== null,
  });
}

export function useTimetableVersion(versionId: string | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('timetable-version', versionId),
    queryFn: ({ signal }) => getTimetableVersion({ p_version_id: versionId as string }, { signal }),
    enabled: versionId !== null,
    // the editor holds unsaved cells; a background refetch must not reset them
    refetchOnWindowFocus: false,
  });
}

function useInvalidateTimetables() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: key('timetable-versions') }),
      qc.invalidateQueries({ queryKey: key('timetable-version') }),
    ]);
}

/** Lessons feed the schedule, Today, rosters, diary and homework screens. */
export function useInvalidateLessons() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [
        'schedule',
        'teacher-today',
        'diary-list',
        'attendance-overview',
        'attendance-register',
        'academic-coverage',
        'dashboard',
      ].map((f) => qc.invalidateQueries({ queryKey: key(f) })),
    );
}

export interface DraftEntry {
  weekday: number;
  slot_ordinal: number;
  subject_id: string;
  staff_id: string | null;
}

export interface DraftInput {
  sectionId: string;
  periodScheduleId: string;
  effectiveFrom: string;
  entries: DraftEntry[];
  /** null = create a new draft */
  versionId: string | null;
  expectedVersion: number | null;
}

/** The exact save_timetable_draft arguments for a draft (unit-tested). */
export function draftArgs(v: DraftInput) {
  return {
    p_section_id: v.sectionId,
    p_period_schedule_id: v.periodScheduleId,
    p_effective_from: v.effectiveFrom,
    p_entries: [...v.entries]
      .sort((a, b) => a.weekday - b.weekday || a.slot_ordinal - b.slot_ordinal)
      .map((e) => ({
        weekday: e.weekday,
        slot_ordinal: e.slot_ordinal,
        subject_id: e.subject_id,
        staff_id: e.staff_id,
      })),
    ...(v.versionId
      ? {
          p_version_id: v.versionId,
          ...(v.expectedVersion !== null ? { p_expected_version: v.expectedVersion } : {}),
        }
      : {}),
  };
}

export function useSaveTimetableDraft() {
  const invalidate = useInvalidateTimetables();
  return useMutation({
    mutationFn: (v: DraftInput) => saveTimetableDraft(draftArgs(v)),
    onSettled: invalidate,
  });
}

export function useActivateTimetable() {
  const invalidate = useInvalidateTimetables();
  return useMutation({
    // 2310: the version the user saw (CONFLICT when the draft changed); a repeat returns replayed: true
    mutationFn: (v: { versionId: string; version: number }) =>
      activateTimetable({ p_version_id: v.versionId, p_expected_version: v.version }),
    onSettled: invalidate,
  });
}

export function useDiscardDraft() {
  const invalidate = useInvalidateTimetables();
  return useMutation({
    mutationFn: (v: { versionId: string; version: number }) =>
      discardTimetableDraft({ p_version_id: v.versionId, p_expected_version: v.version }),
    onSettled: invalidate,
  });
}

export function useCopyTimetable() {
  const invalidate = useInvalidateTimetables();
  return useMutation({
    mutationFn: (v: {
      fromVersionId: string;
      targetSectionId: string;
      effectiveFrom: string;
      keepTeachers: boolean;
    }) =>
      copyTimetable({
        p_from_version_id: v.fromVersionId,
        p_target_section_id: v.targetSectionId,
        p_effective_from: v.effectiveFrom,
        p_keep_teachers: v.keepTeachers,
      }),
    // not awaited: after an uncertain copy the dialog says "checking" at once, not after the refresh
    onSettled: () => void invalidate(),
  });
}

export function useGenerateLessons() {
  const invalidate = useInvalidateLessons();
  return useMutation({
    mutationFn: (v: { from: string; to: string; sectionId: string | null }) =>
      generateLessonSessions({
        p_from: v.from,
        p_to: v.to,
        ...(v.sectionId ? { p_section_id: v.sectionId } : {}),
      }),
    onSettled: invalidate,
  });
}
