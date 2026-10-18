import { useState } from 'react';
import { toast } from 'sonner';
import { ErrorText } from '@/components/shared/ErrorText';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { roleLabel } from '@/contracts/roles';
import { DUTY_ROLES, GRANTABLE_ROLES, type FoundSchoolAccount } from '@/contracts/users';
import { handleSaveError } from '@/lib/save-feedback';
import { useFindSchoolAccount, useGrantMembership } from './hooks';

/**
 * Add a role to an EXISTING login (brief §3.3). find_school_account answers `null` both when the
 * username doesn't exist and when it belongs to another organization — the UI says only that no
 * login was found in this organization.
 */
export function AddRoleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const find = useFindSchoolAccount();
  const grant = useGrantMembership();
  const [username, setUsername] = useState('');
  const [found, setFound] = useState<FoundSchoolAccount | undefined>(undefined);
  const [role, setRole] = useState('');
  const [duty, setDuty] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const activeHere = new Set(
    (found?.roles_here ?? []).filter((r) => r.status === 'active').map((r) => r.role),
  );
  const dutyAllowed = (DUTY_ROLES as readonly string[]).includes(role);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a role to an existing login</DialogTitle>
          <DialogDescription>
            For example, a teacher who is also a parent here. The person keeps one username and password.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setFound(undefined);
            setRole('');
            if (!username.trim()) return;
            try {
              setFound(await find.mutateAsync(username));
            } catch (err) {
              setError(handleSaveError(err));
            }
          }}
        >
          <div className="flex-1 space-y-1">
            <Label htmlFor="find-username">Username</Label>
            <Input
              id="find-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <Button type="submit" variant="outline" disabled={find.isPending || !username.trim()}>
            {find.isPending ? 'Finding…' : 'Find'}
          </Button>
        </form>

        {found === null && (
          <p role="status" className="rounded-md border p-3 text-sm" data-testid="account-not-found">
            No login with that username in your organization.
          </p>
        )}
        {found && (
          <div className="space-y-4" data-testid="account-found">
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">{found.display_name ?? found.username}</p>
              <p className="text-muted-foreground font-mono">{found.username}</p>
              {found.status !== 'active' && <p className="text-destructive">This login is {found.status}.</p>}
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="text-muted-foreground">Roles here:</span>
                {found.roles_here.length === 0 && <span>none</span>}
                {found.roles_here.map((r) => (
                  <Badge key={r.membership_id} variant={r.status === 'active' ? 'secondary' : 'outline'}>
                    {roleLabel(r.role)}
                    {r.status !== 'active' ? ' (disabled)' : ''}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="grant-role">Role to add</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="grant-role" className="w-full">
                  <SelectValue placeholder="Choose a role" />
                </SelectTrigger>
                <SelectContent>
                  {GRANTABLE_ROLES.filter((r) => !activeHere.has(r)).map((r) => (
                    <SelectItem key={r} value={r}>
                      {roleLabel(r)}
                      {found.roles_here.some((x) => x.role === r) ? ' (re-enable)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {dutyAllowed && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={duty} onCheckedChange={(c) => setDuty(c === true)} /> Admissions duty
              </label>
            )}
            {role === 'parent' && (
              <p className="text-muted-foreground text-sm">
                After adding the Parent role, link the login to the guardian record from the student&apos;s
                profile so the right children appear.
              </p>
            )}
          </div>
        )}
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {found && (
            <Button
              disabled={!role || grant.isPending || found.status !== 'active'}
              onClick={async () => {
                setError(null);
                try {
                  await grant.mutateAsync({
                    accountId: found.account_id,
                    role,
                    admissionsDuty: dutyAllowed ? duty : null,
                  });
                  toast.success(`${roleLabel(role)} role added for ${found.username}.`);
                  onOpenChange(false);
                } catch (e) {
                  setError(handleSaveError(e));
                }
              }}
            >
              {grant.isPending ? 'Adding…' : 'Add role'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
