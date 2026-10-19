import { useState } from 'react';
import { Printer } from 'lucide-react';
import { MoneyText } from '@/components/shared/MoneyText';
import { Button } from '@/components/ui/button';
import type { Receipt } from '@/contracts/fees';
import { formatDate, formatDateTime } from '@/lib/dates';
import { amountInWords } from '@/lib/money';
import { methodLabel, reversalCauseLabel } from '../labels';

// Receipt (brief §5): printed from the receipt's SNAPSHOT only — what was true when it was issued —
// so a reprint always shows the original content, whatever changed since. Reversals are listed
// under it. Print CSS: only the receipt is printed, on A5 (default) or A4.

export type PaperSize = 'A5' | 'A4';

/** The print rules for the chosen paper size; only #fee-receipt is printed. */
export function printCss(size: PaperSize): string {
  return `@media print {
  @page { size: ${size} portrait; margin: ${size === 'A5' ? '8mm' : '12mm'}; }
  body * { visibility: hidden !important; }
  #fee-receipt, #fee-receipt * { visibility: visible !important; }
  #fee-receipt { position: absolute; left: 0; top: 0; width: 100%; border: none !important; box-shadow: none !important; padding: 0 !important; color: #000; }
  .receipt-no-print { display: none !important; }
}`;
}

export function ReceiptView({ receipt }: { receipt: Receipt }) {
  const s = receipt.snapshot;
  const [size, setSize] = useState<PaperSize>('A5');
  const reversed = receipt.reversals.reduce((t, r) => t + r.amount_paise, 0);
  return (
    <div className="space-y-3">
      <style>{printCss(size)}</style>
      <div className="receipt-no-print flex flex-wrap items-center gap-2 print:hidden">
        <Button onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden="true" /> Print
        </Button>
        <fieldset className="flex items-center gap-3 text-sm">
          <legend className="sr-only">Paper size</legend>
          {(['A5', 'A4'] as const).map((p) => (
            <label key={p} className="flex items-center gap-1">
              <input type="radio" name="paper" value={p} checked={size === p} onChange={() => setSize(p)} /> {p}
            </label>
          ))}
        </fieldset>
      </div>

      <article
        id="fee-receipt"
        data-testid="receipt"
        className="bg-background mx-auto max-w-2xl space-y-4 rounded-md border p-4 text-sm sm:p-6"
        aria-label={`Receipt ${s.receipt_no}`}
      >
        <header className="border-b pb-3 text-center">
          <h2 className="text-lg font-semibold">{s.school_name ?? ''}</h2>
          {s.school_address && <p className="text-xs">{s.school_address}</p>}
          <p className="mt-1 font-medium tracking-wide uppercase">Fee receipt</p>
        </header>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Receipt no</dt>
          <dd className="font-medium break-all" data-testid="receipt-no">
            {s.receipt_no}
          </dd>
          <dt className="text-muted-foreground">Date</dt>
          <dd>{formatDate(s.date)}</dd>
          <dt className="text-muted-foreground">Student</dt>
          <dd className="font-medium">{s.student_name}</dd>
          <dt className="text-muted-foreground">Admission no</dt>
          <dd className="break-all">{s.admission_no}</dd>
          <dt className="text-muted-foreground">Class</dt>
          <dd>{s.class_section ?? 'Not set'}</dd>
          <dt className="text-muted-foreground">Paid by</dt>
          <dd>
            {methodLabel(s.method)}
            {s.account ? ` · ${s.account}` : ''}
          </dd>
          {s.reference && (
            <>
              <dt className="text-muted-foreground">Reference</dt>
              <dd className="break-all">{s.reference}</dd>
            </>
          )}
          {s.payer && (
            <>
              <dt className="text-muted-foreground">Payer</dt>
              <dd>{s.payer}</dd>
            </>
          )}
        </dl>

        <table className="w-full border-t text-left">
          <thead>
            <tr className="text-muted-foreground text-xs">
              <th className="py-1 font-normal">Invoice</th>
              <th className="py-1 font-normal">For</th>
              <th className="py-1 text-right font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {s.allocations.map((a, i) => (
              <tr key={i} className="border-t">
                <td className="py-1 break-all">{a.invoice_no}</td>
                <td className="py-1">{a.term ?? '—'}</td>
                <td className="py-1 text-right">
                  <MoneyText paise={a.amount_paise} />
                </td>
              </tr>
            ))}
            <tr className="border-t font-semibold">
              <td className="py-1" colSpan={2}>
                Total received
              </td>
              <td className="py-1 text-right" data-testid="receipt-total">
                <MoneyText paise={s.amount_paise} />
              </td>
            </tr>
          </tbody>
        </table>
        <p data-testid="amount-in-words">
          <span className="text-muted-foreground">In words: </span>
          {amountInWords(s.amount_paise)}
        </p>

        <footer className="flex flex-wrap justify-between gap-2 border-t pt-3 text-xs">
          <span>Received by: {s.collected_by ?? '—'}</span>
          <span>Issued {formatDateTime(receipt.issued_at)}</span>
        </footer>

        {receipt.reversals.length > 0 && (
          <section className="space-y-1 border-t pt-3" aria-label="Reversals" data-testid="receipt-reversals">
            <p className="font-medium">
              Reversals (total <MoneyText paise={reversed} />)
            </p>
            <ul className="space-y-0.5">
              {receipt.reversals.map((r, i) => (
                <li key={i}>
                  {formatDateTime(r.at)} · {reversalCauseLabel(r.cause)} · <MoneyText paise={r.amount_paise} />
                  {r.reason ? ` — ${r.reason}` : ''}
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>
    </div>
  );
}
