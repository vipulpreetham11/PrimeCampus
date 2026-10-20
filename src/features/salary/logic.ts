import type {
  OverrideKey,
  SalarySaved,
  SalaryComputation,
  SalaryMonth,
  SalaryMonthRow,
  SalaryOverrides,
  SalaryStatus,
} from '@/contracts/salary';
import { toCsv } from '@/lib/csv';
import { addDays, monthParam, monthStart, type IsoDate } from '@/lib/dates';
import { formatINR, paiseToCsvRupees, parseRupeesToPaise, paiseToRupeesString } from '@/lib/money';

// Salary calculator logic (SAL-01), kept free of React so it can be unit-tested:
// payable = round(salary × (attended + paid leave) / working) — computed by the SERVER; the UI only
// shows the server's numbers in the formula. Days are decimals (0.5 steps from attendance, 0.25 on
// a half-weight day); they are parsed and shown with string rules, never by float arithmetic.

// ------------------------------------------------------------------ days

/** 15 → "15", 15.5 → "15.5", 0.25 → "0.25" (server numbers have at most 2 decimals). */
export function formatDays(n: number): string {
  const fixed = n.toFixed(2);
  return fixed.replace(/\.?0+$/, '') || '0';
}

const DAYS_PATTERN = /^(\d{1,2})(?:\.(\d{1,2}))?$/;

/** User-typed days: 0–31 in steps of 0.5 ("15", "15.5", "15.50"); parsed from the text, not a float. */
export function parseDays(text: string): { ok: true; days: number } | { ok: false; error: string } {
  const m = DAYS_PATTERN.exec(text.trim());
  const error = 'Days must be 0–31 in steps of 0.5';
  if (!m) return { ok: false, error };
  const whole = Number(m[1]);
  const frac = (m[2] ?? '').padEnd(2, '0');
  if (frac !== '00' && frac !== '50') return { ok: false, error };
  if (whole > 31 || (whole === 31 && frac === '50')) return { ok: false, error };
  return { ok: true, days: whole + (frac === '50' ? 0.5 : 0) };
}

/** Compare day values exactly: every server value is a multiple of 0.25. */
function quarters(n: number): number {
  return Math.round(n * 4);
}

// ------------------------------------------------------------------ months

export { monthParam, parseMonthParam } from '@/lib/dates';

/** The salary month to open by default: the previous month (the one that is complete). */
export function defaultSalaryMonth(today: IsoDate): IsoDate {
  return monthStart(addDays(monthStart(today), -1));
}

export function shiftMonth(month: IsoDate, by: 1 | -1): IsoDate {
  return by === -1 ? monthStart(addDays(monthStart(month), -1)) : monthStart(addDays(monthStart(month), 32));
}

// ------------------------------------------------------------------ display

export const STATUS_TEXT: Record<SalaryStatus, string> = {
  not_saved: 'Not calculated',
  saved: 'Saved',
  changed: 'Changed since saved',
  needs_resolution: 'Needs manual resolution',
};

/** Status chip text: "Saved v2" names the version; the others are plain words. */
export function statusText(status: SalaryStatus, versionNo: number | null): string {
  if (status === 'saved' && versionNo !== null) return `Saved v${versionNo}`;
  return STATUS_TEXT[status];
}

/** Each discrepancy code from compute_salary as a sentence. */
export const ISSUE_TEXT: Record<string, string> = {
  attendance_on_non_working_day: 'Attendance is marked on a non-working day — it is not counted.',
  paid_leave_on_non_working_day_ignored: 'Paid leave on a non-working day is ignored.',
  not_employed_on_working_day:
    'A working day before joining or after leaving — it counts in working days but is not paid.',
  paid_leave_overlaps_attendance_capped:
    'Paid leave overlaps attendance on this day — only the rest of the day is counted as leave.',
};

export function issueText(issue: string): string {
  return ISSUE_TEXT[issue] ?? `Needs review (${issue.replace(/_/g, ' ')}).`;
}

interface FormulaInput {
  monthly_salary_paise: number | null;
  working_days: number;
  attended_days: number;
  paid_leave_days: number;
  payable_paise: number | null;
}

/**
 * "₹40,000.00 × (15 + 1) / 20 = ₹32,000.00" with the server's own numbers, or null when the
 * calculation can't be made (no salary, no working days, paid days above working days).
 */
export function formulaText(c: FormulaInput): string | null {
  if (c.monthly_salary_paise === null || c.payable_paise === null) return null;
  return `${formatINR(c.monthly_salary_paise)} × (${formatDays(c.attended_days)} + ${formatDays(
    c.paid_leave_days,
  )}) / ${formatDays(c.working_days)} = ${formatINR(c.payable_paise)}`;
}

