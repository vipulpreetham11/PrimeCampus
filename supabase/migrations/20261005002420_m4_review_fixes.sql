-- =============================================================================
-- PrimeCampus V1 — 2420 M4 review fixes
--  * get_salary_month: one set-based pass for all staff (was compute_salary per staff, twice) — the month
--    view timed out at 47 staff. Numbers are identical to compute_salary (checked against it in tests).
--  * "changed since saved" compares only the numbers (salary, working / attended / paid-leave days, payable);
--    a different set of unmarked days that leaves every number equal is not a change (it would save as a replay)
--  * jit off for these two: the planner's cost for the calendar function made Postgres JIT-compile the query
--    (~0.8 s per call) for a few hundred rows
-- =============================================================================

-- All staff of a month in one pass. Same rules as private.compute_salary (no overrides).
create or replace function private.salary_bulk(p_school uuid, p_month date, p_group uuid)
returns table (staff_id uuid, monthly_salary_paise bigint, working_days numeric, attended_days numeric,
               paid_leave_days numeric, unmarked_days integer, present integer, late integer, half_day integer, absent integer)
language sql stable security definer set search_path = '' set jit = off as $$
  with m as (select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month - 1 day')::date as e),
  st as materialized (
    select x.id, x.staff_group_id, x.joined_on, x.left_on
      from app.staff x, m
     where x.school_id = p_school and x.joined_on <= m.e and (x.left_on is null or x.left_on >= m.s)
       and (p_group is null or x.staff_group_id = p_group)
  ),
  grp as (select distinct staff_group_id from st),
  days as materialized (   -- staff calendar resolved once per group and day
    select g.staff_group_id, d::date as d, coalesce(r.weight, 0) as weight
      from grp g cross join m cross join generate_series(m.s, m.e, interval '1 day') d
      left join lateral private.resolve_day(p_school, 'staff', g.staff_group_id, d::date) r on true
  ),
  per_day as (
    select st.id as staff_id, dy.d, dy.weight,
           (dy.d < st.joined_on or (st.left_on is not null and dy.d > st.left_on)) as not_employed,
           sa.status as att, pl.day_fraction as leave
      from st join days dy on dy.staff_group_id is not distinct from st.staff_group_id
      left join app.staff_attendance sa on sa.staff_id = st.id and sa.attendance_date = dy.d
      left join app.staff_paid_leave pl on pl.staff_id = st.id and pl.leave_date = dy.d and pl.status = 'active'
     where dy.weight > 0
  ),
  scored as (
    select staff_id, weight, not_employed, att, leave,
           case when not_employed then 0
                else case att when 'P' then weight when 'L' then weight when 'H' then weight * 0.5 else 0 end end as credit
      from per_day
  ),
  agg as (
    select staff_id,
           round(sum(weight), 2) as w,
           round(sum(credit), 2) as a,
           round(sum(case when not_employed or leave is null then 0 else greatest(least(leave, weight - credit), 0) end), 2) as p,
           count(*) filter (where not not_employed and leave is null and att is null)::int as unmarked,
           count(*) filter (where not not_employed and att = 'P')::int as np,
           count(*) filter (where not not_employed and att = 'L')::int as nl,
           count(*) filter (where not not_employed and att = 'H')::int as nh,
           count(*) filter (where not not_employed and att = 'A')::int as nab
      from scored group by staff_id
  )
  select st.id,
         coalesce((select r.monthly_salary_paise from app.staff_salary_rates r, m
                    where r.staff_id = st.id and r.effective_from <= m.e order by r.effective_from desc limit 1),
                  (select d.monthly_salary_paise from app.staff_group_salary_defaults d where d.staff_group_id = st.staff_group_id)),
         coalesce(a.w, 0), coalesce(a.a, 0), coalesce(a.p, 0), coalesce(a.unmarked, 0),
         coalesce(a.np, 0), coalesce(a.nl, 0), coalesce(a.nh, 0), coalesce(a.nab, 0)
    from st left join agg a on a.staff_id = st.id
$$;

create or replace function private.salary_payable(p_salary bigint, p_w numeric, p_a numeric, p_p numeric)
returns bigint language sql immutable set search_path = '' as $$
  select case when p_w > 0 and p_salary is not null and p_a + p_p <= p_w and p_a >= 0 and p_p >= 0
              then round(p_salary * (p_a + p_p) / p_w)::bigint end
$$;

create or replace function private.get_salary_month(p_rev integer, p_month date, p_staff_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' set jit = off as $$
declare c record; v_month date := date_trunc('month', p_month)::date; v_end date; v_manage boolean; v_rows jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('staff_finance.read');
  if p_month is null then perform private.fail('VALIDATION_ERROR', 'Choose a month'); end if;
  v_end := (v_month + interval '1 month - 1 day')::date;
  v_manage := private.has_cap('staff_finance.manage');
  with b as (select * from private.salary_bulk(c.school_id, v_month, p_staff_group_id)),
  x as (
    select st.id, st.full_name, st.employee_no, st.staff_group_id, g.name as group_name, st.joined_on, st.left_on,
           b.monthly_salary_paise as sal, b.working_days as w, b.attended_days as a, b.paid_leave_days as p,
           b.unmarked_days, b.present, b.late, b.half_day, b.absent,
           private.salary_payable(b.monthly_salary_paise, b.working_days, b.attended_days, b.paid_leave_days) as payable,
           sc.id as saved_id, sc.version_no, sc.monthly_salary_paise as s_sal, sc.working_days as s_w, sc.attended_days as s_a,
           sc.paid_leave_days as s_p, sc.unpaid_days as s_u, sc.payable_paise as s_pay, sc.overrides as s_ov,
           sc.override_reason as s_reason, sc.created_at as s_at, sc.calculated_by as s_by
      from b join app.staff st on st.id = b.staff_id
      left join app.staff_groups g on g.id = st.staff_group_id
      left join app.salary_calculations sc on sc.staff_id = st.id and sc.month = v_month and sc.status = 'final'
  ),
  y as (
    select x.*,
           -- what the saved calculation would give today with its own overrides
           coalesce((s_ov->>'monthly_salary_paise')::bigint, sal) as c_sal,
           coalesce((s_ov->>'working_days')::numeric, w) as c_w,
           coalesce((s_ov->>'attended_days')::numeric, a) as c_a,
           coalesce((s_ov->>'paid_leave_days')::numeric, p) as c_p
      from x
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'staff_id', id, 'name', full_name, 'employee_no', employee_no, 'staff_group_id', staff_group_id,
      'group', group_name, 'joined_on', joined_on, 'left_on', left_on,
      'partial_month', joined_on > v_month or (left_on is not null and left_on < v_end),
      'status', case
         when saved_id is not null and (c_sal is distinct from s_sal or c_w is distinct from s_w or c_a is distinct from s_a
                                        or c_p is distinct from s_p
                                        or private.salary_payable(c_sal, c_w, c_a, c_p) is distinct from s_pay) then 'changed'
         when saved_id is not null then 'saved'
         when sal is null or w <= 0 then 'needs_resolution'
         else 'not_saved' end,
      'saved', case when saved_id is not null then jsonb_build_object('id', saved_id, 'version_no', version_no,
                 'monthly_salary_paise', s_sal, 'working_days', s_w, 'attended_days', s_a, 'paid_leave_days', s_p,
                 'unpaid_days', s_u, 'payable_paise', s_pay, 'overrides', s_ov, 'override_reason', s_reason, 'created_at', s_at,
                 'calculated_by', (select display_name from app.accounts where id = s_by)) end,
      'live', case when v_manage then jsonb_build_object(
                 'monthly_salary_paise', sal, 'working_days', w, 'attended_days', a, 'paid_leave_days', p,
                 'unpaid_days', w - a - p, 'payable_paise', payable,
                 'needs_manual_resolution', sal is null or w <= 0,
                 'resolution_reason', case when sal is null then 'No salary rate recorded'
                                           when w <= 0 then 'No working days in this month for this staff calendar' end,
                 'marked_days', jsonb_build_object('present', present, 'late', late, 'half_day', half_day, 'absent', absent),
                 'unmarked_count', unmarked_days) end)
      order by full_name), '[]'::jsonb)
    into v_rows from y;
  return jsonb_build_object('month', v_month, 'can_manage', v_manage, 'rows', v_rows,
    'totals', jsonb_build_object(
      'staff', jsonb_array_length(v_rows),
      'saved', (select count(*) from jsonb_array_elements(v_rows) r where r->>'status' in ('saved','changed')),
      'changed', (select count(*) from jsonb_array_elements(v_rows) r where r->>'status' = 'changed'),
      'needs_resolution', (select count(*) from jsonb_array_elements(v_rows) r where r->>'status' = 'needs_resolution'),
      'not_saved', (select count(*) from jsonb_array_elements(v_rows) r where r->>'status' = 'not_saved'),
      'saved_payable_paise', (select coalesce(sum((r->'saved'->>'payable_paise')::bigint), 0) from jsonb_array_elements(v_rows) r)));
end $$;

-- Lockdown (same block as 1400)
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
revoke execute on function private.run_maintenance(text) from authenticated;
grant execute on function private.salary_bulk(uuid, date, uuid), private.salary_payable(bigint, numeric, numeric, numeric) to authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
