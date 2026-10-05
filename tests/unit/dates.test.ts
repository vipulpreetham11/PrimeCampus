import { describe, expect, it } from 'vitest';
import {
  addDays,
  compareIsoDates,
  formatDate,
  formatDateLong,
  formatDateTime,
  isIsoDate,
  monthStart,
  schoolDateOf,
  schoolToday,
} from '@/lib/dates';

describe('schoolToday / schoolDateOf (Asia/Kolkata, UTC+05:30)', () => {
  it('IST midnight: 18:30Z is already the next school day', () => {
    expect(schoolToday(new Date('2026-10-05T18:30:00Z'))).toBe('2026-10-06');
  });

  it('one second before IST midnight is still the same day', () => {
    expect(schoolToday(new Date('2026-10-05T18:29:59Z'))).toBe('2026-10-05');
  });

  it('differs from toISOString() in the early IST morning', () => {
    const instant = new Date('2026-10-05T20:00:00Z'); // 01:30 IST on 6 Oct
    expect(instant.toISOString().slice(0, 10)).toBe('2026-10-05');
    expect(schoolToday(instant)).toBe('2026-10-06');
  });

  it('handles year end', () => {
    expect(schoolToday(new Date('2026-12-31T18:30:00Z'))).toBe('2027-01-01');
  });

  it('can compute other zones explicitly', () => {
    expect(schoolDateOf(new Date('2026-10-05T18:30:00Z'), 'UTC')).toBe('2026-10-05');
  });
});

describe('isIsoDate', () => {
  it.each(['2026-10-05', '2024-02-29', '2000-02-29', '1999-12-31'])('accepts %s', (d) => {
    expect(isIsoDate(d)).toBe(true);
  });
  it.each([
    '2026-02-29',
    '1900-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-1-5',
    '05-10-2026',
    '',
    'x',
    20261005,
    null,
  ])('rejects %j', (d) => {
    expect(isIsoDate(d)).toBe(false);
  });
});

describe('date arithmetic', () => {
  it('adds days across month/year/leap boundaries', () => {
    expect(addDays('2026-10-05', 1)).toBe('2026-10-06');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-10-05', 0)).toBe('2026-10-05');
  });

  it('compares and rejects invalid dates', () => {
    expect(compareIsoDates('2026-10-05', '2026-10-06')).toBe(-1);
    expect(compareIsoDates('2026-10-06', '2026-10-05')).toBe(1);
    expect(compareIsoDates('2026-10-05', '2026-10-05')).toBe(0);
    expect(() => compareIsoDates('2026-02-30', '2026-03-01')).toThrow(RangeError);
    expect(() => addDays('nope', 1)).toThrow(RangeError);
  });

  it('monthStart', () => {
    expect(monthStart('2026-10-05')).toBe('2026-10-01');
  });
});

describe('display formats', () => {
  it('formats business dates without shifting the day', () => {
    expect(formatDate('2026-10-05')).toBe('5 Oct 2026');
    expect(formatDate('2027-01-01')).toBe('1 Jan 2027');
    expect(formatDateLong('2026-10-05')).toBe('Monday, 5 October 2026');
  });

  it('formats instants in school time', () => {
    expect(formatDateTime('2026-10-05T18:30:00Z')).toMatch(/^6 Oct 2026, 12:00\s?am$/i);
    expect(formatDateTime('2026-10-05T03:35:00Z')).toMatch(/^5 Oct 2026, 9:05\s?am$/i);
    expect(() => formatDateTime('not a date')).toThrow(RangeError);
  });
});
