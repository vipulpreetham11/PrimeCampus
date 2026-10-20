import { Link, useSearchParams } from 'react-router';
import { Download } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { AcademicCoverage, CoverageRow } from '@/contracts/reports';
import { SectionSelect, useSectionOptions } from '@/features/timetable/pickers';
import { downloadCsv } from '@/lib/csv';
import { addDays, daysBetween, formatDayShort, isIsoDate, schoolToday } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { useAcademicCoverage } from './hooks';
import {
  COVERAGE_SORTS,
  coverageCsv,
  coverageTotals,
  hasGap,
  sortCoverage,
  type CoverageSort,
} from './logic';

// Academic coverage (HW-03, Principal / Admin): per section · subject · teacher over ≤ 63 days —
// lessons held, diary written, homework set, homework due fully checked / with no checks, period
// attendance marked. "Unassigned" rows (no teacher took the lessons) are shown, never dropped.

export function CoveragePage() {
  const [params, setParams] = useSearchParams();
  const today = schoolToday();
  const from = isIsoDate(params.get('from')) ? (params.get('from') as string) : addDays(today, -29);
  const to = isIsoDate(params.get('to')) ? (params.get('to') as string) : today;
  const sectionId = params.get('section');
  const rawSort = params.get('sort');
  const sort: CoverageSort = rawSort && rawSort in COVERAGE_SORTS ? (rawSort as CoverageSort) : 'section';
  const onlyGaps = params.get('gaps') === '1';
  const span = daysBetween(from, to);
  const valid = span >= 0 && span <= 62;
  const { options: sections } = useSectionOptions();
  const query = useAcademicCoverage(from, to, sectionId, valid);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Academic coverage"
        description="Lessons, diary, homework checking and period attendance per section, subject and teacher."
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/attendance/register">Attendance register</Link>
            </Button>
            <Button
              variant="outline"
              disabled={!query.data}
              onClick={() =>
                query.data &&
                downloadCsv(
                  coverageCsv(sortCoverage(query.data.rows, sort), query.data.from, query.data.to),
                  `academic-coverage-${query.data.from}-to-${query.data.to}.csv`,
                )
              }
            >
              <Download aria-hidden="true" /> Export CSV
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="cov-from">From</Label>
          <DateInput id="cov-from" value={from} onChange={(v) => v && update({ from: v })} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cov-to">To</Label>
          <DateInput id="cov-to" value={to} onChange={(v) => v && update({ to: v })} />
        </div>
        <SectionSelect
          id="cov-section"
          value={sectionId}
          onChange={(v) => update({ section: v })}
          options={sections}
          allowAll
        />
        <div className="grid gap-1.5">
          <Label htmlFor="cov-sort">Sort by</Label>
          <Select value={sort} onValueChange={(v) => update({ sort: v === 'section' ? null : v })}>
            <SelectTrigger id="cov-sort" className="min-h-11 w-full sm:w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(COVERAGE_SORTS) as CoverageSort[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {COVERAGE_SORTS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-h-11 items-center gap-2">
          <Switch
            id="cov-gaps"
            checked={onlyGaps}
            onCheckedChange={(v) => update({ gaps: v ? '1' : null })}
          />
          <Label htmlFor="cov-gaps">Only rows that need attention</Label>
        </div>
      </div>
      {!valid ? (
        <p className="text-destructive text-sm" role="alert">
          Choose a range of up to 63 days, with “To” on or after “From”.
        </p>
      ) : (
        <DataState
          query={query}
          isEmpty={(d) => d.rows.length === 0}
          emptyTitle="No lessons in this range"
          emptyDescription="Lessons appear after timetables are activated and lessons are generated."
        >
          {(d) => <CoverageView data={d} sort={sort} onlyGaps={onlyGaps} />}
        </DataState>
      )}
    </div>
  );
}

