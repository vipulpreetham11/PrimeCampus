// PrimeCampus — `accounts` Edge Function (TRD §6)
//
// POST { action, ...payload } with the caller's Supabase session JWT in Authorization.
//   provision        Admin/Operator creates a login + school roles; returns a one-time temporary password
//   reset_password   Admin (of every school the target belongs to) or Operator; returns a temporary password
//   change_password  Signed-in user changes own password (works while must_change_password is set)
//   set_status       Operator enables/disables an account globally
//
// Login model: school-issued username -> internal alias `<username>@<LOGIN_EMAIL_DOMAIN>`.
// The alias is an identifier, not a mailbox. No email is ever sent.
//
// LOGIN_EMAIL_DOMAIN defaults to login.vipulpreetham.me. Optional secret: ALLOWED_ORIGINS (comma list).
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// Permanent: changing it breaks existing logins. Secret overrides only for local/dev projects.
const LOGIN_DOMAIN = Deno.env.get("LOGIN_EMAIL_DOMAIN") ?? "login.vipulpreetham.me";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

function keyFrom(jsonVar: string, legacyVar: string): string {
  const raw = Deno.env.get(jsonVar);
  if (raw) {
    try {
      const k = JSON.parse(raw)?.default;
      if (k) return k;
    } catch { /* fall through */ }
  }
  return Deno.env.get(legacyVar) ?? "";
}
const SECRET_KEY = keyFrom("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
const PUBLISHABLE_KEY = keyFrom("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, DUPLICATE: 409,
  VALIDATION_ERROR: 400, LIMIT_REACHED: 429, CONFIG_ERROR: 500, TEMPORARILY_UNAVAILABLE: 503,
};

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allow = ALLOWED_ORIGINS.includes("*") ? "*" : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? "");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return JSON.parse(atob(b64));
}

// Strong, readable temporary password (no ambiguous characters).
function temporaryPassword(length = 14): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  // guarantee at least one digit and one upper/lower
  return out.slice(0, length - 3) + "A" + "k" + String(bytes[0] % 10);
}

async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) {
    const code = error.hint && STATUS_BY_CODE[error.hint] ? error.hint : "TEMPORARILY_UNAVAILABLE";
    throw new AppError(code, code === "TEMPORARILY_UNAVAILABLE" ? "Database error. Try again." : error.message,
      STATUS_BY_CODE[code]);
  }
  return data as T;
}

type Caller = { uid: string; sid: string };
type Requester = { account_id: string; username: string; must_change_password: boolean; is_operator: boolean };

async function verifyCaller(req: Request): Promise<Caller> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new AppError("UNAUTHENTICATED", "Sign in required", 401);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) throw new AppError("UNAUTHENTICATED", "Session expired. Sign in again.", 401);
  const claims = decodeJwtPayload(token);
  const sid = String(claims.session_id ?? "");
  if (!sid || claims.sub !== data.user.id) throw new AppError("UNAUTHENTICATED", "Invalid session", 401);
  return { uid: data.user.id, sid };
}

function aliasFor(username: string): string {
  if (!LOGIN_DOMAIN) throw new AppError("CONFIG_ERROR", "LOGIN_EMAIL_DOMAIN secret is not set", 500);
  return `${username.toLowerCase()}@${LOGIN_DOMAIN}`;
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

// ---------------------------------------------------------------------------
async function provision(c: Caller, body: Record<string, unknown>) {
  const { operation_id, username, display_name, memberships, links } = body as {
    operation_id: string; username: string; display_name: string;
    memberships: Array<{ school_id: string; role: string; admissions_duty?: boolean }>;
    links?: Record<string, unknown>;
  };
  if (!isUuid(operation_id)) throw new AppError("VALIDATION_ERROR", "operation_id (uuid) is required");
  if (typeof display_name !== "string" || !display_name.trim()) throw new AppError("VALIDATION_ERROR", "display_name is required");
  if (typeof username !== "string") throw new AppError("VALIDATION_ERROR", "username is required");
  const uname = username.trim().toLowerCase();
  const email = aliasFor(uname);

  await rpc("svc_requester", { p_uid: c.uid, p_auth_session_id: c.sid, p_allow_must_change: false });
  const op = await rpc<{ status: string; auth_user_id: string | null }>("svc_begin_provisioning", {
    p_operation_id: operation_id, p_requested_by: c.uid, p_username: uname,
    p_payload: { memberships, links: links ?? {}, display_name },
  });
  if (op.status === "completed") {
    return { account_id: op.auth_user_id, username: uname, status: "completed", replayed: true,
             note: "Already provisioned. Use reset_password to issue a new temporary password." };
  }

  const password = temporaryPassword();
  let authId = op.auth_user_id;
  try {
    if (!authId) {
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, app_metadata: { username: uname },
      });
      if (error || !data?.user) {
        const taken = /already|registered|exists/i.test(error?.message ?? "");
        throw new AppError(taken ? "DUPLICATE" : "TEMPORARILY_UNAVAILABLE",
          taken ? "Username already taken" : "Could not create the login. Retry with the same operation_id.");
      }
      authId = data.user.id;
      await rpc("svc_set_provisioning_auth_user", { p_operation_id: operation_id, p_auth_user_id: authId });
    } else {
      // resuming a half-finished operation: issue a fresh temporary password
      const { error } = await admin.auth.admin.updateUserById(authId, { password });
      if (error) throw new AppError("TEMPORARILY_UNAVAILABLE", "Could not reset the pending login. Retry.");
    }
    await rpc("svc_provision_account", {
      p_operation_id: operation_id, p_requested_by: c.uid, p_auth_user_id: authId,
      p_username: uname, p_display_name: display_name.trim(), p_memberships: memberships, p_links: links ?? {},
    });
  } catch (e) {
    await admin.rpc("svc_mark_provisioning_failed", { p_operation_id: operation_id, p_error: String((e as Error).message) });
    throw e;
  }
  // Shown once to the issuer for external delivery; never stored or logged.
  return { account_id: authId, username: uname, temporary_password: password, must_change_password: true };
}

