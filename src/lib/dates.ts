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
