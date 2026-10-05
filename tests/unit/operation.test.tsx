import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { newOperationId, useOperationId } from '@/lib/operation';

describe('useOperationId', () => {
  it('is stable across re-renders (so retries reuse it)', () => {
    const { result, rerender } = renderHook(() => useOperationId());
    const first = result.current.operationId;
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    rerender();
    rerender();
    expect(result.current.operationId).toBe(first);
  });

  it('changes only after reset (after success)', () => {
    const { result } = renderHook(() => useOperationId());
    const first = result.current.operationId;
    act(() => result.current.reset());
    expect(result.current.operationId).not.toBe(first);
    const second = result.current.operationId;
    act(() => undefined);
    expect(result.current.operationId).toBe(second);
  });

  it('gives each form/action its own id', () => {
    const a = renderHook(() => useOperationId());
    const b = renderHook(() => useOperationId());
    expect(a.result.current.operationId).not.toBe(b.result.current.operationId);
    expect(newOperationId()).not.toBe(newOperationId());
  });
});
