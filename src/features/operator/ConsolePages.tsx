import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { NavLink } from 'react-router';
import { Lock } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { ErrorText } from '@/components/shared/ErrorText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AuditEvent, AuthEvent, Maintenance, RetentionCleanup, Usage } from '@/contracts/operator';
import { roleLabel } from '@/contracts/roles';
import { addDays, daysBetween, formatDate, formatDateTime, schoolToday } from '@/lib/dates';
import { AppError, toAppError } from '@/lib/errors';
import { useSessionSelector } from '@/lib/session/store';
import { cn } from '@/lib/utils';
import {
  findAccountId,
  useAuditEvents,
  useAuthEvents,
  useMaintenance,
  useRunCleanup,
  useUsage,
  type AuditFilter,
  type AuthFilter,
} from './consoleHooks';
import { useOperatorSchools } from './hooks';

// Operator console (PRD §14): activity log, sign-ins & sessions, usage and maintenance. Shown only
// to an Operator account (the server checks the live grant on every call; raw logs are never shown
// to school roles). Times are shown in school time; date filters are whole IST days.

const TABS = [
  { to: '/operator/activity', label: 'Activity log' },
  { to: '/operator/sign-ins', label: 'Sign-ins & sessions' },
  { to: '/operator/usage', label: 'Usage' },
  { to: '/operator/maintenance', label: 'Maintenance' },
];

function ConsoleFrame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const isOperator = useSessionSelector((s) => s.account?.isOperator ?? false);
  if (!isOperator) {
    return (
      <div
        role="alert"
        className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center"
      >
        <Lock aria-hidden="true" className="text-muted-foreground" />
        <p className="font-medium">You don&apos;t have access to this</p>
        <p className="text-muted-foreground text-sm">The operator console is only for platform Operators.</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <nav aria-label="Operator console" className="-mx-1 overflow-x-auto">
        <ul className="flex min-w-max gap-1 px-1">
          {TABS.map((t) => (
            <li key={t.to}>
              <NavLink
                to={t.to}
                end
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
      <PageHeader title={title} description={description} />
      {children}
    </div>
  );
}

const ALL = '__all__';

function SchoolSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const schools = useOperatorSchools();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>School</Label>
      <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? null : v)}>
        <SelectTrigger id={id} className="min-h-11 w-full sm:w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All schools</SelectItem>
          {(schools.data ?? []).map((s) => (
            <SelectItem key={s.school_id} value={s.school_id}>
              {s.name} ({s.code})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function useSchoolNames(): Map<string, string> {
  const schools = useOperatorSchools();
  return useMemo(() => new Map((schools.data ?? []).map((s) => [s.school_id, s.name])), [schools.data]);
}

function DateRange({
  idPrefix,
  from,
  to,
  setFrom,
  setTo,
}: {
  idPrefix: string;
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
}) {
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-from`}>From</Label>
        <DateInput id={`${idPrefix}-from`} value={from} onChange={setFrom} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-to`}>To</Label>
        <DateInput id={`${idPrefix}-to`} value={to} onChange={setTo} />
      </div>
    </>
  );
}

function LoadMore({
  q,
}: {
  q: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown };
}) {
  if (!q.hasNextPage) return null;
  return (
    <Button variant="outline" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
      {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
    </Button>
  );
}

// ------------------------------------------------------------------ activity log (LOG-02)

export function ActivityLogPage() {
  const today = schoolToday();
  const [form, setForm] = useState({
    schoolId: null as string | null,
    username: '',
    action: '',
    entity: '',
    from: addDays(today, -6),
    to: today,
  });
  const [filter, setFilter] = useState<AuditFilter>({
    schoolId: null,
    actorId: null,
    actionPrefix: null,
    entityId: null,
    from: addDays(today, -6),
    to: today,
  });
  const [actorName, setActorName] = useState<string | null>(null);
  const [formError, setFormError] = useState<AppError | null>(null);
  const [notFound, setNotFound] = useState(false);
  const isOperator = useSessionSelector((s) => s.account?.isOperator ?? false);
  const query = useAuditEvents(filter, isOperator && !notFound);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  const apply = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setNotFound(false);
    let actorId: string | null = null;
    const username = form.username.trim();
    if (username) {
      try {
        actorId = await findAccountId(username);
      } catch (err) {
        setFormError(toAppError(err));
        return;
      }
      if (!actorId) {
        setNotFound(true);
        return;
      }
    }
    setActorName(username || null);
    setFilter({
      schoolId: form.schoolId,
      actorId,
      actionPrefix: form.action.trim() || null,
      entityId: form.entity.trim() || null,
      from: form.from || null,
      to: form.to || null,
    });
  };

  return (
    <ConsoleFrame
      title="Activity log"
      description="Business and access events, newest first. Details are redacted as stored."
    >
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => void apply(e)}
        aria-label="Filter the activity log"
      >
        <SchoolSelect
          id="audit-school"
          value={form.schoolId}
          onChange={(v) => setForm((f) => ({ ...f, schoolId: v }))}
        />
        <div className="grid gap-1.5">
          <Label htmlFor="audit-actor">Who (username)</Label>
          <Input
            id="audit-actor"
            className="min-h-11 w-full sm:w-44"
            value={form.username}
            autoComplete="off"
            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-action">Action starts with</Label>
          <Input
            id="audit-action"
            className="min-h-11 w-full sm:w-44"
            placeholder="e.g. salary."
            value={form.action}
            onChange={(e) => setForm((f) => ({ ...f, action: e.target.value }))}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-entity">Record id</Label>
          <Input
            id="audit-entity"
            className="min-h-11 w-full sm:w-44"
            value={form.entity}
            onChange={(e) => setForm((f) => ({ ...f, entity: e.target.value }))}
          />
        </div>
        <DateRange
          idPrefix="audit"
          from={form.from}
          to={form.to}
          setFrom={(v) => setForm((f) => ({ ...f, from: v }))}
          setTo={(v) => setForm((f) => ({ ...f, to: v }))}
        />
        <Button type="submit" className="min-h-11">
          Show
        </Button>
      </form>
      {notFound && (
        <p role="alert" className="text-sm">
          No account with the username “{form.username.trim()}”.
        </p>
      )}
      <ErrorText error={formError} />
      {!notFound && (
        <DataState
          query={{ ...query, data: query.data ? items : undefined }}
          isEmpty={(rows) => rows.length === 0}
          emptyTitle="No events for these filters"
        >
          {(rows) => (
            <div className="space-y-3">
              {actorName && <p className="text-muted-foreground text-sm">Showing actions by {actorName}.</p>}
              <ul className="space-y-2" data-testid="audit-events">
                {rows.map((e) => (
                  <AuditRow key={e.id} e={e} />
                ))}
              </ul>
              <LoadMore q={query} />
            </div>
          )}
        </DataState>
      )}
    </ConsoleFrame>
  );
}

