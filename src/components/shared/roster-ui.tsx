import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useBlocker } from 'react-router';
import { AlertTriangle, CheckCircle2, CloudOff, Loader2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { RowState } from '@/lib/roster';
import type { SavePhase } from '@/lib/use-roster-save';
import type { AppError } from '@/lib/errors';

// Shared pieces of the bulk rosters (attendance, staff attendance, homework checks). Every state is
// written out in words — colour is never the only signal — and every control is at least 44px tall
// on phones.

export interface ChoiceOption<T extends string> {
  value: T;
  /** One-letter keyboard shortcut and short label shown on phones (e.g. "P"). */
  short: string;
  label: string;
  /** Classes for the selected state (paired with the text label, never alone). */
  selectedClass?: string;
}

/** A row's choice as a radio group of buttons: P / L / A / H, or Completed / Not completed. */
export function ChoiceGroup<T extends string>({
  options,
  value,
  onChange,
  disabled,
  label,
  showLabels = 'sm',
}: {
  options: ChoiceOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Accessible name, e.g. "Attendance for Aarav Sharma". */
  label: string;
  /** Show the full label from this breakpoint (always on 'always'); below it only the short label. */
  showLabels?: 'sm' | 'always';
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((o) => {
        const selected = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o.label}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'focus-visible:ring-ring/50 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border px-2 text-sm font-medium outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
              selected
                ? (o.selectedClass ?? 'border-primary bg-primary text-primary-foreground')
                : 'bg-background hover:bg-accent',
            )}
          >
            {selected && <span className="sr-only">Selected: </span>}
            <span className={showLabels === 'always' ? 'hidden' : 'sm:hidden'} aria-hidden="true">
              {o.short}
            </span>
            <span className={showLabels === 'always' ? '' : 'hidden sm:inline'} aria-hidden="true">
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const STATE_TEXT: Record<RowState, string> = {
  unmarked: 'Unmarked',
  marked: 'Saved',
  changed: 'Not saved',
  conflict: 'Changed by someone else',
};

/** The row's state in words. `unmarkedLabel` lets homework say "Unchecked". */
export function RowStateBadge({ state, unmarkedLabel }: { state: RowState; unmarkedLabel?: string }) {
  const text = state === 'unmarked' && unmarkedLabel ? unmarkedLabel : STATE_TEXT[state];
  return (
    <Badge
      variant={state === 'conflict' ? 'destructive' : state === 'changed' ? 'secondary' : 'outline'}
      data-state={state}
      className={cn(state === 'unmarked' && 'border-dashed')}
    >
      {state === 'conflict' && <AlertTriangle aria-hidden="true" />}
      {text}
    </Badge>
  );
}

/**
 * Roving focus over roster rows: ↑/↓ (and Home/End) move between rows, the option shortcut keys
 * (P, L, A, H …) set the focused row. Attach `onKeyDown` to the list and `rowProps(i)` to each row.
 */
export function useRosterKeyboard(rowCount: number, onShortcut: (rowIndex: number, key: string) => boolean) {
  const rowsRef = useRef<(HTMLElement | null)[]>([]);
  const focusRow = useCallback((i: number) => {
    rowsRef.current[i]?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      // typing in a comment / date field is not a shortcut
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const index = rowsRef.current.findIndex((el) => el?.contains(target));
      if (index < 0) return;
      const move = (to: number) => {
        e.preventDefault();
        focusRow(Math.max(0, Math.min(rowCount - 1, to)));
      };
      if (e.key === 'ArrowDown') return move(index + 1);
      if (e.key === 'ArrowUp') return move(index - 1);
      if (e.key === 'Home') return move(0);
      if (e.key === 'End') return move(rowCount - 1);
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (onShortcut(index, e.key.toUpperCase())) {
        e.preventDefault();
        // move on to the next row, like ticking down a paper register
        if (index < rowCount - 1) focusRow(index + 1);
      }
    },
    [focusRow, onShortcut, rowCount],
  );

  const rowProps = useCallback(
    (i: number) => ({
      ref: (el: HTMLElement | null) => {
        rowsRef.current[i] = el;
      },
      tabIndex: i === 0 ? 0 : -1,
      'data-roster-row': i,
    }),
    [],
  );

  return { onKeyDown, rowProps, focusRow };
}

/** Sticky save bar: counts, Save, and the outcome of the last save (never silently dropped). */
export function RosterSaveBar({
  summary,
  pendingCount,
  conflictCount,
  phase,
  error,
  disabled,
  onSave,
  saveLabel = 'Save',
  extra,
}: {
  summary: ReactNode;
  pendingCount: number;
  conflictCount: number;
  phase: SavePhase;
  error: AppError | null;
  disabled?: boolean;
  onSave: () => void;
  saveLabel?: string;
  extra?: ReactNode;
}) {
  const saving = phase === 'saving';
  const notSaved = phase === 'not_saved' && pendingCount > 0;
  return (
    <div
      className="bg-background/95 sticky bottom-16 z-20 mt-4 rounded-lg border p-3 shadow-sm backdrop-blur md:bottom-2"
      data-testid="roster-save-bar"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 text-sm" aria-live="polite">
          {summary}
        </div>
        {extra}
        <Button onClick={onSave} disabled={disabled || saving || pendingCount === 0} className="min-h-11">
          {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
          {saving ? 'Saving…' : notSaved ? 'Retry' : saveLabel}
          {!saving && pendingCount > 0 && ` (${pendingCount})`}
        </Button>
      </div>
      <div aria-live="assertive">
        {notSaved && (
          <p
            role="alert"
            className="text-destructive mt-2 flex items-start gap-2 text-sm"
            data-testid="not-saved"
          >
            <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              Not saved — retry. Your marks are still on this screen. {error?.message}
              {error && error.code !== 'NETWORK' && (
                <span className="text-muted-foreground block text-xs">Request ID: {error.requestId}</span>
              )}
            </span>
          </p>
        )}
        {phase === 'refused' && error && (
          <p role="alert" className="text-destructive mt-2 flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>Not saved: {error.message}</span>
          </p>
        )}
        {phase === 'saved' && (
          <p role="status" className="mt-2 flex items-start gap-2 text-sm">
            {conflictCount > 0 ? (
              <>
                <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  Saved, except {conflictCount} {conflictCount === 1 ? 'row' : 'rows'} someone else changed
                  first. Choose what to keep for {conflictCount === 1 ? 'it' : 'them'} below.
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>Saved.</span>
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/** Ask before leaving (in-app or closing the tab) while there are unsaved marks. */
export function UnsavedChangesGuard({ when }: { when: boolean }) {
  const blocker = useBlocker(when);
  useEffect(() => {
    if (!when) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [when]);
  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(o) => !o && blocker.reset?.()}
      title="Leave without saving?"
      description="You have changes on this screen that are not saved. If you leave now they are lost."
      confirmLabel="Leave without saving"
      cancelLabel="Stay"
      destructive
      onConfirm={() => blocker.proceed?.()}
    />
  );
}
