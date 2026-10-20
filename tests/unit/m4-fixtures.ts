// Fixtures for the M4 tests (salary, reports, lessons, dashboard, operator). Shapes follow the SQL
// of migrations 2400 / 2410 exactly (the RPC layer validates them with the M4 contracts).

export const M4 = {
  staff: 'a4a4a4a4-0000-4000-8000-000000000001',
  staff2: 'a4a4a4a4-0000-4000-8000-000000000002',
  group: 'a4a4a4a4-0000-4000-8000-000000000003',
  calc: 'a4a4a4a4-0000-4000-8000-000000000004',
  calc2: 'a4a4a4a4-0000-4000-8000-000000000005',
  leave: 'a4a4a4a4-0000-4000-8000-000000000006',
  section: 'a4a4a4a4-0000-4000-8000-000000000007',
  student1: 'a4a4a4a4-0000-4000-8000-000000000008',
  student2: 'a4a4a4a4-0000-4000-8000-000000000009',
  subject: 'a4a4a4a4-0000-4000-8000-00000000000a',
  head1: 'a4a4a4a4-0000-4000-8000-00000000000b',
  head2: 'a4a4a4a4-0000-4000-8000-00000000000c',
  year: '77777777-7777-4777-8777-777777777777',
  school: '22222222-2222-4222-8222-222222222222',
  actor: '11111111-1111-4111-8111-111111111111',
};

export const CAPS = {
  admin: [
    'staff.member',
    'setup.manage',
    'students.read_all',
    'timetable.read_all',
    'timetable.manage',
    'attendance.read_all',
    'attendance.summary',
    'academic.read_all',
    'fees.read',
    'fees.manage',
    'staff.read',
    'staff_attendance.read',
    'staff_attendance.manage',
    'staff_finance.read',
    'staff_finance.manage',
    'admissions.manage',
  ],
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
  accountant: ['staff.member', 'students.read_all', 'fees.read', 'fees.manage', 'staff.read'],
  owner: ['staff.member', 'attendance.summary', 'fees.read', 'staff.read', 'staff_finance.read'],
  teacher: ['staff.member', 'timetable.read_all', 'lessons.teach', 'staff.read'],
};

/** compute_salary for the PRD example (AC-26): ₹40,000, W 20, attended 15, paid leave 1 → ₹32,000. */
export function computation(overrides: Record<string, unknown> = {}) {
  return {
    staff_id: M4.staff,
    month: '2026-09-01',
    monthly_salary_paise: 4_000_000,
    working_days: 20,
    attended_days: 15,
    paid_leave_days: 1,
    unpaid_days: 4,
    marked_days: { present: 14, late: 0, half_day: 2, absent: 2 },
    payable_paise: 3_200_000,
    needs_manual_resolution: false,
    resolution_reason: null,
    unmarked_working_dates: ['2026-09-29', '2026-09-30'],
    discrepancies: [{ date: '2026-09-06', issue: 'attendance_on_non_working_day' }],
    overrides: {},
    ...overrides,
  };
}

export function savedSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: M4.calc,
    version_no: 1,
    monthly_salary_paise: 4_000_000,
    working_days: 20,
    attended_days: 15,
    paid_leave_days: 1,
    unpaid_days: 4,
    payable_paise: 3_200_000,
    overrides: {},
    override_reason: null,
    created_at: '2026-10-01T05:00:00+00:00',
    calculated_by: 'Demo Admin',
    ...overrides,
  };
}

export function liveSummary(overrides: Record<string, unknown> = {}) {
  return {
    monthly_salary_paise: 4_000_000,
    working_days: 20,
    attended_days: 15,
    paid_leave_days: 1,
    unpaid_days: 4,
    payable_paise: 3_200_000,
    marked_days: { present: 14, late: 0, half_day: 2, absent: 2 },
    needs_manual_resolution: false,
    resolution_reason: null,
    unmarked_count: 2,
    discrepancy_count: 1,
    ...overrides,
  };
}

export function monthRow(overrides: Record<string, unknown> = {}) {
  return {
    staff_id: M4.staff,
    name: 'Ramesh Peon',
    employee_no: 'EMP-7',
    staff_group_id: M4.group,
    group: 'Office staff',
    joined_on: '2024-06-01',
    left_on: null,
    partial_month: false,
    status: 'not_saved',
    saved: null,
    live: liveSummary(),
    ...overrides,
  };
}

