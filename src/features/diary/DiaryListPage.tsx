import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  SectionSelect,
  TeacherSelect,
  useSectionOptions,
  useTeacherOptions,
} from '@/features/timetable/pickers';
import {
  addDays,
  daysBetween,
  formatDateTime,
  formatDayShort,
  formatTime,
  isIsoDate,
  schoolToday,
} from '@/lib/dates';
import { useCan } from '@/lib/scope';
import { useDiaryList, type DiaryFilter } from './hooks';

// Diary list (brief §6): lessons with or without a diary entry over ≤ 63 days. A teacher sees their
// own lessons by default (server rule); Admin / Principal filter by section or teacher. "Missing
// diary" lists only lessons that have none.

export function DiaryListPage() {
  const readAll = useCan('academic.read_all');
  const today = schoolToday();
  // The dashboard links here with ?from=&to=&missing=1 (its "diary missing" number).
  const [params] = useSearchParams();
  const [f, setF] = useState<DiaryFilter>(() => ({
    from: isIsoDate(params.get('from')) ? (params.get('from') as string) : addDays(today, -13),
    to: isIsoDate(params.get('to')) ? (params.get('to') as string) : today,
    sectionId: null,
    staffId: null,
    onlyMissing: params.get('missing') === '1',
  }));
  const { options: sections } = useSectionOptions();
  const { options: teachers } = useTeacherOptions();
  const span = f.from && f.to ? daysBetween(f.from, f.to) : -1;
  const valid = span >= 0 && span <= 62;
  const query = useDiaryList(f, valid);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const set = (patch: Partial<DiaryFilter>) => setF((x) => ({ ...x, ...patch }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Diary"
        description={readAll ? 'Lesson diary across the school.' : 'Your lessons and their diary entries.'}
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="diary-from">From</Label>
          <DateInput id="diary-from" value={f.from} onChange={(v) => set({ from: v })} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="diary-to">To</Label>
          <DateInput id="diary-to" value={f.to} onChange={(v) => set({ to: v })} />
        </div>
        <SectionSelect
          id="diary-section"
          value={f.sectionId}
          onChange={(v) => set({ sectionId: v })}
          options={sections}
          allowAll
          allLabel={readAll ? 'All sections' : 'My lessons'}
        />
        {readAll && teachers.length > 0 && (
          <TeacherSelect
            id="diary-teacher"
            value={f.staffId}
            onChange={(v) => set({ staffId: v })}
            options={teachers}
          />
        )}
        <div className="flex min-h-11 items-center gap-2">
          <Switch
            id="diary-missing"
            checked={f.onlyMissing}
            onCheckedChange={(v) => set({ onlyMissing: v })}
          />
          <Label htmlFor="diary-missing">Missing diary only</Label>
        </div>
      </div>
      {!valid ? (
        <p role="alert" className="text-destructive text-sm">
          Choose a range of up to 63 days, with the end on or after the start.
        </p>
      ) : (
        <DataState
          query={query}
          isEmpty={() => items.length === 0}
          emptyTitle={f.onlyMissing ? 'No lessons without a diary' : 'No lessons in this period'}
        >
          {() => (
            <>
              <ul className="space-y-2" aria-label="Lessons and diary">
                {items.map((d) => (
                  <li key={d.lesson_session_id} className="rounded-lg border p-3" data-testid="diary-item">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {formatDayShort(d.date)} · {d.slot_label} ({formatTime(d.start_time)}) · {d.section} ·{' '}
                        {d.subject}
                      </span>
                      {d.diary_entry_id ? (
                        <Badge variant="outline">Written</Badge>
                      ) : (
                        <Badge variant="secondary" data-testid="diary-missing">
                          Missing diary
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground text-xs">{d.teacher ?? 'No teacher'}</p>
                    {d.body && <p className="mt-1 line-clamp-3 text-sm whitespace-pre-wrap">{d.body}</p>}
                    {d.updated_at && (
                      <p className="text-muted-foreground text-xs">Written {formatDateTime(d.updated_at)}</p>
                    )}
                    <Link
                      to={`/lessons/${d.lesson_session_id}`}
                      className="mt-1 inline-flex min-h-11 items-center text-sm underline sm:min-h-0"
                    >
                      {d.diary_entry_id ? 'Open lesson' : 'Write diary'}
                    </Link>
                  </li>
                ))}
              </ul>
              {query.hasNextPage && (
                <Button
                  variant="outline"
                  onClick={() => void query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  Load more
                </Button>
              )}
            </>
          )}
        </DataState>
      )}
    </div>
  );
}
