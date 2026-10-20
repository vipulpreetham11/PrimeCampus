import { Badge } from '@/components/ui/badge';
import type { SalaryStatus } from '@/contracts/salary';
import { cn } from '@/lib/utils';
import { formatDays, statusText } from './logic';

// Small salary display pieces. Status is always in words (colour is only a second signal).

const STATUS_CLASS: Record<SalaryStatus, string> = {
  not_saved: 'border-dashed',
  saved: 'border-emerald-600',
  changed: 'border-amber-500 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100',
  needs_resolution: 'border-destructive text-destructive',
};

export function SalaryStatusChip({ status, versionNo }: { status: SalaryStatus; versionNo: number | null }) {
  return (
    <Badge variant="outline" className={cn(STATUS_CLASS[status])} data-testid="salary-status">
      {statusText(status, versionNo)}
    </Badge>
  );
}

/** Days as text; missing (no saved / no live numbers) is "—", never 0. */
export function DaysText({ days }: { days: number | null | undefined }) {
  if (days === null || days === undefined)
    return (
      <span className="text-muted-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">Not available</span>
      </span>
    );
  return <span className="tabular-nums">{formatDays(days)}</span>;
}

export function ConfidentialNote() {
  return (
    <p className="text-muted-foreground text-xs">
      Confidential — salary is visible only to Admin, Owner and the Operator, on screen and in exports.
    </p>
  );
}
