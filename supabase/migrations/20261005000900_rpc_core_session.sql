-- =============================================================================
-- PrimeCampus V1 — 0900 RPC helpers + session/context operations (TRD §6, §7, §17)
--
-- Pattern for every exposed operation:
--   public.<op>(...)   SECURITY INVOKER thin wrapper, callable by `authenticated`
--   private.<op>(...)  SECURITY DEFINER implementation with search_path = '' that
--                      explicitly checks session, context revision, capability and
--                      target scope before touching data.
-- Errors: SQLSTATE P0001, HINT = one of UNAUTHENTICATED | FORBIDDEN | STALE_CONTEXT |
--   VALIDATION_ERROR | CONFLICT | DUPLICATE | LIMIT_REACHED | NOT_FOUND.
--   PostgREST returns {code, message, hint, details}; the app maps on `hint`.
-- =============================================================================

create or replace function private.fail(p_code text, p_message text, p_details jsonb default null)
returns void language plpgsql set search_path = '' as $$
begin
  raise exception '%', p_message using errcode = 'P0001', hint = p_code, detail = coalesce(p_details::text, '');
end $$;

-- Resolve + validate the caller's live context. p_rev must match unless null.
create or replace function private.require_ctx(p_rev integer)
returns table (account_id uuid, app_session_id uuid, school_id uuid, role text, membership_id uuid,
               student_id uuid, staff_id uuid, via_operator boolean, context_revision integer, admissions_duty boolean)
language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  if auth.uid() is null then perform private.fail('UNAUTHENTICATED', 'Sign in required'); end if;
  select * into r from private.ctx() limit 1;
  if r.account_id is null then
    perform private.fail('UNAUTHENTICATED', 'No active school context. Sign in again or choose a role.');
  end if;
  if p_rev is not null and p_rev <> r.context_revision then
    perform private.fail('STALE_CONTEXT', 'Your role/school/child selection changed. Reload to continue.');
  end if;
  return query select r.account_id, r.app_session_id, r.school_id, r.role, r.membership_id,
                      r.student_id, r.staff_id, r.via_operator, r.context_revision, r.admissions_duty;
end $$;

