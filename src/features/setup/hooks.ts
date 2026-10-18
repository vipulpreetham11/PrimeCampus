import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Json } from '@/generated/database.types';
import {
  getCalendar,
  getSchoolProfile,
  getSetupSnapshot,
  listClassSubjects,
  saveAcademicYear,
  saveCalendarPattern,
  saveCalendarRange,
  saveClass,
  saveClassSubjects,
  savePeriodSchedule,
  saveSchoolProfile,
  saveSection,
  saveSubject,
  setAttendanceMode,
  setCurrentYear,
} from '@/lib/rpc';
import { reloadContext } from '@/lib/session/session';
import { useScopedKey } from '@/lib/scope';

// School setup data (brief §1). Reads: get_school_profile / get_setup_snapshot / get_calendar /
// list_class_subjects. Every key is scoped to the context revision; mutations invalidate only
// the feature keys they affect.

const STABLE = 5 * 60_000; // TRD §18: stable setup data

export function useSchoolProfile() {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('school-profile'),
    queryFn: ({ signal }) => getSchoolProfile({}, { signal }),
    staleTime: STABLE,
  });
}

export function useSaveSchoolProfile() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { p: Record<string, string | null>; version: number }) =>
      saveSchoolProfile({ p: v.p, p_expected_version: v.version }),
    onSettled: () => qc.invalidateQueries({ queryKey: key('school-profile') }),
  });
}

/** Setup snapshot for a year (null = the school's current year). */
export function useSetupSnapshot(yearId: string | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('setup', yearId),
    queryFn: ({ signal }) => getSetupSnapshot(yearId ? { p_academic_year_id: yearId } : {}, { signal }),
    staleTime: STABLE,
  });
}

function useInvalidateSetup() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: key('setup') });
}

export interface YearInput {
  id?: string;
  version?: number;
  name: string;
  start_date: string;
  end_date: string;
}
export function useSaveYear() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    mutationFn: (v: YearInput) =>
      saveAcademicYear({
        p_name: v.name,
        p_start_date: v.start_date,
        p_end_date: v.end_date,
        ...(v.id ? { p_id: v.id, p_expected_version: v.version } : {}),
      }),
    onSettled: invalidate,
  });
}

export function useSetCurrentYear() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    mutationFn: (yearId: string) => setCurrentYear({ p_academic_year_id: yearId }),
    // the header shows the current year from get_context: re-read it (same revision, caches kept)
    onSuccess: () => void reloadContext().catch(() => undefined),
    onSettled: invalidate,
  });
}

export interface ClassInput {
  id?: string;
  version?: number;
  name: string;
  sort_order: number;
  status: 'active' | 'retired';
}
export function useSaveClass() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    mutationFn: (v: ClassInput) =>
      saveClass({
        p_name: v.name,
        p_sort_order: v.sort_order,
        p_status: v.status,
        ...(v.id ? { p_id: v.id, p_expected_version: v.version } : {}),
      }),
    onSettled: invalidate,
  });
}

export interface SectionInput {
  id?: string;
  version?: number;
  academic_year_id: string;
  class_id: string;
  name: string;
  capacity: number | null;
  sort_order: number;
  status: 'active' | 'retired';
}
export function useSaveSection() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    // save_section overwrites capacity/sort_order on update, so the current values are always sent back
    mutationFn: (v: SectionInput) =>
      saveSection({
        p_academic_year_id: v.academic_year_id,
        p_class_id: v.class_id,
        p_name: v.name,
        ...(v.capacity !== null ? { p_capacity: v.capacity } : {}),
        p_sort_order: v.sort_order,
        p_status: v.status,
        ...(v.id ? { p_id: v.id, p_expected_version: v.version } : {}),
      }),
    onSettled: invalidate,
  });
}

export interface SubjectInput {
  id?: string;
  version?: number;
  name: string;
  code: string;
  status: 'active' | 'retired';
}
export function useSaveSubject() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    mutationFn: (v: SubjectInput) =>
      saveSubject({
        p_name: v.name,
        p_code: v.code,
        p_status: v.status,
        ...(v.id ? { p_id: v.id, p_expected_version: v.version } : {}),
      }),
    onSettled: invalidate,
  });
}