function AuditRow({ e }: { e: AuditEvent }) {
  const [open, setOpen] = useState(false);
  const detail =
    e.detail && typeof e.detail === 'object' && Object.keys(e.detail).length > 0 ? e.detail : null;
  return (
    <li className="rounded-lg border p-3 text-sm" data-testid="audit-event">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-xs">{e.action}</span>
        {e.via_operator && <Badge variant="secondary">Via Operator</Badge>}
        <span className="text-muted-foreground ml-auto text-xs">{formatDateTime(e.occurred_at)}</span>
      </div>
      <p className="mt-1" data-testid="audit-actor">
        {e.actor_id ? (
          <>
            <span className="font-medium">{e.actor_name ?? e.actor_username ?? 'Unknown account'}</span>
            {e.actor_username && <span className="text-muted-foreground"> ({e.actor_username})</span>}
            {e.actor_role && <span className="text-muted-foreground"> · {roleLabel(e.actor_role)}</span>}
          </>
        ) : (
          <span className="text-muted-foreground">System (no account)</span>
        )}
        <span className="text-muted-foreground">
          {' '}
          · {e.school_name ?? (e.school_id ? 'Unknown school' : 'No school')}
        </span>
      </p>
      <p className="text-muted-foreground text-xs break-all">
        {e.entity_type}
        {e.entity_id ? ` · ${e.entity_id}` : ''}
        {e.operation_id ? ` · operation ${e.operation_id}` : ''}
      </p>
      {detail !== null && (
        <>
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            {open ? 'Hide details' : 'Show details'}
          </Button>
          {open && (
            <pre className="bg-muted mt-1 max-h-64 overflow-auto rounded-md p-2 text-xs break-all whitespace-pre-wrap">
              {JSON.stringify(detail, null, 2)}
            </pre>
          )}
        </>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ sign-ins & sessions (LOG-01)

const AUTH_EVENT_TEXT: Record<string, string> = {
  login: 'Signed in',
  logout: 'Signed out',
  session_revoked: 'Session ended by the system',
  password_changed: 'Password changed',
  password_reset: 'Password reset',
  account_provisioned: 'Account created',
  account_disabled: 'Account disabled',
  account_enabled: 'Account enabled',
  membership_granted: 'Role granted',
  membership_disabled: 'Role removed',
  context_selected: 'Chose a school / role',
  login_failed: 'Sign-in failed',
};

export function authEventText(event: string): string {
  return AUTH_EVENT_TEXT[event] ?? event.replace(/_/g, ' ');
}

export function SignInsPage() {
  const today = schoolToday();
  const [form, setForm] = useState({
    schoolId: null as string | null,
    username: '',
    from: addDays(today, -6),
    to: today,
  });
  const [filter, setFilter] = useState<AuthFilter>({
    accountId: null,
    schoolId: null,
    from: addDays(today, -6),
    to: today,
  });
  const [notFound, setNotFound] = useState(false);
  const [formError, setFormError] = useState<AppError | null>(null);
  const isOperator = useSessionSelector((s) => s.account?.isOperator ?? false);
  const query = useAuthEvents(filter, isOperator && !notFound);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const usage = useUsage(filter.from ?? today, filter.to ?? today, filter.schoolId, isOperator);
  const schoolNames = useSchoolNames();

  const apply = async (e: FormEvent) => {
    e.preventDefault();
    setNotFound(false);
    setFormError(null);
    let accountId: string | null = null;
    if (form.username.trim()) {
      try {
        accountId = await findAccountId(form.username.trim());
      } catch (err) {
        setFormError(toAppError(err));
        return;
      }
      if (!accountId) {
        setNotFound(true);
        return;
      }
    }
    setFilter({ accountId, schoolId: form.schoolId, from: form.from || null, to: form.to || null });
  };

  return (
    <ConsoleFrame
      title="Sign-ins & sessions"
      description="Sign-in, sign-out, reset and account events, and the app sessions seen in the range."
    >
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => void apply(e)}
        aria-label="Filter sign-ins"
      >
        <SchoolSelect
          id="auth-school"
          value={form.schoolId}
          onChange={(v) => setForm((f) => ({ ...f, schoolId: v }))}
        />
        <div className="grid gap-1.5">
          <Label htmlFor="auth-user">Username</Label>
          <Input
            id="auth-user"
            className="min-h-11 w-full sm:w-44"
            autoComplete="off"
            value={form.username}
            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
          />
        </div>
        <DateRange
          idPrefix="auth"
          from={form.from}
          to={form.to}
          setFrom={(v) => setForm((f) => ({ ...f, from: v }))}
          setTo={(v) => setForm((f) => ({ ...f, to: v }))}
        />
        <Button type="submit" className="min-h-11">
          Show
        </Button>
      </form>
      {notFound && (
        <p role="alert" className="text-sm">
          No account with the username “{form.username.trim()}”.
        </p>
      )}
      <ErrorText error={formError} />
      <section aria-labelledby="auth-heading" className="space-y-2">
        <h2 id="auth-heading" className="text-base font-semibold">
          Account events
        </h2>
        {!notFound && (
          <DataState
            query={{ ...query, data: query.data ? items : undefined }}
            isEmpty={(rows) => rows.length === 0}
            emptyTitle="No account events in this range"
          >
            {(rows) => (
              <div className="space-y-3">
                <ul className="space-y-2" data-testid="auth-events">
                  {rows.map((e) => (
                    <AuthRow
                      key={e.id}
                      e={e}
                      school={e.school_id ? (schoolNames.get(e.school_id) ?? null) : null}
                    />
                  ))}
                </ul>
                <LoadMore q={query} />
              </div>
            )}
          </DataState>
        )}
      </section>
      <section aria-labelledby="sessions-heading" className="space-y-2">
        <h2 id="sessions-heading" className="text-base font-semibold">
          App sessions
        </h2>
        <p className="text-muted-foreground text-xs">
          Last seen is the last time the app reached the server — not a sign-out time. Closing a tab is not
          recorded. Up to 200 sessions are listed.
        </p>
        <DataState
          query={usage}
          isEmpty={(u) => u.sessions.length === 0}
          emptyTitle="No sessions seen in this range"
        >
          {(u) => <SessionsList sessions={u.sessions} />}
        </DataState>
      </section>
    </ConsoleFrame>
  );
}

function AuthRow({ e, school }: { e: AuthEvent; school: string | null }) {
  return (
    <li className="rounded-lg border p-3 text-sm" data-testid="auth-event">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-medium">{authEventText(e.event)}</span>
        {e.outcome === 'failure' && <Badge variant="destructive">Failed</Badge>}
        <span className="text-muted-foreground ml-auto text-xs">{formatDateTime(e.occurred_at)}</span>
      </div>
      <p>
        {e.username ?? <span className="text-muted-foreground">No verified account</span>}
        {school && <span className="text-muted-foreground"> · {school}</span>}
      </p>
      <p className="text-muted-foreground text-xs break-all">
        {[e.device_class, e.ip, e.user_agent, e.auth_session_id ? `session ${e.auth_session_id}` : null]
          .filter(Boolean)
          .join(' · ') || 'No device information'}
      </p>
    </li>
  );
}

function SessionsList({ sessions }: { sessions: Usage['sessions'] }) {
  return (
    <ul className="space-y-2" data-testid="app-sessions">
      {sessions.map((s, i) => (
        <li key={`${s.account}-${s.started}-${i}`} className="rounded-lg border p-3 text-sm">
          <p className="font-medium">{s.account}</p>
          <p className="text-muted-foreground text-xs">
            Started {formatDateTime(s.started)} · last seen {formatDateTime(s.last_seen)}
            {s.device_class ? ` · ${s.device_class}` : ''}
          </p>
          <p className="text-xs">
            {s.ended
              ? `Ended ${formatDateTime(s.ended)}${s.end_reason ? ` (${s.end_reason.replace(/_/g, ' ')})` : ''}`
              : 'Not ended (open or tab closed)'}
          </p>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ usage (LOG-03)

export function UsagePage() {
  const today = schoolToday();
  const [from, setFrom] = useState(addDays(today, -29));
  const [to, setTo] = useState(today);
  const [schoolId, setSchoolId] = useState<string | null>(null);
  const isOperator = useSessionSelector((s) => s.account?.isOperator ?? false);
  const valid = !!from && !!to && daysBetween(from, to) >= 0;
  const query = useUsage(from, to, schoolId, isOperator && valid);
  return (
    <ConsoleFrame
      title="Usage"
      description="Daily active accounts, page views and sign-ins over a date range."
    >
      <div className="flex flex-wrap items-end gap-3">
        <SchoolSelect id="usage-school" value={schoolId} onChange={setSchoolId} />
        <DateRange idPrefix="usage" from={from} to={to} setFrom={setFrom} setTo={setTo} />
      </div>
      {!valid ? (
        <p className="text-destructive text-sm" role="alert">
          Choose a “To” date on or after “From”.
        </p>
      ) : (
        <DataState query={query}>{(u) => <UsageView u={u} />}</DataState>
      )}
    </ConsoleFrame>
  );
}

function UsageView({ u }: { u: Usage }) {
  return (
    <div className="space-y-3" data-testid="usage">
      <p className="text-muted-foreground text-xs" role="note">
        {u.note} Page views and active accounts are estimates; several tabs are not counted several times.
      </p>
      <p className="text-sm">
        Sign-ins in this range:{' '}
        <span className="font-semibold" data-testid="usage-logins">
          {u.logins}
        </span>
      </p>
      {u.daily.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
          No activity recorded in this range.
        </p>
      ) : (
        <table className="w-full max-w-xl text-sm" data-testid="usage-daily">
          <thead>
            <tr className="border-b text-left">
              <th className="py-2 pr-3 font-medium">Day</th>
              <th className="py-2 pr-3 text-right font-medium">Active accounts (est.)</th>
              <th className="py-2 pr-3 text-right font-medium">Page views (est.)</th>
            </tr>
          </thead>
          <tbody>
            {u.daily.map((d) => (
              <tr key={d.day} className="border-b">
                <td className="py-1.5 pr-3">{formatDate(d.day)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{d.active_accounts}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{d.page_views}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ maintenance

const RETENTION_TEXT: Record<string, string> = {
  telemetry_days: 'Browser activity events',
  usage_daily_days: 'Daily usage totals',
  auth_events_days: 'Sign-in and account history',
};

/** pg_cron '0 21 * * *' (UTC) is 02:30 IST the next day. */
export function scheduleText(cron: string): string {
  return cron === '0 21 * * *' ? 'Daily at 02:30 IST' : `Cron (UTC): ${cron}`;
}

export function cleanupText(r: Record<string, unknown> | RetentionCleanup): string {
  const n = (k: string) =>
    typeof (r as Record<string, unknown>)[k] === 'number' ? (r as Record<string, number>)[k] : 0;
  return `${n('telemetry_deleted')} activity events, ${n('usage_daily_deleted')} daily totals, ${n(
    'auth_events_deleted',
  )} sign-in records removed; ${n('sessions_expired')} idle sessions ended`;
}

export function MaintenancePage() {
  const isOperator = useSessionSelector((s) => s.account?.isOperator ?? false);
  const query = useMaintenance(isOperator);
  return (
    <ConsoleFrame title="Maintenance" description="Log retention and the daily clean-up job.">
      <DataState query={query}>{(m) => <MaintenanceView m={m} />}</DataState>
    </ConsoleFrame>
  );
}

function MaintenanceView({ m }: { m: Maintenance }) {
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<RetentionCleanup | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const run = useRunCleanup();
  return (
    <div className="space-y-4" data-testid="maintenance">
      <section className="space-y-1">
        <h2 className="text-base font-semibold">Daily clean-up</h2>
        <p className="text-sm" data-testid="maintenance-schedule">
          {m.scheduled
            ? m.schedule.map((j) => `${scheduleText(j.schedule)}${j.active ? '' : ' (paused)'}`).join('; ')
            : 'Not scheduled on this database — use Run now.'}
        </p>
        <p className="text-muted-foreground text-xs">
          Removes old browser activity, daily totals and sign-in history past their retention, and ends app
          sessions idle for 30 days (those users simply sign in again). Business records and the activity log
          are never removed.
        </p>
        <p className="text-sm">Open app sessions: {m.open_sessions}</p>
        <Button onClick={() => setConfirm(true)} disabled={run.isPending}>
          Run now
        </Button>
        {result && (
          <p role="status" className="rounded-md border p-2 text-sm" data-testid="cleanup-result">
            Done: {cleanupText(result)}.
          </p>
        )}
        <ErrorText error={error} />
      </section>
      <section className="space-y-1">
        <h2 className="text-base font-semibold">Retention</h2>
        <ul className="text-sm">
          {m.retention.map((r) => (
            <li key={r.key}>
              {RETENTION_TEXT[r.key] ?? r.key}: kept {r.days} days
            </li>
          ))}
        </ul>
      </section>
      <section className="space-y-1">
        <h2 className="text-base font-semibold">Recent runs</h2>
        {m.runs.length === 0 ? (
          <p className="text-muted-foreground text-sm">No runs recorded yet.</p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="maintenance-runs">
            {m.runs.map((r) => (
              <li key={r.ran_at} className="rounded-md border p-2">
                <span className="font-medium">{formatDateTime(r.ran_at)}</span> ·{' '}
                {r.trigger === 'operator' ? 'Run by an Operator' : 'Scheduled'} — {cleanupText(r.result)}
              </li>
            ))}
          </ul>
        )}
      </section>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Run the clean-up now?"
        description="Old logs past their retention are deleted and sessions idle for 30 days are ended. This can't be undone."
        confirmLabel="Run now"
        busy={run.isPending}
        onConfirm={() => {
          setError(null);
          run.mutate(undefined, {
            onSuccess: (r) => {
              setResult(r);
              setConfirm(false);
            },
            onError: (e) => {
              setError(toAppError(e));
              setConfirm(false);
            },
          });
        }}
      />
    </div>
  );
}
