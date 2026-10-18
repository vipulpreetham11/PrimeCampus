import { CheckCircle2, CircleSlash, Copy, Hourglass, PencilLine, Trash2, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { isClosedJob, type ImportCounts } from '@/contracts/imports';
import { cn } from '@/lib/utils';
import { ROW_STATE_LABELS, jobStatusLabel, type RowState } from './labels';

// Count tiles and status badges. Every state has text and an icon; colour is only an extra cue.

interface Tile {
  label: string;
  value: number;
  hint: string;
  icon: LucideIcon;
  tone: string;
}

export function CountTiles({ counts }: { counts: ImportCounts }) {
  const tiles: Tile[] = [
    {
      label: 'Ready',
      value: counts.ready,
      hint: 'Will be created',
      icon: CheckCircle2,
      tone: 'border-l-emerald-600',
    },
    {
      label: 'Already exist',
      value: counts.will_skip + counts.skipped,
      hint: 'Nothing will change',
      icon: Copy,
      tone: 'border-l-sky-600',
    },
    {
      label: 'Needs fixing',
      value: counts.needs_fixing,
      hint: 'Edit or remove these',
      icon: PencilLine,
      tone: 'border-l-amber-600',
    },
    {
      label: 'Removed',
      value: counts.removed,
      hint: 'Left out of this import',
      icon: Trash2,
      tone: 'border-l-slate-400',
    },
    {
      label: 'Imported',
      value: counts.created,
      hint: 'New records created',
      icon: CheckCircle2,
      tone: 'border-l-emerald-800',
    },
    {
      label: 'Not imported',
      value: counts.rejected,
      hint: 'Failed at import — fix and retry',
      icon: XCircle,
      tone: 'border-l-red-600',
    },
  ];
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label="Row counts">
      {tiles.map((t) => (
        <li
          key={t.label}
          className={cn('bg-background rounded-md border border-l-4 p-3', t.tone)}
          data-testid={`tile-${t.label}`}
        >
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            <t.icon aria-hidden="true" className="size-3.5" />
            {t.label}
          </div>
          <div className="text-2xl font-semibold tabular-nums">{t.value.toLocaleString('en-IN')}</div>
          <div className="text-muted-foreground text-xs">{t.hint}</div>
        </li>
      ))}
    </ul>
  );
}

const ROW_STATE_ICON: Record<RowState, LucideIcon> = {
  ready: CheckCircle2,
  will_skip: Copy,
  needs_fixing: PencilLine,
  pending: Hourglass,
  created: CheckCircle2,
  skipped: Copy,
  rejected: XCircle,
  removed: CircleSlash,
};

export function RowStateBadge({ state }: { state: RowState }) {
  const Icon = ROW_STATE_ICON[state];
  const variant = state === 'needs_fixing' || state === 'rejected' ? 'destructive' : 'outline';
  return (
    <Badge variant={variant} className="whitespace-normal">
      <Icon aria-hidden="true" />
      {ROW_STATE_LABELS[state]}
    </Badge>
  );
}

export function JobStatusBadge({ status }: { status: string }) {
  return <Badge variant={isClosedJob(status) ? 'secondary' : 'outline'}>{jobStatusLabel(status)}</Badge>;
}
