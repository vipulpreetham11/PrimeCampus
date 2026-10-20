import type {
  AttendanceRegister,
  DailyStatus,
  RegisterCell,
  RegisterDate,
  RegisterStudent,
} from '@/contracts/reports';
import { toCsv } from '@/lib/csv';

// Attendance register (ATT-03) display rules, free of React for unit tests:
//  - a day-wise cell is P / L / H / A, or BLANK = not marked — never shown or counted as absent;
//  - a period-wise cell is "attended / held"; fewer marks than lessons held = incomplete;
//  - a date the student was not in the section has no cell ("—"), different from unmarked;
//  - non-working days are greyed with their label; totals are "Provisional" until every
//    expected day / lesson has a mark.

export const DAILY_TEXT: Record<DailyStatus, string> = {
  P: 'Present',
  L: 'Late',
  H: 'Half day',
  A: 'Absent',
};

export type CellView =
  | { kind: 'not_enrolled' }
  | { kind: 'non_working'; label: string }
  | { kind: 'daily'; status: DailyStatus | null }
  | { kind: 'period'; held: number; marked: number; attended: number };

export function isWorking(d: RegisterDate): boolean {
  return d.weight > 0;
}

/** What one student's cell on one date shows. */
export function cellView(student: RegisterStudent, d: RegisterDate): CellView {
  if (!isWorking(d)) return { kind: 'non_working', label: dayLabel(d) };
  const cell: RegisterCell | undefined = student.cells[d.date];
  if (!cell) return { kind: 'not_enrolled' };
  if ('s' in cell) return { kind: 'daily', status: cell.s };
  return { kind: 'period', held: cell.held, marked: cell.marked, attended: cell.attended };
}

/** Short visible text of a cell; '' for an unmarked day-wise cell (blank = not marked). */
export function cellShort(v: CellView): string {
  switch (v.kind) {
    case 'not_enrolled':
      return '—';
    case 'non_working':
      return '';
    case 'daily':
      return v.status ?? '';
    case 'period':
      return v.held === 0 ? '0' : `${v.attended}/${v.held}`;
  }
}

/** Full words for screen readers, tooltips, the phone list and CSV. */
export function cellLong(v: CellView): string {
  switch (v.kind) {
    case 'not_enrolled':
      return 'Not in this section';
    case 'non_working':
      return v.label;
    case 'daily':
      return v.status ? DAILY_TEXT[v.status] : 'Not marked';
    case 'period':
      if (v.held === 0) return 'No lessons held';
      return `${v.attended} of ${v.held} lessons attended${
        v.marked < v.held ? `, ${v.held - v.marked} not marked` : ''
      }`;
  }
}

/** Period cell with fewer marks than lessons held (some lessons unmarked). */
export function isIncomplete(v: CellView): boolean {
  return v.kind === 'period' && v.marked < v.held;
}

export function dayLabel(d: RegisterDate): string {
  const base =
    d.day_type === 'holiday'
      ? 'Holiday'
      : d.day_type === 'weekly_off'
        ? 'Weekly off'
        : d.day_type === 'none'
          ? 'Outside the academic year'
          : 'Not a working day';
  return d.label ? `${base} — ${d.label}` : base;
}

function units(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** "Attended 18 of 20 marked · 2 unmarked · 90%". Units are days (day-wise) or lessons (period-wise). */
export function totalsText(s: RegisterStudent): string {
  const parts = [`Attended ${units(s.attended_units)} of ${units(s.marked_units)} marked`];
  if (s.unmarked_units > 0) parts.push(`${units(s.unmarked_units)} unmarked`);
  parts.push(s.percentage === null ? 'no marks yet' : `${s.percentage}%`);
  return parts.join(' · ');
}

export function finalText(s: RegisterStudent): string {
  return s.is_final ? 'Final' : 'Provisional';
}

/** CSV: one row per student, one column per date, then the totals. Words, never blanks, in cells. */
export function registerCsv(reg: AttendanceRegister): string {
  const headers = [
    'Roll no',
    'Name',
    'Admission no',
    ...reg.dates.map((d) => d.date),
    'Attended',
    'Marked',
    'Expected',
    'Unmarked',
    'Percentage',
    'Totals',
  ];
  const rows = reg.students.map((s) => [
    s.roll_no,
    s.name,
    s.admission_no,
    ...reg.dates.map((d) => {
      const v = cellView(s, d);
      if (v.kind === 'daily') return v.status ?? 'Not marked';
      if (v.kind === 'period') return v.held === 0 ? 'No lessons' : cellLong(v);
      return cellLong(v);
    }),
    s.attended_units,
    s.marked_units,
    s.expected_units,
    s.unmarked_units,
    s.percentage,
    finalText(s),
  ]);
  return toCsv(headers, rows);
}
