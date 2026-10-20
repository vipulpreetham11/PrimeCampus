import { describe, expect, it } from 'vitest';
import { buildNav } from '@/app/navigation';
import { attendanceRegisterSchema } from '@/contracts/reports';
import { salaryMonthSchema } from '@/contracts/salary';
import { contextSchema } from '@/contracts/session';
import { feeHeadReportSchema } from '@/contracts/reports';
import { dashboardLinks, setupIssueLink } from '@/features/dashboard/links';
import {
  cellLong,
  cellShort,
  cellView,
  isIncomplete,
  registerCsv,
  totalsText,
} from '@/features/attendance/register/logic';
import { auditArgs, istRange } from '@/features/operator/consoleHooks';
import {
  chargedDifference,
  coverageTotals,
  feeHeadCsv,
  hasGap,
  headNet,
  headSums,
  sortCoverage,
} from '@/features/reports/logic';
import {
  buildOverrides,
  deductionPaise,
  defaultSalaryMonth,
  EMPTY_OVERRIDES,
  formatDays,
  formFieldForServer,
  formFromOverrides,
  formulaText,
  issueText,
  parseDays,
  requiredOverride,
  salaryMonthCsv,
  statusText,
} from '@/features/salary/logic';
import { saveSalaryArgs } from '@/features/salary/hooks';
import { extraLessonArgs, lessonActionArgs } from '@/features/schedule/hooks';
import { timeRangeProblem } from '@/features/schedule/LessonActions';
import { extraLessonDuplicateId } from '@/features/schedule/ExtraLessonDialog';
import { AppError } from '@/lib/errors';
import { parseMonthParam } from '@/lib/dates';
import { contextRow } from './fake-supabase';
import {
  CAPS,
  computation,
  coverageRow,
  feeHeadReport,
  M4,
  monthRow,
  registerRow,
  salaryMonth,
  savedSnapshot,
} from './m4-fixtures';

// ------------------------------------------------------------------ salary
describe('salary days (string rules, 0.5 steps)', () => {
  it('formats server numbers without float noise', () => {
    expect(formatDays(15)).toBe('15');
    expect(formatDays(15.5)).toBe('15.5');
    expect(formatDays(0.25)).toBe('0.25');
    expect(formatDays(0)).toBe('0');
  });
  it('parses typed days in 0.5 steps, 0–31', () => {
    expect(parseDays('15')).toEqual({ ok: true, days: 15 });
    expect(parseDays(' 15.5 ')).toEqual({ ok: true, days: 15.5 });
    expect(parseDays('15.50')).toEqual({ ok: true, days: 15.5 });
    expect(parseDays('0')).toEqual({ ok: true, days: 0 });
    expect(parseDays('31')).toEqual({ ok: true, days: 31 });
    for (const bad of ['15.25', '15.3', '31.5', '32', '-1', 'abc', '', '1e1'])
      expect(parseDays(bad).ok, bad).toBe(false);
  });
});

