import { readFileSync } from 'node:fs';

// Test-only API helper for the live project (Demo School only). Uses ONLY the public RPCs and the
// `accounts` Edge Function with a user's own session — never SQL, never a service key.
// Passwords live in memory only: never printed, logged or written to disk.

function publicEnv(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const line = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing`);
  return line.slice(name.length + 1).trim();
}

const URL_ = publicEnv('VITE_SUPABASE_URL');
const KEY = publicEnv('VITE_SUPABASE_PUBLISHABLE_KEY');
const DOMAIN = publicEnv('VITE_LOGIN_EMAIL_DOMAIN');

export class ApiSession {
  private constructor(
    readonly username: string,
    private readonly token: string,
    public rev: number | null = null,
  ) {}

  static async signIn(username: string, password: string): Promise<ApiSession> {
    const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${username}@${DOMAIN}`, password }),
    });
    const body = (await res.json()) as { access_token?: string; error_code?: string };
    if (!res.ok || !body.access_token)
      throw new Error(`sign-in failed for ${username}: ${body.error_code ?? res.status}`);
    const s = new ApiSession(username, body.access_token);
    await s.rpc('bootstrap_account', { p_device_class: 'desktop', p_user_agent: 'playwright-helper' });
    return s;
  }

  private headers() {
    return { apikey: KEY, authorization: `Bearer ${this.token}`, 'content-type': 'application/json' };
  }

  async rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(args),
    });
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const e = body as { hint?: string; message?: string } | null;
      throw new Error(`${fn}: ${e?.hint ?? res.status} ${e?.message ?? ''}`);
    }
    return body as T;
  }

  /** School RPC with this session's context revision. */
  async school<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.rev === null) throw new Error('select a context first');
    return this.rpc<T>(fn, { p_ctx_rev: this.rev, ...args });
  }

  async edge<T = Record<string, unknown>>(action: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${URL_}/functions/v1/accounts`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ action, ...body }),
    });
    const json = (await res.json()) as T & { ok?: boolean; code?: string; message?: string };
    if (!res.ok || json.ok === false)
      throw new Error(`edge ${action}: ${json.code ?? res.status} ${json.message ?? ''}`);
    return json;
  }

  /** Select the Demo School (Operator: support context; others: their membership with `role`). */
  async enterDemo(role?: string): Promise<void> {
    if (!role) {
      const schools = await this.rpc<{ school_id: string; code: string }[]>('op_list_schools');
      const demo = schools.find((s) => s.code === 'demo');
      if (!demo) throw new Error('Demo School missing');
      const sel = await this.rpc<{ context_revision: number }>('select_context', {
        p_operator_school_id: demo.school_id,
      });
      this.rev = sel.context_revision;
    } else {
      const b = await this.rpc<{ contexts: { membership_id: string; school_name: string; role: string }[] }>(
        'bootstrap_account',
        { p_device_class: 'desktop', p_user_agent: 'playwright-helper' },
      );
      const ctx = b.contexts.find((c) => c.role === role && c.school_name === 'Demo School');
      if (!ctx) throw new Error(`${this.username} has no ${role} role in Demo School`);
      const sel = await this.rpc<{ context_revision: number }>('select_context', {
        p_membership_id: ctx.membership_id,
      });
      this.rev = sel.context_revision;
    }
    const ctx = await this.rpc<{ school_name: string }>('get_context');
    if (ctx.school_name !== 'Demo School') throw new Error('safety: not in Demo School');
  }

  async signOut(): Promise<void> {
    await this.rpc('end_app_session').catch(() => undefined);
    await fetch(`${URL_}/auth/v1/logout?scope=local`, { method: 'POST', headers: this.headers() }).catch(
      () => undefined,
    );
  }
}

export function newPassword(): string {
  return `Pc-${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
}

/**
 * Give a demo login a known password for this run: the manager resets it (Edge reset_password),
 * then the user signs in with the temporary password and changes it (Edge change_password).
 */
export async function setKnownPassword(manager: ApiSession, username: string): Promise<string> {
  if (!username.startsWith('demo.')) throw new Error('safety: demo logins only');
  const found = await manager.rpc<{ account_id: string } | null>('op_find_account', { p_username: username });
  if (!found) throw new Error(`${username} not found`);
  const { temporary_password } = await manager.edge<{ temporary_password: string }>('reset_password', {
    account_id: found.account_id,
  });
  const user = await ApiSession.signIn(username, temporary_password);
  const password = newPassword();
  await user.edge('change_password', { current_password: temporary_password, new_password: password });
  await user.signOut();
  return password;
}

export async function operatorSession(): Promise<ApiSession> {
  const u = process.env.E2E_OPERATOR_USERNAME;
  const p = process.env.E2E_OPERATOR_PASSWORD;
  if (!u || !p) throw new Error('E2E_OPERATOR_USERNAME / E2E_OPERATOR_PASSWORD not set');
  return ApiSession.signIn(u, p);
}

export function accountExists(op: ApiSession, username: string) {
  return op.rpc<{ account_id: string; memberships: { role: string; status: string }[] } | null>(
    'op_find_account',
    {
      p_username: username,
    },
  );
}
