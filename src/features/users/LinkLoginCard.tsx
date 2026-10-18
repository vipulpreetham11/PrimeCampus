import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { ErrorText } from '@/components/shared/ErrorText';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { LoginRef } from '@/contracts/staff';
import { roleLabel } from '@/contracts/roles';
import { handleSaveError } from '@/lib/save-feedback';
import { useLinkAccount, useSchoolUsers } from './hooks';

const ROLE_FOR_KIND = {
  staff: ['owner', 'admin', 'principal', 'accountant', 'teacher'],
  guardian: ['parent'],
  student: ['student'],
} as const;

/**
 * Link / unlink a login to a staff, guardian or student record (link_account). Only rendered for
 * users.manage (the caller checks `can.link_login`). The server checks the login holds the matching
 * role here; its message is shown as-is when it refuses.
 */
export function LinkLoginCard({
  kind,
  recordId,
  login,
}: {
  kind: 'staff' | 'guardian' | 'student';
  recordId: string;
  login: LoginRef | null;
}) {
  const users = useSchoolUsers();
  const link = useLinkAccount();
  const [choice, setChoice] = useState('');
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const roles: readonly string[] = ROLE_FOR_KIND[kind];
  const candidates = (users.data ?? []).filter((u) =>
    u.memberships.some((m) => m.status === 'active' && roles.includes(m.role)),
  );

  const run = async (accountId: string | null) => {
    setError(null);
    try {
      await link.mutateAsync({ kind, recordId, accountId });
      toast.success(accountId ? 'Login linked.' : 'Login unlinked.');
      setChoice('');
    } catch (e) {
      setError(handleSaveError(e));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Login</CardTitle>
        <CardDescription>
          Linking lets this person see their own{' '}
          {kind === 'staff' ? 'staff' : kind === 'guardian' ? 'children’s' : 'student'} records when they sign
          in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {login ? (
          <div className="flex flex-wrap items-center justify-between gap-2" data-testid="linked-login">
            <p>
              Linked to <span className="font-mono font-medium">{login.username}</span>
              {login.status !== 'active' && <span className="text-muted-foreground"> ({login.status})</span>}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmUnlink(true)}
              disabled={link.isPending}
            >
              Unlink
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground">No login linked.</p>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1 space-y-1">
            <Label htmlFor={`link-${recordId}`}>{login ? 'Link a different login' : 'Link a login'}</Label>
            <Select value={choice} onValueChange={setChoice} disabled={users.isPending}>
              <SelectTrigger id={`link-${recordId}`} className="w-full">
                <SelectValue placeholder={users.isPending ? 'Loading logins…' : 'Choose a login'} />
              </SelectTrigger>
              <SelectContent>
                {candidates.length === 0 && (
                  <div className="text-muted-foreground p-2 text-sm">
                    No login here has the {roles.map(roleLabel).join(' / ')} role yet.
                  </div>
                )}
                {candidates.map((u) => (
                  <SelectItem key={u.account_id} value={u.account_id}>
                    {u.display_name ?? u.username} ({u.username})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" disabled={!choice || link.isPending} onClick={() => void run(choice)}>
            {link.isPending ? 'Linking…' : 'Link'}
          </Button>
        </div>
        <ErrorText error={error ?? users.error} />
      </CardContent>
      <ConfirmDialog
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        title="Unlink this login?"
        description="The login keeps its roles, but will no longer be connected to this record."
        confirmLabel="Unlink"
        destructive
        busy={link.isPending}
        onConfirm={async () => {
          await run(null);
          setConfirmUnlink(false);
        }}
      />
    </Card>
  );
}
