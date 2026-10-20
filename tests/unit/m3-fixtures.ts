// Fixtures for the M3 (fees) unit/component tests. Shapes follow the SQL of migrations 1100/2300/2320.
import { ids } from './fake-supabase';

export const M3 = {
  student: 'f1f1f1f1-0000-4000-8000-000000000001',
  other: 'f1f1f1f1-0000-4000-8000-000000000002',
  inv1: 'f2f2f2f2-0000-4000-8000-000000000001',
  inv2: 'f2f2f2f2-0000-4000-8000-000000000002',
  inv3: 'f2f2f2f2-0000-4000-8000-000000000003',
  col1: 'f3f3f3f3-0000-4000-8000-000000000001',
  rcpt1: 'f4f4f4f4-0000-4000-8000-000000000001',
  cheque1: 'f5f5f5f5-0000-4000-8000-000000000001',
  tuition: 'f6f6f6f6-0000-4000-8000-000000000001',
  transport: 'f6f6f6f6-0000-4000-8000-000000000002',
  late: 'f6f6f6f6-0000-4000-8000-000000000003',
  lab: 'f6f6f6f6-0000-4000-8000-000000000004',
  term1: 'f7f7f7f7-0000-4000-8000-000000000001',
  class1: 'c1c1c1c1-0000-4000-8000-000000000001',
  class2: 'c1c1c1c1-0000-4000-8000-000000000002',
  bank: 'f8f8f8f8-0000-4000-8000-000000000001',
  upi: 'f8f8f8f8-0000-4000-8000-000000000002',
  preset: 'f9f9f9f9-0000-4000-8000-000000000001',
};

// Capabilities exactly as private.role_has_cap grants them (migration 2200).
export const FEE_CAPS = {
  accountant: ['staff.member', 'students.read_all', 'fees.read', 'fees.manage', 'staff.read'],
  owner: ['staff.member', 'attendance.summary', 'fees.read', 'staff.read', 'staff_finance.read'],
  parent: ['child.view'],
};

export function invoiceRow(o: Partial<Record<string, unknown>> = {}) {
  return {
    invoice_id: M3.inv1,
    invoice_no: 'INV/2026-27/00001',
    due_date: '2026-07-10',
    status: 'issued',
    source: 'term',
    origin_label: null,
    term: 'Term 1',
    year: '2026-27',
    charged_paise: 450000,
    adjustments_paise: 0,
    paid_paise: 0,
    balance_paise: 450000,
    payment_state: 'unpaid',
    overdue: true,
    lines: [
      {
        fee_head_id: M3.tuition,
        label: 'Tuition fee',
        gross_paise: 500000,
        concession_paise: 50000,
        net_paise: 450000,
      },
    ],
    adjustments: null,
    ...o,
  };
}

export function statementRow(o: Partial<Record<string, unknown>> = {}) {
  return {
    student_id: M3.student,
    student: {
      name: 'Aarav Sharma',
      admission_no: '2024/001',
      status: 'active',
      class_id: M3.class1,
      section_id: null,
      class_section: 'Class 1 A',
    },
    invoices: [
      invoiceRow(),
      invoiceRow({
        invoice_id: M3.inv2,
        invoice_no: 'INV/2026-27/00002',
        due_date: '2026-10-10',
        term: 'Term 2',
        charged_paise: 300000,
        balance_paise: 300000,
        overdue: false,
      }),
    ],
    collections: [],
    pending_cheques: [],
    bounced_cheques: [],
    total_due_paise: 750000,
    open_exceptions: 0,
    ...o,
  };
}

export function collectionRowStmt(o: Partial<Record<string, unknown>> = {}) {
  return {
    collection_id: M3.col1,
    receipt_id: M3.rcpt1,
    receipt_no: 'RCT/2026-27/00007',
    received_on: '2026-10-19',
    method: 'cash',
    amount_paise: 200000,
    reference: null,
    allocations: [{ invoice_id: M3.inv1, invoice_no: 'INV/2026-27/00001', amount_paise: 200000 }],
    reversed_paise: 0,
    reversals: null,
    ...o,
  };
}

