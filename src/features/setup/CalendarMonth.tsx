import type { Calendar } from '@/contracts/setup';
import { formatDateLong } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { DAY_TYPE_META, WEEKDAYS, buildMonthGrid, monthBounds } from './calendar-model';

/**
 * One month of a resolved calendar. Desktop: Monday-first grid. Phones: a list.
 * Every day shows its type as text (colour is never the only signal); dated overrides are marked.
 * Days the server did not return (outside the academic year) show "Not in year", never "working".
 */
export function CalendarMonth({ calendar, month }: { calendar: Calendar; month: string }) {
  const overrideDates = new Set(calendar.overrides.map((o) => o.date));
  const weeks = buildMonthGrid(month, calendar.resolved, overrideDates);
  const { from, to } = monthBounds(month);
  const listDays = calendar.resolved.filter((r) => r.date >= from && r.date <= to);
  const overrideBy = new Map(calendar.overrides.map((o) => [o.date, o]));

  return (
    <div>
      {/* Grid: tablets and up */}
      <table
        className="hidden w-full table-fixed border-separate border-spacing-1 sm:table"
        aria-label="Month calendar"
      >
        <thead>
          <tr>
            {WEEKDAYS.map((w) => (
              <th key={w.iso} scope="col" className="text-muted-foreground text-xs font-medium">
                <abbr title={w.long} className="no-underline">
                  {w.short}
                </abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, wi) => (
            <tr key={wi}>
              {week.map((cell, ci) =>
                cell === null ? (
                  <td key={ci} />
                ) : (
                  <td key={cell.date} className="align-top">
                    <div
                      data-testid={`day-${cell.date}`}
                      data-day-type={cell.resolved?.day_type ?? 'none'}
                      className={cn(
                        'flex h-20 flex-col rounded-md border p-1 text-xs',
                        cell.resolved
                          ? DAY_TYPE_META[cell.resolved.day_type].className
                          : 'text-muted-foreground border-dashed',
                      )}
                      title={
                        cell.resolved
                          ? `${formatDateLong(cell.date)}: ${DAY_TYPE_META[cell.resolved.day_type].label}${cell.resolved.label ? ` — ${cell.resolved.label}` : ''}`
                          : `${formatDateLong(cell.date)}: not in this academic year`
                      }
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold">{cell.day}</span>
                        {cell.isOverride && (
                          <span aria-label="Changed for this date" title="Changed for this date">
                            ✎
                          </span>
                        )}
                      </div>
                      <span>
                        {cell.resolved ? DAY_TYPE_META[cell.resolved.day_type].label : 'Not in year'}
                      </span>
                      {cell.resolved?.label && <span className="truncate italic">{cell.resolved.label}</span>}
                    </div>
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {/* List: phones */}
      <ul className="space-y-1 sm:hidden" aria-label="Days this month">
        {listDays.length === 0 && (
          <li className="text-muted-foreground text-sm">No days of this month are in the academic year.</li>
        )}
        {listDays.map((d) => {
          const o = overrideBy.get(d.date);
          return (
            <li
              key={d.date}
              data-testid={`list-day-${d.date}`}
              className={cn(
                'flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm',
                DAY_TYPE_META[d.day_type].className,
              )}
            >
              <span>{formatDateLong(d.date)}</span>
              <span className="text-right">
                <span className="font-medium">{DAY_TYPE_META[d.day_type].label}</span>
                {d.label && <span className="block text-xs italic">{d.label}</span>}
                {o && (
                  <span className="block text-xs">
                    Changed for this date{o.reason ? `: ${o.reason}` : ''}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function CalendarLegend() {
  return (
    <ul className="flex flex-wrap gap-2 text-xs" aria-label="Legend">
      {(Object.keys(DAY_TYPE_META) as (keyof typeof DAY_TYPE_META)[]).map((k) => (
        <li key={k} className={cn('rounded border px-2 py-0.5', DAY_TYPE_META[k].className)}>
          {DAY_TYPE_META[k].label}
        </li>
      ))}
      <li className="rounded border px-2 py-0.5">✎ changed for one date</li>
    </ul>
  );
}
