import { formatINR, type Paise } from '@/lib/money';
import { cn } from '@/lib/utils';

/** Displays integer paise as INR. Missing (null/undefined) is shown as "—", never as ₹0. */
export function MoneyText({ paise, className }: { paise: Paise | null | undefined; className?: string }) {
  if (paise === null || paise === undefined) {
    return (
      <span className={cn('text-muted-foreground', className)}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">No amount</span>
      </span>
    );
  }
  return <span className={cn('tabular-nums', className)}>{formatINR(paise)}</span>;
}