export function feeSetupRow(o: Partial<Record<string, unknown>> = {}) {
  return {
    academic_year_id: ids.year,
    can_manage: true,
    fee_heads: [
      {
        id: M3.tuition,
        name: 'Tuition fee',
        code: 'TUITION',
        kind: 'regular',
        is_optional: false,
        status: 'active',
        version: 1,
      },
      {
        id: M3.lab,
        name: 'Lab fee',
        code: 'LAB',
        kind: 'regular',
        is_optional: false,
        status: 'active',
        version: 1,
      },
      {
        id: M3.transport,
        name: 'Transport',
        code: 'BUS',
        kind: 'regular',
        is_optional: true,
        status: 'active',
        version: 1,
      },
      {
        id: M3.late,
        name: 'Late fee',
        code: 'LATE',
        kind: 'late_fee',
        is_optional: false,
        status: 'active',
        version: 1,
      },
    ],
    receiving_accounts: [
      {
        id: M3.bank,
        label: 'SBI current',
        kind: 'bank',
        bank_name: 'SBI',
        account_last4: '1234',
        ifsc: 'SBIN0001234',
        upi_id: null,
        status: 'active',
        version: 1,
      },
      {
        id: M3.upi,
        label: 'School UPI',
        kind: 'upi',
        bank_name: null,
        account_last4: null,
        ifsc: null,
        upi_id: 'school@okaxis',
        status: 'active',
        version: 1,
      },
    ],
    terms: [
      {
        id: M3.term1,
        name: 'Term 1',
        sort_order: 1,
        due_date: '2026-07-10',
        status: 'active',
        version: 1,
        invoices_issued: 0,
      },
    ],
    structure: [
      { fee_term_id: M3.term1, class_id: M3.class1, fee_head_id: M3.tuition, amount_paise: 500000 },
      { fee_term_id: M3.term1, class_id: M3.class1, fee_head_id: M3.transport, amount_paise: 0 },
    ],
    concession_presets: [
      {
        id: M3.preset,
        name: 'Sibling 10%',
        kind: 'percent',
        percent_bp: 1000,
        fixed_paise: null,
        status: 'active',
        version: 1,
        fee_head_ids: [M3.tuition],
      },
    ],
    late_fee_rule: null,
    ...o,
  };
}

export function snapshotM3() {
  return {
    academic_years: [
      {
        id: ids.year,
        name: '2026-27',
        start_date: '2026-06-01',
        end_date: '2027-03-31',
        is_current: true,
        status: 'active',
        version: 1,
      },
    ],
    selected_year_id: ids.year,
    classes: [
      { id: M3.class1, name: 'Class 1', sort_order: 1, status: 'active', version: 1 },
      { id: M3.class2, name: 'Class 2', sort_order: 2, status: 'active', version: 1 },
    ],
    sections: [],
    subjects: [],
    period_schedules: [],
    attendance_mode_today: 'daily',
    attendance_modes: [],
  };
}

export function receiptRow(o: Partial<Record<string, unknown>> = {}) {
  return {
    receipt_id: M3.rcpt1,
    receipt_no: 'RCT/2026-27/00007',
    issued_at: '2026-10-19T05:30:00Z',
    template_version: 1,
    snapshot: {
      school_name: 'Demo School',
      school_address: '1 Main Road, Hyderabad, 500001',
      receipt_no: 'RCT/2026-27/00007',
      date: '2026-10-19',
      student_name: 'Aarav Sharma',
      admission_no: '2024/001',
      class_section: 'Class 1 A',
      method: 'upi',
      reference: 'UTR123456',
      account: 'School UPI',
      payer: null,
      amount_paise: 455050,
      allocations: [{ invoice_no: 'INV/2026-27/00001', term: 'Term 1', amount_paise: 455050 }],
      collected_by: 'Demo Accountant',
    },
    reversals: null,
    ...o,
  };
}

export function duesRow(o: Partial<Record<string, unknown>> = {}) {
  return {
    student_id: M3.student,
    name: 'Aarav Sharma',
    admission_no: '2024/001',
    student_status: 'active',
    class_id: M3.class1,
    section_id: null,
    class_section: 'Class 1 A',
    charged_paise: 450000,
    paid_paise: 100000,
    balance_paise: 350000,
    overdue_paise: 350000,
    invoices: 1,
    pending_cheque_paise: 0,
    ...o,
  };
}