create or replace function private.require_cap(p_cap text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_cap(p_cap) then
    perform private.fail('FORBIDDEN', 'You do not have permission for this action');
  end if;
end $$;

-- Trusted business event (same transaction as the change)
create or replace function private.log_event(p_action text, p_entity_type text, p_entity_id text,
                                             p_detail jsonb default '{}', p_operation_id uuid default null,
                                             p_year_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.ctx() limit 1;
  insert into private.audit_events (actor_id, actor_role, via_operator, app_session_id, school_id, academic_year_id,
                                    action, entity_type, entity_id, operation_id, detail)
  values (coalesce(c.account_id, auth.uid()), c.role, coalesce(c.via_operator, false), c.app_session_id, c.school_id,
          p_year_id, p_action, p_entity_type, p_entity_id, p_operation_id, coalesce(p_detail, '{}'));
end $$;

-- Idempotency: returns stored result for a replay; raises DUPLICATE if the same key carried different content
create or replace function private.idem_lookup(p_school uuid, p_type text, p_op uuid, p_fingerprint text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if p_op is null then perform private.fail('VALIDATION_ERROR', 'operation_id is required'); end if;
  select * into r from private.idempotency_keys
   where school_id = p_school and operation_type = p_type and operation_id = p_op;
  if not found then return null; end if;
  if r.fingerprint <> p_fingerprint then
    perform private.fail('DUPLICATE', 'This operation id was already used for different content');
  end if;
  return r.result || jsonb_build_object('replayed', true);
end $$;

create or replace function private.idem_store(p_school uuid, p_type text, p_op uuid, p_fingerprint text, p_result jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into private.idempotency_keys (operation_id, school_id, operation_type, actor_id, fingerprint, result)
  values (p_op, p_school, p_type, auth.uid(), p_fingerprint, p_result)
$$;

create or replace function private.fingerprint(p jsonb)
returns text language sql immutable set search_path = '' as $$ select md5(p::text) $$;

-- Calendar resolution (TRD §9): dated override (group) > dated override (default)
-- > weekday pattern (group) > weekday pattern (default) > non-working.
create or replace function private.resolve_day(p_school uuid, p_audience text, p_group uuid, p_date date)
returns table (academic_year_id uuid, day_type text, weight numeric, period_schedule_id uuid, label text)
language sql stable security definer set search_path = '' as $$
  with y as (
    select ay.id from app.academic_years ay
     where ay.school_id = p_school and p_date between ay.start_date and ay.end_date
  ), pick as (
    select 1 as prio, d.day_type, d.period_schedule_id, d.label from app.calendar_days d, y
     where d.school_id = p_school and d.audience = p_audience and d.cal_date = p_date
       and d.academic_year_id = y.id and p_group is not null and d.staff_group_id = p_group
    union all
    select 2, d.day_type, d.period_schedule_id, d.label from app.calendar_days d, y
     where d.school_id = p_school and d.audience = p_audience and d.cal_date = p_date
       and d.academic_year_id = y.id and d.staff_group_id is null
    union all
    select 3, cp.day_type, cp.period_schedule_id, null from app.calendar_patterns cp, y
     where cp.academic_year_id = y.id and cp.audience = p_audience and p_group is not null
       and cp.staff_group_id = p_group and cp.weekday = extract(isodow from p_date)
    union all
    select 4, cp.day_type, cp.period_schedule_id, null from app.calendar_patterns cp, y
     where cp.academic_year_id = y.id and cp.audience = p_audience and cp.staff_group_id is null
       and cp.weekday = extract(isodow from p_date)
  ), best as (select * from pick order by prio limit 1)
  select (select id from y),
         coalesce(b.day_type, 'weekly_off'),
         case coalesce(b.day_type, 'weekly_off') when 'working' then 1.0 when 'half_day' then 0.5 else 0 end,
         b.period_schedule_id,
         b.label
  from (select 1) one left join best b on true
$$;

-- Student attendance mode effective on a date
create or replace function private.attendance_mode_on(p_school uuid, p_date date)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select mode from app.attendance_modes
                    where school_id = p_school and effective_from <= p_date
                    order by effective_from desc limit 1), 'daily')
$$;

-- =============================================================================
-- Session / context
-- =============================================================================

-- Called right after Supabase password sign-in. Creates/refreshes the app session
-- and returns ONLY the caller's own available contexts. No operational data.
create or replace function private.bootstrap_account(p_device_class text, p_user_agent text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_sid   uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_acc   app.accounts;
  v_sess  private.app_sessions;
  v_new   boolean := false;
  v_ctxs  jsonb;
  v_is_op boolean;
begin
  if v_uid is null or v_sid is null then perform private.fail('UNAUTHENTICATED', 'Sign in required'); end if;
  select * into v_acc from app.accounts where id = v_uid;
  if not found or v_acc.status <> 'active' then
    perform private.fail('FORBIDDEN', 'This account is not active. Contact your school office.');
  end if;

  select * into v_sess from private.app_sessions where auth_session_id = v_sid;
  if found and (v_sess.account_id <> v_uid or v_sess.ended_at is not null) then
    perform private.fail('UNAUTHENTICATED', 'This session has ended. Sign in again.');
  end if;
  if not found then
    insert into private.app_sessions (account_id, auth_session_id, device_class, user_agent)
    values (v_uid, v_sid,
            case when p_device_class in ('desktop','mobile','tablet') then p_device_class else 'unknown' end,
            left(p_user_agent, 400))
    returning * into v_sess;
    v_new := true;
    insert into private.auth_events (account_id, event, app_session_id, auth_session_id, device_class, user_agent)
    values (v_uid, 'login', v_sess.id, v_sid, v_sess.device_class, v_sess.user_agent);
  else
    update private.app_sessions set last_seen_at = now() where id = v_sess.id;
  end if;
  update app.accounts set last_seen_at = now() where id = v_uid and (last_seen_at is null or last_seen_at < now() - interval '5 minutes');

  if v_acc.must_change_password then
    return jsonb_build_object('account_id', v_uid, 'username', v_acc.username, 'display_name', v_acc.display_name,
                              'must_change_password', true, 'contexts', '[]'::jsonb);
  end if;

  v_is_op := exists (select 1 from private.platform_operators where account_id = v_uid and revoked_at is null);

  select coalesce(jsonb_agg(x order by x->>'school_name', x->>'role'), '[]') into v_ctxs from (
    select jsonb_build_object(
      'membership_id', m.id, 'school_id', s.id, 'school_name', s.name, 'role', m.role,
      'children', case when m.role = 'parent' then (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'student_id', st.id, 'name', st.full_name,
                   'class_section', (select c.name || ' ' || sec.name
                                       from app.placements p
                                       join app.sections sec on sec.id = p.section_id
                                       join app.classes c on c.id = sec.class_id
                                      where p.student_id = st.id
                                      order by p.effective_from desc limit 1)) order by st.full_name), '[]')
            from app.guardians g
            join app.student_guardians sg on sg.guardian_id = g.id and sg.portal_access
            join app.students st on st.id = sg.student_id and st.status = 'active'
           where g.account_id = v_uid and g.school_id = m.school_id and g.status = 'active')
        when m.role = 'student' then (
          select coalesce(jsonb_agg(jsonb_build_object('student_id', st.id, 'name', st.full_name)), '[]')
            from app.students st where st.account_id = v_uid and st.school_id = m.school_id and st.status = 'active')
        else null end) as x
    from app.memberships m join app.schools s on s.id = m.school_id
   where m.account_id = v_uid and m.status = 'active' and s.status = 'active'
  ) q;

  return jsonb_build_object(
    'account_id', v_uid, 'username', v_acc.username, 'display_name', v_acc.display_name,
    'must_change_password', false, 'is_operator', v_is_op, 'new_session', v_new,
    'contexts', v_ctxs,
    'selected', (select jsonb_build_object('membership_id', v_sess.membership_id,
                                           'operator_school_id', v_sess.operator_school_id,
                                           'student_id', v_sess.student_id,
                                           'context_revision', v_sess.context_revision)));