describe('salary formula display (AC-26)', () => {
  it('shows the server numbers: ₹40,000 × (15 + 1) / 20 = ₹32,000', () => {
    const c = computation();
    expect(formulaText(c)).toBe('₹40,000.00 × (15 + 1) / 20 = ₹32,000.00');
    expect(deductionPaise(c)).toBe(800_000);
  });
  it('half days show as decimals', () => {
    expect(
      formulaText(computation({ attended_days: 14.5, paid_leave_days: 0.5, payable_paise: 3_000_000 })),
    ).toBe('₹40,000.00 × (14.5 + 0.5) / 20 = ₹30,000.00');
  });
  it('no formula (and no deduction) when it can’t be calculated — never ₹0', () => {
    expect(formulaText(computation({ monthly_salary_paise: null, payable_paise: null }))).toBeNull();
    expect(deductionPaise(computation({ payable_paise: null }))).toBeNull();
  });
  it('maps every discrepancy code to a sentence', () => {
    expect(issueText('not_employed_on_working_day')).toMatch(/before joining or after leaving/);
    expect(issueText('paid_leave_overlaps_attendance_capped')).toMatch(/overlaps attendance/);
    expect(issueText('attendance_on_non_working_day')).toMatch(/non-working day/);
    expect(issueText('paid_leave_on_non_working_day_ignored')).toMatch(/ignored/);
    expect(issueText('something_new')).toMatch(/something new/);
  });
  it('status chips are words', () => {
    expect(statusText('not_saved', null)).toBe('Not calculated');
    expect(statusText('saved', 2)).toBe('Saved v2');
    expect(statusText('changed', 2)).toBe('Changed since saved');
    expect(statusText('needs_resolution', null)).toBe('Needs manual resolution');
  });
  it('the default month is the previous one; month params are validated', () => {
    expect(defaultSalaryMonth('2026-10-20')).toBe('2026-09-01');
    expect(defaultSalaryMonth('2027-01-05')).toBe('2026-12-01');
    expect(parseMonthParam('2026-09')).toBe('2026-09-01');
    expect(parseMonthParam('2026-13')).toBeNull();
    expect(parseMonthParam('Sep')).toBeNull();
  });
});

describe('salary override validation', () => {
  const calc = { working_days: 20, attended_days: 15, paid_leave_days: 1 };
  it('no overrides → nothing to send, no reason needed', () => {
    expect(buildOverrides(EMPTY_OVERRIDES, calc)).toEqual({ ok: true, overrides: {}, reason: null });
  });
  it('days in 0.5 steps and rupees → paise by string math; a reason is required', () => {
    const r = buildOverrides(
      { ...EMPTY_OVERRIDES, attended_days: '16.5', monthly_salary: '40,000.50', reason: ' Corrected ' },
      calc,
    );
    expect(r).toEqual({
      ok: true,
      overrides: { attended_days: 16.5, monthly_salary_paise: 4_000_050 },
      reason: 'Corrected',
    });
    const noReason = buildOverrides({ ...EMPTY_OVERRIDES, working_days: '21' }, calc);
    expect(noReason).toEqual({ ok: false, errors: { reason: 'Overrides need a reason' } });
  });
  it('field errors: bad days, bad money, paid days above working days', () => {
    const r = buildOverrides(
      { ...EMPTY_OVERRIDES, attended_days: '15.3', monthly_salary: '12.555', reason: 'x' },
      calc,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.attended_days).toBe('Days must be 0–31 in steps of 0.5');
      expect(r.errors.monthly_salary).toMatch(/2 decimal places/);
    }
    const over = buildOverrides({ ...EMPTY_OVERRIDES, attended_days: '20', reason: 'x' }, calc);
    expect(over).toEqual({
      ok: false,
      errors: { attended_days: "Attended (20) + paid leave (1) can't be more than working days (20)" },
    });
  });
  it('manual resolution requires the matching override', () => {
    expect(requiredOverride('No salary rate recorded')).toBe('monthly_salary_paise');
    expect(requiredOverride('No working days in this month for this staff calendar')).toBe('working_days');
    const r = buildOverrides(EMPTY_OVERRIDES, null, 'monthly_salary_paise');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.monthly_salary).toMatch(/No salary rate/);
  });
  it('server field names map to the form; saved overrides refill the form', () => {
    expect(formFieldForServer('monthly_salary_paise')).toBe('monthly_salary');
    expect(formFieldForServer('override_reason')).toBe('reason');
    expect(formFieldForServer('working_days')).toBe('working_days');
    expect(formFieldForServer('staff_id')).toBeNull();
    expect(formFromOverrides({ working_days: 21, monthly_salary_paise: 4_000_050 }, 'Late join')).toEqual({
      working_days: '21',
      attended_days: '',
      paid_leave_days: '',
      monthly_salary: '40000.50',
      reason: 'Late join',
    });
  });
  it('save arguments: overrides and reason only when there are overrides', () => {
    expect(saveSalaryArgs({ staffId: M4.staff, month: '2026-09-01', overrides: {}, reason: null })).toEqual({
      p_staff_id: M4.staff,
      p_month: '2026-09-01',
    });
    expect(
      saveSalaryArgs({
        staffId: M4.staff,
        month: '2026-09-01',
        overrides: { working_days: 21 },
        reason: 'r',
      }),
    ).toEqual({
      p_staff_id: M4.staff,
      p_month: '2026-09-01',
      p_overrides: { working_days: 21 },
      p_override_reason: 'r',
    });
  });
});