async function resetPassword(c: Caller, body: Record<string, unknown>) {
  const target = body.account_id;
  if (!isUuid(target)) throw new AppError("VALIDATION_ERROR", "account_id is required");
  if (target === c.uid) throw new AppError("VALIDATION_ERROR", "Use change_password for your own account");
  await rpc("svc_requester", { p_uid: c.uid, p_auth_session_id: c.sid, p_allow_must_change: false });
  const allowed = await rpc<boolean>("svc_can_manage_account", { p_requester: c.uid, p_target: target });
  if (!allowed) throw new AppError("FORBIDDEN", "You can only reset accounts that belong entirely to your schools", 403);
  const password = temporaryPassword();
  const { error } = await admin.auth.admin.updateUserById(target, { password });
  if (error) throw new AppError("TEMPORARILY_UNAVAILABLE", "Could not reset the password. Retry.", 503);
  await rpc("svc_password_changed", { p_account_id: target, p_actor_id: c.uid, p_was_reset: true });
  return { account_id: target, temporary_password: password, must_change_password: true };
}

async function changePassword(c: Caller, body: Record<string, unknown>) {
  const { current_password, new_password } = body as { current_password: string; new_password: string };
  if (typeof new_password !== "string" || new_password.length < 8 || new_password.length > 72) {
    throw new AppError("VALIDATION_ERROR", "New password must be 8–72 characters");
  }
  if (new_password === current_password) throw new AppError("VALIDATION_ERROR", "Choose a different password");
  const me = await rpc<Requester>("svc_requester", { p_uid: c.uid, p_auth_session_id: c.sid, p_allow_must_change: true });

  // Verify the current password with an ordinary password sign-in, then end that extra session.
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: aliasFor(me.username), password: current_password ?? "" }),
  });
  if (!res.ok) throw new AppError("VALIDATION_ERROR", "Current password is incorrect");
  const verify = await res.json();
  if (verify?.access_token) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
      method: "POST", headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${verify.access_token}` },
    }).catch(() => undefined);
  }

  const { error } = await admin.auth.admin.updateUserById(c.uid, { password: new_password });
  if (error) throw new AppError("VALIDATION_ERROR", error.message);
  await rpc("svc_password_changed", { p_account_id: c.uid, p_actor_id: c.uid, p_was_reset: false });
  return { changed: true, must_change_password: false };
}

async function setStatus(c: Caller, body: Record<string, unknown>) {
  const { account_id, active } = body as { account_id: string; active: boolean };
  if (!isUuid(account_id) || typeof active !== "boolean") throw new AppError("VALIDATION_ERROR", "account_id and active are required");
  if (account_id === c.uid) throw new AppError("VALIDATION_ERROR", "You cannot change your own status");
  const me = await rpc<Requester>("svc_requester", { p_uid: c.uid, p_auth_session_id: c.sid, p_allow_must_change: false });
  if (!me.is_operator) {
    throw new AppError("FORBIDDEN", "Only an Operator can disable an account globally. Admins disable a school role instead.", 403);
  }
  const { error } = await admin.auth.admin.updateUserById(account_id, { ban_duration: active ? "none" : "876000h" });
  if (error) throw new AppError("TEMPORARILY_UNAVAILABLE", "Could not update the login. Retry.", 503);
  await rpc("svc_set_account_status", { p_account_id: account_id, p_actor_id: c.uid, p_active: active });
  return { account_id, status: active ? "active" : "disabled" };
}

// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { code: "VALIDATION_ERROR", message: "POST only" }, 405);
  const requestId = crypto.randomUUID();
  try {
    if (!SECRET_KEY) throw new AppError("CONFIG_ERROR", "Server key missing", 500);
    const caller = await verifyCaller(req);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    let result: unknown;
    switch (body.action) {
      case "provision":       result = await provision(caller, body); break;
      case "reset_password":  result = await resetPassword(caller, body); break;
      case "change_password": result = await changePassword(caller, body); break;
      case "set_status":      result = await setStatus(caller, body); break;
      default: throw new AppError("VALIDATION_ERROR", "Unknown action");
    }
    return json(req, { ok: true, request_id: requestId, ...(result as object) });
  } catch (e) {
    const err = e instanceof AppError ? e : new AppError("TEMPORARILY_UNAVAILABLE", "Unexpected error", 500);
    if (!(e instanceof AppError)) console.error(requestId, (e as Error)?.message); // never log bodies/passwords
    return json(req, { ok: false, code: err.code, message: err.message, request_id: requestId }, err.status);
  }
});