end $$;

create or replace function private.select_context(p_membership_id uuid, p_student_id uuid, p_operator_school_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_sid  uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_sess private.app_sessions;
  v_m    app.memberships;
  v_rev  integer;
  v_school uuid;
begin
  select s.* into v_sess from private.app_sessions s
    join app.accounts a on a.id = s.account_id
   where s.auth_session_id = v_sid and s.account_id = v_uid and s.ended_at is null
     and a.status = 'active' and not a.must_change_password
   for update of s;
  if not found then perform private.fail('UNAUTHENTICATED', 'Session not initialised. Sign in again.'); end if;

  if p_operator_school_id is not null then
    if p_membership_id is not null or p_student_id is not null then
      perform private.fail('VALIDATION_ERROR', 'Operator context takes only a school');
    end if;
    if not exists (select 1 from private.platform_operators where account_id = v_uid and revoked_at is null) then
      perform private.fail('FORBIDDEN', 'Operator access required');
    end if;
    if not exists (select 1 from app.schools where id = p_operator_school_id) then
      perform private.fail('NOT_FOUND', 'School not found');
    end if;
    v_school := p_operator_school_id;
  else
    select * into v_m from app.memberships
     where id = p_membership_id and account_id = v_uid and status = 'active';
    if not found then perform private.fail('FORBIDDEN', 'That role is not available to you'); end if;
    v_school := v_m.school_id;
    if v_m.role = 'parent' then
      if p_student_id is null then perform private.fail('VALIDATION_ERROR', 'Choose a child'); end if;
      if not exists (select 1 from app.student_guardians sg
                       join app.guardians g on g.id = sg.guardian_id
                       join app.students st on st.id = sg.student_id
                      where sg.student_id = p_student_id and sg.portal_access
                        and g.account_id = v_uid and g.status = 'active'
                        and st.school_id = v_m.school_id and st.status = 'active') then
        perform private.fail('FORBIDDEN', 'That child is not linked to your account');
      end if;
    elsif v_m.role = 'student' then
      select id into p_student_id from app.students
       where account_id = v_uid and school_id = v_m.school_id and status = 'active';
      if p_student_id is null then perform private.fail('FORBIDDEN', 'No active student record for this login'); end if;
    elsif p_student_id is not null then
      perform private.fail('VALIDATION_ERROR', 'Child selection applies only to Parent context');
    end if;
  end if;

  update private.app_sessions
     set membership_id = case when p_operator_school_id is null then p_membership_id end,
         operator_school_id = p_operator_school_id,
         student_id = p_student_id,
         context_revision = context_revision + 1,
         last_seen_at = now()
   where id = v_sess.id
  returning context_revision into v_rev;

  insert into private.auth_events (account_id, event, app_session_id, auth_session_id, school_id, detail)
  values (v_uid, 'context_selected', v_sess.id, v_sid, v_school,
          jsonb_build_object('role', coalesce(v_m.role, 'operator'), 'student_id', p_student_id));

  return jsonb_build_object('context_revision', v_rev, 'school_id', v_school,
                            'role', coalesce(v_m.role, 'operator'), 'student_id', p_student_id,
                            'membership_id', p_membership_id);
end $$;

create or replace function private.end_app_session()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  update private.app_sessions set ended_at = now(), end_reason = 'logout'
   where account_id = auth.uid() and auth_session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
     and ended_at is null
  returning id into v_id;
  if v_id is not null then
    insert into private.auth_events (account_id, event, app_session_id, auth_session_id)
    values (auth.uid(), 'logout', v_id, nullif(auth.jwt() ->> 'session_id', '')::uuid);
  end if;
  return jsonb_build_object('ended', v_id is not null);
end $$;

-- Lightweight context echo for the app shell
create or replace function private.get_context()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_school text; v_year jsonb;
begin
  select * into c from private.require_ctx(null);
  select name into v_school from app.schools where id = c.school_id;
  select jsonb_build_object('id', id, 'name', name, 'start_date', start_date, 'end_date', end_date)
    into v_year from app.academic_years where school_id = c.school_id and is_current;
  return jsonb_build_object(
    'school_id', c.school_id, 'school_name', v_school, 'role', c.role, 'via_operator', c.via_operator,
    'student_id', c.student_id, 'staff_id', c.staff_id, 'context_revision', c.context_revision,
    'current_year', v_year,
    'capabilities', (select jsonb_agg(cap) from unnest(array[
        'setup.manage','users.manage','students.read_all','students.manage','students.sensitive','admissions.manage',
        'imports.manage','timetable.read_all','timetable.manage','attendance.read_all','attendance.mark_any',
        'attendance.summary','academic.read_all','academic.correct','fees.read','fees.manage','staff.read',
        'staff.manage','staff_attendance.read','staff_attendance.manage','staff_finance.read',
        'staff_finance.manage','export.full','audit.read']) cap
        where private.role_has_cap(c.role, cap) or (cap = 'admissions.manage' and c.admissions_duty)));
end $$;

-- Browser telemetry: approximate, bounded (TRD §16.2). ≤20 events, ≤2KB payload each.
create or replace function private.record_telemetry(p_events jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_s private.app_sessions; v_n integer; v_school uuid;
begin
  select * into v_s from private.app_sessions
   where account_id = auth.uid() and auth_session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid and ended_at is null;
  if not found then perform private.fail('UNAUTHENTICATED', 'No active session'); end if;
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 20 then
    perform private.fail('LIMIT_REACHED', 'At most 20 events per request');
  end if;
  v_school := private.ctx_school_id();
  insert into private.telemetry_events (occurred_at, account_id, app_session_id, school_id, event, path, browser, os, device_class, payload)
  select least(coalesce((e->>'occurred_at')::timestamptz, now()), now()), auth.uid(), v_s.id, v_school,
         e->>'event', left(e->>'path', 200), left(e->>'browser', 40), left(e->>'os', 40),
         case when e->>'device_class' in ('desktop','mobile','tablet') then e->>'device_class' else 'unknown' end,
         coalesce(e->'payload', '{}')
    from jsonb_array_elements(p_events) e
   where e->>'event' in ('page_view','context_display','activity')
     and pg_column_size(coalesce(e->'payload','{}')) <= 2048;
  get diagnostics v_n = row_count;
  -- last-seen at most every 5 minutes per session
  update private.app_sessions set last_seen_at = now()
   where id = v_s.id and last_seen_at < now() - interval '5 minutes';
  if v_school is not null then
    insert into private.usage_daily (day, account_id, school_id, page_views)
    values ((now() at time zone 'Asia/Kolkata')::date, auth.uid(), v_school,
            (select count(*) from jsonb_array_elements(p_events) e where e->>'event' = 'page_view'))
    on conflict (day, account_id, school_id) do update set page_views = private.usage_daily.page_views + excluded.page_views;
  end if;
  return jsonb_build_object('accepted', v_n);
end $$;

-- ---------------- service_role only (called from Edge Functions) --------------
-- Cleared only after the Edge function verified a successful Auth password update.
create or replace function private.svc_password_changed(p_account_id uuid, p_actor_id uuid, p_was_reset boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update app.accounts set must_change_password = p_was_reset where id = p_account_id;
  if p_was_reset then
    update private.app_sessions set ended_at = now(), end_reason = 'password_reset'
     where account_id = p_account_id and ended_at is null;
  end if;
  insert into private.auth_events (account_id, actor_id, event)
  values (p_account_id, p_actor_id, case when p_was_reset then 'password_reset' else 'password_changed' end);
end $$;

create or replace function private.svc_set_account_status(p_account_id uuid, p_actor_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update app.accounts set status = case when p_active then 'active' else 'disabled' end where id = p_account_id;
  if not p_active then
    update private.app_sessions set ended_at = now(), end_reason = 'account_disabled'
     where account_id = p_account_id and ended_at is null;
  end if;
  insert into private.auth_events (account_id, actor_id, event)
  values (p_account_id, p_actor_id, case when p_active then 'account_enabled' else 'account_disabled' end);
end $$;

-- Resumable provisioning: Edge creates the Auth user, then calls this with its id.
-- p_memberships: [{school_id, role, admissions_duty}]
-- p_links: {"staff_id": uuid} | {"guardian_ids": [uuid]} | {"student_id": uuid}
create or replace function private.svc_provision_account(p_operation_id uuid, p_requested_by uuid, p_auth_user_id uuid,
                                                         p_username text, p_display_name text,
                                                         p_memberships jsonb, p_links jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_is_op boolean := exists (select 1 from private.platform_operators where account_id = p_requested_by and revoked_at is null);
  m jsonb; g text;
begin
  -- requester must be Operator, or Admin of every school being granted (never Operator grants)
  for m in select * from jsonb_array_elements(p_memberships) loop
    if not v_is_op and not exists (select 1 from app.memberships am
                                    where am.account_id = p_requested_by and am.role = 'admin' and am.status = 'active'
                                      and am.school_id = (m->>'school_id')::uuid) then
      perform private.fail('FORBIDDEN', 'Requester cannot grant access to this school');
    end if;
  end loop;

  insert into private.provisioning_operations (operation_id, requested_by, username, auth_user_id, requested_payload, status)
  values (p_operation_id, p_requested_by, lower(p_username), p_auth_user_id,
          jsonb_build_object('memberships', p_memberships, 'links', p_links), 'auth_created')
  on conflict (operation_id) do update set auth_user_id = excluded.auth_user_id, updated_at = now();

  insert into app.accounts (id, username, display_name, status, must_change_password, created_by)
  values (p_auth_user_id, lower(p_username), p_display_name, 'active', true, p_requested_by)
  on conflict (id) do nothing;

  for m in select * from jsonb_array_elements(p_memberships) loop
    insert into app.memberships (account_id, school_id, role, admissions_duty, granted_by)
    values (p_auth_user_id, (m->>'school_id')::uuid, m->>'role', coalesce((m->>'admissions_duty')::boolean, false), p_requested_by)
    on conflict (account_id, school_id, role) do nothing;
    insert into private.auth_events (account_id, actor_id, event, school_id, detail)
    values (p_auth_user_id, p_requested_by, 'membership_granted', (m->>'school_id')::uuid, jsonb_build_object('role', m->>'role'));
  end loop;

  if p_links ? 'staff_id' then
    update app.staff set account_id = p_auth_user_id where id = (p_links->>'staff_id')::uuid and account_id is null;
  end if;
  if p_links ? 'student_id' then
    update app.students set account_id = p_auth_user_id where id = (p_links->>'student_id')::uuid and account_id is null;
  end if;
  if p_links ? 'guardian_ids' then
    for g in select jsonb_array_elements_text(p_links->'guardian_ids') loop
      update app.guardians set account_id = p_auth_user_id where id = g::uuid and account_id is null;
    end loop;
  end if;

  update private.provisioning_operations set status = 'completed', updated_at = now() where operation_id = p_operation_id;
  insert into private.auth_events (account_id, actor_id, event) values (p_auth_user_id, p_requested_by, 'account_provisioned');
  return jsonb_build_object('account_id', p_auth_user_id, 'status', 'completed');
end $$;

-- Local membership disable: keeps other schools' access (PRD ACCESS-03, AC-29)
create or replace function private.disable_membership(p_rev integer, p_membership_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_m app.memberships;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('users.manage');
  select * into v_m from app.memberships where id = p_membership_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Membership not found in this school'); end if;
  if v_m.account_id = c.account_id then perform private.fail('VALIDATION_ERROR', 'You cannot disable your own access'); end if;
  update app.memberships set status = 'disabled', disabled_at = now(), disabled_by = c.account_id where id = v_m.id;
  -- end sessions currently using that membership only
  update private.app_sessions set ended_at = now(), end_reason = 'revoked'
   where membership_id = v_m.id and ended_at is null;
  insert into private.auth_events (account_id, actor_id, event, school_id, detail)
  values (v_m.account_id, c.account_id, 'membership_disabled', c.school_id, jsonb_build_object('role', v_m.role, 'reason', p_reason));
  return jsonb_build_object('membership_id', v_m.id, 'status', 'disabled');
end $$;

-- ---------------------------------------------------------------- public wrappers
create or replace function public.bootstrap_account(p_device_class text default null, p_user_agent text default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.bootstrap_account(p_device_class, p_user_agent) $$;
create or replace function public.select_context(p_membership_id uuid default null, p_student_id uuid default null, p_operator_school_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.select_context(p_membership_id, p_student_id, p_operator_school_id) $$;
create or replace function public.end_app_session()
returns jsonb language sql security invoker set search_path = '' as $$ select private.end_app_session() $$;
create or replace function public.get_context()
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_context() $$;
create or replace function public.record_telemetry(p_events jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select private.record_telemetry(p_events) $$;
create or replace function public.disable_membership(p_ctx_rev integer, p_membership_id uuid, p_reason text)
returns jsonb language sql security invoker set search_path = '' as $$ select private.disable_membership(p_ctx_rev, p_membership_id, p_reason) $$;

-- Internal helpers (fail, require_ctx, log_event, idem_*, resolve_day, ...) are NOT
-- granted to clients: definer implementations call them as the owner, so a
-- browser can never write a "trusted" audit event or idempotency record itself.
grant execute on function
  private.bootstrap_account(text, text), private.select_context(uuid, uuid, uuid), private.end_app_session(),
  private.get_context(), private.record_telemetry(jsonb), private.disable_membership(integer, uuid, text)
to authenticated;
grant execute on function
  private.svc_password_changed(uuid, uuid, boolean), private.svc_set_account_status(uuid, uuid, boolean),
  private.svc_provision_account(uuid, uuid, uuid, text, text, jsonb, jsonb)
to service_role;
grant execute on function
  public.bootstrap_account(text, text), public.select_context(uuid, uuid, uuid), public.end_app_session(),
  public.get_context(), public.record_telemetry(jsonb), public.disable_membership(integer, uuid, text)
to authenticated;