describe('salary CSV (saved results only)', () => {
  it('exports the saved snapshot, never live numbers, with a total', () => {
    const data = salaryMonthSchema.parse(
      salaryMonth(
        [
          monthRow({ status: 'saved', saved: savedSnapshot() }),
          monthRow({ staff_id: M4.staff2, name: 'Lata Iyer', employee_no: 'EMP-8' }),
        ],
        true,
        { saved: 1, not_saved: 1, saved_payable_paise: 3_200_000 },
      ),
    );
    const lines = salaryMonthCsv(data).trim().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(
      '2026-09,EMP-7,Ramesh Peon,Office staff,Saved,1,,40000.00,20,15,1,4,32000.00,,Demo Admin,2026-10-01T05:00:00+00:00',
    );
    // not saved: status only — the live ₹32,000 is not exported
    expect(lines[2]).toBe('2026-09,EMP-8,Lata Iyer,Office staff,Not calculated,,,,,,,,,,,');
    expect(lines[3]).toBe('Total,,1 of 2 saved,,,,,,,,,,32000.00,,,');
  });
});

// ------------------------------------------------------------------ register
describe('register cells', () => {
  const reg = attendanceRegisterSchema.parse(registerRow());
  const [sunday, periodDay, dailyDay] = reg.dates as [
    (typeof reg.dates)[0],
    (typeof reg.dates)[0],
    (typeof reg.dates)[0],
  ];
  const [aarav, anaya] = reg.students as [(typeof reg.students)[0], (typeof reg.students)[0]];

  it('unmarked is blank and says "Not marked" — never absent', () => {
    const v = cellView(aarav, dailyDay);
    expect(v).toEqual({ kind: 'daily', status: null });
    expect(cellShort(v)).toBe('');
    expect(cellLong(v)).toBe('Not marked');
    expect(cellLong(cellView(anaya, dailyDay))).toBe('Absent');
  });
  it('period cells are attended/held; fewer marks than lessons is incomplete', () => {
    const v = cellView(aarav, periodDay);
    expect(cellShort(v)).toBe('2/3');
    expect(isIncomplete(v)).toBe(true);
    expect(cellLong(v)).toBe('2 of 3 lessons attended, 1 not marked');
  });
  it('not in the section ≠ unmarked; non-working days carry their label', () => {
    expect(cellLong(cellView(anaya, periodDay))).toBe('Not in this section');
    expect(cellShort(cellView(anaya, periodDay))).toBe('—');
    expect(cellLong(cellView(aarav, sunday))).toBe('Weekly off — Sunday');
  });
  it('totals say provisional and count unmarked separately', () => {
    expect(totalsText(aarav)).toBe('Attended 2 of 2 marked · 2 unmarked · 100%');
    expect(totalsText(anaya)).toBe('Attended 0 of 1 marked · 0%');
  });
  it('CSV writes words, never a blank for "not marked"', () => {
    const lines = registerCsv(reg).trim().split('\r\n');
    expect(lines[0]).toBe(
      'Roll no,Name,Admission no,2026-10-18,2026-10-19,2026-10-20,Attended,Marked,Expected,Unmarked,Percentage,Totals',
    );
    expect(lines[1]).toBe(
      '1,Aarav Sharma,DEMO-S1,Weekly off — Sunday,"2 of 3 lessons attended, 1 not marked",Not marked,2,2,4,2,100,Provisional',
    );
    expect(lines[2]).toBe('2,Anaya Rao,DEMO-S2,Weekly off — Sunday,Not in this section,A,0,1,1,0,0,Final');
  });
});

