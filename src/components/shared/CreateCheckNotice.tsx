import { CloudOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CreateCheck } from '@/lib/create-check';

/** What the screen knows after an uncertain create failure (see useCreateCheck). */
export function CreateCheckNotice({ check }: { check: CreateCheck }) {
  if (check.state === 'checking') {
    return (
      <p
        role="status"
        className="flex items-start gap-2 rounded-md border p-3 text-sm"
        data-testid="create-check"
      >
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />
        Not confirmed — checking…
      </p>
    );
  }
  if (check.state === 'not_saved') {
    return (
      <p
        role="alert"
        className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border p-3 text-sm"
        data-testid="create-check"
      >
        Wasn&apos;t saved — try again.
      </p>
    );
  }
  if (check.state === 'unconfirmed') {
    return (
      <div
        role="alert"
        className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm"
        data-testid="create-check"
      >
        <p className="text-destructive flex items-start gap-2">
          <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Not confirmed — we couldn&apos;t check whether it was saved. Check your connection, then check
          again.
        </p>
        <Button size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={check.checkAgain}>
          Check again
        </Button>
      </div>
    );
  }
  return null;
}
