import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { CreateCheckNotice } from '@/components/shared/CreateCheckNotice';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { ErrorText } from '@/components/shared/ErrorText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { TimetableVersionRow } from '@/contracts/timetable';
import { useSetupSnapshot } from '@/features/setup/hooks';
import { formatDate, maxDate, schoolToday } from '@/lib/dates';
import { useCan } from '@/lib/scope';
import { ExistingDraftNotice, useDraftCreate } from './draft-create';
import { useCopyTimetable, useSaveTimetableDraft, useTimetableVersions } from './hooks';
import { SectionSelect, useSectionOptions } from './pickers';

// Timetable versions of a section (brief §1): draft / active / retired with their dates. Admin can
// start a new draft — blank or from the current timetable — and open any version in the grid.

const STATUS_TEXT: Record<TimetableVersionRow['status'], string> = {
  draft: 'Draft',
  active: 'Active',
  retired: 'Retired',
};

export function versionDates(v: { effective_from: string; effective_to: string | null }) {
  // effective_to is exclusive: the version ends the day before
  return v.effective_to
    ? `${formatDate(v.effective_from)} – until ${formatDate(v.effective_to)}`
    : `From ${formatDate(v.effective_from)}`;
}

export function TimetablePage() {
  const canManage = useCan('timetable.manage');
  const [params, setParams] = useSearchParams();
  const { options, query: sectionsQuery } = useSectionOptions();
  const sectionId = params.get('section') ?? options[0]?.id ?? null;
  const versions = useTimetableVersions(sectionId);
  const [creating, setCreating] = useState(false);
  const section = options.find((o) => o.id === sectionId);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Timetable"
        description="Weekly plan per section. A draft becomes the timetable when it is activated."
        actions={
          canManage && (
            <Button asChild variant="outline">
              <Link to="/timetable/lessons">Update lessons</Link>
            </Button>
          )
        }
      />
      <DataState
        query={sectionsQuery}
        isEmpty={() => options.length === 0}
        emptyTitle="No sections this year"
        emptyDescription="Create classes and sections in School setup first."
      >
        {() => (
          <div className="flex flex-wrap items-end gap-3">
            <SectionSelect
              id="tt-section"
              value={sectionId}
              onChange={(v) => v && setParams({ section: v })}
              options={options}
            />
            {canManage && sectionId && (
              <Button onClick={() => setCreating(true)} className="min-h-11">
                <Plus aria-hidden="true" /> New draft
              </Button>
            )}
          </div>
        )}
      </DataState>

      {sectionId && (
        <DataState
          query={versions}
          isEmpty={(v) => v.length === 0}
          emptyTitle="No timetable yet"
          emptyDescription={
            canManage ? 'Start a new draft for this section.' : 'The school has not planned this section yet.'
          }
        >
          {(rows) => (
            <ul className="space-y-2" aria-label="Timetable versions">
              {rows.map((v) => (
                <li key={v.timetable_version_id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        v.status === 'active' ? 'default' : v.status === 'draft' ? 'secondary' : 'outline'
                      }
                    >
                      {STATUS_TEXT[v.status]}
                    </Badge>
                    <span className="font-medium">{versionDates(v)}</span>
                    <span className="text-muted-foreground text-sm">· {v.period_schedule}</span>
                    <Button asChild size="sm" variant="outline" className="ml-auto min-h-11 sm:min-h-8">
                      <Link to={`/timetable/${v.timetable_version_id}`}>
                        {v.status === 'draft' && canManage ? 'Edit' : 'Open'}
                      </Link>
                    </Button>
                  </div>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {v.entry_count} periods planned
                    {v.unassigned_teacher_count > 0 && ` · ${v.unassigned_teacher_count} without a teacher`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </DataState>
      )}

      {creating && sectionId && section && (
        <NewDraftDialog
          sectionId={sectionId}
          sectionLabel={section.label}
          versions={versions.data ?? []}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function NewDraftDialog({
  sectionId,
  sectionLabel,
  versions,
  onClose,
}: {
  sectionId: string;
  sectionLabel: string;
  versions: TimetableVersionRow[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const snapshot = useSetupSnapshot(null);
  const schedules = (snapshot.data?.period_schedules ?? []).filter((p) => p.effective_to === null);
  const source =
    versions.find((v) => v.status === 'active') ?? versions.find((v) => v.status !== 'draft') ?? null;
  const year = snapshot.data?.academic_years.find((y) => y.id === snapshot.data?.selected_year_id);
  const [start, setStart] = useState<string>(year ? maxDate(schoolToday(), year.start_date) : schoolToday());
  const [mode, setMode] = useState<'copy' | 'blank'>(source ? 'copy' : 'blank');
  const [scheduleId, setScheduleId] = useState<string | null>(schedules[0]?.id ?? null);
  const save = useSaveTimetableDraft();
  const copy = useCopyTimetable();
  const create = useDraftCreate();
  const { check } = create;
  const busy = save.isPending || copy.isPending;

  const open = (id: string) => navigate(`/timetable/${id}`);
  const opened = (id: string) => {
    toast.success('Draft created.');
    open(id);
  };
  const submit = () => {
    if (mode === 'copy' && source) {
      const request = {
        fromVersionId: source.timetable_version_id,
        targetSectionId: sectionId,
        effectiveFrom: start,
        keepTeachers: true,
      };
      create.run(
        () => copy.mutateAsync(request),
        start,
        (r) => opened(r.timetable_version_id),
        opened,
      );
    } else if (scheduleId) {
      const draft = {
        sectionId,
        periodScheduleId: scheduleId,
        effectiveFrom: start,
        entries: [],
        versionId: null,
        expectedVersion: null,
      };
      create.run(
        () => save.mutateAsync(draft),
        start,
        (r) => opened(r.timetable_version_id),
        opened,
      );
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New timetable draft — {sectionLabel}</DialogTitle>
          <DialogDescription>The draft does not change any lessons until you activate it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="nd-start">Starts on</Label>
            <DateInput
              id="nd-start"
              value={start}
              onChange={setStart}
              min={year?.start_date}
              max={year?.end_date}
            />
          </div>
          {source && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Start from</legend>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="nd-mode"
                  checked={mode === 'copy'}
                  onChange={() => setMode('copy')}
                />
                A copy of the {source.status} timetable ({versionDates(source)}), teachers included
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="nd-mode"
                  checked={mode === 'blank'}
                  onChange={() => setMode('blank')}
                />
                A blank timetable
              </label>
            </fieldset>
          )}
          {mode === 'blank' && (
            <div className="grid gap-1.5">
              <Label htmlFor="nd-schedule">Bell schedule</Label>
              <Select value={scheduleId ?? undefined} onValueChange={setScheduleId}>
                <SelectTrigger id="nd-schedule" className="min-h-11 w-full">
                  <SelectValue placeholder="Choose a bell schedule" />
                </SelectTrigger>
                <SelectContent>
                  {schedules.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {schedules.length === 0 && (
                <p className="text-muted-foreground text-sm">Create a bell schedule in School setup first.</p>
              )}
            </div>
          )}
          <ErrorText error={create.error} />
          <ExistingDraftNotice existing={create.existing} onOpen={open} />
          <CreateCheckNotice check={check} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={busy || check.blocksRetry || !start || (mode === 'blank' && !scheduleId)}
          >
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