/** Salary − payable (integer paise), or null when either is unknown. */
export function deductionPaise(c: FormulaInput): number | null {
  if (c.monthly_salary_paise === null || c.payable_paise === null) return null;
  return c.monthly_salary_paise - c.payable_paise;
}

/** Every override the plain calculation needs: no salary rate, and/or no working days on the calendar. */
export function requiredOverrides(
  live: { monthly_salary_paise: number | null; working_days: number } | null,
): OverrideKey[] {
  if (!live) return [];
  const out: OverrideKey[] = [];
  if (live.monthly_salary_paise === null) out.push('monthly_salary_paise');
  if (live.working_days <= 0) out.push('working_days');
  return out;
}

/** Which override a "needs manual resolution" reason asks for. */
export function requiredOverride(reason: string | null): OverrideKey | null {
  if (!reason) return null;
  if (reason.startsWith('No salary rate')) return 'monthly_salary_paise';
  if (reason.startsWith('No working days')) return 'working_days';
  return null;
}

// ------------------------------------------------------------------ overrides form

export interface OverrideForm {
  working_days: string;
  attended_days: string;
  paid_leave_days: string;
  /** Rupees as typed. */
  monthly_salary: string;
  reason: string;
}
export type OverrideFormField = keyof OverrideForm;

export const EMPTY_OVERRIDES: OverrideForm = {
  working_days: '',
  attended_days: '',
  paid_leave_days: '',
  monthly_salary: '',
  reason: '',
};

/** A saved version's overrides back into the form (to correct a saved calculation). */
export function formFromOverrides(o: SalaryOverrides, reason: string | null): OverrideForm {
  return {
    working_days: o.working_days !== undefined ? formatDays(o.working_days) : '',
    attended_days: o.attended_days !== undefined ? formatDays(o.attended_days) : '',
    paid_leave_days: o.paid_leave_days !== undefined ? formatDays(o.paid_leave_days) : '',
    monthly_salary: o.monthly_salary_paise !== undefined ? paiseToRupeesString(o.monthly_salary_paise) : '',
    reason: reason ?? '',
  };
}

export type BuiltOverrides =
  | { ok: true; overrides: SalaryOverrides; reason: string | null }
  | { ok: false; errors: Partial<Record<OverrideFormField, string>> };

/**
 * Validate the override form the way the server does (salary_overrides_check + save rules), so
 * most mistakes show under their field before anything is sent. `calculated` = the calculator's
 * values without overrides, used for "attended + paid leave ≤ working days".
 */
