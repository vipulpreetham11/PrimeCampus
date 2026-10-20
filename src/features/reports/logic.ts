import type { CoverageRow, FeeHeadReport, FeeHeadTotal } from '@/contracts/reports';
import { toCsv } from '@/lib/csv';
import { paiseToCsvRupees } from '@/lib/money';

// Academic coverage and fee-head totals (M4 reports): sorting, gap detection, sums and CSV.
// Every number comes from the server; the only client arithmetic is adding integer paise and
// counts of the rows shown.

// ------------------------------------------------------------------ academic coverage

export const COVERAGE_SORTS = {
  section: 'Section and subject',
  teacher: 'Teacher',
  diary_gap: 'Most diary missing',
  unchecked: 'Most homework unchecked',
} as const;
export type CoverageSort = keyof typeof COVERAGE_SORTS;

export function diaryMissing(r: CoverageRow): number {
  return r.lessons - r.diary_written;
}

/** A row that needs attention: diary missing, homework due with no checks, period attendance unmarked, or no teacher. */
export function hasGap(r: CoverageRow): boolean {
  return (
    diaryMissing(r) > 0 ||
    r.homework_due_unchecked > 0 ||
    r.period_attendance_marked < r.period_lessons ||
    r.staff_id === null
  );
}

export function sortCoverage(rows: CoverageRow[], by: CoverageSort): CoverageRow[] {
  const base = (a: CoverageRow, b: CoverageRow) =>
    a.section.localeCompare(b.section) ||
    a.subject.localeCompare(b.subject) ||
    a.teacher.localeCompare(b.teacher);
  const copy = [...rows];
  switch (by) {
    case 'teacher':
      return copy.sort((a, b) => a.teacher.localeCompare(b.teacher) || base(a, b));
    case 'diary_gap':
      return copy.sort((a, b) => diaryMissing(b) - diaryMissing(a) || base(a, b));
    case 'unchecked':
      return copy.sort((a, b) => b.homework_due_unchecked - a.homework_due_unchecked || base(a, b));
    default:
      return copy.sort(base);
  }
}

export interface CoverageTotals {
  lessons: number;
  diary_written: number;
  homework_set: number;
  homework_due: number;
  homework_due_fully_checked: number;
  homework_due_unchecked: number;
  period_lessons: number;
  period_attendance_marked: number;
}

/** Totals of the rows shown (sum of the rows, never a separate figure). */
export function coverageTotals(rows: CoverageRow[]): CoverageTotals {
  const t: CoverageTotals = {
    lessons: 0,
    diary_written: 0,
    homework_set: 0,
    homework_due: 0,
    homework_due_fully_checked: 0,
    homework_due_unchecked: 0,
    period_lessons: 0,
    period_attendance_marked: 0,
  };
  for (const r of rows) for (const k of Object.keys(t) as (keyof CoverageTotals)[]) t[k] += r[k];
  return t;
}

export function coverageCsv(rows: CoverageRow[], from: string, to: string): string {
  return toCsv(
    [
      'From',
      'To',
      'Section',
      'Subject',
      'Teacher',
      'Lessons',
      'Diary written',
      'Diary missing',
      'Homework set',
      'Homework due',
      'Due and fully checked',
      'Due with no checks',
      'Period-wise lessons',
      'Period attendance marked',
    ],
    rows.map((r) => [
      from,
      to,
      r.section,
      r.subject,
      r.teacher,
      r.lessons,
      r.diary_written,
      diaryMissing(r),
      r.homework_set,
      r.homework_due,
      r.homework_due_fully_checked,
      r.homework_due_unchecked,
      r.period_lessons,
      r.period_attendance_marked,
    ]),
  );
}

// ------------------------------------------------------------------ fee-head totals

/** Net charged on a head: gross − concession + adjustments (adjustments are signed). */
export function headNet(h: FeeHeadTotal): number {
  return h.gross_paise - h.concession_paise + h.adjustments_paise;
}

export interface HeadSums {
  gross: number;
  concession: number;
  adjustments: number;
  net: number;
}

export function headSums(heads: FeeHeadTotal[]): HeadSums {
  return heads.reduce<HeadSums>(
    (t, h) => ({
      gross: t.gross + h.gross_paise,
      concession: t.concession + h.concession_paise,
      adjustments: t.adjustments + h.adjustments_paise,
      net: t.net + headNet(h),
    }),
    { gross: 0, concession: 0, adjustments: 0, net: 0 },
  );
}

/**
 * Heads' net + adjustments without a head should equal the server's "charged" total. Returns the
 * difference (0 when they agree) so the page can say so instead of hiding it.
 */
export function chargedDifference(r: FeeHeadReport): number {
  return r.totals.charged_paise - (headSums(r.heads).net + r.adjustments_without_head_paise);
}

const KIND_TEXT: Record<string, string> = { regular: 'Regular', optional: 'Optional', late_fee: 'Late fee' };
export function headKindText(kind: string): string {
  return KIND_TEXT[kind] ?? kind.replace(/_/g, ' ');
}

export function feeHeadCsv(r: FeeHeadReport, periodLabel: string): string {
  const s = headSums(r.heads);
  const m = paiseToCsvRupees;
  return toCsv(
    [
      'Period',
      'Code',
      'Head',
      'Kind',
      'Invoices',
      'Gross (₹)',
      'Concession (₹)',
      'Adjustments (₹)',
      'Net (₹)',
    ],
    [
      ...r.heads.map((h) => [
        periodLabel,
        h.code,
        h.name,
        headKindText(h.kind),
        h.invoices,
        m(h.gross_paise),
        m(h.concession_paise),
        m(h.adjustments_paise),
        m(headNet(h)),
      ]),
      [
        periodLabel,
        null,
        'Adjustments without a head',
        null,
        null,
        null,
        null,
        m(r.adjustments_without_head_paise),
        m(r.adjustments_without_head_paise),
      ],
      [
        periodLabel,
        null,
        'Total of heads',
        null,
        null,
        m(s.gross),
        m(s.concession),
        m(s.adjustments),
        m(s.net),
      ],
      [periodLabel, null, 'Charged (all invoices)', null, null, null, null, null, m(r.totals.charged_paise)],
      [periodLabel, null, 'Paid', null, null, null, null, null, m(r.totals.paid_paise)],
      [periodLabel, null, 'Balance', null, null, null, null, null, m(r.totals.balance_paise)],
    ],
    new Set([5, 6, 7, 8]),
  );
}
