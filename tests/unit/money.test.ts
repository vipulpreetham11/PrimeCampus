import { describe, expect, it } from 'vitest';
import { formatINR, paiseToRupeesString, parseRupeesToPaise } from '@/lib/money';

const ok = (paise: number) => ({ ok: true, paise });

describe('parseRupeesToPaise', () => {
  it.each([
    ['0.05', 5],
    ['₹0.05', 5],
    ['0.5', 50],
    ['1', 100],
    ['1500', 150000],
    ['1,500', 150000],
    ['1,00,000.50', 10000050],
    ['100000.50', 10000050],
    ['₹ 1,00,000', 10000000],
    ['Rs. 250', 25000],
    ['  42.10  ', 4210],
    ['0', 0],
    ['0.00', 0],
    ['007', 700],
    ['12,34,56,789.99', 123456789_99],
  ])('parses %s exactly', (input, paise) => {
    expect(parseRupeesToPaise(input)).toEqual(ok(paise));
  });

  it('avoids float error (0.1 + 0.2 style inputs stay exact)', () => {
    expect(parseRupeesToPaise('0.29')).toEqual(ok(29));
    expect(parseRupeesToPaise('1.13')).toEqual(ok(113));
    expect(parseRupeesToPaise('4.35')).toEqual(ok(435));
  });

  it('rejects negatives unless allowed', () => {
    expect(parseRupeesToPaise('-500').ok).toBe(false);
    expect(parseRupeesToPaise('-500', { allowNegative: true })).toEqual(ok(-50000));
    expect(parseRupeesToPaise('-₹0.05', { allowNegative: true })).toEqual(ok(-5));
  });

  it('rejects zero when not allowed', () => {
    expect(parseRupeesToPaise('0', { allowZero: false }).ok).toBe(false);
    expect(parseRupeesToPaise('-0', { allowNegative: true })).toEqual(ok(0));
  });

  it.each([
    '',
    '   ',
    '.',
    '.5',
    '1.234',
    'abc',
    '1e5',
    '1.2.3',
    '1,0',
    ',100',
    '100,',
    '₹',
    '--5',
    '5-',
    'NaN',
    'Infinity',
    '1 000',
  ])('rejects invalid input %j', (input) => {
    expect(parseRupeesToPaise(input).ok).toBe(false);
  });

  it('rejects amounts beyond the safe integer range', () => {
    expect(parseRupeesToPaise('99999999999999999').ok).toBe(false);
    expect(parseRupeesToPaise('9999999999999.99')).toEqual(ok(999999999999999));
  });
});

describe('paiseToRupeesString', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [50, '0.50'],
    [100, '1.00'],
    [10000050, '100000.50'],
    [-5, '-0.05'],
    [-150000, '-1500.00'],
  ])('%i -> %s', (paise, text) => {
    expect(paiseToRupeesString(paise)).toBe(text);
  });

  it('round-trips with the parser', () => {
    for (const p of [0, 1, 5, 99, 100, 101, 123456789, 10000050]) {
      expect(parseRupeesToPaise(paiseToRupeesString(p))).toEqual(ok(p));
    }
  });

  it('refuses non-integer paise', () => {
    expect(() => paiseToRupeesString(1.5)).toThrow(RangeError);
    expect(() => formatINR(Number.NaN)).toThrow(RangeError);
  });
});

describe('formatINR', () => {
  it('uses Indian grouping and two decimals', () => {
    expect(formatINR(10000050)).toBe('₹1,00,000.50');
    expect(formatINR(5)).toBe('₹0.05');
    expect(formatINR(0)).toBe('₹0.00');
    expect(formatINR(1234567890)).toBe('₹1,23,45,678.90');
  });

  it('formats negatives', () => {
    expect(formatINR(-50000)).toBe('-₹500.00');
  });

  it('is exact for large values', () => {
    expect(formatINR(999999999999999)).toBe('₹99,99,99,99,99,999.99');
  });
});