export function useClassSubjects(yearId: string | null, classId: string | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('class-subjects', yearId, classId),
    queryFn: ({ signal }) =>
      listClassSubjects({ p_academic_year_id: yearId!, p_class_id: classId! }, { signal }),
    enabled: !!yearId && !!classId,
    staleTime: STABLE,
  });
}

export function useSaveClassSubjects() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      yearId: string;
      classId: string;
      subjects: { subject_id: string; is_optional: boolean; sort_order: number }[];
    }) =>
      saveClassSubjects({
        p_academic_year_id: v.yearId,
        p_class_id: v.classId,
        p_subjects: v.subjects as unknown as Json,
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: key('class-subjects') }),
  });
}

export interface ScheduleInput {
  name: string;
  kind: 'regular' | 'half_day' | 'special';
  day_start: string;
  day_end: string;
  effective_from: string;
  slots: { ordinal: number; label: string; kind: 'period' | 'break'; start_time: string; end_time: string }[];
}
export function useSavePeriodSchedule() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    mutationFn: (v: ScheduleInput) =>
      savePeriodSchedule({
        p_name: v.name,
        p_kind: v.kind,
        p_day_start: v.day_start,
        p_day_end: v.day_end,
        p_effective_from: v.effective_from,
        p_slots: v.slots as unknown as Json,
      }),
    onSettled: invalidate,
  });
}

export function useSetAttendanceMode() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    mutationFn: (v: { mode: 'daily' | 'period'; effective_from: string }) =>
      setAttendanceMode({ p_mode: v.mode, p_effective_from: v.effective_from }),
    onSettled: invalidate,
  });
}

export interface CalendarQuery {
  yearId: string | null;
  audience: 'student' | 'staff';
  staffGroupId: string | null;
  from: string | null;
  to: string | null;
}
export function useCalendar(q: CalendarQuery) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('calendar', q.yearId, q.audience, q.staffGroupId, q.from, q.to),
    queryFn: ({ signal }) =>
      getCalendar(
        {
          p_academic_year_id: q.yearId!,
          p_audience: q.audience,
          ...(q.staffGroupId ? { p_staff_group_id: q.staffGroupId } : {}),
          ...(q.from ? { p_from: q.from } : {}),
          ...(q.to ? { p_to: q.to } : {}),
        },
        { signal },
      ),
    enabled: !!q.yearId,
    staleTime: STABLE,
  });
}

function useInvalidateCalendar() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: key('calendar') });
}

export function useSaveCalendarPattern() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (v: {
      yearId: string;
      audience: 'student' | 'staff';
      staffGroupId: string | null;
      patterns: { weekday: number; day_type: string; period_schedule_id: string | null }[];
    }) =>
      saveCalendarPattern({
        p_academic_year_id: v.yearId,
        p_audience: v.audience,
        p_patterns: v.patterns as unknown as Json,
        ...(v.staffGroupId ? { p_staff_group_id: v.staffGroupId } : {}),
      }),
    onSettled: invalidate,
  });
}

export interface CalendarRangeInput {
  yearId: string;
  audience: 'student' | 'staff';
  staffGroupId: string | null;
  from: string;
  to: string;
  day_type: 'working' | 'half_day' | 'holiday' | 'weekly_off';
  period_schedule_id: string | null;
  label: string | null;
  reason: string | null;
  is_exam_day: boolean;
  weekdays: number[] | null;
}
export function useSaveCalendarRange() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (v: CalendarRangeInput) =>
      saveCalendarRange({
        p_academic_year_id: v.yearId,
        p_audience: v.audience,
        p_from: v.from,
        p_to: v.to,
        p_day_type: v.day_type,
        p_is_exam_day: v.is_exam_day,
        ...(v.staffGroupId ? { p_staff_group_id: v.staffGroupId } : {}),
        ...(v.period_schedule_id ? { p_period_schedule_id: v.period_schedule_id } : {}),
        ...(v.label ? { p_label: v.label } : {}),
        ...(v.reason ? { p_reason: v.reason } : {}),
        ...(v.weekdays && v.weekdays.length > 0 ? { p_weekdays: v.weekdays } : {}),
      }),
    onSettled: invalidate,
  });
}
