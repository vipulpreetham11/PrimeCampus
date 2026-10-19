import { useState } from 'react';
import { Link } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { HomeworkListItem } from '@/contracts/academic';
import { useSetupSnapshot } from '@/features/setup/hooks';
import {
  SectionSelect,
  TeacherSelect,
  useSectionOptions,
  useTeacherOptions,
} from '@/features/timetable/pickers';
import { addDays, daysBetween, formatDate, schoolToday } from '@/lib/dates';
import { useCan } from '@/lib/scope';
import { HomeworkFormDialog } from './HomeworkFormDialog';
import { useHomeworkList, type HomeworkFilter } from './hooks';

// Homework list (brief §7) with check progress. Teachers see sections they teach (or homework they
// set); Admin / Principal can filter by section, subject and teacher.

const ALL = '__all__';

export function HomeworkListPage() {
  const readAll = useCan('academic.read_all');
  const today = schoolToday();
  const [filter, setFilter] = useState<HomeworkFilter>({
    from: addDays(today, -30),
    to: today,
    sectionId: null,
    subjectId: null,
    staffId: null,
    status: 'active',
  });
  const [editing, setEditing] = useState<HomeworkListItem | null>(null);
  const { options: sections } = useSectionOptions();
  const { options: teachers } = useTeacherOptions();
  const snapshot = useSetupSnapshot(null);
  const subjects = (snapshot.data?.subjects ?? []).filter((s) => s.status === 'active');
  const span = filter.from && filter.to ? daysBetween(filter.from, filter.to) : -1;
  const valid = span >= 0 && span <= 400;
  const query = useHomeworkList(filter, valid);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const set = (patch: Partial<HomeworkFilter>) => setFilter((f) => ({ ...f, ...patch }));

  return (
    <div className="space-y-4">
      <PageHeader title="Homework" description="Homework set in lessons, with how much has been checked." />
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="hw-from">Set from</Label>
          <DateInput id="hw-from" value={filter.from} onChange={(v) => set({ from: v })} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="hw-to">to</Label>
          <DateInput id="hw-to" value={filter.to} onChange={(v) => set({ to: v })} />
        </div>
        <SectionSelect
          id="hw-section"
          value={filter.sectionId}
          onChange={(v) => set({ sectionId: v })}
          options={sections}
          allowAll
        />
        <div className="grid gap-1.5">
          <Label htmlFor="hw-subject">Subject</Label>
          <Select
            value={filter.subjectId ?? ALL}
            onValueChange={(v) => set({ subjectId: v === ALL ? null : v })}
          >
            <SelectTrigger id="hw-subject" className="min-h-11 w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All subjects</SelectItem>
              {subjects.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {readAll && teachers.length > 0 && (
          <TeacherSelect
            id="hw-teacher"
            value={filter.staffId}
            onChange={(v) => set({ staffId: v })}
            options={teachers}
          />
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="hw-status">Status</Label>
          <Select value={filter.status} onValueChange={(v) => set({ status: v as HomeworkFilter['status'] })}>
            <SelectTrigger id="hw-status" className="min-h-11 w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {!valid ? (
        <p role="alert" className="text-destructive text-sm">
          Choose a range of up to 400 days, with the end on or after the start.
        </p>
      ) : (
        <DataState query={query} isEmpty={() => items.length === 0} emptyTitle="No homework in this period">
          {() => (
            <>
              <ul className="space-y-2" aria-label="Homework">
                {items.map((h) => (
                  <HomeworkItem key={h.assignment_id} h={h} onEdit={() => setEditing(h)} />
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
      {editing && (
        <HomeworkFormDialog
          homework={editing}
          title={`Edit homework — ${editing.subject}`}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

export function HomeworkProgress({
  h,
}: {
  h: Pick<HomeworkListItem, 'eligible' | 'checked' | 'completed' | 'not_completed' | 'correction_required'>;
}) {
  const unchecked = Math.max(0, h.eligible - h.checked);
  return (
    <p className="text-sm" data-testid="homework-progress">
      Checked {h.checked} of {h.eligible}
      {unchecked > 0 && <span className="text-muted-foreground"> · {unchecked} unchecked</span>}
      {h.checked > 0 && (
        <span className="text-muted-foreground">
          {' '}
          · Completed {h.completed} · Not completed {h.not_completed} · Correction required{' '}
          {h.correction_required}
        </span>
      )}
    </p>
  );
}

function HomeworkItem({ h, onEdit }: { h: HomeworkListItem; onEdit: () => void }) {
  return (
    <li className="rounded-lg border p-3" data-testid="homework-item">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {h.subject} · {h.section}
        </span>
        {h.status === 'cancelled' && <Badge variant="destructive">Cancelled</Badge>}
        <span className="text-muted-foreground text-sm">
          Set {formatDate(h.assigned_on)} · due {formatDate(h.due_on)}
          {h.assigned_by && ` · ${h.assigned_by}`}
        </span>
      </div>
      <p className="mt-1 line-clamp-3 text-sm whitespace-pre-wrap">{h.description}</p>
      <HomeworkProgress h={h} />
      <div className="mt-2 flex flex-wrap gap-2">
        {h.status === 'active' && (
          <Button
            asChild
            size="sm"
            variant={h.can_check ? 'default' : 'outline'}
            className="min-h-11 sm:min-h-8"
          >
            <Link to={`/homework/${h.assignment_id}`}>{h.can_check ? 'Check' : 'See checks'}</Link>
          </Button>
        )}
        {h.can_edit && h.status === 'active' && (
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={onEdit}>
            Edit
          </Button>
        )}
        {h.lesson_session_id && (
          <Button asChild size="sm" variant="ghost" className="min-h-11 sm:min-h-8">
            <Link to={`/lessons/${h.lesson_session_id}`}>Lesson</Link>
          </Button>
        )}
      </div>
    </li>
  );
}