export function buildOverrides(
  form: OverrideForm,
  calculated: Pick<SalaryComputation, 'working_days' | 'attended_days' | 'paid_leave_days'> | null,
  requiredKeys: OverrideKey | null | readonly (OverrideKey | null)[] = null,
): BuiltOverrides {
  // several can apply at once: a new staff group with no calendar and no salary needs both
  const req = new Set(Array.isArray(requiredKeys) ? requiredKeys : [requiredKeys]);
  const required = {
    has: (k: OverrideKey) => req.has(k),
  };
  const errors: Partial<Record<OverrideFormField, string>> = {};
  const overrides: SalaryOverrides = {};
  for (const key of ['working_days', 'attended_days', 'paid_leave_days'] as const) {
    if (form[key].trim() === '') continue;
    const r = parseDays(form[key]);
    if (r.ok) overrides[key] = r.days;
    else errors[key] = r.error;
  }
  if (form.monthly_salary.trim() !== '') {
    const r = parseRupeesToPaise(form.monthly_salary, { allowZero: true });
    if (r.ok) overrides.monthly_salary_paise = r.paise;
    else errors.monthly_salary = r.error;
  }
  if (required.has('monthly_salary_paise') && overrides.monthly_salary_paise === undefined)
    errors.monthly_salary ??= 'No salary rate is recorded — enter the monthly salary for this month';
  if (required.has('working_days') && overrides.working_days === undefined)
    errors.working_days ??= 'There are no working days on the calendar — enter the working days';
  if (required.has('working_days') && overrides.working_days === 0)
    errors.working_days ??= 'Working days must be more than 0';

  const reason = form.reason.trim();
  if (Object.keys(overrides).length > 0 && reason === '') errors.reason = 'Overrides need a reason';
  if (reason.length > 500) errors.reason = 'Reason can be at most 500 characters';

  if (calculated && !errors.working_days && !errors.attended_days && !errors.paid_leave_days) {
    const w = overrides.working_days ?? calculated.working_days;
    const a = overrides.attended_days ?? calculated.attended_days;
    const p = overrides.paid_leave_days ?? calculated.paid_leave_days;
    if (quarters(a) + quarters(p) > quarters(w)) {
      const field: OverrideFormField =
        overrides.attended_days !== undefined
          ? 'attended_days'
          : overrides.paid_leave_days !== undefined
            ? 'paid_leave_days'
            : 'working_days';
      errors[field] =
        `Attended (${formatDays(a)}) + paid leave (${formatDays(p)}) can't be more than working days (${formatDays(w)})`;
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, overrides, reason: Object.keys(overrides).length > 0 ? reason : null };
}

/** The override form field a server error names (`details.field`). */
export function formFieldForServer(field: string): OverrideFormField | null {
  if (field === 'monthly_salary_paise') return 'monthly_salary';
  if (field === 'override_reason') return 'reason';
  if (field === 'working_days' || field === 'attended_days' || field === 'paid_leave_days') return field;
  return null;
}

export function sameOverrides(a: SalaryOverrides, b: SalaryOverrides): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<OverrideKey>;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

// ------------------------------------------------------------------ after a save

/**
 * The month view right after a save (or a replay) of `staffId`: that row is "Saved vN" with the
 * numbers just saved, and the totals follow. Applied to the cached month before the refetch, so the
 * screen never shows the old "Changed since saved" while the server is asked again (M4 review).
 * A replay keeps the saved version's own time and author; a new version shows `now` / `who` until
 * the refetch brings the server's.
 */
export function applySavedToMonth(
  data: SalaryMonth,
  staffId: string,
  r: SalarySaved,
  reason: string | null,
  who: string | null,
  now: string,
): SalaryMonth {
  if (data.month !== r.month) return data;
  let found = false;
  const rows = data.rows.map((row): SalaryMonthRow => {
    if (row.staff_id !== staffId || r.payable_paise === null || r.monthly_salary_paise === null) return row;
    found = true;
    const keep = r.replayed && row.saved?.version_no === r.version_no ? row.saved : null;
    return {
      ...row,
      status: 'saved',
      saved: {
        id: r.salary_calculation_id,
        version_no: r.version_no,
        monthly_salary_paise: r.monthly_salary_paise,
        working_days: r.working_days,
        attended_days: r.attended_days,
        paid_leave_days: r.paid_leave_days,
        unpaid_days: Math.max(r.unpaid_days, 0),
        payable_paise: r.payable_paise,
        overrides: r.overrides,
        override_reason: keep ? keep.override_reason : reason,
        created_at: keep?.created_at ?? now,
        calculated_by: keep?.calculated_by ?? who,
      },
    };
  });
  if (!found) return data;
  const count = (s: SalaryStatus) => rows.filter((x) => x.status === s).length;
  return {
    ...data,
    rows,
    totals: {
      ...data.totals,
      saved: count('saved') + count('changed'),
      changed: count('changed'),
      needs_resolution: count('needs_resolution'),
      not_saved: count('not_saved'),
      saved_payable_paise: rows.reduce((t, x) => t + (x.saved?.payable_paise ?? 0), 0),
    },
  };
}

// ------------------------------------------------------------------ export

/** Days shown in the month view: the saved snapshot when there is one, else the live numbers (managers). */
export function rowDays(row: SalaryMonthRow) {
  return row.saved ?? row.live;
}

/**
 * CSV of the month view: one line per staff member with the SAVED result only (a live preview is
 * never exported), amounts as rupees with 2 decimals, and a total of the saved payable.
 */
export function salaryMonthCsv(data: SalaryMonth): string {
  const money = (p: number | null | undefined) =>
    p === null || p === undefined ? null : paiseToCsvRupees(p);
  const days = (n: number | undefined) => (n === undefined ? null : formatDays(n));
  return toCsv(
    [
      'Month',
      'Employee no',
      'Name',
      'Group',
      'Status',
      'Version',
      'Partial month',
      'Monthly salary (₹)',
      'Working days',
      'Attended days',
      'Paid leave days',
      'Unpaid days',
      'Payable (₹)',
      'Override reason',
      'Saved by',
      'Saved at',
    ],
    [
      ...data.rows.map((r) => [
        monthParam(data.month),
        r.employee_no,
        r.name,
        r.group,
        STATUS_TEXT[r.status],
        r.saved?.version_no ?? null,
        r.partial_month ? 'Yes' : null,
        money(r.saved?.monthly_salary_paise),
        days(r.saved?.working_days),
        days(r.saved?.attended_days),
        days(r.saved?.paid_leave_days),
        days(r.saved?.unpaid_days),
        money(r.saved?.payable_paise),
        r.saved?.override_reason ?? null,
        r.saved?.calculated_by ?? null,
        r.saved?.created_at ?? null,
      ]),
      [
        'Total',
        null,
        `${data.totals.saved} of ${data.totals.staff} saved`,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        money(data.totals.saved_payable_paise),
        null,
        null,
        null,
      ],
    ],
    new Set([7, 12]),
  );
}
