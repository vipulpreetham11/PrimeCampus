import { useId, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { CloudOff, Search } from 'lucide-react';
import { ErrorText } from '@/components/shared/ErrorText';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Capability } from '@/contracts/capabilities';
import type { PaymentState } from '@/contracts/fees';
import type { StudentListItem } from '@/contracts/students';
import { useSetupSnapshot } from '@/features/setup/hooks';
import type { AppError } from '@/lib/errors';
import { useCan, useCanAny } from '@/lib/scope';
import { useSessionSelector } from '@/lib/session/store';
import { cn } from '@/lib/utils';
import { useStudentSearch } from './hooks';
import { PAYMENT_STATE_LABELS } from './labels';

// ------------------------------------------------------------------ layout
const TABS: { to: string; label: string; anyOf: Capability[] }[] = [
  { to: '/fees/collect', label: 'Collect payment', anyOf: ['fees.manage'] },
  { to: '/fees/invoices', label: 'Invoices', anyOf: ['fees.manage'] },
  { to: '/fees/cheques', label: 'Cheques', anyOf: ['fees.read'] },
  { to: '/fees/exceptions', label: 'Payment exceptions', anyOf: ['fees.read'] },
  { to: '/fees/concessions', label: 'Concessions', anyOf: ['fees.read'] },
  { to: '/fees/day-book', label: 'Day book', anyOf: ['fees.read'] },
  { to: '/fees/reports', label: 'Collection report', anyOf: ['fees.read'] },
  { to: '/fees/dues', label: 'Dues', anyOf: ['fees.read'] },
  { to: '/fees/setup', label: 'Fee setup', anyOf: ['fees.read'] },
];

/** Fee area tabs (capability-driven) above every fee page; hidden when printing. */
export function FeesLayout() {
  const caps = useSessionSelector((s) => s.context?.capabilities ?? []);
  const { pathname } = useLocation();
  const tabs = TABS.filter((t) => t.anyOf.some((c) => caps.includes(c)));
  const onReceipt = pathname.startsWith('/fees/receipts/');
  return (
    <div>
      {!onReceipt && (
        <nav aria-label="Fee sections" className="-mx-1 mb-4 overflow-x-auto print:hidden">
          <ul className="flex min-w-max gap-1 px-1">
            {tabs.map((t) => (
              <li key={t.to}>
                <NavLink
                  to={t.to}
                  className={({ isActive }) =>
                    cn(
                      'inline-block rounded-md border px-3 py-1.5 text-sm whitespace-nowrap',
                      isActive
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'bg-background hover:bg-accent',
                    )
                  }
                >
                  {t.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <Outlet />
    </div>
  );
}

/** "/fees": the accountant's main screen when they can collect, otherwise the dues report. */
export function useFeesHome(): string {
  return useCan('fees.manage') ? '/fees/collect' : '/fees/dues';
}

// ------------------------------------------------------------------ small pieces
export function PaymentStateBadge({ state }: { state: PaymentState }) {
  const variant = state === 'paid' ? 'secondary' : state === 'cancelled' ? 'outline' : 'default';
  return (
    <Badge variant={variant} data-testid="payment-state">
      {PAYMENT_STATE_LABELS[state]}
    </Badge>
  );
}

export function OverdueBadge() {
  return (
    <Badge variant="destructive" data-testid="overdue">
      Overdue
    </Badge>
  );
}

/** Label + value pair used in summaries. */
export function Figure({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * After an uncertain failure of a money action: the server may or may not have done it. The user
 * checks the statement, then re-sends the SAME request (same operation id) or discards it.
 */
export function UnconfirmedNotice({
  error,
  onRetry,
  onDiscard,
  busy,
  what = 'payment',
  children,
}: {
  error: AppError;
  onRetry: () => void;
  onDiscard: () => void;
  busy: boolean;
  what?: string;
  children?: ReactNode;
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  return (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-amber-600/60 bg-amber-50 p-3 text-sm dark:bg-amber-950/30"
      data-testid="unconfirmed"
    >
      <p className="flex items-start gap-2 font-medium">
        <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        Not confirmed — check the statement before trying again.
      </p>
      <p>
        We don&apos;t know whether this {what} was saved. Trying again is safe: it sends the same {what}, and the
        server never saves it twice.
      </p>
      {error.code !== 'NETWORK' && error.code !== 'CONFLICT' && <ErrorText error={error} />}
      {children}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onRetry} disabled={busy}>
          {busy ? 'Trying again…' : `Try again (same ${what})`}
        </Button>
        {!confirmDiscard ? (
          <Button size="sm" variant="outline" onClick={() => setConfirmDiscard(true)} disabled={busy}>
            Discard
          </Button>
        ) : (
          <Button size="sm" variant="destructive" onClick={onDiscard} disabled={busy}>
            The statement doesn&apos;t show it — discard
          </Button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ year select
export function YearSelect({
  value,
  onChange,
  id,
}: {
  value: string | null;
  onChange: (yearId: string) => void;
  id?: string;
}) {
  const snapshot = useSetupSnapshot(null);
  const years = snapshot.data?.academic_years ?? [];
  const autoId = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id ?? autoId}>Academic year</Label>
      <Select value={value ?? ''} onValueChange={onChange}>
        <SelectTrigger id={id ?? autoId} className="w-full sm:w-44" aria-label="Academic year">
          <SelectValue placeholder={snapshot.isPending ? 'Loading…' : 'Choose a year'} />
        </SelectTrigger>
        <SelectContent>
          {years.map((y) => (
            <SelectItem key={y.id} value={y.id}>
              {y.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ------------------------------------------------------------------ student picker
/** Find a student by name start or admission number (needs students.read_all). */
export function StudentPicker({
  onPick,
  label = 'Find student',
  autoFocus,
}: {
  onPick: (s: StudentListItem) => void;
  label?: string;
  autoFocus?: boolean;
}) {
  const canSearch = useCanAny('students.read_all');
  const [text, setText] = useState('');
  const query = useStudentSearch(text);
  const inputId = useId();
  if (!canSearch) {
    return (
      <p className="text-muted-foreground text-sm">
        Your role can&apos;t search students. Open a student from the Dues report or the Day book.
      </p>
    );
  }
  const items = query.data?.items ?? [];
  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="relative">
        <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" aria-hidden="true" />
        <Input
          id={inputId}
          value={text}
          autoFocus={autoFocus}
          autoComplete="off"
          placeholder="Name or admission number"
          className="pl-9"
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {text.trim().length >= 2 && (
        <div aria-live="polite">
          {query.isPending ? (
            <p className="text-muted-foreground text-sm">Searching…</p>
          ) : query.isError ? (
            <ErrorText error={query.error} />
          ) : items.length === 0 ? (
            <p className="text-muted-foreground text-sm">No student matches “{text.trim()}”.</p>
          ) : (
            <ul className="divide-y rounded-md border" data-testid="student-results">
              {items.map((s) => (
                <li key={s.student_id}>
                  <button
                    type="button"
                    className="hover:bg-accent focus-visible:bg-accent w-full px-3 py-2 text-left text-sm"
                    onClick={() => {
                      onPick(s);
                      setText('');
                    }}
                  >
                    <span className="block font-medium">{s.name}</span>
                    <span className="text-muted-foreground block text-xs break-all">
                      {s.admission_no}
                      {s.class ? ` · ${s.class} ${s.section ?? ''}` : ' · Class not set'}
                      {s.status !== 'active' ? ` · ${s.status}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
