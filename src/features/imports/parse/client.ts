import { parseSpreadsheet } from './index';
import { lazyLibs } from './libs';
import type { ParseRequest } from './parse.worker';
import type { ParseResult } from './sheet';

const UNREADABLE: ParseResult = {
  ok: false,
  message: 'This file could not be read. Check that it is a valid .xlsx or .csv file.',
};

function parseInWorker(req: ParseRequest): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(e instanceof Error ? e : new Error('worker unavailable'));
      return;
    }
    worker.onmessage = (e: MessageEvent<ParseResult>) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      reject(new Error('worker failed'));
    };
    // The buffer is transferred, not copied: the page keeps its own copy for the fingerprint.
    worker.postMessage(req, [req.buffer]);
  });
}

/**
 * Parse a file in a Web Worker; where workers are unavailable (tests, locked-down browsers) parse
 * on the main thread with the same lazy-loaded code.
 */
export async function parseFile(name: string, bytes: ArrayBuffer): Promise<ParseResult> {
  if (typeof Worker !== 'undefined') {
    try {
      return await parseInWorker({ name, buffer: bytes.slice(0) });
    } catch {
      // fall through to the main thread
    }
  }
  try {
    return await parseSpreadsheet(name, bytes, lazyLibs);
  } catch {
    return UNREADABLE;
  }
}
