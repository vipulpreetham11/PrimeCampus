// Fixtures for the M2 unit/component tests. Shapes follow the SQL of migrations 1000/1300/2200.
import { ids } from './fake-supabase';

export const M2 = {
  sectionA: 'a1a1a1a1-0000-4000-8000-000000000001',
  sectionB: 'a1a1a1a1-0000-4000-8000-000000000002',
  class1: 'c1c1c1c1-0000-4000-8000-000000000001',
  maths: '5a5a5a5a-0000-4000-8000-000000000001',
  english: '5a5a5a5a-0000-4000-8000-000000000002',
  science: '5a5a5a5a-0000-4000-8000-000000000003',
  schedule: '5c5c5c5c-0000-4000-8000-000000000001',
  version: '7e7e7e7e-0000-4000-8000-000000000001',
  meera: '57a57a57-0000-4000-8000-000000000001',
  ravi: '57a57a57-0000-4000-8000-000000000002',
  s1: '57d57d57-0000-4000-8000-000000000001',
  s2: '57d57d57-0000-4000-8000-000000000002',
  s3: '57d57d57-0000-4000-8000-000000000003',
  homework: '40404040-0000-4000-8000-000000000001',
  diary: 'd1d1d1d1-0000-4000-8000-000000000001',
};

// Capabilities exactly as private.role_has_cap grants them (migration 2200).
export const CAPS = {
  teacher: ['staff.member', 'lessons.teach', 'timetable.read_all', 'staff.read'],
  parent: ['child.view'],
  principal: [
    'staff.member',
    'students.read_all',
    'timetable.read_all',
    'attendance.read_all',
    'attendance.summary',
    'academic.read_all',
    'staff.read',
    'staff_attendance.read',
  ],
  admin: [
    'staff.member',
    'setup.manage',
    'users.manage',
    'students.read_all',
    'students.manage',
    'students.sensitive',
    'admissions.manage',
    'imports.manage',
    'timetable.read_all',
    'timetable.manage',
    'attendance.read_all',
    'attendance.mark_any',
    'attendance.summary',
    'academic.read_all',
    'academic.correct',
    'fees.read',
    'fees.manage',
    'staff.read',
    'staff.manage',
    'staff_attendance.read',
    'staff_attendance.manage',
    'staff_finance.read',
    'staff_finance.manage',
    'export.full',
  ],
};

const slot = (ordinal: number, label: string, kind: 'period' | 'break', start: string, end: string) => ({
  ordinal,
  label,
  kind,
  start_time: start,
  end_time: end,
});

export const SLOTS = [
  slot(1, 'Period 1', 'period', '09:00:00', '09:40:00'),
  slot(2, 'Period 2', 'period', '09:40:00', '10:20:00'),
  slot(3, 'Lunch', 'break', '10:20:00', '10:50:00'),
  slot(4, 'Period 3', 'period', '10:50:00', '11:30:00'),
];

export function snapshotM2() {
  return {
    academic_years: [
      {
        id: ids.year,
        name: '2026-27',
        start_date: '2026-04-01',
        end_date: '2027-03-31',
        is_current: true,
        status: 'active',
        version: 1,
      },
    ],
    selected_year_id: ids.year,
    classes: [{ id: M2.class1, name: 'Class 1', sort_order: 1, status: 'active', version: 1 }],
    sections: [
      {
        id: M2.sectionA,
        academic_year_id: ids.year,
        class_id: M2.class1,
        name: 'A',
        capacity: 40,
        sort_order: 1,
        status: 'active',
        version: 1,
      },
      {
        id: M2.sectionB,
        academic_year_id: ids.year,
        class_id: M2.class1,
        name: 'B',
        capacity: 40,
        sort_order: 2,
        status: 'active',
        version: 1,
      },
    ],
    subjects: [
      { id: M2.maths, name: 'Mathematics', code: 'MATH', status: 'active', version: 1 },
      { id: M2.english, name: 'English', code: 'ENG', status: 'active', version: 1 },
      { id: M2.science, name: 'Science', code: 'SCI', status: 'active', version: 1 },
    ],
    period_schedules: [
      {
        id: M2.schedule,
        name: 'Regular day',
        kind: 'regular',
        effective_from: '2026-04-01',
        effective_to: null,
        slots: SLOTS,
      },
    ],
    attendance_mode_today: 'period',
    attendance_modes: [{ mode: 'period', effective_from: '2026-10-19' }],
  };
}

export function classSubjectsM2() {
  return [M2.maths, M2.english, M2.science].map((subject_id, i) => ({
    id: `c5c5c5c5-0000-4000-8000-00000000000${i + 1}`,
    class_id: M2.class1,
    subject_id,
    subject: ['Mathematics', 'English', 'Science'][i],
    code: ['MATH', 'ENG', 'SCI'][i],
    is_optional: false,
    sort_order: i + 1,
    status: 'active',
  }));
}

export function staffListM2() {
  return [
    { id: M2.meera, name: 'Meera Rao', no: 'DEMO-T2' },
    { id: M2.ravi, name: 'Ravi Kumar', no: 'DEMO-T1' },
  ].map((s) => ({
    staff_id: s.id,
    employee_no: s.no,
    name: s.name,
    group: 'Teaching staff',
    staff_group_id: 'a9a9a9a9-0000-4000-8000-000000000001',
    designation: null,
    is_teaching: true,
    phone: null,
    status: 'active',
    joined_on: '2026-04-01',
    has_login: true,
    version: 1,
  }));
}

