import type { Json } from '@/generated/database.types';
import { browserName, deviceClass, osName } from './device';
import { recordTelemetry } from './rpc';

// Browser telemetry (TRD §16.2): approximate page views, batched ≤20 per request, flushed every
// 60 s and when the page is hidden. Best effort — failures are dropped and never block the UI.

export const MAX_BATCH = 20;
export const FLUSH_INTERVAL_MS = 60_000;
const MAX_QUEUE = 100;

interface TelemetryEvent {
  event: 'page_view';
  occurred_at: string;
  path: string;
  browser: string;
  os: string;
  device_class: string;
}

let queue: TelemetryEvent[] = [];
let enabled = false;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

/** Strip ids/query strings so paths stay coarse and bounded (≤200 chars server-side). */
export function normalizePath(pathname: string): string {
  return pathname
    .split('?')[0]!
    .split('#')[0]!
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .slice(0, 200);
}

export function trackPageView(pathname: string): void {
  if (!enabled) return;
  queue.push({
    event: 'page_view',
    occurred_at: new Date().toISOString(), // an instant, not a business date
    path: normalizePath(pathname),
    browser: browserName(),
    os: osName(),
    device_class: deviceClass(),
  });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  if (queue.length >= MAX_BATCH) void flushTelemetry();
}

export function flushTelemetry(): Promise<void> {
  if (inFlight) return inFlight;
  if (queue.length === 0) return Promise.resolve();
  const batch = queue.slice(0, MAX_BATCH);
  queue = queue.slice(MAX_BATCH);
  inFlight = recordTelemetry({ p_events: batch as unknown as Json }, { detached: true, silent: true })
    .then(() => undefined)
    .catch(() => undefined) // best effort: dropped on failure
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') void flushTelemetry();
}

function onPageHide(): void {
  void flushTelemetry();
}

/** Enable while a signed-in app session exists; disable (and drop the queue) on sign-out. */
export function setTelemetryEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  if (on) {
    timer = setInterval(() => void flushTelemetry(), FLUSH_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
  } else {
    if (timer) clearInterval(timer);
    timer = null;
    queue = [];
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
  }
}

/** Test helper. */
export function _queueLength(): number {
  return queue.length;
}
