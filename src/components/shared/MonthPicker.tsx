import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { addDays, formatMonth, monthStart, type IsoDate } from '@/lib/dates';

// Previous / next month with the month in words. Works the same on every browser (an
// <input type="month"> is a plain text box in some). `month` is the first day ("2026-09-01").

export function MonthPicker({
  id,
  label = 'Month',
  month,
  onChange,
  max,
}: {
  id: string;
  label?: string;
  month: IsoDate;
  onChange: (month: IsoDate) => void;
  /** The latest month that can be chosen (first day), e.g. the current month. */
  max?: IsoDate;
}) {
  const prev = monthStart(addDays(month, -1));
  const next = monthStart(addDays(month, 32));
  const atMax = max !== undefined && next > max;
  return (
    <div className="grid gap-1.5">
      <span id={`${id}-label`} className="text-sm font-medium">
        {label}
      </span>
      <div className="flex items-center gap-1" role="group" aria-labelledby={`${id}-label`}>
        <Button
          variant="outline"
          size="icon"
          className="size-11 sm:size-9"
          aria-label="Previous month"
          onClick={() => onChange(prev)}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <output id={id} className="min-w-36 text-center font-medium" aria-live="polite">
          {formatMonth(month)}
        </output>
        <Button
          variant="outline"
          size="icon"
          className="size-11 sm:size-9"
          aria-label="Next month"
          disabled={atMax}
          onClick={() => onChange(next)}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
