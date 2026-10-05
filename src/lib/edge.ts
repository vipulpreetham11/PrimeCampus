import { FunctionsHttpError } from '@supabase/supabase-js';
import type { Role } from '@/contracts/roles';
import { AppError, newRequestId, reportGlobalError, toAppError } from './errors';
import { supabase } from './supabase';

// Caller for the `accounts` Edge Function (CLAUDE.md rule 10, supabase/functions/accounts).
// Request/response bodies may contain temporary passwords: never log, cache or persist them.

export interface MembershipGrant {
  school_id: string;
  role: Exclude<Role, 'operator'>;
  admissions_duty?: boolean;
}

export interface AccountsActions {
  provision: {
    request: {
      operation_id: string;
      username: string;
      display_name: string;
      memberships: MembershipGrant[];
      links?: { staff_id?: string; student_id?: string; guardian_ids?: string[] };
    };
    response:
      | { account_id: string; username: string; temporary_password: string; must_change_password: true }
      | { account_id: string; username: string; status: 'completed'; replayed: true; note: string };
  };
  reset_password: {
    request: { account_id: string };
    response: { account_id: string; temporary_password: string; must_change_password: true };
  };
  change_password: {
    request: { current_password: string; new_password: string };
    response: { changed: true; must_change_password: false };
  };
  set_status: {
    request: { account_id: string; active: boolean };
    response: { account_id: string; status: 'active' | 'disabled' };
  };
}

export type AccountsAction = keyof AccountsActions;
export type AccountsResponse<A extends AccountsAction> = AccountsActions[A]['response'] & { request_id: string };

interface EdgeErrorBody {
  ok?: false;
  code?: string;
  message?: string;
  request_id?: string;
}

export async function invokeAccounts<A extends AccountsAction>(
  action: A,
  body: AccountsActions[A]['request'],
): Promise<AccountsResponse<A>> {
  const fallbackId = newRequestId();
  const { data, error } = await supabase.functions.invoke('accounts', { body: { action, ...body } });
  if (error) {
    let appError: AppError;
    if (error instanceof FunctionsHttpError) {
      const payload = (await (error.context as Response)
        .clone()
        .json()
        .catch(() => ({}))) as EdgeErrorBody;
      const requestId = payload.request_id ?? fallbackId;
      appError = toAppError({ message: payload.message }, requestId, payload.code);
      // Edge-only config failures are not user-actionable.
      if (payload.code === 'CONFIG_ERROR') appError = new AppError('UNKNOWN', 'Something went wrong.', requestId);
    } else {
      appError = toAppError(error, fallbackId);
    }
    reportGlobalError(appError);
    throw appError;
  }
  const result = data as AccountsResponse<A> & { ok?: boolean };
  if (!result || result.ok === false) throw new AppError('UNKNOWN', 'Something went wrong.', fallbackId);
  return result;
}
