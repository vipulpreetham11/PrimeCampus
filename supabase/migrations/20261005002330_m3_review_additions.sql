-- =============================================================================
-- PrimeCampus V1 — 2330 M3 review additions
--  * post_collection: the same payment (student, method, amount, received date) recorded in the last 30 minutes
--    is refused as DUPLICATE {possible_duplicate, collection_id, receipt_no, recorded_at} unless the user confirms
--    (p_allow_possible_duplicate). Catches a payment re-typed after a page reload or a discarded unconfirmed attempt.
--    A retry with the same operation id still replays as before.
--  * search_fee_students: find a student for fee work with fees.read (the Owner has no students.read_all)
--  * get_collection_report: by_collector carries collected_by, by_account carries receiving_account_id
-- =============================================================================
drop function if exists public.post_collection(integer, uuid, uuid, text, bigint, date, jsonb, uuid, text, text, text);
drop function if exists private.post_collection(integer, uuid, uuid, text, bigint, date, uuid, text, text, text, jsonb);
create or replace function private.post_collection(p_rev integer, p_operation_id uuid, p_student_id uuid, p_method text,
                                                   p_amount_paise bigint, p_received_on date, p_receiving_account_id uuid,
                                                   p_external_ref text, p_payer_name text, p_notes text, p_allocations jsonb,
                                                   p_allow_possible_duplicate boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_existing record; v_fp text; v_dup record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if p_operation_id is null then perform private.fail('VALIDATION_ERROR', 'operation id is required'); end if;
  if p_method not in ('cash','upi','bank_transfer') then
    perform private.fail('VALIDATION_ERROR', 'Use the cheque register for cheques');
  end if;
  if length(p_payer_name) > 200 or length(p_notes) > 1000 or length(p_external_ref) > 80 then
    perform private.fail('VALIDATION_ERROR', 'Payer name, reference or notes are too long');
  end if;
  if p_method in ('upi','bank_transfer') and private.normalize_ref(p_external_ref) is null then
    perform private.fail('VALIDATION_ERROR', 'Enter the UPI / bank transaction reference');
  end if;
  if p_method in ('upi','bank_transfer') and private.normalize_ref(p_external_ref) !~ '^[A-Z0-9]{3,80}$' then
    perform private.fail('VALIDATION_ERROR', 'Transaction reference must have at least 3 letters or digits');
  end if;
  v_fp := private.fingerprint(jsonb_build_object('s', p_student_id, 'm', p_method, 'a', p_amount_paise,
                                                 'd', p_received_on, 'acc', p_receiving_account_id,
                                                 'ref', p_external_ref, 'al', p_allocations));
  select col.id, r.id as receipt_id, r.receipt_no, col.amount_paise into v_existing
    from app.collections col join app.receipts r on r.collection_id = col.id
   where col.school_id = c.school_id and col.operation_id = p_operation_id;
  if v_existing.id is not null then
    perform private.idem_lookup(c.school_id, 'fees.post_collection', p_operation_id, v_fp);
    return jsonb_build_object('collection_id', v_existing.id, 'receipt_id', v_existing.receipt_id,
                              'receipt_no', v_existing.receipt_no, 'amount_paise', v_existing.amount_paise, 'replayed', true);
  end if;
  -- the same payment typed twice (page reloaded, or retried with a new id) is caught here; a genuine second
  -- payment is saved when the user confirms it (p_allow_possible_duplicate)
  if not coalesce(p_allow_possible_duplicate, false) then
    select col.id, col.created_at, r.receipt_no into v_dup
      from app.collections col join app.receipts r on r.collection_id = col.id
     where col.school_id = c.school_id and col.student_id = p_student_id and col.method = p_method
       and col.amount_paise = p_amount_paise and col.received_on = p_received_on
       and col.created_at > now() - interval '30 minutes'
     order by col.created_at desc limit 1;
    if v_dup.id is not null then
      perform private.fail('DUPLICATE',
        'The same payment for this student was recorded a few minutes ago (receipt ' || v_dup.receipt_no
        || '). If this is a second, separate payment, confirm and save again.',
        jsonb_build_object('possible_duplicate', true, 'collection_id', v_dup.id, 'receipt_no', v_dup.receipt_no,
                           'recorded_at', v_dup.created_at));
    end if;
  end if;
  begin
    perform private.idem_store(c.school_id, 'fees.post_collection', p_operation_id, v_fp, '{}'::jsonb);
  exception when unique_violation then
    perform private.fail('CONFLICT', 'This payment is already being saved. Wait a moment and refresh the student''s statement.');
  end;
  return private._post_collection(c.school_id, c.account_id, p_operation_id, p_student_id, p_method, p_amount_paise,
                                  p_received_on, p_receiving_account_id, p_external_ref, p_payer_name, p_notes,
                                  p_allocations, null);
end $$;


create or replace function private.get_collection_report(p_rev integer, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_tz text;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.read');
  if p_from is null or p_to is null or p_to < p_from then perform private.fail('VALIDATION_ERROR', 'Choose a valid date range'); end if;
  if p_to - p_from > 400 then perform private.fail('LIMIT_REACHED', 'Range too long'); end if;
  select coalesce(timezone, 'Asia/Kolkata') into v_tz from app.schools where id = c.school_id;
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'by_day_method', coalesce((select jsonb_agg(jsonb_build_object('date', received_on, 'method', method,
                        'count', n, 'amount_paise', amt) order by received_on, method)
                      from (select received_on, method, count(*) n, sum(amount_paise) amt from app.collections
                             where school_id = c.school_id and received_on between p_from and p_to
                             group by received_on, method) q), '[]'::jsonb),
    'by_collector', coalesce((select jsonb_agg(jsonb_build_object('collector', a.display_name, 'collected_by', q.collected_by, 'amount_paise', q.amt))
                      from (select collected_by, sum(amount_paise) amt from app.collections
                             where school_id = c.school_id and received_on between p_from and p_to group by collected_by) q
                      join app.accounts a on a.id = q.collected_by), '[]'::jsonb),
    'by_account', coalesce((select jsonb_agg(jsonb_build_object('account', coalesce(ra.label, 'Cash'), 'receiving_account_id', q.receiving_account_id, 'amount_paise', q.amt))
                      from (select receiving_account_id, sum(amount_paise) amt from app.collections
                             where school_id = c.school_id and received_on between p_from and p_to group by receiving_account_id) q
                      left join app.receiving_accounts ra on ra.id = q.receiving_account_id), '[]'::jsonb),
    'gross_posted_paise', (select coalesce(sum(amount_paise), 0) from app.collections
                            where school_id = c.school_id and received_on between p_from and p_to),
    'reversed_paise', (select coalesce(sum(amount_paise), 0) from app.collection_reversals
                        where school_id = c.school_id and (created_at at time zone v_tz)::date between p_from and p_to),
    'pending_cheques', (select jsonb_build_object('count', count(*), 'amount_paise', coalesce(sum(amount_paise), 0))
                          from app.cheques where school_id = c.school_id and status = 'pending'),
    'bounced_cheques_in_range', (select count(*) from app.cheques where school_id = c.school_id and status = 'bounced'
                                   and bounced_on between p_from and p_to),
    'concessions_paise', (select coalesce(sum(l.concession_paise), 0) from app.invoice_lines l join app.invoices i on i.id = l.invoice_id
                           where i.school_id = c.school_id and i.status = 'issued'
                             and (i.issued_at at time zone v_tz)::date between p_from and p_to),
    'waivers_paise', (select coalesce(-sum(amount_paise), 0) from app.invoice_adjustments
                       where school_id = c.school_id and kind in ('late_fee_waiver','discount')
                         and (created_at at time zone v_tz)::date between p_from and p_to));
end $$;



create or replace function private.search_fee_students(p_rev integer, p_q text, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_q text := lower(btrim(coalesce(p_q, ''))); v_year uuid; v_today date;
        v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.read');
  if length(v_q) < 2 then perform private.fail('VALIDATION_ERROR', 'Type at least 2 letters or digits'); end if;
  v_today := private.school_today(c.school_id);
  v_year := (select id from app.academic_years where school_id = c.school_id and is_current);
  return coalesce((select jsonb_agg(x order by x->>'name', x->>'admission_no') from (
    select jsonb_build_object('student_id', st.id, 'name', st.full_name, 'admission_no', st.admission_no,
             'status', st.status,
             'class_section', (select fp.class_name || ' ' || fp.section_name from private.fee_placement(st.id, v_year, v_today) fp),
             'balance_paise', (select coalesce(sum(b.balance_paise), 0) from private.invoice_balances(c.school_id, st.id) b)) as x
      from app.students st
     where st.school_id = c.school_id
       and (starts_with(lower(st.full_name), v_q) or lower(st.admission_no) = v_q or starts_with(lower(st.admission_no), v_q)
            or exists (select 1 from regexp_split_to_table(lower(st.full_name), '\s+') w where starts_with(w, v_q)))
     order by st.full_name limit v_limit) q), '[]'::jsonb);
end $$;

create or replace function public.post_collection(p_ctx_rev integer, p_operation_id uuid, p_student_id uuid, p_method text, p_amount_paise bigint, p_received_on date, p_allocations jsonb, p_receiving_account_id uuid default null, p_external_ref text default null, p_payer_name text default null, p_notes text default null, p_allow_possible_duplicate boolean default false)
returns jsonb language sql security invoker set search_path = '' as $$ select private.post_collection(p_ctx_rev, p_operation_id, p_student_id, p_method, p_amount_paise, p_received_on, p_receiving_account_id, p_external_ref, p_payer_name, p_notes, p_allocations, p_allow_possible_duplicate) $$;
create or replace function public.search_fee_students(p_ctx_rev integer, p_q text, p_limit integer default 20)
returns jsonb language sql security invoker set search_path = '' as $$ select private.search_fee_students(p_ctx_rev, p_q, p_limit) $$;

-- Lockdown (same block as 1400)
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on function
  private.post_collection(integer, uuid, uuid, text, bigint, date, uuid, text, text, text, jsonb, boolean),
  private.search_fee_students(integer, text, integer),
  private.get_collection_report(integer, date, date)
to authenticated;
grant execute on function
  public.post_collection(integer, uuid, uuid, text, bigint, date, jsonb, uuid, text, text, text, boolean),
  public.search_fee_students(integer, text, integer)
to authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
