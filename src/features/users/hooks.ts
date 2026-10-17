import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeAccounts, type MembershipGrant } from '@/lib/edge';
import {
  disableMembership,
  findSchoolAccount,
  grantMembership,
  linkAccount,
  listSchoolUsers,
  setAdmissionsDuty,
} from '@/lib/rpc';
import { useScopedKey } from '@/lib/scope';

// School user management (brief §3, capability users.manage). Temporary passwords never go
// through TanStack Query (its caches keep results); see provisionLogin / resetLoginPassword.

export function useSchoolUsers(enabled = true) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('users'),
    queryFn: ({ signal }) => listSchoolUsers({}, { signal }),
    enabled,
    staleTime: 60_000,
  });
}

function useInvalidateUsers() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: key('users') });
  };
}

export function useFindSchoolAccount() {
  return useMutation({
    // A lookup triggered by a button; not cached (the answer depends on what was typed).
    mutationFn: (username: string) => findSchoolAccount({ p_username: username.trim().toLowerCase() }),
  });
}

export function useGrantMembership() {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (v: { accountId: string; role: string; admissionsDuty: boolean | null }) =>
      grantMembership({
        p_account_id: v.accountId,
        p_role: v.role,
        ...(v.admissionsDuty !== null ? { p_admissions_duty: v.admissionsDuty } : {}),
      }),
    onSettled: invalidate,
  });
}

export function useSetAdmissionsDuty() {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (v: { membershipId: string; on: boolean; version: number }) =>
      setAdmissionsDuty({ p_membership_id: v.membershipId, p_on: v.on, p_expected_version: v.version }),
    onSettled: invalidate,
  });
}

export function useDisableMembership() {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (v: { membershipId: string; reason: string }) =>
      disableMembership({ p_membership_id: v.membershipId, p_reason: v.reason }),
    onSettled: invalidate,
  });
}

export function useLinkAccount() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { kind: 'staff' | 'guardian' | 'student'; recordId: string; accountId: string | null }) =>
      linkAccount({
        p_kind: v.kind,
        p_record_id: v.recordId,
        ...(v.accountId ? { p_account_id: v.accountId } : {}),
      }),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: key('users') });
      const feature = v.kind === 'staff' ? 'staff' : v.kind === 'guardian' ? 'guardian' : 'student';
      void qc.invalidateQueries({ queryKey: key(feature, v.recordId) });
      if (v.kind === 'staff') void qc.invalidateQueries({ queryKey: key('staff-list') });
      if (v.kind === 'guardian') void qc.invalidateQueries({ queryKey: key('student') });
    },
  });
}

export function useSetLoginStatus() {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (v: { accountId: string; active: boolean }) =>
      invokeAccounts('set_status', { account_id: v.accountId, active: v.active }),
    onSettled: invalidate,
  });
}

export interface IssuedPassword {
  username: string;
  temporaryPassword: string;
}

/**
 * Create a login (Edge `provision`). Plain async on purpose — never a TanStack mutation, whose cache
 * would keep the temporary password. Returns null if the server replayed a completed operation.
 */
export async function provisionLogin(input: {
  operationId: string;
  username: string;
  displayName: string;
  memberships: MembershipGrant[];
  links: { staff_id?: string; student_id?: string; guardian_ids?: string[] };
}): Promise<IssuedPassword | null> {
  const res = await invokeAccounts('provision', {
    operation_id: input.operationId,
    username: input.username,
    display_name: input.displayName,
    memberships: input.memberships,
    ...(Object.keys(input.links).length > 0 ? { links: input.links } : {}),
  });
  return 'temporary_password' in res
    ? { username: res.username, temporaryPassword: res.temporary_password }
    : null;
}

/** Edge `reset_password`; same no-cache rule as provisionLogin. */
export async function resetLoginPassword(accountId: string, username: string): Promise<IssuedPassword> {
  const res = await invokeAccounts('reset_password', { account_id: accountId });
  return { username, temporaryPassword: res.temporary_password };
}
