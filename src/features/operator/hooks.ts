import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountKeys } from '@/contracts/query-keys';
import { invokeAccounts, type MembershipGrant } from '@/lib/edge';
import { AppError, isAppError, newRequestId } from '@/lib/errors';
import { opCreateSchool, opFindAccount, opListSchools } from '@/lib/rpc';
import { useSessionSelector } from '@/lib/session/store';

// Operator-only data (migration 1600). These RPCs take no context revision; the server checks
// the live Operator grant on every call.

export function useOperatorSchools(enabled = true) {
  const accountId = useSessionSelector((s) => s.account?.accountId ?? '');
  return useQuery({
    queryKey: accountKeys.operatorSchools(accountId),
    queryFn: ({ signal }) => opListSchools({ signal }),
    enabled: enabled && accountId !== '',
    staleTime: 60_000,
  });
}

export interface NewSchoolInput {
  organization: { id: string } | { name: string; code: string };
  school: { name: string; code: string; board?: string; city?: string; pincode?: string };
}

export function useCreateSchool() {
  const qc = useQueryClient();
  const accountId = useSessionSelector((s) => s.account?.accountId ?? '');
  return useMutation({
    mutationFn: (input: NewSchoolInput) =>
      opCreateSchool({ p_organization: input.organization, p_school: input.school }),
    onSettled: () => qc.invalidateQueries({ queryKey: accountKeys.operatorSchools(accountId) }),
  });
}

export type IssuedCredential = { username: string; temporaryPassword: string };

/**
 * Provision a school's first Admin. NOT a TanStack mutation on purpose: mutation results are
 * kept in the mutation cache, and a temporary password must never be cached (CLAUDE.md rule 10).
 * Returns null when the server replayed an already-completed operation (no new password).
 */
export async function provisionAdmin(input: {
  operationId: string;
  username: string;
  displayName: string;
  schoolId: string;
}): Promise<IssuedCredential | null> {
  const grant: MembershipGrant = { school_id: input.schoolId, role: 'admin' };
  const res = await invokeAccounts('provision', {
    operation_id: input.operationId,
    username: input.username,
    display_name: input.displayName,
    memberships: [grant],
  });
  if ('temporary_password' in res)
    return { username: res.username, temporaryPassword: res.temporary_password };
  return null;
}

/** Operator recovery for an existing login: look it up, then issue a new temporary password. */
export async function reissueTemporaryPassword(username: string): Promise<IssuedCredential> {
  const account = await opFindAccount({ p_username: username });
  if (!account) throw new AppError('NOT_FOUND', 'No account with that username.', newRequestId());
  const res = await invokeAccounts('reset_password', { account_id: account.account_id });
  return { username: account.username, temporaryPassword: res.temporary_password };
}

export function isDuplicate(e: unknown): boolean {
  return isAppError(e) && e.code === 'DUPLICATE';
}
