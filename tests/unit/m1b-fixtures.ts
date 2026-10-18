// Fixtures for the M1b import tests, shaped exactly like the SQL responses (migrations 2000/2100).

/** get_import_template('staff') — private.imp_columns('staff'). */
export function staffTemplateRow() {
  return {
    dataset: 'staff',
    columns: [
      { key: 'employee_no', label: 'Employee no', required: true, example: 'T001', max: 40 },
      { key: 'full_name', label: 'Full name', required: true, example: 'Ravi Kumar', max: 200 },
      {
        key: 'gender',
        label: 'Gender',
        required: false,
        example: 'male',
        allowed: ['male', 'female', 'transgender'],
      },
      { key: 'phone', label: 'Mobile', required: false, example: '9876543210', hint: '10 digits' },
      { key: 'email', label: 'Email', required: false, example: 'ravi@example.com' },
      {
        key: 'staff_group',
        label: 'Staff group',
        required: true,
        example: 'Teaching staff',
        hint: 'Must already exist in Setup → Staff groups',
      },
      { key: 'designation', label: 'Designation', required: false, example: 'PGT Maths', max: 80 },
      {
        key: 'is_teaching',
        label: 'Teaching staff?',
        required: false,
        example: 'yes',
        allowed: ['yes', 'no'],
      },
      {
        key: 'joined_on',
        label: 'Joined on',
        required: true,
        example: '2024-06-01',
        hint: 'YYYY-MM-DD or DD/MM/YYYY',
      },
    ],
    needs_year: false,
    max_rows: 10000,
    max_rows_per_upload: 500,
    max_rows_per_commit: 100,
  };
}

export const JOB_ID = '88888888-8888-4888-8888-888888888888';
export const STAFF_1 = '99999999-9999-4999-8999-999999999999';

export function countsRow(over: Partial<Record<string, number>> = {}) {
  return {
    total: 0,
    ready: 0,
    will_skip: 0,
    needs_fixing: 0,
    created: 0,
    skipped: 0,
    rejected: 0,
    removed: 0,
    ...over,
  };
}

/** private.imp_job_json */
export function jobRow(over: Record<string, unknown> = {}) {
  return {
    job_id: JOB_ID,
    dataset: 'staff',
    academic_year_id: null,
    academic_year: null,
    file_name: 'staff.csv',
    status: 'validating',
    created_at: '2026-10-18T04:00:00+00:00',
    created_by: 'Demo Admin',
    updated_at: '2026-10-18T04:00:00+00:00',
    counts: countsRow(),
    ...over,
  };
}

/** private.imp_row_json */
export function rowRow(over: Record<string, unknown> = {}) {
  return {
    row_no: 2,
    status: 'draft',
    action: 'create',
    data: {
      employee_no: 'T1',
      full_name: 'Ravi Kumar',
      staff_group: 'Teaching staff',
      joined_on: '2026-06-01',
    },
    errors: [],
    result_entity_id: null,
    info: null,
    ...over,
  };
}