export function salaryMonth(
  rows: unknown[] = [monthRow()],
  canManage = true,
  totals: Record<string, unknown> = {},
) {
  return {
    month: '2026-09-01',
    can_manage: canManage,
    rows,
    totals: {
      staff: rows.length,
      saved: 0,
      changed: 0,
      needs_resolution: 0,
      not_saved: rows.length,
      saved_payable_paise: 0,
      ...totals,
    },
  };
}

export function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: M4.calc,
    staff_id: M4.staff,
    staff_name: 'Ramesh Peon',
    employee_no: 'EMP-7',
    month: '2026-09-01',
    version_no: 1,
    status: 'final',
    monthly_salary_paise: 4_000_000,
    working_days: 20,
    attended_days: 15,
    paid_leave_days: 1,
    unpaid_days: 4,
    payable_paise: 3_200_000,
    discrepancies: { unmarked_working_dates: [], items: [] },
    overrides: {},
    override_reason: null,
    created_at: '2026-10-01T05:00:00+00:00',
    calculated_by: 'Demo Admin',
    ...overrides,
  };
}

export function paidLeaveRow(overrides: Record<string, unknown> = {}) {
  return {
    id: M4.leave,
    staff_id: M4.staff,
    name: 'Ramesh Peon',
    leave_date: '2026-09-15',
    day_fraction: 1,
    reason: 'Family function',
    status: 'active',
    recorded_by: 'Demo Admin',
    created_at: '2026-09-16T05:00:00+00:00',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------- register

export function registerRow() {
  const date = (
    d: string,
    mode: 'daily' | 'period',
    weight = 1,
    day_type = 'working',
    label: string | null = null,
  ) => ({
    date: d,
    weekday: 1,
    weight,
    day_type,
    label,
    mode,
  });
  return {
    section_id: M4.section,
    section: 'Class 1 A',
    month: '2026-10-01',
    to: '2026-10-20',
    dates: [
      date('2026-10-18', 'daily', 0, 'weekly_off', 'Sunday'),
      date('2026-10-19', 'period'),
      date('2026-10-20', 'daily'),
    ],
    students: [
      {
        student_id: M4.student1,
        name: 'Aarav Sharma',
        admission_no: 'DEMO-S1',
        roll_no: '1',
        cells: {
          '2026-10-19': { held: 3, marked: 2, attended: 2 },
          '2026-10-20': { s: null },
        },
        expected_units: 4,
        marked_units: 2,
        attended_units: 2,
        unmarked_units: 2,
        percentage: 100,
        is_final: false,
      },
      {
        student_id: M4.student2,
        name: 'Anaya Rao',
        admission_no: 'DEMO-S2',
        roll_no: '2',
        cells: { '2026-10-20': { s: 'A' } },
        expected_units: 1,
        marked_units: 1,
        attended_units: 0,
        unmarked_units: 0,
        percentage: 0,
        is_final: true,
      },
    ],
    legend: { daily: 'x', period: 'y' },
  };
}

export function changeRow(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'student_daily',
    attendance_date: '2026-10-20',
    person_id: M4.student1,
    person: 'Aarav Sharma',
    admission_no: 'DEMO-S1',
    lesson_session_id: null,
    lesson: null,
    section: 'Class 1 A',
    old_status: 'A',
    new_status: 'P',
    changed_by: 'Demo Admin',
    changed_by_role: 'admin',
    changed_at: '2026-10-20T06:00:00+00:00',
    ...overrides,
  };
}

export function coverageRow(overrides: Record<string, unknown> = {}) {
  return {
    section_id: M4.section,
    section: 'Class 1 A',
    subject_id: M4.subject,
    subject: 'English',
    staff_id: M4.staff2,
    teacher: 'Ravi Kumar',
    lessons: 10,
    diary_written: 7,
    period_lessons: 2,
    period_attendance_marked: 2,
    homework_set: 3,
    homework_due: 2,
    homework_due_fully_checked: 1,
    homework_due_unchecked: 1,
    ...overrides,
  };
}

export function feeHeadReport(overrides: Record<string, unknown> = {}) {
  return {
    academic_year_id: M4.year,
    fee_term_id: null,
    heads: [
      {
        fee_head_id: M4.head1,
        code: 'TU',
        name: 'Tuition',
        kind: 'regular',
        invoices: 2,
        gross_paise: 1_000_000,
        concession_paise: 50_000,
        adjustments_paise: -15_000,
      },
      {
        fee_head_id: M4.head2,
        code: 'LF',
        name: 'Late fee',
        kind: 'late_fee',
        invoices: 0,
        gross_paise: 0,
        concession_paise: 0,
        adjustments_paise: 10_000,
      },
    ],
    adjustments_without_head_paise: 20_000,
    totals: { charged_paise: 965_000, paid_paise: 400_000, balance_paise: 565_000 },
    note: 'Payments are allocated to invoices, not to fee heads, so collections are shown in total only.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------- dashboard

const BLOCKS = {
  attendance: {
    mode: 'daily',
    sections_expected: 4,
    sections_complete: 3,
    sections_not_started: 1,
    expected: 120,
    marked: 90,
    present: 85.5,
  },
  staff: { active_staff: 12, marked: 10, absent: 2, half_day: 1, lessons_with_absent_teacher: 3 },
  academic: {
    lessons_today: 24,
    diary_missing_last_7_days: 5,
    homework_due_unchecked_from: '2026-10-06',
    homework_due_unchecked: 4,
  },
  admissions: { followups_overdue: 2, followups_today: 1, open_leads: 9 },
  fees: {
    collected_on_date: { count: 3, amount_paise: 450_000 },
    academic_year_id: M4.year,
    due_paise: 9_000_000,
    overdue_paise: 2_500_000,
    older_years_due_paise: 0,
    pending_cheques: { count: 1, amount_paise: 80_000 },
    open_exceptions: 1,
  },
  salary: { month: '2026-09-01', staff: 12, saved: 5, saved_payable_paise: 15_000_000 },
  setup_issues: [
    { code: 'no_timetable', section_id: M4.section, message: 'Class 1 A has no active timetable' },
  ],
};

/** get_dashboard as the server builds it for a role (blocks by capability). */
export function dashboardFor(role: 'admin' | 'principal' | 'accountant' | 'owner') {
  const base = {
    date: '2026-10-20',
    today: '2026-10-20',
    role,
    day: { academic_year_id: M4.year, day_type: 'working', weight: 1, period_schedule_id: null, label: null },
  };
  switch (role) {
    case 'admin':
      return { ...base, ...BLOCKS };
    case 'principal':
      return { ...base, attendance: BLOCKS.attendance, staff: BLOCKS.staff, academic: BLOCKS.academic };
    case 'accountant':
      return { ...base, fees: BLOCKS.fees };
    case 'owner':
      return { ...base, attendance: BLOCKS.attendance, fees: BLOCKS.fees, salary: BLOCKS.salary };
  }
}

// ---------------------------------------------------------------------------- operator

export function auditEvent(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    occurred_at: '2026-10-20T06:00:00+00:00',
    actor_id: M4.actor,
    actor_role: 'admin',
    via_operator: false,
    app_session_id: null,
    school_id: M4.school,
    academic_year_id: null,
    action: 'salary.calculation.saved',
    entity_type: 'salary_calculations',
    entity_id: M4.calc,
    operation_id: null,
    detail: { staff_id: M4.staff, version_no: 1, payable_paise: 3_200_000 },
    actor_username: 'demo.admin',
    actor_name: 'Demo Admin',
    school_name: 'Demo School',
    ...overrides,
  };
}

export function maintenanceRow(overrides: Record<string, unknown> = {}) {
  return {
    retention: [
      { key: 'auth_events_days', days: 400, updated_at: '2026-10-05T00:00:00+00:00' },
      { key: 'telemetry_days', days: 30, updated_at: '2026-10-05T00:00:00+00:00' },
    ],
    schedule: [{ jobname: 'primecampus-maintenance', schedule: '0 21 * * *', active: true }],
    scheduled: true,
    runs: [
      {
        ran_at: '2026-10-19T21:00:00+00:00',
        trigger: 'schedule',
        result: { telemetry_deleted: 4, usage_daily_deleted: 0, auth_events_deleted: 0, sessions_expired: 1 },
      },
    ],
    open_sessions: 7,
    ...overrides,
  };
}
