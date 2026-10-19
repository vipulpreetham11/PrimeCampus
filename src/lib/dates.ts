// Business dates are 'YYYY-MM-DD' strings in the school's zone (CLAUDE.md rule 7).
// Never derive a business date with toISOString() — that is UTC and is wrong for 00:00–05:29 IST.

export type IsoDate = string;

export const SCHOOL_TIME_ZONE = 'Asia/Kolkata';

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const m = ISO_PATTERN.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parts(iso: IsoDate): [number, number, number] {
  if (!isIsoDate(iso)) throw new RangeError(`Not a valid YYYY-MM-DD date: ${String(iso)}`);
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** The calendar date at `instant` in the school's zone. */
export function schoolDateOf(instant: Date, timeZone: string = SCHOOL_TIME_ZONE): IsoDate {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** "Today" for the school (Asia/Kolkata), regardless of the device's own time zone. */
export function schoolToday(now: Date = new Date()): IsoDate {
  return schoolDateOf(now);
}

/** Calendar arithmetic on the date itself (UTC math on a date-only value, no zone shifts). */
export function addDays(iso: IsoDate, days: number): IsoDate {
  const [y, m, d] = parts(iso);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function compareIsoDates(a: IsoDate, b: IsoDate): number {
  parts(a);
  parts(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** First day of the month containing `iso` — the format the salary RPCs take for p_month. */
export function monthStart(iso: IsoDate): IsoDate {
  const [y, m] = parts(iso);
  return `${pad(y, 4)}-${pad(m)}-01`;
}

const DISPLAY = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const DISPLAY_LONG = new Intl.DateTimeFormat('en-IN', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const DATE_TIME = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: SCHOOL_TIME_ZONE,
});

function asUtcNoon(iso: IsoDate): Date {
  const [y, m, d] = parts(iso);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** '2026-10-05' -> '5 Oct 2026'. */
export function formatDate(iso: IsoDate): string {
  return DISPLAY.format(asUtcNoon(iso));
}

/** '2026-10-05' -> 'Monday, 5 October 2026'. */
export function formatDateLong(iso: IsoDate): string {
  return DISPLAY_LONG.format(asUtcNoon(iso));
}

/** A server timestamp (timestamptz ISO string) shown in school time: '5 Oct 2026, 9:05 am'. */
export function formatDateTime(instant: string | Date): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) throw new RangeError(`Not a valid timestamp: ${String(instant)}`);
  return DATE_TIME.format(d);
}

// ---------------------------------------------------------------------------
// Week / month ranges for the schedule, attendance and homework screens (M2). All of these work on
// the date string itself; none of them reads the device clock or zone.

/** ISO weekday of a date: 1 = Monday … 7 = Sunday (the numbering the timetable uses). */
export function isoWeekday(iso: IsoDate): number {
  const [y, m, d] = parts(iso);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** Monday of the week containing `iso`. */
export function weekStart(iso: IsoDate): IsoDate {
  return addDays(iso, 1 - isoWeekday(iso));
}

/** The seven dates Monday … Sunday of the week containing `iso`. */
export function weekDates(iso: IsoDate): IsoDate[] {
  const monday = weekStart(iso);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Last day of the month containing `iso`. */
export function monthEnd(iso: IsoDate): IsoDate {
  const [y, m] = parts(iso);
  return `${pad(y, 4)}-${pad(m)}-${pad(daysInMonth(y, m))}`;
}

/** Whole days from `from` to `to` (to − from); negative when `to` is earlier. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const [y1, m1, d1] = parts(from);
  const [y2, m2, d2] = parts(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** The later of two dates. */
export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return compareIsoDates(a, b) >= 0 ? a : b;
}

/** The earlier of two dates. */
export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return compareIsoDates(a, b) <= 0 ? a : b;
}

const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const WEEKDAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** 1 → 'Mon' … 7 → 'Sun'. */
export function weekdayShort(isoDay: number): string {
  return WEEKDAY_SHORT[isoDay - 1] ?? String(isoDay);
}

/** 1 → 'Monday' … 7 → 'Sunday'. */
export function weekdayLong(isoDay: number): string {
  return WEEKDAY_LONG[isoDay - 1] ?? String(isoDay);
}

const DAY_MONTH = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const MONTH_YEAR = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** '2026-10-21' -> '21 Oct'. */
export function formatDayMonth(iso: IsoDate): string {
  return DAY_MONTH.format(asUtcNoon(iso));
}

/** '2026-10-19' -> 'Mon 19 Oct'. */
export function formatDayShort(iso: IsoDate): string {
  return `${weekdayShort(isoWeekday(iso))} ${DAY_MONTH.format(asUtcNoon(iso))}`;
}

/** '2026-10-19' -> 'October 2026'. */
export function formatMonth(iso: IsoDate): string {
  return MONTH_YEAR.format(asUtcNoon(iso));
}

/** Postgres `time` ('09:05:00' or '09:05') -> '9:05 am'. Wall-clock school time; no zone conversion. */
export function formatTime(time: string): string {
  const m = /^(\d{2}):(\d{2})/.exec(time);
  if (!m) throw new RangeError(`Not a valid time: ${time}`);
  const h = Number(m[1]);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}
