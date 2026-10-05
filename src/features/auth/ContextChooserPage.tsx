import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronRight, School, UserRound } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { roleLabel } from '@/contracts/roles';
import type { AvailableContext } from '@/contracts/session';
import { chooseContext, logout } from '@/lib/session/session';
import { useSession } from '@/lib/session/store';
import { useOperatorSchools } from '@/features/operator/hooks';

function ChoiceButton({
  title,
  subtitle,
  current,
  disabled,
  onClick,
  testId,
}: {
  title: string;
  subtitle?: string;
  current?: boolean;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="bg-background hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        {subtitle && <span className="text-muted-foreground block text-sm">{subtitle}</span>}
      </span>
      {current && <Badge variant="outline">Current</Badge>}
      <ChevronRight aria-hidden="true" className="text-muted-foreground size-4" />
    </button>
  );
}

function OperatorSchools({
  busy,
  onPick,
  currentSchoolId,
}: {
  busy: boolean;
  onPick: (id: string) => void;
  currentSchoolId?: string;
}) {
  const query = useOperatorSchools();
  const [filter, setFilter] = useState('');
  return (
    <DataState
      query={query}
      isEmpty={(d) => d.length === 0}
      emptyTitle="No schools yet"
      emptyDescription="Create the first school in School onboarding."
    >
      {(schools) => {
        const f = filter.trim().toLowerCase();
        const shown = f
          ? schools.filter((s) => `${s.name} ${s.code} ${s.organization_name}`.toLowerCase().includes(f))
          : schools;
        return (
          <div className="space-y-2">
            {schools.length > 6 && (
              <Input
                aria-label="Search schools"
                placeholder="Search schools"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}
            {shown.map((s) => (
              <ChoiceButton
                key={s.school_id}
                testId={`operator-school-${s.code}`}
                title={s.name}
                subtitle={`${s.organization_name} · code ${s.code}${s.status !== 'active' ? ` · ${s.status}` : ''}`}
                current={s.school_id === currentSchoolId}
                disabled={busy}
                onClick={() => onPick(s.school_id)}
              />
            ))}
            {shown.length === 0 && (
              <p className="text-muted-foreground text-sm">No school matches “{filter}”.</p>
            )}
          </div>
        );
      }}
    </DataState>
  );
}

function ContextOptions({
  ctx,
  busy,
  currentMembership,
  currentStudent,
  onPick,
}: {
  ctx: AvailableContext;
  busy: boolean;
  currentMembership: string | null;
  currentStudent: string | null;
  onPick: (membershipId: string, studentId?: string) => void;
}) {
  const label = `${roleLabel(ctx.role)} — ${ctx.school_name}`;
  if (ctx.role !== 'parent') {
    return (
      <ChoiceButton
        testId={`context-${ctx.role}`}
        title={label}
        current={currentMembership === ctx.membership_id}
        disabled={busy}
        onClick={() => onPick(ctx.membership_id)}
      />
    );
  }
  const children = ctx.children ?? [];
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      {children.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
          No children are linked to this login yet. Contact the school office.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {children.map((child) => (
            <ChoiceButton
              key={child.student_id}
              testId={`child-${child.student_id}`}
              title={child.name}
              subtitle={`${ctx.school_name} · ${child.class_section ?? 'Class not assigned'}`}
              current={currentMembership === ctx.membership_id && currentStudent === child.student_id}
              disabled={busy}
              onClick={() => onPick(ctx.membership_id, child.student_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ContextChooserPage() {
  const s = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const isOperator = s.account?.isOperator ?? false;
  const current = s.context;
  const currentMembership = current
    ? (s.contexts.find((c) => c.school_id === current.school_id && c.role === current.role)?.membership_id ??
      null)
    : null;

  const pick = async (choice: Parameters<typeof chooseContext>[0]) => {
    setBusy(true);
    setError(null);
    try {
      await chooseContext(choice);
      navigate('/dashboard', { replace: true });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const nothing = s.contexts.length === 0 && !isOperator;

  return (
    <main className="bg-muted/30 min-h-dvh px-4 py-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-lg font-semibold tracking-tight">PrimeCampus</p>
            <h1 className="mt-2 text-xl font-semibold">Choose where to continue</h1>
            <p className="text-muted-foreground text-sm">
              Signed in as{' '}
              <span className="font-medium">{s.account?.displayName ?? s.account?.username}</span>
            </p>
          </div>
          <div className="flex gap-2">
            {current && (
              <Button variant="outline" size="sm" asChild>
                <Link to="/dashboard">Back</Link>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await logout();
                navigate('/sign-in', { replace: true });
              }}
            >
              Sign out
            </Button>
          </div>
        </div>

        <ErrorText error={error} />
        {busy && (
          <p role="status" className="text-muted-foreground text-sm">
            Switching…
          </p>
        )}

        {nothing && (
          <Card>
            <CardContent className="pt-6 text-sm">
              Your login has no active school roles. Contact your school office.
            </CardContent>
          </Card>
        )}

        {s.contexts.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <UserRound className="size-4" aria-hidden="true" /> Your roles
              </CardTitle>
              <CardDescription>Each role only shows what that role is allowed to see.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {s.contexts.map((ctx) => (
                <ContextOptions
                  key={ctx.membership_id}
                  ctx={ctx}
                  busy={busy}
                  currentMembership={current?.via_operator ? null : currentMembership}
                  currentStudent={current?.student_id ?? null}
                  onPick={(membershipId, studentId) => void pick({ membershipId, studentId })}
                />
              ))}
            </CardContent>
          </Card>
        )}

        {isOperator && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <School className="size-4" aria-hidden="true" /> Operator
              </CardTitle>
              <CardDescription>
                Open a school for support. Your actions are recorded as Operator, not as a school user.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button variant="outline" asChild>
                <Link to="/operator/onboarding" data-testid="operator-console">
                  School onboarding
                </Link>
              </Button>
              <OperatorSchools
                busy={busy}
                currentSchoolId={current?.via_operator ? current.school_id : undefined}
                onPick={(id) => void pick({ operatorSchoolId: id })}
              />
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
