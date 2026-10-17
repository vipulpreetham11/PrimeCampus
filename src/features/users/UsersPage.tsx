import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { OneTimeSecretDialog } from '@/components/shared/OneTimeSecretDialog';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { roleLabel } from '@/contracts/roles';
import { DUTY_ROLES, type Membership, type SchoolUser } from '@/contracts/users';
import { formatDateTime } from '@/lib/dates';
import { handleSaveError } from '@/lib/save-feedback';
import { useSessionSelector } from '@/lib/session/store';
import { AddRoleDialog } from './AddRoleDialog';
import { CreateLoginDialog } from './CreateLoginDialog';
import {
  resetLoginPassword,
  useDisableMembership,
  useSchoolUsers,
  useSetAdmissionsDuty,
  useSetLoginStatus,
  type IssuedPassword,
  useRefreshAfterLoginChange,
} from './hooks';

type Pending =
  | { kind: 'disable-role'; user: SchoolUser; membership: Membership }
  | { kind: 'reset'; user: SchoolUser }
  | { kind: 'status'; user: SchoolUser; active: boolean }
  | null;

function linkedRecords(u: SchoolUser): string {
  const parts = [
    u.staff && `Staff: ${u.staff.name}`,
    u.guardian && `Guardian: ${u.guardian.name}`,
    u.student && `Student: ${u.student.name}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Not linked to a record';
}

function DutySwitch({ m, onError }: { m: Membership; onError: (e: unknown) => void }) {
  const set = useSetAdmissionsDuty();
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <Switch
        checked={m.admissions_duty}
        disabled={set.isPending || m.status !== 'active'}
        aria-label={`Admissions duty for ${roleLabel(m.role)}`}
        onCheckedChange={async (on) => {
          try {
            await set.mutateAsync({ membershipId: m.membership_id, on, version: m.version });
            toast.success(on ? 'Admissions duty given.' : 'Admissions duty removed.');
          } catch (e) {
            // CONFLICT: the list is reloaded by the mutation's invalidation; tell the user.
            onError(handleSaveError(e));
          }
        }}
      />
      Admissions
    </label>
  );
}

export function UsersPage() {
  const me = useSessionSelector((s) => s.account?.accountId);
  const users = useSchoolUsers();
  const refresh = useRefreshAfterLoginChange();
  const disableRole = useDisableMembership();
  const setStatus = useSetLoginStatus();
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedPassword | null>(null);
  const [error, setError] = useState<unknown>(null);

  const f = filter.trim().toLowerCase();
  const shown = (users.data ?? []).filter(
    (u) => !f || u.username.includes(f) || (u.display_name ?? '').toLowerCase().includes(f),
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Users & logins"
        description="Everyone with a role in this school. Disabling a role here does not affect their other schools."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              Add role to existing login
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              Create login
            </Button>
          </>
        }
      />
      <div className="max-w-sm space-y-1">
        <Label htmlFor="user-filter">Filter</Label>
        <Input
          id="user-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Name or username"
        />
      </div>
      <ErrorText error={error} />
      <DataState query={users} isEmpty={(d) => d.length === 0} emptyTitle="No users yet">
        {() => (
          <ul className="space-y-2" aria-label="Users">
            {shown.length === 0 && (
              <li className="text-muted-foreground text-sm">No user matches “{filter}”.</li>
            )}
            {shown.map((u) => (
              <li key={u.account_id}>
                <Card data-testid={`user-${u.username}`}>
                  <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1 text-sm">
                      <p className="font-medium">
                        {u.display_name ?? u.username}{' '}
                        <span className="text-muted-foreground font-mono font-normal">{u.username}</span>
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        {u.memberships.map((m) => (
                          <span
                            key={m.membership_id}
                            className="flex items-center gap-2 rounded-md border px-2 py-1"
                          >
                            <Badge variant={m.status === 'active' ? 'secondary' : 'outline'}>
                              {roleLabel(m.role)}
                              {m.status !== 'active' ? ' — disabled' : ''}
                            </Badge>
                            {(DUTY_ROLES as readonly string[]).includes(m.role) && m.status === 'active' && (
                              <DutySwitch m={m} onError={setError} />
                            )}
                          </span>
                        ))}
                      </div>
                      <p className="text-muted-foreground">{linkedRecords(u)}</p>
                      <p className="text-muted-foreground">
                        {u.status !== 'active' && (
                          <span className="text-destructive">Login {u.status}. </span>
                        )}
                        {u.must_change_password && <span>Must change password at next sign-in. </span>}
                        Last seen: {u.last_seen_at ? formatDateTime(u.last_seen_at) : 'never'}
                      </p>
                    </div>
                    {u.account_id !== me && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="outline" aria-label={`Actions for ${u.username}`}>
                            <MoreHorizontal /> Actions
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-60">
                          <DropdownMenuLabel>{u.username}</DropdownMenuLabel>
                          <DropdownMenuItem onSelect={() => setPending({ kind: 'reset', user: u })}>
                            Reset password
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              setPending({ kind: 'status', user: u, active: u.status !== 'active' })
                            }
                          >
                            {u.status === 'active' ? 'Disable login' : 'Enable login'}
                          </DropdownMenuItem>
                          {u.memberships.some((m) => m.status === 'active') && <DropdownMenuSeparator />}
                          {u.memberships
                            .filter((m) => m.status === 'active')
                            .map((m) => (
                              <DropdownMenuItem
                                key={m.membership_id}
                                onSelect={() => {
                                  setReason('');
                                  setPending({ kind: 'disable-role', user: u, membership: m });
                                }}
                              >
                                Disable {roleLabel(m.role)} role here
                              </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </DataState>

      {creating && <CreateLoginDialog open onOpenChange={setCreating} onIssued={setIssued} />}
      {adding && <AddRoleDialog open onOpenChange={setAdding} />}

      <ConfirmDialog
        open={pending?.kind === 'disable-role'}
        onOpenChange={(o) => !o && setPending(null)}
        title={
          pending?.kind === 'disable-role'
            ? `Disable ${roleLabel(pending.membership.role)} role for ${pending.user.username}?`
            : ''
        }
        description={
          <span className="block space-y-2">
            <span className="block">
              They are signed out of this role immediately. Their other roles and schools keep working.
              History they created is kept.
            </span>
            <span className="block">
              <Label htmlFor="disable-reason" className="mb-1 block">
                Reason (required)
              </Label>
              <Textarea id="disable-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </span>
          </span>
        }
        confirmLabel="Disable role"
        destructive
        busy={busy}
        onConfirm={async () => {
          if (pending?.kind !== 'disable-role') return;
          if (!reason.trim()) {
            toast.error('Enter a reason.');
            return;
          }
          setBusy(true);
          setError(null);
          try {
            await disableRole.mutateAsync({
              membershipId: pending.membership.membership_id,
              reason: reason.trim(),
            });
            toast.success('Role disabled.');
          } catch (e) {
            setError(handleSaveError(e));
          } finally {
            setBusy(false);
            setPending(null);
          }
        }}
      />

      <ConfirmDialog
        open={pending?.kind === 'reset'}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.kind === 'reset' ? `Reset the password for ${pending.user.username}?` : ''}
        description="They are signed out everywhere and must sign in with a new temporary password, then choose their own."
        confirmLabel="Reset password"
        busy={busy}
        onConfirm={async () => {
          if (pending?.kind !== 'reset') return;
          setBusy(true);
          setError(null);
          try {
            setIssued(await resetLoginPassword(pending.user.account_id, pending.user.username));
            refresh(); // "must change password" and last-seen changed
          } catch (e) {
            setError(handleSaveError(e));
          } finally {
            setBusy(false);
            setPending(null);
          }
        }}
      />

      <ConfirmDialog
        open={pending?.kind === 'status'}
        onOpenChange={(o) => !o && setPending(null)}
        title={
          pending?.kind === 'status'
            ? `${pending.active ? 'Enable' : 'Disable'} the login ${pending.user.username}?`
            : ''
        }
        description={
          pending?.kind === 'status' && !pending.active
            ? 'They cannot sign in at all until it is enabled again. If the login is also used in a school you don’t manage, you’ll be asked to disable their role here instead.'
            : 'They can sign in again with their current password.'
        }
        confirmLabel={pending?.kind === 'status' && pending.active ? 'Enable login' : 'Disable login'}
        destructive={pending?.kind === 'status' && !pending.active}
        busy={busy}
        onConfirm={async () => {
          if (pending?.kind !== 'status') return;
          setBusy(true);
          setError(null);
          try {
            await setStatus.mutateAsync({ accountId: pending.user.account_id, active: pending.active });
            toast.success(pending.active ? 'Login enabled.' : 'Login disabled.');
          } catch (e) {
            // FORBIDDEN (login used in another school) is shown with the server's message as-is.
            setError(handleSaveError(e));
          } finally {
            setBusy(false);
            setPending(null);
          }
        }}
      />

      <OneTimeSecretDialog
        secret={issued?.temporaryPassword ?? null}
        username={issued?.username ?? ''}
        onClose={() => setIssued(null)}
      />
    </div>
  );
}
