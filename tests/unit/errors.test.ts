import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  SERVER_ERROR_CODES,
  isTransient,
  reportGlobalError,
  setGlobalErrorHandler,
  toAppError,
} from '@/lib/errors';

const pg = (hint: string, message = 'server says hi') => ({ code: 'P0001', hint, message, details: '' });

describe('toAppError — PostgREST hint mapping (CLAUDE.md rule 3)', () => {
  it.each(SERVER_ERROR_CODES)('maps hint %s to the same code', (code) => {
    const e = toAppError(pg(code), 'req-1');
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe(code);
    expect(e.requestId).toBe('req-1');
  });

  it('shows the server message for user-actionable codes', () => {
    expect(toAppError(pg('VALIDATION_ERROR', 'Choose a child')).message).toBe('Choose a child');
    expect(toAppError(pg('DUPLICATE', 'School code already exists')).message).toBe(
      'School code already exists',
    );
    expect(toAppError(pg('LIMIT_REACHED', 'At most 20 events')).message).toBe('At most 20 events');
    expect(toAppError(pg('NOT_FOUND', 'School not found')).message).toBe('School not found');
    expect(toAppError(pg('FORBIDDEN', 'Operator access required')).message).toBe('Operator access required');
  });

  it('uses fixed safe messages for session/concurrency codes', () => {
    expect(toAppError(pg('STALE_CONTEXT')).message).toMatch(/role\/school changed/i);
    expect(toAppError(pg('CONFLICT')).message).toMatch(/someone else changed/i);
    expect(toAppError(pg('UNAUTHENTICATED')).message).toMatch(/sign in again/i);
  });

  it('never exposes SQL for unknown database errors', () => {
    const e = toAppError({
      code: '23505',
      message: 'duplicate key value violates unique constraint "schools_code_key"',
    });
    expect(e.code).toBe('UNKNOWN');
    expect(e.message).toBe('Something went wrong.');
    expect(e.message).not.toMatch(/constraint|duplicate key/);
    expect(e.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ignores hints that are not part of the contract', () => {
    expect(toAppError({ hint: 'DROP TABLE', message: 'x' }).code).toBe('UNKNOWN');
  });

  it('maps expired JWTs to UNAUTHENTICATED', () => {
    expect(toAppError({ code: 'PGRST301', message: 'JWT expired' }).code).toBe('UNAUTHENTICATED');
  });

  it('maps fetch failures to NETWORK (never to an empty/zero result)', () => {
    expect(toAppError({ message: 'TypeError: Failed to fetch' }).code).toBe('NETWORK');
    expect(toAppError(new TypeError('NetworkError when attempting to fetch resource.')).code).toBe('NETWORK');
  });

  it('maps aborts to CANCELLED', () => {
    expect(toAppError(new DOMException('The operation was aborted.', 'AbortError')).code).toBe('CANCELLED');
  });

  it('prefers an explicit server code (Edge Function body)', () => {
    const e = toAppError({ message: 'Username already taken' }, 'edge-req', 'DUPLICATE');
    expect(e.code).toBe('DUPLICATE');
    expect(e.requestId).toBe('edge-req');
    expect(e.message).toBe('Username already taken');
  });

  it('passes AppError through unchanged', () => {
    const original = new AppError('CONFLICT', 'x', 'r');
    expect(toAppError(original)).toBe(original);
  });
});

describe('global handlers', () => {
  afterEach(() => {
    setGlobalErrorHandler('UNAUTHENTICATED', undefined);
    setGlobalErrorHandler('STALE_CONTEXT', undefined);
  });

  it('routes UNAUTHENTICATED and STALE_CONTEXT to their handlers only', () => {
    const unauth = vi.fn();
    const stale = vi.fn();
    setGlobalErrorHandler('UNAUTHENTICATED', unauth);
    setGlobalErrorHandler('STALE_CONTEXT', stale);
    reportGlobalError(new AppError('UNAUTHENTICATED', 'x', '1'));
    reportGlobalError(new AppError('STALE_CONTEXT', 'x', '2'));
    reportGlobalError(new AppError('FORBIDDEN', 'x', '3'));
    reportGlobalError(new AppError('CONFLICT', 'x', '4'));
    expect(unauth).toHaveBeenCalledTimes(1);
    expect(stale).toHaveBeenCalledTimes(1);
  });
});

describe('isTransient', () => {
  it('retries only network/temporary failures', () => {
    expect(isTransient(new AppError('NETWORK', '', ''))).toBe(true);
    expect(isTransient(new AppError('TEMPORARILY_UNAVAILABLE', '', ''))).toBe(true);
    for (const code of [
      'FORBIDDEN',
      'VALIDATION_ERROR',
      'CONFLICT',
      'DUPLICATE',
      'STALE_CONTEXT',
      'UNKNOWN',
    ] as const) {
      expect(isTransient(new AppError(code, '', ''))).toBe(false);
    }
  });
});
