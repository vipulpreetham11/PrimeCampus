import { parseSpreadsheet } from './index';
import { lazyLibs } from './libs';
import type { ParseResult } from './sheet';

// Parses one uploaded file off the main thread (TRD §14.2: keep forms responsive). The file's
// contents only travel between this worker and the page that created it.
export interface ParseRequest {
  name: string;
  buffer: ArrayBuffer;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ParseRequest>) => void) | null;
  postMessage: (m: ParseResult) => void;
};

ctx.onmessage = (e) => {
  parseSpreadsheet(e.data.name, e.data.buffer, lazyLibs).then(
    (r) => ctx.postMessage(r),
    () =>
      ctx.postMessage({
        ok: false,
        message: 'This file could not be read. Check that it is a valid .xlsx or .csv file.',
      }),
  );
};
