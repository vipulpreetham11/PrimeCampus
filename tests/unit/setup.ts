import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// Brief M1: every shadcn primitive must forwardRef on React 18. Fail any test that triggers
// React's "Function components cannot be given refs" warning.
const REF_WARNING = /Function components cannot be given refs/;
beforeEach(() => {
  const original = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (args.some((a) => typeof a === 'string' && REF_WARNING.test(a))) {
      throw new Error(`React ref warning: ${String(args[0])} ${String(args[1] ?? '')}`);
    }
    original(...args);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom lacks these; Radix Select/Popper call them.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
// Radix Checkbox/Switch measure themselves (useSize).
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
