import type { DayType, ResolvedDay } from '@/contracts/setup';

// Calendar month model (pure; unit-tested). Business dates are 'YYYY-MM-DD' strings; weekday
// math uses UTC on date-only values so the device time zone never shifts a day.

export const DAY_TYPE_META: Record<DayType, { label: string; short: string; className: string }> = {
  working: {
    label: 'Working day',
    short: 'W',
    className: 'bg-emerald-50 text-emerald-900 border-emerald-200',
  },
  half_day: { label: 'Half day', short: 'H', className: 'bg-amber-50 text-amber-900 border-amber-200' },
  holiday: { label: 'Holiday', short: 'Hol', className: 'bg-rose-50 text-rose-900 border-rose-200' },
  weekly_off: {
    label: 'Weekly off',
    short: 'Off',
    className: 'bg-slate-100 text-slate-600 border-slate-200',
  },
};

export const WEEKDAYS = [
  { iso: 1, short: 'Mon', long: 'Monday' },
  { iso: 2, short: 'Tue', long: 'Tuesday' },
  { iso: 3, short: 'Wed', long: 'Wednesday' },
  { iso: 4, short: 'Thu', long: 'Thursday' },
  { iso: 5, short: 'Fri', long: 'Friday' },
  { iso: 6, short: 'Sat', long: 'Saturday' },
  { iso: 7, short: 'Sun', long: 'Sunday' },
] as const;

/** ISO weekday (Mon=1 … Sun=7) of a 'YYYY-MM-DD' date. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

/** 'YYYY-MM' months covering [start, end]. */
export function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let [y, m] = start.split('-').map(Number) as [number, number];
  const [ey, em] = end.split('-').map(Number) as [number, number];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export interface MonthCell {
  date: string;
  day: number;
  /** null = outside the academic year / not returned by the server (not "working"). */
  resolved: ResolvedDay | null;
  isOverride: boolean;
}

/** Monday-first weeks for a month; days outside the month are null. */
export function buildMonthGrid(
  month: string,
  resolved: ResolvedDay[],
  overrideDates: ReadonlySet<string> = new Set(),
): (MonthCell | null)[][] {
  const byDate = new Map(resolved.map((r) => [r.date, r]));
  const { to } = monthBounds(month);
  const days = Number(to.slice(8));
  const lead = isoWeekday(`${month}-01`) - 1;
  const cells: (MonthCell | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    cells.push({ date, day: d, resolved: byDate.get(date) ?? null, isOverride: overrideDates.has(date) });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (MonthCell | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 15)),
  );
}
