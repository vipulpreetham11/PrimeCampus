import type { SessionStatus } from '@/lib/session/store';

/**
 * Where the current session state allows the user to be. Returns a redirect target, or null to stay.
 * While must_change_password is set, change-password is the ONLY reachable screen (CLAUDE.md rule 9).
 */
export function redirectFor(status: SessionStatus, pathname: string, isOperator: boolean): string | null {
  switch (status) {
    case 'loading':
      return null;
    case 'signed_out':
      return pathname === '/sign-in' ? null : '/sign-in';
    case 'must_change_password':
      return pathname === '/change-password' ? null : '/change-password';
    case 'choosing':
      if (pathname === '/choose' || pathname === '/change-password') return null;
      if (isOperator && pathname.startsWith('/operator/')) return null;
      return '/choose';
    case 'ready':
      return pathname === '/sign-in' ? '/dashboard' : null;
  }
}

/** The screen a user belongs on right after an action (sign-in, password change) — agrees with the gate. */
export function homeFor(status: SessionStatus): string {
  switch (status) {
    case 'ready':
      return '/dashboard';
    case 'choosing':
      return '/choose';
    case 'must_change_password':
      return '/change-password';
    default:
      return '/sign-in';
  }
}