// ------------------------------------------------------------------ coverage + fee heads
describe('academic coverage', () => {
  const rows = [
    coverageRow(),
    coverageRow({
      subject: 'Maths',
      subject_id: M4.head1,
      staff_id: null,
      teacher: 'Unassigned',
      diary_written: 2,
    }),
    coverageRow({
      section: 'Class 2 A',
      diary_written: 10,
      homework_due_unchecked: 0,
      homework_due_fully_checked: 2,
    }),
  ];
  it('sorts and finds rows that need attention (incl. Unassigned)', () => {
    expect(sortCoverage(rows, 'diary_gap').map((r) => r.subject)).toEqual(['Maths', 'English', 'English']);
    expect(rows.filter(hasGap).map((r) => r.teacher)).toEqual(['Ravi Kumar', 'Unassigned']);
  });
  it('totals are the sum of the rows shown', () => {
    const t = coverageTotals(rows);
    expect(t.lessons).toBe(30);
    expect(t.diary_written).toBe(19);
    expect(t.homework_due_unchecked).toBe(2);
  });
});

describe('fee-head totals', () => {
  const r = feeHeadReportSchema.parse(feeHeadReport());
  it('net per head = gross − concession + signed adjustments; sums reconcile with charged', () => {
    expect(headNet(r.heads[0]!)).toBe(935_000);
    expect(headSums(r.heads)).toEqual({
      gross: 1_000_000,
      concession: 50_000,
      adjustments: -5_000,
      net: 945_000,
    });
    expect(chargedDifference(r)).toBe(0);
    expect(chargedDifference({ ...r, totals: { ...r.totals, charged_paise: 1_000_000 } })).toBe(35_000);
  });
  it('CSV as rupees with 2 decimals', () => {
    const lines = feeHeadCsv(r, 'Whole year').trim().split('\r\n');
    expect(lines[1]).toBe('Whole year,TU,Tuition,Regular,2,10000.00,500.00,-150.00,9350.00');
    expect(lines[3]).toBe('Whole year,,Adjustments without a head,,,,,200.00,200.00');
    expect(lines[5]).toBe('Whole year,,Charged (all invoices),,,,,,9650.00');
  });
});

// ------------------------------------------------------------------ lessons (TIME-02)
describe('lesson change time / extra lesson arguments', () => {
  it('change_time sends the version and HH:MM times; reason only when given', () => {
    expect(
      lessonActionArgs({
        lessonId: 9,
        version: 4,
        action: 'change_time',
        startTime: '10:00',
        endTime: '10:40',
        reason: null,
      }),
    ).toEqual({
      p_lesson_session_id: 9,
      p_action: 'change_time',
      p_expected_version: 4,
      p_start_time: '10:00',
      p_end_time: '10:40',
    });
    expect(timeRangeProblem('10:40', '10:00')).toMatch(/later than the start/);
    expect(timeRangeProblem('10:00', '10:40')).toBeNull();
  });
  it('extra lesson leaves optional fields out; DUPLICATE names the existing lesson', () => {
    expect(
      extraLessonArgs({
        sectionId: M4.section,
        date: '2026-10-23',
        startTime: '15:00',
        endTime: '15:40',
        subjectId: M4.subject,
        staffId: null,
        label: null,
        reason: 'Revision',
      }),
    ).toEqual({
      p_section_id: M4.section,
      p_date: '2026-10-23',
      p_start_time: '15:00',
      p_end_time: '15:40',
      p_subject_id: M4.subject,
      p_reason: 'Revision',
    });
    expect(extraLessonDuplicateId(new AppError('DUPLICATE', 'x', 'r', { lesson_session_id: 77 }))).toBe(77);
    expect(
      extraLessonDuplicateId(new AppError('VALIDATION_ERROR', 'x', 'r', { lesson_session_id: 77 })),
    ).toBeNull();
  });
});