function CoverageView({
  data,
  sort,
  onlyGaps,
}: {
  data: AcademicCoverage;
  sort: CoverageSort;
  onlyGaps: boolean;
}) {
  const rows = sortCoverage(data.rows, sort).filter((r) => !onlyGaps || hasGap(r));
  const t = coverageTotals(rows);
  return (
    <div className="space-y-3" data-testid="coverage">
      <p className="text-muted-foreground text-xs">
        {formatDayShort(data.from)} – {formatDayShort(data.to)}. {data.note} Period attendance counts lessons
        with at least one mark.
      </p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
          Nothing needs attention in this range.
        </p>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[60rem] text-sm" data-testid="coverage-table">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2 pr-3 font-medium">Section</th>
                  <th className="py-2 pr-3 font-medium">Subject</th>
                  <th className="py-2 pr-3 font-medium">Teacher</th>
                  <th className="py-2 pr-3 text-right font-medium">Lessons</th>
                  <th className="py-2 pr-3 text-right font-medium">Diary written</th>
                  <th className="py-2 pr-3 text-right font-medium">Homework set</th>
                  <th className="py-2 pr-3 text-right font-medium">Due: fully checked</th>
                  <th className="py-2 pr-3 text-right font-medium">Due: no checks</th>
                  <th className="py-2 pr-3 text-right font-medium">Period attendance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.section_id}-${r.subject_id}-${r.staff_id ?? 'none'}`}
                    className="border-b"
                    data-testid="coverage-row"
                  >
                    <td className="py-2 pr-3">{r.section}</td>
                    <td className="py-2 pr-3">{r.subject}</td>
                    <td className="py-2 pr-3">
                      <Teacher r={r} />
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.lessons}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      <Ratio done={r.diary_written} of={r.lessons} />
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.homework_set}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.homework_due_fully_checked} of {r.homework_due}
                    </td>
                    <td
                      className={cn(
                        'py-2 pr-3 text-right tabular-nums',
                        r.homework_due_unchecked > 0 && 'font-medium text-amber-800 dark:text-amber-300',
                      )}
                    >
                      {r.homework_due_unchecked}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.period_lessons === 0 ? (
                        <span className="text-muted-foreground">Day-wise</span>
                      ) : (
                        <Ratio done={r.period_attendance_marked} of={r.period_lessons} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-medium">
                  <td className="py-2 pr-3" colSpan={3}>
                    Total ({rows.length} rows)
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{t.lessons}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {t.diary_written} / {t.lessons}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{t.homework_set}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {t.homework_due_fully_checked} of {t.homework_due}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{t.homework_due_unchecked}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {t.period_attendance_marked} / {t.period_lessons}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <ul className="space-y-2 md:hidden" aria-label="Coverage">
            {rows.map((r) => (
              <li
                key={`${r.section_id}-${r.subject_id}-${r.staff_id ?? 'none'}`}
                className="rounded-lg border p-3 text-sm"
                data-testid="coverage-card"
              >
                <p className="font-medium">
                  {r.section} · {r.subject}
                </p>
                <p>
                  <Teacher r={r} />
                </p>
                <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
                  <dt className="text-muted-foreground">Diary written</dt>
                  <dd className="text-right">
                    <Ratio done={r.diary_written} of={r.lessons} />
                  </dd>
                  <dt className="text-muted-foreground">Homework set</dt>
                  <dd className="text-right">{r.homework_set}</dd>
                  <dt className="text-muted-foreground">Due: fully checked</dt>
                  <dd className="text-right">
                    {r.homework_due_fully_checked} of {r.homework_due}
                  </dd>
                  <dt className="text-muted-foreground">Due: no checks</dt>
                  <dd className="text-right">{r.homework_due_unchecked}</dd>
                  {r.period_lessons > 0 && (
                    <>
                      <dt className="text-muted-foreground">Period attendance</dt>
                      <dd className="text-right">
                        <Ratio done={r.period_attendance_marked} of={r.period_lessons} />
                      </dd>
                    </>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Teacher({ r }: { r: CoverageRow }) {
  if (r.staff_id === null)
    return (
      <Badge variant="outline" className="border-amber-500">
        Unassigned
      </Badge>
    );
  return <>{r.teacher}</>;
}

function Ratio({ done, of }: { done: number; of: number }) {
  const missing = of - done;
  return (
    <span className={cn(missing > 0 && 'font-medium text-amber-800 dark:text-amber-300')}>
      {done} / {of}
      {missing > 0 && <span className="sr-only"> ({missing} missing)</span>}
    </span>
  );
}
