import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { createOrExisting, isUncertainFailure, useCreateCheck, type CreateCheck } from '@/lib/create-check';
import { formatDate } from '@/lib/dates';
import { toAppError, type AppError } from '@/lib/errors';

// Creating a timetable draft (copy_timetable, or save_timetable_draft without a version id). Since
// migration 2310 a second draft for the same section and start date is refused as DUPLICATE with
// the existing draft's id:
//  - first attempt → DUPLICATE: "This section already has a draft starting on <date>" + Open it
//  - after an uncertain failure the same request is sent again ("checking…"): created, or DUPLICATE
//    = the earlier attempt worked → that draft opens. Never two drafts.

export interface ExistingDraft {
  id: string;
  effectiveFrom: string;
}

export interface DraftCreate {
  check: CreateCheck;
  error: AppError | null;
  existing: ExistingDraft | null;
  run: <R extends { timetable_version_id: string }>(
    send: () => Promise<R>,
    effectiveFrom: string,
    onCreated: (r: R) => void,
    onSavedEarlier: (versionId: string) => void,
  ) => void;
}

export function useDraftCreate(): DraftCreate {
  const check = useCreateCheck();
  const [error, setError] = useState<AppError | null>(null);
  const [existing, setExisting] = useState<ExistingDraft | null>(null);

  const run: DraftCreate['run'] = (send, effectiveFrom, onCreated, onSavedEarlier) => {
    setError(null);
    setExisting(null);
    check.reset();
    const attempt = () => createOrExisting(send, 'timetable_version_id');
    attempt().then(
      (r) => {
        if (r.existingId !== undefined) setExisting({ id: r.existingId, effectiveFrom });
        else onCreated(r.created);
      },
      (e: unknown) => {
        if (!isUncertainFailure(e)) return setError(toAppError(e));
        check.verify(
          () => attempt().then((r) => r.existingId ?? r.created.timetable_version_id),
          onSavedEarlier,
          (refused) => setError(toAppError(refused)),
        );
      },
    );
  };

  return { check, error, existing, run };
}

/** "This section already has a draft starting on <date>" with a button to open that draft. */
export function ExistingDraftNotice({
  existing,
  onOpen,
}: {
  existing: ExistingDraft | null;
  onOpen: (versionId: string) => void;
}) {
  if (!existing) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
      data-testid="existing-draft"
    >
      <span>This section already has a draft starting on {formatDate(existing.effectiveFrom)}.</span>
      <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => onOpen(existing.id)}>
        Open it
      </Button>
    </div>
  );
}