// ------------------------------------------------------------------ dashboard links
describe('dashboard numbers link to pages with the same rules', () => {
  it('builds the detail links', () => {
    expect(dashboardLinks.diaryMissing('2026-10-20')).toBe('/diary?from=2026-10-13&to=2026-10-19&missing=1');
    expect(dashboardLinks.homeworkUnchecked('2026-10-06', '2026-10-20')).toBe(
      '/homework?due_unchecked=1&from=2026-10-06&to=2026-10-20',
    );
    expect(dashboardLinks.uncoveredLessons('2026-10-20')).toBe('/schedule?date=2026-10-20&uncovered=1');
    expect(dashboardLinks.dayBook('2026-10-20')).toBe('/fees/day-book?from=2026-10-20&to=2026-10-20');
    expect(dashboardLinks.salary('2026-09-01')).toBe('/salary?month=2026-09');
  });
  it('every setup issue links to the page that fixes it', () => {
    expect(setupIssueLink({ code: 'no_timetable', message: 'm', section_id: M4.section }).to).toBe(
      `/timetable?section=${M4.section}`,
    );
    expect(setupIssueLink({ code: 'no_class_teacher', message: 'm' }).to).toBe('/staff/teaching');
    expect(setupIssueLink({ code: 'no_attendance_mode', message: 'm' }).to).toBe('/setup/attendance-mode');
    expect(setupIssueLink({ code: 'no_current_year', message: 'm' }).to).toBe('/setup/years');
    expect(setupIssueLink({ code: 'no_sections', message: 'm' }).to).toBe('/setup/classes');
  });
});

// ------------------------------------------------------------------ operator
describe('operator filters', () => {
  it('whole IST days as [from, to) instants', () => {
    expect(istRange('2026-10-01', '2026-10-20')).toEqual({
      p_from: '2026-10-01T00:00:00+05:30',
      p_to: '2026-10-21T00:00:00+05:30',
    });
    expect(
      auditArgs(
        {
          schoolId: M4.school,
          actorId: null,
          actionPrefix: 'salary.',
          entityId: null,
          from: null,
          to: '2026-10-31',
        },
        120,
      ),
    ).toEqual({
      p_school_id: M4.school,
      p_action_prefix: 'salary.',
      p_to: '2026-11-01T00:00:00+05:30',
      p_before_id: 120,
    });
  });
});

// ------------------------------------------------------------------ navigation
describe('M4 navigation (capabilities, never role names)', () => {
  const nav = (caps: string[], role = 'admin', isOperator = false) =>
    buildNav(contextSchema.parse(contextRow(1, role, caps)), isOperator);
  it('Salary only for staff_finance.read; Academic coverage for academic.read_all; nothing "coming"', () => {
    const labels = (caps: string[], op = false) => nav(caps, 'admin', op).map((i) => i.label);
    expect(labels(CAPS.admin)).toEqual(expect.arrayContaining(['Salary', 'Academic coverage']));
    expect(labels(CAPS.owner)).toContain('Salary');
    expect(labels(CAPS.owner)).not.toContain('Academic coverage');
    expect(labels(CAPS.teacher)).not.toContain('Salary');
    expect(labels(CAPS.accountant)).not.toContain('Salary');
    expect(nav(CAPS.admin).some((i) => i.kind === 'upcoming')).toBe(false);
  });
  it('the Operator console is shown only to an Operator account', () => {
    expect(nav(CAPS.admin, 'admin', true).map((i) => i.label)).toContain('Operator console');
    expect(nav(CAPS.admin, 'admin', false).map((i) => i.label)).not.toContain('Operator console');
  });
});