/** A draft for Class 1 A: Mon P1 Maths (Meera, clashes with Class 1 B), Mon P2 English (no teacher). */
export function timetableVersionRow(overrides: Record<string, unknown> = {}) {
  return {
    timetable_version_id: M2.version,
    section_id: M2.sectionA,
    section: 'Class 1 A',
    class_id: M2.class1,
    academic_year_id: ids.year,
    period_schedule_id: M2.schedule,
    period_schedule: 'Regular day',
    effective_from: '2026-10-12',
    effective_to: null,
    status: 'draft',
    copied_from_id: null,
    version: 3,
    can_edit: true,
    weekdays: [1, 2, 3, 4, 5, 6],
    slots: SLOTS,
    entries: [
      {
        weekday: 1,
        slot_ordinal: 1,
        subject_id: M2.maths,
        subject: 'Mathematics',
        staff_id: M2.meera,
        staff: 'Meera Rao',
      },
      {
        weekday: 1,
        slot_ordinal: 2,
        subject_id: M2.english,
        subject: 'English',
        staff_id: null,
        staff: null,
      },
    ],
    conflicts: [
      {
        weekday: 1,
        slot_ordinal: 1,
        staff_id: M2.meera,
        clashes_with_section_id: M2.sectionB,
        other_slot_ordinal: 1,
      },
    ],
    unassigned_periods: 16,
    ...overrides,
  };
}

/** A period roster: three students, one already marked Present (version 2). */
export function periodRosterRow(overrides: Record<string, unknown> = {}) {
  return {
    section_id: M2.sectionA,
    date: '2026-10-16',
    lesson_session_id: 501,
    mode_on_date: 'period',
    lesson_status: 'scheduled',
    can_mark: true,
    day: {
      academic_year_id: ids.year,
      day_type: 'working',
      weight: 1,
      period_schedule_id: null,
      label: null,
    },
    students: [
      {
        student_id: M2.s1,
        roll_no: '1',
        name: 'Aarav Sharma',
        admission_no: 'DEMO-S1',
        status: null,
        version: null,
      },
      {
        student_id: M2.s2,
        roll_no: '2',
        name: 'Bela Nair',
        admission_no: 'DEMO-S2',
        status: null,
        version: null,
      },
      {
        student_id: M2.s3,
        roll_no: '3',
        name: 'Chetan Das',
        admission_no: 'DEMO-S3',
        status: 'P',
        version: 2,
      },
    ],
    ...overrides,
  };
}

export function marksSavedRow(overrides: Record<string, unknown> = {}) {
  return {
    submission_id: 9001,
    marked: 2,
    changed: 0,
    conflicts: [],
    eligible: 3,
    unmarked_remaining: 0,
    ...overrides,
  };
}

export function diaryEntryRow(
  entry: { body: string; version: number } | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    lesson: {
      lesson_session_id: 501,
      date: '2026-10-16',
      slot_label: 'Period 1',
      start_time: '09:00:00',
      end_time: '09:40:00',
      section_id: M2.sectionA,
      section: 'Class 1 A',
      subject: 'Mathematics',
      teacher: 'Meera Rao',
      status: 'scheduled',
    },
    entry: entry && {
      diary_entry_id: M2.diary,
      body: entry.body,
      version: entry.version,
      recorded_by_staff: 'Meera Rao',
      created_at: '2026-10-16T10:00:00+05:30',
      updated_at: '2026-10-16T10:00:00+05:30',
    },
    can_edit: true,
    ...overrides,
  };
}

export function homeworkRosterRow(overrides: Record<string, unknown> = {}) {
  return {
    can_check: true,
    assignment: {
      id: M2.homework,
      academic_year_id: ids.year,
      section_id: M2.sectionA,
      subject_id: M2.maths,
      lesson_session_id: 501,
      assigned_by_staff: M2.meera,
      assigned_on: '2026-10-16',
      due_on: '2026-10-17',
      description: 'Exercise 3.1, questions 1–5',
      status: 'active',
      version: 1,
      created_by: ids.account,
      created_at: '2026-10-16T10:00:00+05:30',
      updated_at: '2026-10-16T10:00:00+05:30',
    },
    students: [
      {
        student_id: M2.s1,
        roll_no: '1',
        name: 'Aarav Sharma',
        state: 'unchecked',
        correction: null,
        observed_on: null,
        completed_on: null,
        comment: null,
        version: null,
      },
      {
        student_id: M2.s2,
        roll_no: '2',
        name: 'Bela Nair',
        state: 'unchecked',
        correction: null,
        observed_on: null,
        completed_on: null,
        comment: null,
        version: null,
      },
      {
        student_id: M2.s3,
        roll_no: '3',
        name: 'Chetan Das',
        state: 'completed',
        correction: 'none',
        observed_on: '2026-10-17',
        completed_on: null,
        comment: null,
        version: 1,
      },
    ],
    ...overrides,
  };
}
