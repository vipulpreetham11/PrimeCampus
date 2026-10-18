-- =============================================================================
-- PrimeCampus V1 — 2300 M3 fees backend
-- Gaps found before handing M3 (Fees) to the coding agent:
--  * reads for the fee screens: get_fee_setup, list_student_concessions, list_optional_fee_roster,
--    list_collections (day book / search), list_cheques, list_payment_exceptions
--  * writes: set_optional_fees (bulk, idempotent), cancel_cheque, resolve_payment_exception,
--    cancel_invoice (only unpaid invoices), record_payment_exception now takes an operation id,
--    grant_concession now takes an operation id and lists issued invoices it does not change,
--    retire_late_fee_rule; fee setup writes (heads, accounts, terms incl. retire, price lists,
--    concessions, late-fee rule) are definer functions with readable validation instead of raw
--    constraint errors
--  * money rules: a fixed concession is applied once per invoice (spread across its heads), not once
--    per line; students without a price are skipped and reported by name; retired terms can't be
--    issued; late fees are never added twice to one invoice; waive targets the unwaived late fee
--  * opening balances: shared core (_issue_opening_balance) used by the RPC and by a new import
--    dataset 'opening_balances' (needs imports.manage + fees.manage); replay with a different
--    student/amount is refused
--  * dues report counts every debt (also students with no placement), filters by term and balance
--  * statement: per-payment allocations; collection report uses the school's time zone
-- =============================================================================
-- -----------------------------------------------------------------------------
-- Reads for fee setup forms
-- -----------------------------------------------------------------------------
create or replace function private.get_fee_setup(p_rev integer, p_academic_year_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_year uuid;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.read');
  v_year := coalesce(p_academic_year_id, (select id from app.academic_years where school_id = c.school_id and is_current));
  if v_year is not null and not exists (select 1 from app.academic_years where id = v_year and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Academic year not found');
  end if;
  return jsonb_build_object(
    'academic_year_id', v_year, 'can_manage', private.has_cap('fees.manage'),
    'fee_heads', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'code', code, 'kind', kind,
                     'is_optional', is_optional, 'status', status, 'version', version) order by status, upper(code))
                   from app.fee_heads where school_id = c.school_id), '[]'::jsonb),
    'receiving_accounts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'kind', kind,
                     'bank_name', bank_name, 'account_last4', account_last4, 'ifsc', ifsc, 'upi_id', upi_id,
                     'status', status, 'version', version) order by status, label)
                   from app.receiving_accounts where school_id = c.school_id), '[]'::jsonb),
    'terms', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'sort_order', sort_order,
                     'due_date', due_date, 'status', status, 'version', version,
                     'invoices_issued', (select count(*) from app.invoices i where i.fee_term_id = t.id and i.status = 'issued'))
                     order by sort_order, due_date)
                   from app.fee_terms t where school_id = c.school_id and academic_year_id = v_year), '[]'::jsonb),
    'structure', coalesce((select jsonb_agg(jsonb_build_object('fee_term_id', fsl.fee_term_id, 'class_id', fsl.class_id,
                     'fee_head_id', fsl.fee_head_id, 'amount_paise', fsl.amount_paise))
                   from app.fee_structure_lines fsl
                  where fsl.school_id = c.school_id and fsl.academic_year_id = v_year and fsl.status = 'active'), '[]'::jsonb),
    'concession_presets', coalesce((select jsonb_agg(jsonb_build_object('id', cp.id, 'name', cp.name, 'kind', cp.kind,
                     'percent_bp', cp.percent_bp, 'fixed_paise', cp.fixed_paise, 'status', cp.status, 'version', cp.version,
                     'fee_head_ids', coalesce((select jsonb_agg(cph.fee_head_id) from app.concession_preset_heads cph
                                                where cph.preset_id = cp.id), '[]'::jsonb)) order by cp.status, cp.name)
                   from app.concession_presets cp where cp.school_id = c.school_id), '[]'::jsonb),
    'late_fee_rule', (select jsonb_build_object('id', r.id, 'fee_head_id', r.fee_head_id, 'amount_paise', r.amount_paise,
                     'grace_days', r.grace_days)
                   from app.late_fee_rules r where r.school_id = c.school_id and r.academic_year_id = v_year and r.status = 'active'));
end $$;

create or replace function private.list_student_concessions(p_rev integer, p_academic_year_id uuid, p_student_id uuid,
                                                            p_include_revoked boolean, p_after_id uuid, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_items jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.read');
  select coalesce(jsonb_agg(x order by x->>'id'), '[]') into v_items from (
    select jsonb_build_object('id', sc.id, 'student_id', sc.student_id, 'name', st.full_name, 'admission_no', st.admission_no,
             'academic_year_id', sc.academic_year_id, 'preset_id', sc.preset_id, 'preset_name', cp.name,
             'kind', cp.kind, 'percent_bp', cp.percent_bp, 'fixed_paise', cp.fixed_paise,
             'fee_term_id', sc.fee_term_id, 'term', (select name from app.fee_terms where id = sc.fee_term_id),
             'reason', sc.reason, 'status', sc.status,
             'granted_by', (select display_name from app.accounts where id = sc.granted_by), 'granted_at', sc.granted_at,
             'revoked_at', sc.revoked_at, 'revoke_reason', sc.revoke_reason) as x
      from app.student_concessions sc join app.students st on st.id = sc.student_id
      join app.concession_presets cp on cp.id = sc.preset_id
     where sc.school_id = c.school_id
       and (p_academic_year_id is null or sc.academic_year_id = p_academic_year_id)
       and (p_student_id is null or sc.student_id = p_student_id)
       and (coalesce(p_include_revoked, false) or sc.status = 'active')
       and (p_after_id is null or sc.id > p_after_id)
     order by sc.id limit v_limit) q;
  return jsonb_build_object('items', v_items,
    'next_cursor', case when jsonb_array_length(v_items) = v_limit then v_items->-1->>'id' end);
end $$;

-- -----------------------------------------------------------------------------
-- Optional fees: roster per section + bulk save
-- -----------------------------------------------------------------------------
create or replace function private.list_optional_fee_roster(p_rev integer, p_academic_year_id uuid, p_fee_head_id uuid, p_section_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_today date;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.read');
  if not exists (select 1 from app.fee_heads where id = p_fee_head_id and school_id = c.school_id and is_optional) then
    perform private.fail('VALIDATION_ERROR', 'Choose an optional fee head');
  end if;
  if not exists (select 1 from app.sections where id = p_section_id and school_id = c.school_id and academic_year_id = p_academic_year_id) then
    perform private.fail('NOT_FOUND', 'Section not found in that year');
  end if;
  v_today := greatest(private.school_today(c.school_id), (select start_date from app.academic_years where id = p_academic_year_id));
  return coalesce((select jsonb_agg(jsonb_build_object('student_id', st.id, 'name', st.full_name, 'admission_no', st.admission_no,
             'roll_no', p.roll_no,
             'enabled', exists (select 1 from app.student_optional_fees so where so.student_id = st.id
                                  and so.academic_year_id = p_academic_year_id and so.fee_head_id = p_fee_head_id and so.status = 'active'))
             order by p.roll_no nulls last, st.full_name)
    from app.placements p join app.students st on st.id = p.student_id
   where p.section_id = p_section_id and st.status = 'active'
     and p.effective_from <= v_today and (p.effective_to is null or p.effective_to > v_today)), '[]'::jsonb);
end $$;

create or replace function private.set_optional_fees(p_rev integer, p_operation_id uuid, p_academic_year_id uuid,
                                                     p_fee_head_id uuid, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_fp text; v_prev jsonb; x jsonb; v_on integer := 0; v_off integer := 0; v_n integer;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if p_operation_id is null then perform private.fail('VALIDATION_ERROR', 'operation id is required'); end if;
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) not between 1 and 500 then
    perform private.fail('VALIDATION_ERROR', 'Send 1–500 changes');
  end if;
  v_fp := private.fingerprint(jsonb_build_object('y', p_academic_year_id, 'h', p_fee_head_id, 'c', p_changes));
  v_prev := private.idem_lookup(c.school_id, 'fees.optional', p_operation_id, v_fp);
  if v_prev is not null then return v_prev; end if;
  if not exists (select 1 from app.fee_heads where id = p_fee_head_id and school_id = c.school_id and is_optional and status = 'active') then
    perform private.fail('VALIDATION_ERROR', 'Choose an active optional fee head');
  end if;
  if not exists (select 1 from app.academic_years where id = p_academic_year_id and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Academic year not found');
  end if;
  if exists (select 1 from jsonb_array_elements(p_changes) y
              where jsonb_typeof(y->'enabled') <> 'boolean'
                 or not exists (select 1 from app.students s where s.id = (y->>'student_id')::uuid and s.school_id = c.school_id)) then
    perform private.fail('VALIDATION_ERROR', 'Each change needs a student of this school and enabled true/false');
  end if;
  for x in select * from jsonb_array_elements(p_changes) loop
    if (x->>'enabled')::boolean then
      insert into app.student_optional_fees (school_id, student_id, academic_year_id, fee_head_id, created_by)
      select c.school_id, (x->>'student_id')::uuid, p_academic_year_id, p_fee_head_id, c.account_id
       where not exists (select 1 from app.student_optional_fees where student_id = (x->>'student_id')::uuid
                           and academic_year_id = p_academic_year_id and fee_head_id = p_fee_head_id and status = 'active');
      get diagnostics v_n = row_count; v_on := v_on + v_n;
    else
      update app.student_optional_fees set status = 'removed'
       where student_id = (x->>'student_id')::uuid and academic_year_id = p_academic_year_id
         and fee_head_id = p_fee_head_id and status = 'active' and school_id = c.school_id;
      get diagnostics v_n = row_count; v_off := v_off + v_n;
    end if;
  end loop;
  v_prev := jsonb_build_object('enabled', v_on, 'disabled', v_off,
              'note', 'Applies to invoices issued from now on; issued invoices change only via adjustments');
  perform private.log_event('fees.optional_fees.set', 'fee_heads', p_fee_head_id::text, v_prev, p_operation_id, p_academic_year_id);
  perform private.idem_store(c.school_id, 'fees.optional', p_operation_id, v_fp, v_prev);
  return v_prev;
end $$;

-- -----------------------------------------------------------------------------
-- Day book / search, cheque register, payment exceptions
-- -----------------------------------------------------------------------------
create or replace function private.list_collections(p_rev integer, p_from date, p_to date, p_method text, p_receiving_account_id uuid,
                                                    p_collected_by uuid, p_search text, p_before_date date, p_before_id uuid,
                                                    p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_items jsonb; v_q text := nullif(btrim(p_search), '');
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.read');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    perform private.fail('LIMIT_REACHED', 'Choose a range up to 400 days');
  end if;
  if (p_before_date is null) <> (p_before_id is null) then perform private.fail('VALIDATION_ERROR', 'Pass both cursor values, or neither'); end if;
  select coalesce(jsonb_agg(x order by (x->>'received_on') desc, x->>'collection_id' desc), '[]') into v_items from (
    select jsonb_build_object('collection_id', col.id, 'receipt_id', r.id, 'receipt_no', r.receipt_no,
             'received_on', col.received_on, 'student_id', st.id, 'name', st.full_name, 'admission_no', st.admission_no,
             'method', col.method, 'amount_paise', col.amount_paise,
             'reversed_paise', (select coalesce(sum(cr.amount_paise), 0) from app.collection_reversals cr where cr.collection_id = col.id),
             'external_ref', col.external_ref, 'payer_name', col.payer_name,
             'account', coalesce(ra.label, 'Cash'), 'receiving_account_id', col.receiving_account_id,
             'collector', a.display_name, 'collected_by', col.collected_by, 'created_at', col.created_at) as x
      from app.collections col
      join app.receipts r on r.collection_id = col.id
      join app.students st on st.id = col.student_id
      join app.accounts a on a.id = col.collected_by
      left join app.receiving_accounts ra on ra.id = col.receiving_account_id
     where col.school_id = c.school_id and col.received_on between p_from and p_to
       and (p_method is null or col.method = p_method)
       and (p_receiving_account_id is null or col.receiving_account_id = p_receiving_account_id)
       and (p_collected_by is null or col.collected_by = p_collected_by)
       and (v_q is null or upper(r.receipt_no) = upper(v_q) or upper(st.admission_no) = upper(v_q)
            or col.external_ref_norm = private.normalize_ref(v_q) or lower(st.full_name) like lower(v_q) || '%')
       and (p_before_date is null or (col.received_on, col.id) < (p_before_date, p_before_id))
     order by col.received_on desc, col.id desc limit v_limit) q;
  return jsonb_build_object('items', v_items,
    'next_cursor', case when jsonb_array_length(v_items) = v_limit
                        then jsonb_build_object('before_date', v_items->-1->>'received_on', 'before_id', v_items->-1->>'collection_id') end);
end $$;

create or replace function private.list_cheques(p_rev integer, p_status text, p_from date, p_to date, p_before_date date,
                                                p_before_id uuid, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_items jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.read');
  if p_status is not null and p_status not in ('pending','cleared','bounced','cancelled') then
    perform private.fail('VALIDATION_ERROR', 'Unknown status');
  end if;
  if (p_before_date is null) <> (p_before_id is null) then perform private.fail('VALIDATION_ERROR', 'Pass both cursor values, or neither'); end if;
  select coalesce(jsonb_agg(x order by (x->>'received_on') desc, x->>'cheque_id' desc), '[]') into v_items from (
    select jsonb_build_object('cheque_id', ch.id, 'cheque_no', ch.cheque_no, 'bank_name', ch.bank_name,
             'cheque_date', ch.cheque_date, 'amount_paise', ch.amount_paise, 'student_id', st.id, 'name', st.full_name,
             'admission_no', st.admission_no, 'received_on', ch.received_on, 'status', ch.status,
             'account', ra.label, 'cleared_on', ch.cleared_on, 'bounced_on', ch.bounced_on, 'bounce_reason', ch.bounce_reason,
             'receipt_no', (select r.receipt_no from app.receipts r where r.collection_id = ch.collection_id),
             'planned_allocations', (select coalesce(jsonb_agg(jsonb_build_object('invoice_id', i.id, 'invoice_no', i.invoice_no,
                                       'amount_paise', (pa->>'amount_paise')::bigint)), '[]'::jsonb)
                                     from jsonb_array_elements(ch.planned_allocations) pa join app.invoices i on i.id = (pa->>'invoice_id')::uuid),
             'version', ch.version) as x
      from app.cheques ch join app.students st on st.id = ch.student_id
      join app.receiving_accounts ra on ra.id = ch.receiving_account_id
     where ch.school_id = c.school_id and (p_status is null or ch.status = p_status)
       and (p_from is null or ch.received_on >= p_from) and (p_to is null or ch.received_on <= p_to)
       and (p_before_date is null or (ch.received_on, ch.id) < (p_before_date, p_before_id))
     order by ch.received_on desc, ch.id desc limit v_limit) q;
  return jsonb_build_object('items', v_items,
    'next_cursor', case when jsonb_array_length(v_items) = v_limit
                        then jsonb_build_object('before_date', v_items->-1->>'received_on', 'before_id', v_items->-1->>'cheque_id') end);
end $$;

create or replace function private.cancel_cheque(p_rev integer, p_cheque_id uuid, p_reason text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_ch app.cheques;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if coalesce(btrim(p_reason), '') = '' then perform private.fail('VALIDATION_ERROR', 'A reason is required'); end if;
  select * into v_ch from app.cheques where id = p_cheque_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Cheque not found'); end if;
  if v_ch.status = 'cancelled' then return jsonb_build_object('cheque_id', v_ch.id, 'status', 'cancelled', 'replayed', true); end if;
  if v_ch.status <> 'pending' then perform private.fail('VALIDATION_ERROR', 'Only a pending cheque can be cancelled'); end if;
  if p_expected_version is not null and p_expected_version <> v_ch.version then
    perform private.fail('CONFLICT', 'This cheque changed since you opened it');
  end if;
  update app.cheques set status = 'cancelled', bounce_reason = left('Cancelled: ' || p_reason, 500) where id = v_ch.id;
  perform private.log_event('fees.cheque.cancelled', 'cheques', v_ch.id::text, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('cheque_id', v_ch.id, 'status', 'cancelled');
end $$;

-- Excess / unidentified money: recorded, never credited (AC-25). Idempotent per operation id.
drop function if exists public.record_payment_exception(integer, text, bigint, text, uuid, uuid, text);
create or replace function private.record_payment_exception(p_rev integer, p_operation_id uuid, p_kind text, p_amount_paise bigint,
                                                            p_note text, p_student_id uuid, p_collection_id uuid, p_reference text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_fp text; v_prev jsonb; v_id uuid;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if p_operation_id is null then perform private.fail('VALIDATION_ERROR', 'operation id is required'); end if;
  v_fp := private.fingerprint(jsonb_build_object('k', p_kind, 'a', p_amount_paise, 'n', p_note, 's', p_student_id,
                                                 'c', p_collection_id, 'r', p_reference));
  v_prev := private.idem_lookup(c.school_id, 'fees.exception', p_operation_id, v_fp);
  if v_prev is not null then return v_prev; end if;
  if p_kind not in ('overpayment','unidentified','other') then perform private.fail('VALIDATION_ERROR', 'Unknown exception type'); end if;
  if p_amount_paise is null or p_amount_paise <= 0 then perform private.fail('VALIDATION_ERROR', 'Amount must be positive'); end if;
  if length(btrim(coalesce(p_note, ''))) = 0 or length(p_note) > 1000 then
    perform private.fail('VALIDATION_ERROR', 'Add a note (up to 1000 characters)');
  end if;
  if length(p_reference) > 120 then perform private.fail('VALIDATION_ERROR', 'Reference can be at most 120 characters'); end if;
  if p_student_id is not null and not exists (select 1 from app.students where id = p_student_id and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Student not found');
  end if;
  if p_collection_id is not null and not exists (select 1 from app.collections where id = p_collection_id and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Collection not found');
  end if;
  insert into app.payment_exceptions (school_id, student_id, kind, amount_paise, collection_id, reference, note, created_by)
  values (c.school_id, p_student_id, p_kind, p_amount_paise, p_collection_id, p_reference, btrim(p_note), c.account_id)
  returning id into v_id;
  v_prev := jsonb_build_object('payment_exception_id', v_id);
  perform private.log_event('fees.exception.recorded', 'payment_exceptions', v_id::text,
                            jsonb_build_object('kind', p_kind, 'amount_paise', p_amount_paise), p_operation_id);
  perform private.idem_store(c.school_id, 'fees.exception', p_operation_id, v_fp, v_prev);
  return v_prev;
end $$;

create or replace function private.list_payment_exceptions(p_rev integer, p_status text, p_before_id uuid, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_items jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.read');
  if p_status is not null and p_status not in ('open','resolved') then perform private.fail('VALIDATION_ERROR', 'Unknown status'); end if;
  select coalesce(jsonb_agg(x order by x->>'id' desc), '[]') into v_items from (
    select jsonb_build_object('id', e.id, 'kind', e.kind, 'amount_paise', e.amount_paise, 'student_id', e.student_id,
             'name', st.full_name, 'admission_no', st.admission_no, 'collection_id', e.collection_id,
             'receipt_no', (select r.receipt_no from app.receipts r where r.collection_id = e.collection_id),
             'reference', e.reference, 'note', e.note, 'status', e.status, 'resolution_note', e.resolution_note,
             'created_by', (select display_name from app.accounts where id = e.created_by), 'created_at', e.created_at,
             'resolved_by', (select display_name from app.accounts where id = e.resolved_by), 'resolved_at', e.resolved_at,
             'version', e.version) as x
      from app.payment_exceptions e left join app.students st on st.id = e.student_id
     where e.school_id = c.school_id and (p_status is null or e.status = p_status)
       and (p_before_id is null or e.id < p_before_id)
     order by e.id desc limit v_limit) q;
  return jsonb_build_object('items', v_items,
    'next_cursor', case when jsonb_array_length(v_items) = v_limit then v_items->-1->>'id' end);
end $$;

create or replace function private.resolve_payment_exception(p_rev integer, p_id uuid, p_note text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_e app.payment_exceptions;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if length(btrim(coalesce(p_note, ''))) = 0 or length(p_note) > 1000 then
    perform private.fail('VALIDATION_ERROR', 'Describe how it was resolved (up to 1000 characters)');
  end if;
  select * into v_e from app.payment_exceptions where id = p_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Exception not found'); end if;
  if v_e.status = 'resolved' then perform private.fail('VALIDATION_ERROR', 'Already resolved'); end if;
  if p_expected_version is not null and p_expected_version <> v_e.version then
    perform private.fail('CONFLICT', 'This exception changed since you opened it');
  end if;
  update app.payment_exceptions set status = 'resolved', resolution_note = btrim(p_note), resolved_by = c.account_id,
         resolved_at = now() where id = v_e.id returning * into v_e;
  perform private.log_event('fees.exception.resolved', 'payment_exceptions', v_e.id::text, jsonb_build_object('note', p_note));
  return jsonb_build_object('id', v_e.id, 'status', v_e.status, 'version', v_e.version);
end $$;

-- -----------------------------------------------------------------------------
-- Invoice cancellation (nothing paid, no pending cheque)
-- -----------------------------------------------------------------------------
create or replace function private.cancel_invoice(p_rev integer, p_operation_id uuid, p_invoice_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_inv app.invoices; v_paid bigint;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if coalesce(btrim(p_reason), '') = '' or length(p_reason) > 500 then
    perform private.fail('VALIDATION_ERROR', 'Give a reason (up to 500 characters)');
  end if;
  select * into v_inv from app.invoices where id = p_invoice_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Invoice not found'); end if;
  if v_inv.status = 'cancelled' then return jsonb_build_object('invoice_id', v_inv.id, 'status', 'cancelled', 'replayed', true); end if;
  select b.allocated_paise - b.reversed_paise into v_paid from private.invoice_balances(c.school_id, v_inv.student_id) b
   where b.invoice_id = v_inv.id;
  if v_paid > 0 then perform private.fail('VALIDATION_ERROR', 'Money is allocated to this invoice; reverse the collection first'); end if;
  if exists (select 1 from app.cheques ch, jsonb_array_elements(ch.planned_allocations) pa
              where ch.school_id = c.school_id and ch.status = 'pending' and (pa->>'invoice_id')::uuid = v_inv.id) then
    perform private.fail('VALIDATION_ERROR', 'A pending cheque is planned against this invoice; cancel or bounce it first');
  end if;
  update app.invoices set status = 'cancelled', cancelled_by = c.account_id, cancelled_at = now(), cancel_reason = btrim(p_reason)
   where id = v_inv.id;
  perform private.log_event('fees.invoice.cancelled', 'invoices', v_inv.id::text,
                            jsonb_build_object('invoice_no', v_inv.invoice_no, 'reason', p_reason), p_operation_id, v_inv.academic_year_id);
  return jsonb_build_object('invoice_id', v_inv.id, 'status', 'cancelled',
    'note', case when v_inv.source = 'term' then 'Re-issuing this term for the student creates nothing; the term key stays used' end);
end $$;

-- -----------------------------------------------------------------------------
-- Opening balances: shared core used by the RPC and the import
-- -----------------------------------------------------------------------------
create or replace function private.rupees_to_paise(p_text text)
returns bigint language plpgsql immutable set search_path = '' as $$
declare t text := regexp_replace(coalesce(p_text, ''), '(₹|rs\.?|inr|,|\s)', '', 'gi'); m text[];
begin
  m := regexp_match(t, '^(\d{1,9})(?:\.(\d{1,2}))?$');
  if m is null then return null; end if;
  return m[1]::bigint * 100 + coalesce(rpad(m[2], 2, '0'), '00')::bigint;
end $$;

-- Same key whether a balance is typed in Fees or imported: admission no + head code + reference
create or replace function private.opening_key(p_admission_no text, p_head_code text, p_ref text)
returns text language sql immutable set search_path = '' as $$
  select case when length(k) > 150 then 'md5:' || md5(k) else k end
    from (select upper(btrim(p_admission_no)) || ':' || upper(btrim(p_head_code)) || ':' || upper(btrim(p_ref)) as k) q
$$;

create or replace function private._issue_opening_balance(p_school uuid, p_actor uuid, p_student_id uuid, p_academic_year_id uuid,
                                                          p_fee_head_id uuid, p_amount_paise bigint, p_origin_label text,
                                                          p_source_ref text, p_due_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_inv app.invoices; v_no integer; v_year app.academic_years; v_st record; v_fh app.fee_heads; v_amt bigint;
begin
  if p_amount_paise is null or p_amount_paise <= 0 then perform private.fail('VALIDATION_ERROR', 'Opening balance must be positive'); end if;
  if coalesce(btrim(p_source_ref), '') = '' or length(p_source_ref) > 190 then
    perform private.fail('VALIDATION_ERROR', 'A source reference (up to 190 characters) is required');
  end if;
  if length(p_origin_label) > 120 then perform private.fail('VALIDATION_ERROR', 'Origin can be at most 120 characters'); end if;
  select full_name, admission_no into v_st from app.students where id = p_student_id and school_id = p_school;
  if v_st.full_name is null then perform private.fail('NOT_FOUND', 'Student not found'); end if;
  select * into v_year from app.academic_years where id = p_academic_year_id and school_id = p_school;
  if v_year.id is null then perform private.fail('NOT_FOUND', 'Academic year not found'); end if;
  select * into v_fh from app.fee_heads where id = p_fee_head_id and school_id = p_school;
  if v_fh.id is null or v_fh.status <> 'active' or v_fh.kind = 'late_fee' then
    perform private.fail('VALIDATION_ERROR', 'Choose an active regular or other fee head');
  end if;
  select * into v_inv from app.invoices where school_id = p_school and source_key = 'opening:' || p_source_ref;
  if v_inv.id is not null then
    select gross_paise into v_amt from app.invoice_lines where invoice_id = v_inv.id limit 1;
    if v_inv.student_id <> p_student_id or v_amt <> p_amount_paise then
      perform private.fail('DUPLICATE', 'This source reference was already used for a different student or amount',
                           jsonb_build_object('invoice_id', v_inv.id, 'invoice_no', v_inv.invoice_no));
    end if;
    return jsonb_build_object('invoice_id', v_inv.id, 'invoice_no', v_inv.invoice_no, 'replayed', true);
  end if;
  v_no := private.next_doc_number(p_school, v_year.id, 'invoice');
  insert into app.invoices (school_id, academic_year_id, student_id, invoice_no, source, source_key, origin_label,
                            due_date, snapshot, issued_by)
  values (p_school, v_year.id, p_student_id, 'INV/' || v_year.name || '/' || lpad(v_no::text, 5, '0'),
          'opening_balance', 'opening:' || p_source_ref, p_origin_label, coalesce(p_due_date, v_year.start_date),
          jsonb_build_object('school_name', (select name from app.schools where id = p_school),
                             'student_name', v_st.full_name, 'admission_no', v_st.admission_no, 'year', v_year.name,
                             'origin', p_origin_label),
          p_actor)
  returning * into v_inv;
  insert into app.invoice_lines (school_id, invoice_id, fee_head_id, label, gross_paise)
  values (p_school, v_inv.id, p_fee_head_id, 'Opening balance' || coalesce(' (' || p_origin_label || ')', ''), p_amount_paise);
  return jsonb_build_object('invoice_id', v_inv.id, 'invoice_no', v_inv.invoice_no);
end $$;

create or replace function private.issue_opening_balance(p_rev integer, p_student_id uuid, p_academic_year_id uuid,
                                                         p_fee_head_id uuid, p_amount_paise bigint, p_origin_label text,
                                                         p_source_ref text, p_due_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v jsonb; v_adm text; v_code text;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if coalesce(btrim(p_source_ref), '') = '' or length(p_source_ref) > 60 then
    perform private.fail('VALIDATION_ERROR', 'A reference (up to 60 characters) is required, for example the old ledger page');
  end if;
  if coalesce(btrim(p_origin_label), '') = '' then perform private.fail('VALIDATION_ERROR', 'Say what the balance is for'); end if;
  select admission_no into v_adm from app.students where id = p_student_id and school_id = c.school_id;
  if v_adm is null then perform private.fail('NOT_FOUND', 'Student not found'); end if;
  select code into v_code from app.fee_heads where id = p_fee_head_id and school_id = c.school_id;
  if v_code is null then perform private.fail('VALIDATION_ERROR', 'Choose an active regular or other fee head'); end if;
  v := private._issue_opening_balance(c.school_id, c.account_id, p_student_id, p_academic_year_id, p_fee_head_id,
                                      p_amount_paise, btrim(p_origin_label), private.opening_key(v_adm, v_code, p_source_ref),
                                      p_due_date);
  if not (v ? 'replayed') then
    perform private.log_event('fees.opening_balance.issued', 'invoices', v->>'invoice_id',
                              jsonb_build_object('student_id', p_student_id, 'amount_paise', p_amount_paise, 'origin', p_origin_label),
                              null, p_academic_year_id);
  end if;
  return v;
end $$;

-- -----------------------------------------------------------------------------
-- Late fees: one per invoice EVER (a rule edit never re-charges); waiver targets the unwaived charge
-- -----------------------------------------------------------------------------
create or replace function private.evaluate_late_fees(p_rev integer, p_as_of date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_added integer; v_pending jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if p_as_of is null or p_as_of > private.school_today(c.school_id) then perform private.fail('VALIDATION_ERROR', 'Choose today or an earlier date'); end if;
  select coalesce(jsonb_agg(distinct (pa->>'invoice_id')), '[]') into v_pending
    from app.cheques ch, jsonb_array_elements(ch.planned_allocations) pa
   where ch.school_id = c.school_id and ch.status = 'pending';
  insert into app.invoice_adjustments (school_id, invoice_id, student_id, kind, amount_paise, fee_head_id,
                                       late_fee_rule_id, reason, created_by)
  select c.school_id, b.invoice_id, b.student_id, 'late_fee', r.amount_paise, r.fee_head_id, r.id,
         'Late fee after ' || (i.due_date + r.grace_days), c.account_id
    from private.invoice_balances(c.school_id) b
    join app.invoices i on i.id = b.invoice_id
    join app.late_fee_rules r on r.academic_year_id = b.academic_year_id and r.status = 'active'
   where b.status = 'issued' and b.source = 'term' and b.balance_paise > 0
     and p_as_of > i.due_date + r.grace_days
     and not (v_pending ? b.invoice_id::text)
     and not exists (select 1 from app.invoice_adjustments x where x.invoice_id = b.invoice_id and x.kind = 'late_fee')
  on conflict do nothing;
  get diagnostics v_added = row_count;
  perform private.log_event('fees.late_fees.evaluated', 'invoices', null,
                            jsonb_build_object('as_of', p_as_of, 'added', v_added, 'skipped_pending_cheque', v_pending));
  return jsonb_build_object('late_fees_added', v_added, 'skipped_pending_cheque', v_pending);
end $$;

create or replace function private.waive_late_fee(p_rev integer, p_invoice_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_lf app.invoice_adjustments; v_bal bigint; v_id uuid;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if coalesce(btrim(p_reason), '') = '' or length(p_reason) > 500 then
    perform private.fail('VALIDATION_ERROR', 'Give a reason (up to 500 characters)');
  end if;
  perform 1 from app.invoices where id = p_invoice_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Invoice not found'); end if;
  select * into v_lf from app.invoice_adjustments lf
   where lf.invoice_id = p_invoice_id and lf.kind = 'late_fee'
     and not exists (select 1 from app.invoice_adjustments w where w.invoice_id = lf.invoice_id and w.kind = 'late_fee_waiver'
                       and w.late_fee_rule_id = lf.late_fee_rule_id)
   order by lf.created_at desc limit 1;
  if not found then
    select id into v_id from app.invoice_adjustments where invoice_id = p_invoice_id and kind = 'late_fee_waiver'
     order by created_at desc limit 1;
    if v_id is not null then return jsonb_build_object('adjustment_id', v_id, 'replayed', true); end if;
    perform private.fail('VALIDATION_ERROR', 'No late fee on this invoice');
  end if;
  v_bal := private.invoice_balance(p_invoice_id);
  if v_bal < v_lf.amount_paise then
    perform private.fail('VALIDATION_ERROR', 'Late fee is already paid; reverse the collection first if it was wrong');
  end if;
  insert into app.invoice_adjustments (school_id, invoice_id, student_id, kind, amount_paise, fee_head_id,
                                       late_fee_rule_id, reason, created_by)
  values (c.school_id, p_invoice_id, v_lf.student_id, 'late_fee_waiver', -v_lf.amount_paise, v_lf.fee_head_id,
          v_lf.late_fee_rule_id, btrim(p_reason), c.account_id)
  returning id into v_id;
  perform private.log_event('fees.late_fee.waived', 'invoices', p_invoice_id::text, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('adjustment_id', v_id, 'balance_paise', v_bal - v_lf.amount_paise);
end $$;

-- -----------------------------------------------------------------------------
-- Term lines: fixed concession applies ONCE per invoice, spread over the preset's heads
-- (by head code) and capped per line; percent per line. Names added for the preview.
-- -----------------------------------------------------------------------------
create or replace function private.compute_term_lines(p_school uuid, p_term uuid, p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_term app.fee_terms; v_pl record; v_lines jsonb := '[]'; v_conflict jsonb; v_missing jsonb; v_st record;
        h record; v_left jsonb := '{}'; v_conc bigint; v_key text;
begin
  select * into v_term from app.fee_terms where id = p_term and school_id = p_school;
  select full_name, admission_no into v_st from app.students where id = p_student;
  select * into v_pl from private.fee_placement(p_student, v_term.academic_year_id, private.school_today(p_school));
  if v_pl.section_id is null then
    return jsonb_build_object('student_id', p_student, 'name', v_st.full_name, 'admission_no', v_st.admission_no,
                              'skip_reason', 'No placement in this academic year');
  end if;

  select coalesce(jsonb_agg(fee_head_id), '[]') into v_conflict from (
    select cph.fee_head_id
      from app.student_concessions sc
      join app.concession_presets cp on cp.id = sc.preset_id
      join app.concession_preset_heads cph on cph.preset_id = cp.id
     where sc.student_id = p_student and sc.academic_year_id = v_term.academic_year_id and sc.status = 'active'
       and (sc.fee_term_id is null or sc.fee_term_id = p_term)
     group by cph.fee_head_id having count(*) > 1) q;

  for h in
    select fsl.fee_head_id, fh.name, fh.code, fsl.amount_paise as gross,
           sc.id as sc_id, cp.id as preset_id, cp.kind, cp.percent_bp, cp.fixed_paise, cp.name as preset_name
      from app.fee_structure_lines fsl
      join app.fee_heads fh on fh.id = fsl.fee_head_id and fh.status = 'active'
      left join lateral (
        select sc.id, sc.preset_id from app.student_concessions sc
          join app.concession_preset_heads cph on cph.preset_id = sc.preset_id and cph.fee_head_id = fsl.fee_head_id
         where sc.student_id = p_student and sc.academic_year_id = v_term.academic_year_id and sc.status = 'active'
           and (sc.fee_term_id is null or sc.fee_term_id = p_term)
           and not (v_conflict ? fsl.fee_head_id::text)
         limit 1) sc on true
      left join app.concession_presets cp on cp.id = sc.preset_id
     where fsl.fee_term_id = p_term and fsl.class_id = v_pl.class_id and fsl.status = 'active'
       and (not fh.is_optional or exists (select 1 from app.student_optional_fees so
                                            where so.student_id = p_student and so.fee_head_id = fh.id
                                              and so.academic_year_id = v_term.academic_year_id and so.status = 'active'))
     order by upper(fh.code)
  loop
    if h.sc_id is null then v_conc := 0;
    elsif h.kind = 'percent' then v_conc := least(h.gross, round(h.gross * h.percent_bp / 10000.0)::bigint);
    else
      v_key := h.sc_id::text;
      if not (v_left ? v_key) then v_left := v_left || jsonb_build_object(v_key, h.fixed_paise); end if;
      v_conc := least(h.gross, (v_left->>v_key)::bigint);
      v_left := v_left || jsonb_build_object(v_key, (v_left->>v_key)::bigint - v_conc);
    end if;
    v_lines := v_lines || jsonb_build_object('fee_head_id', h.fee_head_id, 'label', h.name, 'gross_paise', h.gross,
                 'student_concession_id', h.sc_id, 'concession_name', h.preset_name, 'concession_paise', v_conc);
  end loop;

  select jsonb_agg(distinct fh.name) into v_missing
    from app.fee_structure_lines o
    join app.fee_heads fh on fh.id = o.fee_head_id and not fh.is_optional and fh.kind = 'regular' and fh.status = 'active'
   where o.fee_term_id = p_term and o.status = 'active'
     and not exists (select 1 from app.fee_structure_lines x where x.fee_term_id = p_term and x.class_id = v_pl.class_id
                       and x.fee_head_id = o.fee_head_id and x.status = 'active');

  return jsonb_build_object(
    'student_id', p_student, 'name', v_st.full_name, 'admission_no', v_st.admission_no,
    'class_id', v_pl.class_id, 'class', v_pl.class_name, 'section', v_pl.section_name,
    'roll_no', v_pl.roll_no, 'lines', v_lines,
    'concession_conflicts', v_conflict, 'missing_prices', coalesce(v_missing, '[]'),
    'gross_paise', (select coalesce(sum((l->>'gross_paise')::bigint), 0) from jsonb_array_elements(v_lines) l),
    'concession_paise', (select coalesce(sum((l->>'concession_paise')::bigint), 0) from jsonb_array_elements(v_lines) l),
    'net_paise', (select coalesce(sum((l->>'gross_paise')::bigint - (l->>'concession_paise')::bigint), 0)
                    from jsonb_array_elements(v_lines) l));
end $$;

-- Students placed in the term's year (only placements that have started, or start on the year's first day)
create or replace function private.term_target_students(p_school uuid, p_term uuid, p_section uuid, p_students uuid[])
returns setof uuid language sql stable security definer set search_path = '' as $$
  select e.student_id
    from app.fee_terms t
    join app.academic_years ay on ay.id = t.academic_year_id
    join app.enrollments e on e.academic_year_id = t.academic_year_id and e.status = 'active'
    join app.students st on st.id = e.student_id and st.status = 'active'
   where t.id = p_term and t.school_id = p_school
     and (p_students is null or e.student_id = any (p_students))
     and (p_section is null or exists (
           select 1 from app.placements p where p.student_id = e.student_id and p.section_id = p_section
              and p.academic_year_id = t.academic_year_id
              and p.effective_from <= greatest(private.school_today(p_school), ay.start_date)
              and (p.effective_to is null or p.effective_to > greatest(private.school_today(p_school), ay.start_date))))
$$;

-- Issue term demands. Students with concession conflicts OR missing prices are skipped and reported.
create or replace function private.issue_term_invoices(p_rev integer, p_operation_id uuid, p_term_id uuid,
                                                       p_section_id uuid, p_student_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_term app.fee_terms; v_school text; v_year text; s uuid; v jsonb; v_inv uuid; v_no integer;
        v_issued integer := 0; v_existing integer := 0; v_skipped jsonb := '[]'; v_fp text; v_prev jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  select * into v_term from app.fee_terms where id = p_term_id and school_id = c.school_id;
  if not found then perform private.fail('NOT_FOUND', 'Term not found'); end if;
  if v_term.status <> 'active' then perform private.fail('VALIDATION_ERROR', 'This term is retired'); end if;
  v_fp := private.fingerprint(jsonb_build_object('t', p_term_id, 's', p_section_id, 'ids', p_student_ids));
  v_prev := private.idem_lookup(c.school_id, 'fees.issue_term', p_operation_id, v_fp);
  if v_prev is not null then return v_prev; end if;
  select name into v_school from app.schools where id = c.school_id;
  select name into v_year from app.academic_years where id = v_term.academic_year_id;

  for s in select * from private.term_target_students(c.school_id, p_term_id, p_section_id, p_student_ids) order by 1 loop
    if exists (select 1 from app.invoices where school_id = c.school_id and source_key = 'term:' || p_term_id || ':' || s) then
      v_existing := v_existing + 1; continue;
    end if;
    v := private.compute_term_lines(c.school_id, p_term_id, s);
    if v ? 'skip_reason' or jsonb_array_length(v->'concession_conflicts') > 0 or jsonb_array_length(v->'lines') = 0
       or jsonb_array_length(v->'missing_prices') > 0 then
      v_skipped := v_skipped || jsonb_build_object('student_id', s, 'name', v->>'name', 'admission_no', v->>'admission_no',
                     'reason', coalesce(v->>'skip_reason',
                                        case when jsonb_array_length(v->'concession_conflicts') > 0 then 'More than one concession applies to the same fee head'
                                             when jsonb_array_length(v->'missing_prices') > 0 then 'No price set for: ' ||
                                                  (select string_agg(x, ', ') from jsonb_array_elements_text(v->'missing_prices') x)
                                             else 'No fee lines configured for this class/term' end));
      continue;
    end if;
    v_no := private.next_doc_number(c.school_id, v_term.academic_year_id, 'invoice');
    insert into app.invoices (school_id, academic_year_id, student_id, invoice_no, fee_term_id, source, source_key,
                              due_date, snapshot, issued_by)
    values (c.school_id, v_term.academic_year_id, s, 'INV/' || v_year || '/' || lpad(v_no::text, 5, '0'),
            p_term_id, 'term', 'term:' || p_term_id || ':' || s, v_term.due_date,
            jsonb_build_object('school_name', v_school, 'year', v_year, 'term', v_term.name,
                               'student_name', v->>'name', 'admission_no', v->>'admission_no',
                               'class', v->>'class', 'section', v->>'section', 'roll_no', v->>'roll_no'),
            c.account_id)
    on conflict (school_id, source_key) do nothing
    returning id into v_inv;
    if v_inv is null then v_existing := v_existing + 1; continue; end if;
    insert into app.invoice_lines (school_id, invoice_id, fee_head_id, label, gross_paise, concession_paise,
                                   student_concession_id, sort_order)
    select c.school_id, v_inv, (l->>'fee_head_id')::uuid, l->>'label', (l->>'gross_paise')::bigint,
           (l->>'concession_paise')::bigint, (l->>'student_concession_id')::uuid, (ord - 1)::smallint
      from jsonb_array_elements(v->'lines') with ordinality as t(l, ord);
    v_issued := v_issued + 1; v_inv := null;
  end loop;

  v_prev := jsonb_build_object('issued', v_issued, 'already_existing', v_existing, 'skipped', v_skipped);
  perform private.log_event('fees.invoices.issued', 'fee_terms', p_term_id::text, v_prev, p_operation_id, v_term.academic_year_id);
  perform private.idem_store(c.school_id, 'fees.issue_term', p_operation_id, v_fp, v_prev);
  return v_prev;
end $$;

-- Manual adjustment: replay with different content is refused
create or replace function private.add_invoice_adjustment(p_rev integer, p_operation_id uuid, p_invoice_id uuid,
                                                          p_kind text, p_amount_paise bigint, p_reason text, p_fee_head_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_inv app.invoices; v_bal bigint; v_old app.invoice_adjustments; v_id uuid;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if p_operation_id is null then perform private.fail('VALIDATION_ERROR', 'operation id is required'); end if;
  select * into v_old from app.invoice_adjustments where school_id = c.school_id and operation_id = p_operation_id;
  if v_old.id is not null then
    if v_old.invoice_id <> p_invoice_id or v_old.kind <> p_kind or v_old.amount_paise <> p_amount_paise then
      perform private.fail('DUPLICATE', 'This operation id was already used for a different adjustment');
    end if;
    return jsonb_build_object('adjustment_id', v_old.id, 'replayed', true);
  end if;
  if p_kind not in ('discount','additional_charge','correction') then
    perform private.fail('VALIDATION_ERROR', 'Use the late-fee actions for late fees');
  end if;
  if p_amount_paise is null or p_amount_paise = 0 then perform private.fail('VALIDATION_ERROR', 'Enter a non-zero amount'); end if;
  if (p_kind = 'discount' and p_amount_paise > 0) or (p_kind = 'additional_charge' and p_amount_paise < 0) then
    perform private.fail('VALIDATION_ERROR', 'A discount reduces the amount (negative); an extra charge increases it (positive)');
  end if;
  if coalesce(btrim(p_reason), '') = '' or length(p_reason) > 500 then
    perform private.fail('VALIDATION_ERROR', 'Give a reason (up to 500 characters)');
  end if;
  if p_fee_head_id is not null and not exists (select 1 from app.fee_heads where id = p_fee_head_id and school_id = c.school_id) then
    perform private.fail('VALIDATION_ERROR', 'Unknown fee head');
  end if;
  select * into v_inv from app.invoices where id = p_invoice_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Invoice not found'); end if;
  if v_inv.status <> 'issued' then perform private.fail('VALIDATION_ERROR', 'Invoice is cancelled'); end if;
  v_bal := private.invoice_balance(v_inv.id);
  if v_bal + p_amount_paise < 0 then
    perform private.fail('VALIDATION_ERROR', 'This would make the amount due negative', jsonb_build_object('balance_paise', v_bal));
  end if;
  insert into app.invoice_adjustments (school_id, invoice_id, student_id, kind, amount_paise, fee_head_id, reason,
                                       operation_id, created_by)
  values (c.school_id, v_inv.id, v_inv.student_id, p_kind, p_amount_paise, p_fee_head_id, btrim(p_reason), p_operation_id, c.account_id)
  returning id into v_id;
  perform private.log_event('fees.invoice.adjusted', 'invoices', v_inv.id::text,
                            jsonb_build_object('kind', p_kind, 'amount_paise', p_amount_paise, 'reason', p_reason),
                            p_operation_id, v_inv.academic_year_id);
  return jsonb_build_object('adjustment_id', v_id, 'balance_paise', v_bal + p_amount_paise);
end $$;

-- Cheques: validate up front (not only at clearing); replay with different content refused
create or replace function private.record_cheque(p_rev integer, p_operation_id uuid, p_student_id uuid, p_cheque_no text,
                                                 p_bank_name text, p_cheque_date date, p_amount_paise bigint,
                                                 p_receiving_account_id uuid, p_received_on date, p_allocations jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_old app.cheques; v_id uuid; v_sum bigint; a jsonb; v_bal bigint; v_planned bigint;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if p_operation_id is null then perform private.fail('VALIDATION_ERROR', 'operation id is required'); end if;
  select * into v_old from app.cheques where school_id = c.school_id and operation_id = p_operation_id;
  if v_old.id is not null then
    if v_old.student_id <> p_student_id or v_old.cheque_no <> p_cheque_no or v_old.amount_paise <> p_amount_paise then
      perform private.fail('DUPLICATE', 'This operation id was already used for a different cheque');
    end if;
    return jsonb_build_object('cheque_id', v_old.id, 'status', v_old.status, 'replayed', true);
  end if;
  if not exists (select 1 from app.students where id = p_student_id and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Student not found');
  end if;
  if coalesce(p_cheque_no, '') !~ '^[0-9]{6,10}$' then perform private.fail('VALIDATION_ERROR', 'Cheque number must be 6–10 digits'); end if;
  if coalesce(btrim(p_bank_name), '') = '' or length(p_bank_name) > 120 then
    perform private.fail('VALIDATION_ERROR', 'Enter the bank name');
  end if;
  if p_amount_paise is null or p_amount_paise <= 0 then perform private.fail('VALIDATION_ERROR', 'Amount must be positive'); end if;
  if p_cheque_date is null then perform private.fail('VALIDATION_ERROR', 'Enter the cheque date'); end if;
  if p_received_on is null or p_received_on > private.school_today(c.school_id) then
    perform private.fail('VALIDATION_ERROR', 'Received date must be today or earlier');
  end if;
  if not exists (select 1 from app.receiving_accounts where id = p_receiving_account_id and school_id = c.school_id
                   and kind = 'bank' and status = 'active') then
    perform private.fail('VALIDATION_ERROR', 'Choose the bank account the cheque will be deposited into');
  end if;
  if exists (select 1 from app.cheques where school_id = c.school_id and upper(bank_name) = upper(btrim(p_bank_name))
               and cheque_no = p_cheque_no and status <> 'cancelled') then
    perform private.fail('DUPLICATE', 'This cheque (bank + number) is already recorded');
  end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    perform private.fail('VALIDATION_ERROR', 'Plan which invoices this cheque pays');
  end if;
  if (select count(distinct x->>'invoice_id') from jsonb_array_elements(p_allocations) x) <> jsonb_array_length(p_allocations) then
    perform private.fail('VALIDATION_ERROR', 'An invoice appears twice');
  end if;
  v_sum := 0;
  for a in select * from jsonb_array_elements(p_allocations) loop
    if not exists (select 1 from app.invoices i where i.id = (a->>'invoice_id')::uuid and i.student_id = p_student_id
                     and i.school_id = c.school_id and i.status = 'issued') then
      perform private.fail('VALIDATION_ERROR', 'Allocations must target issued invoices of this student');
    end if;
    if coalesce((a->>'amount_paise')::bigint, 0) <= 0 then perform private.fail('VALIDATION_ERROR', 'Allocation amounts must be positive'); end if;
    v_bal := private.invoice_balance((a->>'invoice_id')::uuid);
    select coalesce(sum((pa->>'amount_paise')::bigint), 0) into v_planned
      from app.cheques ch, jsonb_array_elements(ch.planned_allocations) pa
     where ch.school_id = c.school_id and ch.status = 'pending' and pa->>'invoice_id' = a->>'invoice_id';
    if (a->>'amount_paise')::bigint > v_bal - v_planned then
      perform private.fail('VALIDATION_ERROR', 'Allocation exceeds the amount due (after other pending cheques)',
                           jsonb_build_object('invoice_id', a->>'invoice_id', 'balance_paise', v_bal, 'pending_cheques_paise', v_planned));
    end if;
    v_sum := v_sum + (a->>'amount_paise')::bigint;
  end loop;
  if v_sum <> p_amount_paise then perform private.fail('VALIDATION_ERROR', 'Planned allocations must equal the cheque amount'); end if;
  insert into app.cheques (school_id, student_id, cheque_no, bank_name, cheque_date, amount_paise, receiving_account_id,
                           received_on, planned_allocations, operation_id, recorded_by)
  values (c.school_id, p_student_id, p_cheque_no, btrim(p_bank_name), p_cheque_date, p_amount_paise, p_receiving_account_id,
          p_received_on, p_allocations, p_operation_id, c.account_id)
  returning id into v_id;
  perform private.log_event('fees.cheque.recorded', 'cheques', v_id::text,
                            jsonb_build_object('student_id', p_student_id, 'amount_paise', p_amount_paise), p_operation_id);
  return jsonb_build_object('cheque_id', v_id, 'status', 'pending');
end $$;

-- post_collection: a concurrent duplicate submit gets a hinted answer instead of a raw key error
create or replace function private.post_collection(p_rev integer, p_operation_id uuid, p_student_id uuid, p_method text,
                                                   p_amount_paise bigint, p_received_on date, p_receiving_account_id uuid,
                                                   p_external_ref text, p_payer_name text, p_notes text, p_allocations jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_existing record; v_fp text;
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
  begin
    perform private.idem_store(c.school_id, 'fees.post_collection', p_operation_id, v_fp, '{}'::jsonb);
  exception when unique_violation then
    perform private.fail('CONFLICT', 'This payment is already being saved. Wait a moment and refresh the student''s statement.');
  end;
  return private._post_collection(c.school_id, c.account_id, p_operation_id, p_student_id, p_method, p_amount_paise,
                                  p_received_on, p_receiving_account_id, p_external_ref, p_payer_name, p_notes,
                                  p_allocations, null);
end $$;

-- Dues: every debt counted (also students without a placement in that year), one row per student
drop function if exists public.get_dues_report(integer, uuid, uuid, uuid, boolean);
create or replace function private.get_dues_report(p_rev integer, p_academic_year_id uuid, p_class_id uuid, p_section_id uuid,
                                                   p_only_overdue boolean, p_fee_term_id uuid, p_only_with_balance boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_today date; v_year uuid;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.read');
  v_today := private.school_today(c.school_id);
  v_year := coalesce(p_academic_year_id, (select id from app.academic_years where school_id = c.school_id and is_current));
  return coalesce((
    select jsonb_agg(x order by x->>'class_section' nulls last, x->>'name') from (
      select jsonb_build_object(
        'student_id', st.id, 'name', st.full_name, 'admission_no', st.admission_no, 'student_status', st.status,
        'class_id', fp.class_id, 'section_id', fp.section_id,
        'class_section', case when fp.section_id is not null then fp.class_name || ' ' || fp.section_name end,
        'charged_paise', sum(b.charged_paise + b.adjustments_paise) filter (where b.status = 'issued'),
        'paid_paise', sum(b.allocated_paise - b.reversed_paise),
        'balance_paise', sum(b.balance_paise),
        'overdue_paise', coalesce(sum(b.balance_paise) filter (where b.due_date < v_today), 0),
        'invoices', count(*) filter (where b.status = 'issued'),
        'pending_cheque_paise', (select coalesce(sum(amount_paise), 0) from app.cheques ch
                                   where ch.student_id = st.id and ch.status = 'pending')) as x
        from private.invoice_balances(c.school_id, null, p_academic_year_id) b
        join app.invoices i on i.id = b.invoice_id
        join app.students st on st.id = b.student_id
        left join lateral private.fee_placement(st.id, v_year, v_today) fp on true
       where (p_fee_term_id is null or i.fee_term_id = p_fee_term_id)
         and (p_class_id is null or fp.class_id = p_class_id)
         and (p_section_id is null or fp.section_id = p_section_id)
       group by st.id, st.full_name, st.admission_no, st.status, fp.class_id, fp.section_id, fp.class_name, fp.section_name
      having (not coalesce(p_only_overdue, false) or coalesce(sum(b.balance_paise) filter (where b.due_date < v_today), 0) > 0)
         and (not coalesce(p_only_with_balance, false) or sum(b.balance_paise) > 0)
    ) q), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- Fee configuration writes: definer functions with readable (hinted) validation.
-- The 1300 versions were invoker functions that surfaced raw constraint errors.
-- -----------------------------------------------------------------------------
create or replace function private.save_fee_head(p_rev integer, p_name text, p_code text, p_kind text, p_is_optional boolean,
                                                 p_status text, p_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_id uuid; v integer; v_old app.fee_heads; v_name text := btrim(coalesce(p_name, ''));
        v_code text := btrim(coalesce(p_code, '')); v_kind text := coalesce(p_kind, 'regular');
        v_status text := coalesce(p_status, 'active');
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if length(v_name) not between 1 and 80 then perform private.fail('VALIDATION_ERROR', 'Name is required (up to 80 characters)'); end if;
  if v_code !~ '^[A-Za-z0-9_-]{1,20}$' then
    perform private.fail('VALIDATION_ERROR', 'Code: 1–20 letters, digits, - or _ (for example TUITION)');
  end if;
  if v_status not in ('active','retired') then perform private.fail('VALIDATION_ERROR', 'Status must be active or retired'); end if;
  if p_id is not null then
    select * into v_old from app.fee_heads where id = p_id and school_id = c.school_id;
    if v_old.id is null then perform private.fail('NOT_FOUND', 'Fee head not found'); end if;
    v_kind := v_old.kind;   -- kind is fixed once created
  end if;
  if v_kind not in ('regular','late_fee','other') then perform private.fail('VALIDATION_ERROR', 'Kind must be regular, late_fee or other'); end if;
  if v_kind = 'late_fee' and coalesce(p_is_optional, false) then
    perform private.fail('VALIDATION_ERROR', 'A late-fee head cannot be optional');
  end if;
  if exists (select 1 from app.fee_heads where school_id = c.school_id and upper(code) = upper(v_code)
               and id is distinct from p_id) then
    perform private.fail('DUPLICATE', 'Another fee head already uses code ' || upper(v_code));
  end if;
  if p_id is null then
    insert into app.fee_heads (school_id, name, code, kind, is_optional, status)
    values (c.school_id, v_name, upper(v_code), v_kind, coalesce(p_is_optional, false), v_status) returning id, version into v_id, v;
  else
    if p_expected_version is null then perform private.fail('VALIDATION_ERROR', 'expected version is required'); end if;
    if v_status = 'retired' and v_old.status = 'active'
       and exists (select 1 from app.late_fee_rules where fee_head_id = p_id and status = 'active') then
      perform private.fail('VALIDATION_ERROR', 'This head is used by the active late-fee rule. Change the rule first.');
    end if;
    update app.fee_heads set name = v_name, code = upper(v_code), is_optional = coalesce(p_is_optional, false), status = v_status
     where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Fee head');
  end if;
  perform private.log_event(case when p_id is null then 'fees.head.created' else 'fees.head.updated' end, 'fee_heads', v_id::text,
    jsonb_build_object('code', upper(v_code), 'status', v_status));
  return jsonb_build_object('fee_head_id', v_id, 'version', v);
end $$;

create or replace function private.save_receiving_account(p_rev integer, p jsonb, p_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_id uuid; v integer; v_old app.receiving_accounts; r app.receiving_accounts;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if jsonb_typeof(p) is distinct from 'object' then perform private.fail('VALIDATION_ERROR', 'Account details are missing'); end if;
  if p_id is not null then
    select * into v_old from app.receiving_accounts where id = p_id and school_id = c.school_id;
    if v_old.id is null then perform private.fail('NOT_FOUND', 'Receiving account not found'); end if;
    if p_expected_version is null then perform private.fail('VALIDATION_ERROR', 'expected version is required'); end if;
    r := v_old;
  else
    r.kind := p->>'kind'; r.status := 'active';
  end if;
  -- keys present in p replace the value (empty = clear); absent keys keep the old value
  if p ? 'label' then r.label := btrim(coalesce(p->>'label', '')); end if;
  if p ? 'status' then r.status := p->>'status'; end if;
  if p ? 'bank_name' then r.bank_name := nullif(btrim(coalesce(p->>'bank_name', '')), ''); end if;
  if p ? 'account_last4' then r.account_last4 := nullif(btrim(coalesce(p->>'account_last4', '')), ''); end if;
  if p ? 'ifsc' then r.ifsc := upper(nullif(btrim(coalesce(p->>'ifsc', '')), '')); end if;
  if p ? 'upi_id' then r.upi_id := nullif(btrim(coalesce(p->>'upi_id', '')), ''); end if;

  if coalesce(r.kind, '') not in ('cash_desk','bank','upi') then
    perform private.fail('VALIDATION_ERROR', 'Type must be cash desk, bank or UPI');
  end if;
  if length(coalesce(r.label, '')) not between 1 and 80 then perform private.fail('VALIDATION_ERROR', 'Name is required (up to 80 characters)'); end if;
  if coalesce(r.status, '') not in ('active','retired') then perform private.fail('VALIDATION_ERROR', 'Status must be active or retired'); end if;
  if length(r.bank_name) > 120 then perform private.fail('VALIDATION_ERROR', 'Bank name can be at most 120 characters'); end if;
  if r.account_last4 is not null and r.account_last4 !~ '^[0-9]{4}$' then
    perform private.fail('VALIDATION_ERROR', 'Account number: enter only the last 4 digits');
  end if;
  if r.ifsc is not null and r.ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
    perform private.fail('VALIDATION_ERROR', 'IFSC must look like SBIN0001234 (11 characters)');
  end if;
  if r.upi_id is not null and r.upi_id !~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z]{2,32}$' then
    perform private.fail('VALIDATION_ERROR', 'UPI ID must look like schoolname@okaxis');
  end if;
  if r.kind = 'bank' and r.bank_name is null then perform private.fail('VALIDATION_ERROR', 'Bank name is required for a bank account'); end if;
  if r.kind = 'upi' and r.upi_id is null then perform private.fail('VALIDATION_ERROR', 'UPI ID is required for a UPI account'); end if;
  if exists (select 1 from app.receiving_accounts where school_id = c.school_id and lower(label) = lower(r.label)
               and id is distinct from p_id) then
    perform private.fail('DUPLICATE', 'Another receiving account already has this name');
  end if;

  if p_id is null then
    insert into app.receiving_accounts (school_id, label, kind, bank_name, account_last4, ifsc, upi_id, status)
    values (c.school_id, r.label, r.kind, r.bank_name, r.account_last4, r.ifsc, r.upi_id, r.status)
    returning id, version into v_id, v;
  else
    update app.receiving_accounts set label = r.label, status = r.status, bank_name = r.bank_name,
           account_last4 = r.account_last4, ifsc = r.ifsc, upi_id = r.upi_id
     where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Receiving account');
  end if;
  perform private.log_event(case when p_id is null then 'fees.account.created' else 'fees.account.updated' end,
    'receiving_accounts', v_id::text, jsonb_build_object('label', r.label, 'kind', r.kind, 'status', r.status));
  return jsonb_build_object('receiving_account_id', v_id, 'version', v);
end $$;

drop function if exists public.save_fee_term(integer, uuid, text, integer, date, uuid, integer);
create or replace function private.save_fee_term(p_rev integer, p_academic_year_id uuid, p_name text, p_sort_order integer,
                                                 p_due_date date, p_id uuid, p_expected_version integer, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_id uuid; v integer; v_old app.fee_terms; v_y app.academic_years; v_name text := btrim(coalesce(p_name, ''));
        v_status text;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if p_id is not null then
    select * into v_old from app.fee_terms where id = p_id and school_id = c.school_id;
    if v_old.id is null then perform private.fail('NOT_FOUND', 'Fee term not found'); end if;
    if p_expected_version is null then perform private.fail('VALIDATION_ERROR', 'expected version is required'); end if;
    if p_academic_year_id is not null and p_academic_year_id <> v_old.academic_year_id then
      perform private.fail('VALIDATION_ERROR', 'A term cannot move to another year');
    end if;
  end if;
  select * into v_y from app.academic_years where id = coalesce(v_old.academic_year_id, p_academic_year_id) and school_id = c.school_id;
  if v_y.id is null then perform private.fail('NOT_FOUND', 'Academic year not found'); end if;
  v_status := coalesce(p_status, v_old.status, 'active');
  if v_status not in ('active','retired') then perform private.fail('VALIDATION_ERROR', 'Status must be active or retired'); end if;
  if length(v_name) not between 1 and 60 then perform private.fail('VALIDATION_ERROR', 'Name is required (up to 60 characters)'); end if;
  if p_sort_order is null or p_sort_order not between 1 and 99 then perform private.fail('VALIDATION_ERROR', 'Order must be a number from 1 to 99'); end if;
  if p_due_date is null then perform private.fail('VALIDATION_ERROR', 'Due date is required'); end if;
  if p_due_date not between v_y.start_date - 90 and v_y.end_date then
    perform private.fail('VALIDATION_ERROR', 'Due date must fall within ' || v_y.name || ' (or up to 90 days before it starts)');
  end if;
  if exists (select 1 from app.fee_terms where academic_year_id = v_y.id and lower(name) = lower(v_name) and id is distinct from p_id) then
    perform private.fail('DUPLICATE', 'This year already has a term named ' || v_name);
  end if;
  if p_id is null then
    insert into app.fee_terms (school_id, academic_year_id, name, sort_order, due_date, status)
    values (c.school_id, v_y.id, v_name, p_sort_order, p_due_date, v_status) returning id, version into v_id, v;
  else
    update app.fee_terms set name = v_name, sort_order = p_sort_order, due_date = p_due_date, status = v_status
     where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Fee term');
  end if;
  perform private.log_event(case when p_id is null then 'fees.term.created' else 'fees.term.updated' end, 'fee_terms', v_id::text,
    jsonb_build_object('name', v_name, 'due_date', p_due_date, 'status', v_status), null, v_y.id);
  return jsonb_build_object('fee_term_id', v_id, 'version', v,
    'invoices_issued', (select count(*) from app.invoices where fee_term_id = v_id and status = 'issued'),
    'note', case when p_id is not null and exists (select 1 from app.invoices where fee_term_id = v_id and status = 'issued')
                 then 'Invoices already issued for this term keep their due date and amounts' end);
end $$;

create or replace function private.save_fee_structure(p_rev integer, p_fee_term_id uuid, p_class_id uuid, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_term app.fee_terms; x jsonb; v_amt bigint; v_removed integer; v_issued integer;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  select * into v_term from app.fee_terms where id = p_fee_term_id and school_id = c.school_id;
  if v_term.id is null then perform private.fail('NOT_FOUND', 'Fee term not found'); end if;
  if v_term.status <> 'active' then perform private.fail('VALIDATION_ERROR', 'This term is retired'); end if;
  if not exists (select 1 from app.classes where id = p_class_id and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Class not found');
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) > 60 then
    perform private.fail('VALIDATION_ERROR', 'Send a list of up to 60 fee lines');
  end if;
  for x in select * from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(x) <> 'object' or coalesce(x->>'fee_head_id', '') !~ '^[0-9a-fA-F-]{36}$' then
      perform private.fail('VALIDATION_ERROR', 'Each line needs a fee head');
    end if;
    if not exists (select 1 from app.fee_heads h where h.id = (x->>'fee_head_id')::uuid and h.school_id = c.school_id
                     and h.status = 'active' and h.kind <> 'late_fee') then
      perform private.fail('VALIDATION_ERROR', 'Each line must use an active fee head that is not a late fee',
                           jsonb_build_object('fee_head_id', x->>'fee_head_id'));
    end if;
    if jsonb_typeof(x->'amount_paise') <> 'number' or (x->>'amount_paise') !~ '^\d{1,11}$'
       or (x->>'amount_paise')::bigint > 10000000000 then
      perform private.fail('VALIDATION_ERROR', 'Amounts must be whole paise from 0 to ₹10,00,00,000',
                           jsonb_build_object('fee_head_id', x->>'fee_head_id'));
    end if;
  end loop;
  if (select count(distinct z->>'fee_head_id') from jsonb_array_elements(p_lines) z) <> jsonb_array_length(p_lines) then
    perform private.fail('VALIDATION_ERROR', 'A fee head appears twice');
  end if;
  -- heads left out are retired for that class/term (= "no price"), never silently zero
  update app.fee_structure_lines set status = 'retired'
   where fee_term_id = p_fee_term_id and class_id = p_class_id and status = 'active'
     and fee_head_id not in (select (y->>'fee_head_id')::uuid from jsonb_array_elements(p_lines) y);
  get diagnostics v_removed = row_count;
  for x in select * from jsonb_array_elements(p_lines) loop
    v_amt := (x->>'amount_paise')::bigint;
    update app.fee_structure_lines set amount_paise = v_amt
     where fee_term_id = p_fee_term_id and class_id = p_class_id and fee_head_id = (x->>'fee_head_id')::uuid
       and status = 'active' and amount_paise <> v_amt;
    if not exists (select 1 from app.fee_structure_lines where fee_term_id = p_fee_term_id and class_id = p_class_id
                     and fee_head_id = (x->>'fee_head_id')::uuid and status = 'active') then
      insert into app.fee_structure_lines (school_id, academic_year_id, fee_term_id, class_id, fee_head_id, amount_paise, created_by)
      values (c.school_id, v_term.academic_year_id, p_fee_term_id, p_class_id, (x->>'fee_head_id')::uuid, v_amt, c.account_id);
    end if;
  end loop;
  select count(*) into v_issued from app.invoices i
   where i.fee_term_id = p_fee_term_id and i.status = 'issued'
     and exists (select 1 from private.fee_placement(i.student_id, v_term.academic_year_id, private.school_today(c.school_id)) fp
                  where fp.class_id = p_class_id);
  perform private.log_event('fees.structure.saved', 'fee_terms', p_fee_term_id::text,
    jsonb_build_object('class_id', p_class_id, 'lines', p_lines, 'removed', v_removed), null, v_term.academic_year_id);
  return jsonb_build_object('fee_term_id', p_fee_term_id, 'class_id', p_class_id, 'lines', jsonb_array_length(p_lines),
    'removed', v_removed, 'invoices_already_issued', v_issued,
    'note', case when v_issued > 0 then 'Invoices already issued for this class and term are not changed; use adjustments' end);
end $$;

create or replace function private.save_concession_preset(p_rev integer, p_name text, p_kind text, p_fee_head_ids uuid[],
                                                          p_percent_bp integer, p_fixed_paise bigint, p_status text,
                                                          p_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_id uuid; v integer; v_name text := btrim(coalesce(p_name, '')); v_status text := coalesce(p_status, 'active');
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if length(v_name) not between 1 and 80 then perform private.fail('VALIDATION_ERROR', 'Name is required (up to 80 characters)'); end if;
  if coalesce(p_kind, '') not in ('fixed','percent') then perform private.fail('VALIDATION_ERROR', 'Type must be fixed amount or percent'); end if;
  if v_status not in ('active','retired') then perform private.fail('VALIDATION_ERROR', 'Status must be active or retired'); end if;
  if p_kind = 'percent' and (p_percent_bp is null or p_percent_bp not between 1 and 10000 or p_fixed_paise is not null) then
    perform private.fail('VALIDATION_ERROR', 'Percent must be from 0.01% to 100%');
  end if;
  if p_kind = 'fixed' and (p_fixed_paise is null or p_fixed_paise not between 1 and 10000000000 or p_percent_bp is not null) then
    perform private.fail('VALIDATION_ERROR', 'Enter a fixed amount greater than ₹0');
  end if;
  if coalesce(array_length(p_fee_head_ids, 1), 0) = 0 then
    perform private.fail('VALIDATION_ERROR', 'Choose the fee heads this concession applies to');
  end if;
  if exists (select 1 from unnest(p_fee_head_ids) h
              where not exists (select 1 from app.fee_heads f where f.id = h and f.school_id = c.school_id and f.kind <> 'late_fee')) then
    perform private.fail('VALIDATION_ERROR', 'Concessions apply only to this school''s regular or other fee heads');
  end if;
  if exists (select 1 from app.concession_presets where school_id = c.school_id and lower(name) = lower(v_name) and id is distinct from p_id) then
    perform private.fail('DUPLICATE', 'Another concession already has this name');
  end if;
  if p_id is null then
    insert into app.concession_presets (school_id, name, kind, percent_bp, fixed_paise, status)
    values (c.school_id, v_name, p_kind, p_percent_bp, p_fixed_paise, v_status) returning id, version into v_id, v;
  else
    if p_expected_version is null then perform private.fail('VALIDATION_ERROR', 'expected version is required'); end if;
    update app.concession_presets set name = v_name, kind = p_kind, percent_bp = p_percent_bp, fixed_paise = p_fixed_paise,
           status = v_status
     where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Concession');
    delete from app.concession_preset_heads where preset_id = v_id;
  end if;
  insert into app.concession_preset_heads (school_id, preset_id, fee_head_id)
  select distinct c.school_id, v_id, h from unnest(p_fee_head_ids) h;
  perform private.log_event(case when p_id is null then 'fees.concession_preset.created' else 'fees.concession_preset.updated' end,
    'concession_presets', v_id::text, jsonb_build_object('name', v_name, 'kind', p_kind, 'percent_bp', p_percent_bp,
    'fixed_paise', p_fixed_paise, 'status', v_status));
  return jsonb_build_object('concession_preset_id', v_id, 'version', v,
    'students_using', (select count(*) from app.student_concessions where preset_id = v_id and status = 'active'),
    'note', 'Applies to invoices issued from now on; issued invoices change only via adjustments');
end $$;

drop function if exists public.grant_concession(integer, uuid, uuid, uuid, text, uuid);
create or replace function private.grant_concession(p_rev integer, p_operation_id uuid, p_student_id uuid, p_academic_year_id uuid,
                                                    p_preset_id uuid, p_reason text, p_fee_term_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_id uuid; v_fp text; v_prev jsonb; v_reason text := btrim(coalesce(p_reason, ''));
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if p_operation_id is null then perform private.fail('VALIDATION_ERROR', 'operation id is required'); end if;
  v_fp := private.fingerprint(jsonb_build_object('s', p_student_id, 'y', p_academic_year_id, 'p', p_preset_id,
                                                 't', p_fee_term_id, 'r', v_reason));
  v_prev := private.idem_lookup(c.school_id, 'fees.concession.grant', p_operation_id, v_fp);
  if v_prev is not null then return v_prev; end if;
  if length(v_reason) not between 1 and 500 then perform private.fail('VALIDATION_ERROR', 'Reason is required (up to 500 characters)'); end if;
  if not exists (select 1 from app.students where id = p_student_id and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Student not found');
  end if;
  if not exists (select 1 from app.academic_years where id = p_academic_year_id and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Academic year not found');
  end if;
  if not exists (select 1 from app.concession_presets where id = p_preset_id and school_id = c.school_id and status = 'active') then
    perform private.fail('VALIDATION_ERROR', 'Choose an active concession');
  end if;
  if p_fee_term_id is not null and not exists (select 1 from app.fee_terms where id = p_fee_term_id
                                                  and academic_year_id = p_academic_year_id and school_id = c.school_id) then
    perform private.fail('VALIDATION_ERROR', 'The term must belong to the chosen year');
  end if;
  if exists (select 1 from app.student_concessions where student_id = p_student_id and academic_year_id = p_academic_year_id
               and preset_id = p_preset_id and fee_term_id is not distinct from p_fee_term_id and status = 'active') then
    perform private.fail('DUPLICATE', 'The student already has this concession for that period');
  end if;
  insert into app.student_concessions (school_id, student_id, academic_year_id, preset_id, fee_term_id, reason, granted_by)
  values (c.school_id, p_student_id, p_academic_year_id, p_preset_id, p_fee_term_id, v_reason, c.account_id)
  returning id into v_id;
  v_prev := jsonb_build_object('student_concession_id', v_id,
    -- already-issued term invoices are not recalculated; the UI lists them so staff can add an adjustment
    'issued_invoices_not_changed', coalesce((select jsonb_agg(jsonb_build_object('invoice_id', i.id, 'invoice_no', i.invoice_no,
                                       'term', i.snapshot->>'term') order by i.due_date)
                                     from app.invoices i where i.student_id = p_student_id and i.academic_year_id = p_academic_year_id
                                      and i.status = 'issued' and i.source = 'term'
                                      and (p_fee_term_id is null or i.fee_term_id = p_fee_term_id)), '[]'::jsonb));
  perform private.log_event('fees.concession.granted', 'student_concessions', v_id::text,
    jsonb_build_object('student_id', p_student_id, 'preset_id', p_preset_id, 'fee_term_id', p_fee_term_id, 'reason', v_reason),
    p_operation_id, p_academic_year_id);
  perform private.idem_store(c.school_id, 'fees.concession.grant', p_operation_id, v_fp, v_prev);
  return v_prev;
end $$;

create or replace function private.revoke_concession(p_rev integer, p_student_concession_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_sc app.student_concessions; v_reason text := btrim(coalesce(p_reason, ''));
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if length(v_reason) not between 1 and 500 then perform private.fail('VALIDATION_ERROR', 'Reason is required (up to 500 characters)'); end if;
  select * into v_sc from app.student_concessions where id = p_student_concession_id and school_id = c.school_id for update;
  if v_sc.id is null then perform private.fail('NOT_FOUND', 'Concession not found'); end if;
  if v_sc.status = 'revoked' then
    return jsonb_build_object('student_concession_id', v_sc.id, 'status', 'revoked', 'replayed', true);
  end if;
  update app.student_concessions set status = 'revoked', revoked_by = c.account_id, revoked_at = now(), revoke_reason = v_reason
   where id = v_sc.id;
  perform private.log_event('fees.concession.revoked', 'student_concessions', v_sc.id::text,
    jsonb_build_object('student_id', v_sc.student_id, 'reason', v_reason), null, v_sc.academic_year_id);
  return jsonb_build_object('student_concession_id', v_sc.id, 'status', 'revoked',
    'note', 'Invoices already issued keep this concession; it stops applying to invoices issued from now on');
end $$;

create or replace function private.save_late_fee_rule(p_rev integer, p_academic_year_id uuid, p_fee_head_id uuid,
                                                      p_amount_paise bigint, p_grace_days integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_id uuid;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if not exists (select 1 from app.academic_years where id = p_academic_year_id and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Academic year not found');
  end if;
  if not exists (select 1 from app.fee_heads where id = p_fee_head_id and school_id = c.school_id and kind = 'late_fee' and status = 'active') then
    perform private.fail('VALIDATION_ERROR', 'Choose an active fee head of kind "late fee"');
  end if;
  if p_amount_paise is null or p_amount_paise not between 1 and 10000000 then
    perform private.fail('VALIDATION_ERROR', 'Late fee must be from ₹0.01 to ₹1,00,000');
  end if;
  if coalesce(p_grace_days, 0) not between 0 and 120 then perform private.fail('VALIDATION_ERROR', 'Grace days must be 0–120'); end if;
  update app.late_fee_rules set status = 'retired' where academic_year_id = p_academic_year_id and status = 'active';
  insert into app.late_fee_rules (school_id, academic_year_id, fee_head_id, amount_paise, grace_days, created_by)
  values (c.school_id, p_academic_year_id, p_fee_head_id, p_amount_paise, coalesce(p_grace_days, 0), c.account_id) returning id into v_id;
  perform private.log_event('fees.late_fee_rule.saved', 'late_fee_rules', v_id::text,
    jsonb_build_object('amount_paise', p_amount_paise, 'grace_days', coalesce(p_grace_days, 0)), null, p_academic_year_id);
  return jsonb_build_object('late_fee_rule_id', v_id,
    'note', 'Late fees already added to invoices are not changed');
end $$;

-- Retire a late-fee rule without replacing it
create or replace function private.retire_late_fee_rule(p_rev integer, p_academic_year_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_n integer;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  update app.late_fee_rules set status = 'retired'
   where academic_year_id = p_academic_year_id and school_id = c.school_id and status = 'active';
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform private.log_event('fees.late_fee_rule.retired', 'academic_years', p_academic_year_id::text, '{}', null, p_academic_year_id);
  end if;
  return jsonb_build_object('retired', v_n);
end $$;
create or replace function private.imp_columns(p_dataset text)
returns jsonb language sql immutable set search_path = '' as $$
  select case p_dataset
  when 'classes_sections' then jsonb_build_array(
    jsonb_build_object('key','class_name','label','Class','required',true,'example','Class 1','max',40),
    jsonb_build_object('key','class_order','label','Class order','required',false,'example','1','hint','Whole number; sorts classes'),
    jsonb_build_object('key','section_name','label','Section','required',true,'example','A','max',20),
    jsonb_build_object('key','capacity','label','Capacity','required',false,'example','40','hint','1–200'))
  when 'staff' then jsonb_build_array(
    jsonb_build_object('key','employee_no','label','Employee no','required',true,'example','T001','max',40),
    jsonb_build_object('key','full_name','label','Full name','required',true,'example','Ravi Kumar','max',200),
    jsonb_build_object('key','gender','label','Gender','required',false,'example','male','allowed',jsonb_build_array('male','female','transgender')),
    jsonb_build_object('key','phone','label','Mobile','required',false,'example','9876543210','hint','10 digits'),
    jsonb_build_object('key','email','label','Email','required',false,'example','ravi@example.com'),
    jsonb_build_object('key','staff_group','label','Staff group','required',true,'example','Teaching staff','hint','Must already exist in Setup → Staff groups'),
    jsonb_build_object('key','designation','label','Designation','required',false,'example','PGT Maths','max',80),
    jsonb_build_object('key','is_teaching','label','Teaching staff?','required',false,'example','yes','allowed',jsonb_build_array('yes','no')),
    jsonb_build_object('key','joined_on','label','Joined on','required',true,'example','2024-06-01','hint','YYYY-MM-DD or DD/MM/YYYY'))
  when 'students_guardians' then jsonb_build_array(
    jsonb_build_object('key','admission_no','label','Admission no','required',true,'example','2024/001','max',40),
    jsonb_build_object('key','full_name','label','Student name','required',true,'example','Aarav Sharma','max',200),
    jsonb_build_object('key','gender','label','Gender','required',true,'example','male','allowed',jsonb_build_array('male','female','transgender')),
    jsonb_build_object('key','date_of_birth','label','Date of birth','required',true,'example','2016-04-12','hint','YYYY-MM-DD or DD/MM/YYYY'),
    jsonb_build_object('key','class_name','label','Class','required',true,'example','Class 1','hint','Must exist in the selected year'),
    jsonb_build_object('key','section_name','label','Section','required',true,'example','A'),
    jsonb_build_object('key','roll_no','label','Roll no','required',false,'example','12','hint','Letters, digits, / or - (max 12)'),
    jsonb_build_object('key','joined_on','label','Joined this year on','required',false,'example','2026-06-12','hint','Defaults to the year start'),
    jsonb_build_object('key','admission_date','label','Admission date','required',false,'example','2022-06-01','hint','Defaults to Joined on'),
    jsonb_build_object('key','father_name','label','Father''s name','required',false,'example','Rakesh Sharma'),
    jsonb_build_object('key','mother_name','label','Mother''s name','required',false,'example','Priya Sharma'),
    jsonb_build_object('key','address_line','label','Address','required',false,'example','12-3, Ameerpet, Hyderabad','max',500),
    jsonb_build_object('key','pincode','label','Pincode','required',false,'example','500016'),
    jsonb_build_object('key','mobile','label','Student mobile','required',false,'example',''),
    jsonb_build_object('key','email','label','Student email','required',false,'example',''),
    jsonb_build_object('key','mother_tongue','label','Mother tongue','required',false,'example','Telugu'),
    jsonb_build_object('key','blood_group','label','Blood group','required',false,'example','O+','allowed',jsonb_build_array('A+','A-','B+','B-','AB+','AB-','O+','O-')),
    jsonb_build_object('key','previous_school','label','Previous school','required',false,'example',''),
    jsonb_build_object('key','previous_class','label','Previous class','required',false,'example',''),
    jsonb_build_object('key','guardian1_name','label','Parent 1 name','required',true,'example','Priya Sharma'),
    jsonb_build_object('key','guardian1_phone','label','Parent 1 mobile','required',true,'example','9876543210','hint','Siblings: use the same name + mobile and they share one parent login'),
    jsonb_build_object('key','guardian1_relationship','label','Parent 1 relationship','required',false,'example','mother','allowed',jsonb_build_array('mother','father','guardian','grandparent','sibling','other')),
    jsonb_build_object('key','guardian1_email','label','Parent 1 email','required',false,'example',''),
    jsonb_build_object('key','guardian1_occupation','label','Parent 1 occupation','required',false,'example',''),
    jsonb_build_object('key','guardian2_name','label','Parent 2 name','required',false,'example','Rakesh Sharma'),
    jsonb_build_object('key','guardian2_phone','label','Parent 2 mobile','required',false,'example',''),
    jsonb_build_object('key','guardian2_relationship','label','Parent 2 relationship','required',false,'example','father','allowed',jsonb_build_array('mother','father','guardian','grandparent','sibling','other')))
  when 'placements' then jsonb_build_array(
    jsonb_build_object('key','admission_no','label','Admission no','required',true,'example','2024/001','hint','Student must already exist'),
    jsonb_build_object('key','class_name','label','Class','required',true,'example','Class 2'),
    jsonb_build_object('key','section_name','label','Section','required',true,'example','A'),
    jsonb_build_object('key','roll_no','label','Roll no','required',false,'example','12'),
    jsonb_build_object('key','effective_from','label','From date','required',false,'example','2026-06-12','hint','Defaults to the year start'))
  when 'opening_balances' then jsonb_build_array(
    jsonb_build_object('key','admission_no','label','Admission no','required',true,'example','2024/001','hint','Student must already exist'),
    jsonb_build_object('key','fee_head_code','label','Fee head code','required',true,'example','TUITION','hint','Code of an active fee head (not a late fee)'),
    jsonb_build_object('key','amount','label','Amount due (₹)','required',true,'example','4500.00','hint','Rupees; up to 2 decimals. Commas and ₹ are fine'),
    jsonb_build_object('key','origin_label','label','What it is for','required',true,'example','Balance from 2025-26','max',120),
    jsonb_build_object('key','due_date','label','Due date','required',false,'example','2026-06-30','hint','Defaults to the year start'),
    jsonb_build_object('key','source_ref','label','Old reference','required',false,'example','LEDGER-2025-118','max',60,'hint','Use when one student has two balances for the same fee head'))
  end
$$;


create or replace function private.imp_validate(p_school uuid, p_dataset text, p_year uuid, p jsonb,
                                                out errors jsonb, out source_key text, out action text,
                                                out norm jsonb, out info jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare
  e jsonb := '[]'; k text; v text; d date; n integer; y record; v_cls uuid; v_sec uuid; v_sid uuid; v_exist uuid;
  v_allowed text[] := array(select x->>'key' from jsonb_array_elements(private.imp_columns(p_dataset)) x);
  r jsonb := '{}'; g1p text; g2p text; v_rel text;
begin
  info := '{}'; action := 'create';
  if jsonb_typeof(p) <> 'object' then
    errors := jsonb_build_array(jsonb_build_object('field', null, 'message', 'Row data is not an object')); return;
  end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any (v_allowed)) then
      e := e || jsonb_build_object('field', k, 'message', 'Unknown column "' || k || '"');
    end if;
  end loop;
  -- required fields
  for k in select x->>'key' from jsonb_array_elements(private.imp_columns(p_dataset)) x where (x->>'required')::boolean loop
    if private.imp_text(p, k) is null then e := e || jsonb_build_object('field', k, 'message', 'Required'); end if;
  end loop;
  if p_year is not null then
    select id, start_date, end_date into y from app.academic_years where id = p_year and school_id = p_school;
  end if;

  if p_dataset = 'classes_sections' then
    r := jsonb_build_object('class_name', private.imp_text(p,'class_name'), 'section_name', private.imp_text(p,'section_name'));
    if length(r->>'class_name') > 40 then e := e || jsonb_build_object('field','class_name','message','At most 40 characters'); end if;
    if length(r->>'section_name') > 20 then e := e || jsonb_build_object('field','section_name','message','At most 20 characters'); end if;
    v := private.imp_text(p,'class_order');
    if v is not null then
      if v !~ '^\d{1,4}$' then e := e || jsonb_build_object('field','class_order','message','Whole number');
      else r := r || jsonb_build_object('class_order', v::int); end if;
    end if;
    v := private.imp_text(p,'capacity');
    if v is not null then
      if v !~ '^\d{1,3}$' or v::int not between 1 and 200 then e := e || jsonb_build_object('field','capacity','message','A number from 1 to 200');
      else r := r || jsonb_build_object('capacity', v::int); end if;
    end if;
    if r->>'class_name' is not null and r->>'section_name' is not null then
      source_key := p_year::text || ':' || lower(r->>'class_name') || '|' || lower(r->>'section_name');
      select id into v_cls from app.classes where school_id = p_school and lower(name) = lower(r->>'class_name');
      if v_cls is not null then
        info := info || jsonb_build_object('class_exists', true);
        select id into v_exist from app.sections
         where school_id = p_school and academic_year_id = p_year and class_id = v_cls and lower(name) = lower(r->>'section_name');
      end if;
    end if;

  elsif p_dataset = 'staff' then
    r := jsonb_build_object('employee_no', private.imp_text(p,'employee_no'), 'full_name', private.imp_text(p,'full_name'),
                            'designation', private.imp_text(p,'designation'));
    if length(r->>'employee_no') > 40 then e := e || jsonb_build_object('field','employee_no','message','At most 40 characters'); end if;
    if length(r->>'full_name') > 200 then e := e || jsonb_build_object('field','full_name','message','At most 200 characters'); end if;
    if length(r->>'designation') > 80 then e := e || jsonb_build_object('field','designation','message','At most 80 characters'); end if;
    v := private.imp_text(p,'gender');
    if v is not null then
      if private.imp_gender(v) is null then e := e || jsonb_build_object('field','gender','message','Use male, female or transgender');
      else r := r || jsonb_build_object('gender', private.imp_gender(v)); end if;
    end if;
    v := private.imp_text(p,'phone');
    if v is not null then
      if private.imp_phone(v) is null then e := e || jsonb_build_object('field','phone','message','Use a 10-digit mobile number');
      else r := r || jsonb_build_object('phone', private.imp_phone(v)); end if;
    end if;
    v := private.imp_text(p,'email');
    if v is not null then
      if v !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then e := e || jsonb_build_object('field','email','message','Not a valid email');
      else r := r || jsonb_build_object('email', lower(v)); end if;
    end if;
    v := private.imp_text(p,'is_teaching');
    if v is not null then
      if private.imp_bool(v) is null then e := e || jsonb_build_object('field','is_teaching','message','Use yes or no');
      else r := r || jsonb_build_object('is_teaching', private.imp_bool(v)); end if;
    end if;
    v := private.imp_text(p,'joined_on');
    if v is not null then
      d := private.imp_date(v);
      if d is null then e := e || jsonb_build_object('field','joined_on','message','Not a valid date (use YYYY-MM-DD or DD/MM/YYYY)');
      else r := r || jsonb_build_object('joined_on', d); end if;
    end if;
    v := private.imp_text(p,'staff_group');
    if v is not null then
      select id into v_cls from app.staff_groups where school_id = p_school and lower(name) = lower(v) and status = 'active';
      if v_cls is null then e := e || jsonb_build_object('field','staff_group','message','No active staff group named "' || v || '". Create it first.');
      else r := r || jsonb_build_object('staff_group_id', v_cls); end if;
    end if;
    if r->>'employee_no' is not null then
      source_key := upper(r->>'employee_no');
      select id into v_exist from app.staff where school_id = p_school and upper(employee_no) = upper(r->>'employee_no');
    end if;

  elsif p_dataset in ('students_guardians', 'placements') then
    r := jsonb_build_object('admission_no', private.imp_text(p,'admission_no'));
    if length(r->>'admission_no') > 40 then e := e || jsonb_build_object('field','admission_no','message','At most 40 characters'); end if;
    -- section in the selected year
    if private.imp_text(p,'class_name') is not null and private.imp_text(p,'section_name') is not null then
      select s.id into v_sec from app.sections s join app.classes cl on cl.id = s.class_id
       where s.school_id = p_school and s.academic_year_id = p_year and s.status = 'active'
         and lower(cl.name) = lower(private.imp_text(p,'class_name')) and lower(s.name) = lower(private.imp_text(p,'section_name'));
      if v_sec is null then
        e := e || jsonb_build_object('field','section_name','message','No active section ' || private.imp_text(p,'class_name') || ' ' ||
                                     private.imp_text(p,'section_name') || ' in the selected year');
      else r := r || jsonb_build_object('section_id', v_sec); end if;
    end if;
    v := private.imp_text(p,'roll_no');
    if v is not null then
      if v !~ '^[A-Za-z0-9/-]{1,12}$' then e := e || jsonb_build_object('field','roll_no','message','Letters, digits, / or -, at most 12');
      else r := r || jsonb_build_object('roll_no', v); end if;
    end if;
    v := private.imp_text(p, case when p_dataset = 'placements' then 'effective_from' else 'joined_on' end);
    d := coalesce(private.imp_date(v), y.start_date);
    if v is not null and private.imp_date(v) is null then
      e := e || jsonb_build_object('field', case when p_dataset = 'placements' then 'effective_from' else 'joined_on' end,
                                   'message','Not a valid date (use YYYY-MM-DD or DD/MM/YYYY)');
    elsif d is not null and y.id is not null and d not between y.start_date and y.end_date then
      e := e || jsonb_build_object('field', case when p_dataset = 'placements' then 'effective_from' else 'joined_on' end,
                                   'message','Must be inside the selected academic year (' || y.start_date || ' to ' || y.end_date || ')');
    else r := r || jsonb_build_object('joined_on', d); end if;

    if p_dataset = 'placements' then
      if r->>'admission_no' is not null then
        source_key := p_year::text || ':' || upper(r->>'admission_no');
        select id into v_sid from app.students where school_id = p_school and upper(admission_no) = upper(r->>'admission_no');
        if v_sid is null then e := e || jsonb_build_object('field','admission_no','message','No student with this admission number. Import students first.');
        else
          r := r || jsonb_build_object('student_id', v_sid);
          select p2.section_id into v_exist from app.placements p2
           where p2.student_id = v_sid and p2.academic_year_id = p_year
           order by p2.effective_from desc limit 1;
          if v_exist is not null and v_exist is distinct from v_sec then
            e := e || jsonb_build_object('field','section_name','message',
                       'Already placed in another section this year. Use Students → Move placements instead.');
            v_exist := null;
          elsif v_exist is not null then
            v_exist := v_sid;     -- same section: nothing to do
          end if;
        end if;
      end if;
    else
      r := r || jsonb_build_object('full_name', private.imp_text(p,'full_name'), 'father_name', private.imp_text(p,'father_name'),
             'mother_name', private.imp_text(p,'mother_name'), 'address_line', private.imp_text(p,'address_line'),
             'mother_tongue', private.imp_text(p,'mother_tongue'), 'previous_school', private.imp_text(p,'previous_school'),
             'previous_class', private.imp_text(p,'previous_class'));
      if length(r->>'full_name') > 200 then e := e || jsonb_build_object('field','full_name','message','At most 200 characters'); end if;
      if length(r->>'father_name') > 200 then e := e || jsonb_build_object('field','father_name','message','At most 200 characters'); end if;
      if length(r->>'mother_name') > 200 then e := e || jsonb_build_object('field','mother_name','message','At most 200 characters'); end if;
      if length(r->>'address_line') > 500 then e := e || jsonb_build_object('field','address_line','message','At most 500 characters'); end if;
      if length(r->>'mother_tongue') > 60 then e := e || jsonb_build_object('field','mother_tongue','message','At most 60 characters'); end if;
      if length(r->>'previous_school') > 200 then e := e || jsonb_build_object('field','previous_school','message','At most 200 characters'); end if;
      if length(r->>'previous_class') > 40 then e := e || jsonb_build_object('field','previous_class','message','At most 40 characters'); end if;
      v := private.imp_text(p,'gender');
      if v is not null then
        if private.imp_gender(v) is null then e := e || jsonb_build_object('field','gender','message','Use male, female or transgender');
        else r := r || jsonb_build_object('gender', private.imp_gender(v)); end if;
      end if;
      v := private.imp_text(p,'date_of_birth');
      if v is not null then
        d := private.imp_date(v);
        if d is null then e := e || jsonb_build_object('field','date_of_birth','message','Not a valid date (use YYYY-MM-DD or DD/MM/YYYY)');
        elsif d <= date '1990-01-01' or d > private.school_today(p_school) then
          e := e || jsonb_build_object('field','date_of_birth','message','Date of birth looks wrong');
        else r := r || jsonb_build_object('date_of_birth', d); end if;
      end if;
      v := private.imp_text(p,'admission_date');
      if v is not null then
        d := private.imp_date(v);
        if d is null then e := e || jsonb_build_object('field','admission_date','message','Not a valid date (use YYYY-MM-DD or DD/MM/YYYY)');
        else r := r || jsonb_build_object('admission_date', d); end if;
      end if;
      v := private.imp_text(p,'pincode');
      if v is not null then
        if v !~ '^[0-9]{6}$' then e := e || jsonb_build_object('field','pincode','message','6 digits');
        else r := r || jsonb_build_object('pincode', v); end if;
      end if;
      v := private.imp_text(p,'mobile');
      if v is not null then
        if private.imp_phone(v) is null then e := e || jsonb_build_object('field','mobile','message','Use a 10-digit mobile number');
        else r := r || jsonb_build_object('mobile', private.imp_phone(v)); end if;
      end if;
      v := private.imp_text(p,'email');
      if v is not null then
        if v !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then e := e || jsonb_build_object('field','email','message','Not a valid email');
        else r := r || jsonb_build_object('email', lower(v)); end if;
      end if;
      v := private.imp_text(p,'blood_group');
      if v is not null then
        if upper(replace(v, ' ', '')) not in ('A+','A-','B+','B-','AB+','AB-','O+','O-') then
          e := e || jsonb_build_object('field','blood_group','message','Use A+, A-, B+, B-, AB+, AB-, O+ or O-');
        else r := r || jsonb_build_object('blood_group', upper(replace(v, ' ', ''))); end if;
      end if;
      -- guardians
      g1p := private.imp_phone(private.imp_text(p,'guardian1_phone'));
      if private.imp_text(p,'guardian1_phone') is not null and g1p is null then
        e := e || jsonb_build_object('field','guardian1_phone','message','Use a 10-digit mobile number');
      end if;
      v_rel := private.imp_relationship(private.imp_text(p,'guardian1_relationship'));
      if v_rel = 'invalid' then e := e || jsonb_build_object('field','guardian1_relationship','message','Use mother, father, guardian, grandparent, sibling or other'); end if;
      v := private.imp_text(p,'guardian1_email');
      if v is not null and v !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        e := e || jsonb_build_object('field','guardian1_email','message','Not a valid email');
      end if;
      if length(private.imp_text(p,'guardian1_name')) > 200 then e := e || jsonb_build_object('field','guardian1_name','message','At most 200 characters'); end if;
      if length(private.imp_text(p,'guardian1_occupation')) > 100 then e := e || jsonb_build_object('field','guardian1_occupation','message','At most 100 characters'); end if;
      r := r || jsonb_build_object('guardians', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
              'full_name', private.imp_text(p,'guardian1_name'), 'phone', g1p,
              'relationship', coalesce(nullif(v_rel, 'invalid'), 'guardian'), 'email', lower(v),
              'occupation', private.imp_text(p,'guardian1_occupation'), 'is_primary', true))));
      if private.imp_text(p,'guardian2_name') is not null or private.imp_text(p,'guardian2_phone') is not null then
        g2p := private.imp_phone(private.imp_text(p,'guardian2_phone'));
        if private.imp_text(p,'guardian2_name') is null then e := e || jsonb_build_object('field','guardian2_name','message','Required when Parent 2 mobile is given'); end if;
        if g2p is null then e := e || jsonb_build_object('field','guardian2_phone','message','Use a 10-digit mobile number'); end if;
        if length(private.imp_text(p,'guardian2_name')) > 200 then e := e || jsonb_build_object('field','guardian2_name','message','At most 200 characters'); end if;
        v_rel := private.imp_relationship(private.imp_text(p,'guardian2_relationship'));
        if v_rel = 'invalid' then e := e || jsonb_build_object('field','guardian2_relationship','message','Use mother, father, guardian, grandparent, sibling or other'); end if;
        if g2p is not null and g2p = g1p and lower(private.imp_text(p,'guardian2_name')) = lower(private.imp_text(p,'guardian1_name')) then
          e := e || jsonb_build_object('field','guardian2_name','message','Parent 2 is the same person as Parent 1');
        end if;
        r := jsonb_set(r, '{guardians}', (r->'guardians') || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
               'full_name', private.imp_text(p,'guardian2_name'), 'phone', g2p,
               'relationship', coalesce(nullif(v_rel, 'invalid'), 'guardian'), 'is_primary', false))));
      end if;
      -- existing guardians that will be reused (siblings)
      info := info || jsonb_build_object('reuses_guardians', coalesce((
        select jsonb_agg(jsonb_build_object('guardian_id', g.id, 'full_name', g.full_name))
          from app.guardians g, jsonb_array_elements(r->'guardians') x
         where g.school_id = p_school and g.phone = x->>'phone' and lower(g.full_name) = lower(x->>'full_name')), '[]'::jsonb));
      if r->>'admission_no' is not null then
        source_key := upper(r->>'admission_no');
        select id into v_exist from app.students where school_id = p_school and upper(admission_no) = upper(r->>'admission_no');
      end if;
    end if;
  elsif p_dataset = 'opening_balances' then
    r := jsonb_build_object('origin_label', private.imp_text(p,'origin_label'), 'source_ref', private.imp_text(p,'source_ref'));
    if length(r->>'origin_label') > 120 then e := e || jsonb_build_object('field','origin_label','message','At most 120 characters'); end if;
    if length(r->>'source_ref') > 60 then e := e || jsonb_build_object('field','source_ref','message','At most 60 characters'); end if;
    if p_year is null or not exists (select 1 from app.academic_years ay where ay.id = p_year and ay.school_id = p_school) then e := e || jsonb_build_object('field', null, 'message', 'Academic year not found'); end if;
    v := private.imp_text(p,'admission_no');
    if v is not null then
      select id into v_sid from app.students where school_id = p_school and upper(admission_no) = upper(v);
      if v_sid is null then e := e || jsonb_build_object('field','admission_no','message','No student with this admission number');
      else
        r := r || jsonb_build_object('student_id', v_sid);
        info := info || jsonb_build_object('student_name', (select full_name from app.students where id = v_sid));
      end if;
    end if;
    k := private.imp_text(p,'fee_head_code');
    if k is not null then
      select id into v_cls from app.fee_heads where school_id = p_school and upper(code) = upper(k) and status = 'active' and kind <> 'late_fee';
      if v_cls is null then e := e || jsonb_build_object('field','fee_head_code','message','No active fee head with this code (late-fee heads can''t be used)');
      else
        r := r || jsonb_build_object('fee_head_id', v_cls);
        info := info || jsonb_build_object('fee_head_name', (select name from app.fee_heads where id = v_cls));
      end if;
    end if;
    if private.imp_text(p,'amount') is not null then
      if coalesce(private.rupees_to_paise(private.imp_text(p,'amount')), 0) <= 0 then
        e := e || jsonb_build_object('field','amount','message','An amount in rupees greater than 0, for example 4500 or 4,500.50');
      else
        r := r || jsonb_build_object('amount_paise', private.rupees_to_paise(private.imp_text(p,'amount')));
        info := info || jsonb_build_object('amount_paise', r->'amount_paise');
      end if;
    end if;
    v := private.imp_text(p,'due_date');
    if v is not null then
      d := private.imp_date(v);
      if d is null then e := e || jsonb_build_object('field','due_date','message','Use YYYY-MM-DD or DD/MM/YYYY');
      else r := r || jsonb_build_object('due_date', d); end if;
    end if;
    if private.imp_text(p,'admission_no') is not null and k is not null and r->>'origin_label' is not null then
      source_key := private.opening_key(private.imp_text(p,'admission_no'), k, coalesce(r->>'source_ref', r->>'origin_label'));
      r := r || jsonb_build_object('source_key', source_key);
      select i.id into v_exist from app.invoices i where i.school_id = p_school and i.source_key = 'opening:' || imp_validate.source_key;
      if v_exist is not null and (r ? 'amount_paise')
         and (select coalesce(sum(l.gross_paise), 0) from app.invoice_lines l where l.invoice_id = v_exist) <> (r->>'amount_paise')::bigint then
        e := e || jsonb_build_object('field','amount','message',
               'An opening balance for this student, fee head and description was already imported with a different amount. '
               || 'Fix it on the student''s fee statement, or give this row an Old reference.');
      end if;
    end if;
  end if;

  if source_key is not null and v_exist is null then
    select sk.entity_id into v_exist from app.import_source_keys sk
     where sk.school_id = p_school and sk.dataset = p_dataset and sk.source_key = imp_validate.source_key;
  end if;
  if v_exist is not null then
    action := 'skip';
    info := info || jsonb_build_object('existing_id', v_exist, 'note', 'Already exists — nothing will change');
  end if;
  errors := case when jsonb_array_length(e) = 0 then null else e end;
  norm := r;
end $$;


create or replace function private.imp_commit_row(c record, j app.import_jobs, n jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_cls uuid; v_id uuid; v_sid uuid; v_eid uuid; g jsonb; v_gid uuid; v_y record;
begin
  if j.dataset = 'classes_sections' then
    select id into v_cls from app.classes where school_id = c.school_id and lower(name) = lower(n->>'class_name');
    if v_cls is null then
      insert into app.classes (school_id, name, sort_order)
      values (c.school_id, n->>'class_name',
              coalesce((n->>'class_order')::int, (select coalesce(max(sort_order), 0) + 1 from app.classes where school_id = c.school_id)))
      returning id into v_cls;
    end if;
    insert into app.sections (school_id, academic_year_id, class_id, name, capacity, sort_order)
    values (c.school_id, j.academic_year_id, v_cls, n->>'section_name', (n->>'capacity')::int,
            (select coalesce(max(sort_order), 0) + 1 from app.sections where school_id = c.school_id
               and academic_year_id = j.academic_year_id and class_id = v_cls))
    returning id into v_id;
    return v_id;

  elsif j.dataset = 'staff' then
    insert into app.staff (school_id, employee_no, full_name, gender, phone, email, staff_group_id, designation,
                           is_teaching, joined_on, created_by)
    values (c.school_id, n->>'employee_no', n->>'full_name', n->>'gender', n->>'phone', n->>'email',
            (n->>'staff_group_id')::uuid, n->>'designation', coalesce((n->>'is_teaching')::boolean, false),
            (n->>'joined_on')::date, c.account_id)
    returning id into v_id;
    return v_id;

  elsif j.dataset = 'students_guardians' then
    insert into app.students (school_id, admission_no, full_name, gender, date_of_birth, mother_name, father_name,
                              address_line, pincode, mobile, email, mother_tongue, blood_group, admission_date,
                              previous_school, previous_class, created_by, updated_by)
    values (c.school_id, n->>'admission_no', n->>'full_name', n->>'gender', (n->>'date_of_birth')::date,
            n->>'mother_name', n->>'father_name', n->>'address_line', n->>'pincode', n->>'mobile', n->>'email',
            n->>'mother_tongue', n->>'blood_group', coalesce((n->>'admission_date')::date, (n->>'joined_on')::date),
            n->>'previous_school', n->>'previous_class', c.account_id, c.account_id)
    returning id into v_sid;
    for g in select * from jsonb_array_elements(n->'guardians') loop
      -- siblings share a guardian when name + mobile match
      select id into v_gid from app.guardians
       where school_id = c.school_id and phone = g->>'phone' and lower(full_name) = lower(g->>'full_name')
       order by created_at limit 1;
      if v_gid is null then
        insert into app.guardians (school_id, full_name, phone, email, occupation, address_line, created_by)
        values (c.school_id, g->>'full_name', g->>'phone', g->>'email', g->>'occupation', n->>'address_line', c.account_id)
        returning id into v_gid;
      end if;
      insert into app.student_guardians (school_id, student_id, guardian_id, relationship, is_primary, portal_access)
      values (c.school_id, v_sid, v_gid, g->>'relationship', coalesce((g->>'is_primary')::boolean, false), true)
      on conflict (student_id, guardian_id) do nothing;
    end loop;
    insert into app.enrollments (school_id, academic_year_id, student_id, joined_on, created_by)
    values (c.school_id, j.academic_year_id, v_sid, (n->>'joined_on')::date, c.account_id) returning id into v_eid;
    insert into app.placements (school_id, academic_year_id, enrollment_id, student_id, section_id, roll_no,
                                effective_from, reason, created_by)
    values (c.school_id, j.academic_year_id, v_eid, v_sid, (n->>'section_id')::uuid, n->>'roll_no',
            (n->>'joined_on')::date, 'Import', c.account_id);
    return v_sid;

  elsif j.dataset = 'placements' then
    v_sid := (n->>'student_id')::uuid;
    select id into v_eid from app.enrollments where student_id = v_sid and academic_year_id = j.academic_year_id;
    if v_eid is null then
      insert into app.enrollments (school_id, academic_year_id, student_id, joined_on, created_by)
      values (c.school_id, j.academic_year_id, v_sid, (n->>'joined_on')::date, c.account_id) returning id into v_eid;
    end if;
    -- a still-open placement from an earlier year ends when that year ends (or when this one starts)
    update app.placements p
       set effective_to = least((select ay.end_date + 1 from app.academic_years ay where ay.id = p.academic_year_id),
                                (n->>'joined_on')::date)
     where p.student_id = v_sid and p.academic_year_id <> j.academic_year_id
       and p.effective_from < (n->>'joined_on')::date
       and (p.effective_to is null or p.effective_to > (n->>'joined_on')::date);
    insert into app.placements (school_id, academic_year_id, enrollment_id, student_id, section_id, roll_no,
                                effective_from, reason, created_by)
    values (c.school_id, j.academic_year_id, v_eid, v_sid, (n->>'section_id')::uuid, n->>'roll_no',
            (n->>'joined_on')::date, 'Import', c.account_id);
    return v_sid;

  elsif j.dataset = 'opening_balances' then
    return (private._issue_opening_balance(c.school_id, c.account_id, (n->>'student_id')::uuid, j.academic_year_id,
              (n->>'fee_head_id')::uuid, (n->>'amount_paise')::bigint, n->>'origin_label', n->>'source_key',
              (n->>'due_date')::date)->>'invoice_id')::uuid;
  end if;
  perform private.fail('VALIDATION_ERROR', 'Unknown dataset');
end $$;


create or replace function private.get_import_template(p_rev integer, p_dataset text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('imports.manage');
  if p_dataset not in ('classes_sections','staff','students_guardians','placements','opening_balances') then
    perform private.fail('VALIDATION_ERROR', 'Unknown dataset');
  end if;
  return jsonb_build_object('dataset', p_dataset, 'columns', private.imp_columns(p_dataset),
                            'needs_year', p_dataset <> 'staff', 'max_rows', 10000, 'max_rows_per_upload', 500,
                            'max_rows_per_commit', 100);
end $$;


create or replace function private.start_import(p_rev integer, p_operation_id uuid, p_dataset text, p_academic_year_id uuid,
                                                p_file_name text, p_source_fingerprint text, p_mapping jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; j app.import_jobs;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('imports.manage');
  if p_operation_id is null then perform private.fail('VALIDATION_ERROR', 'operation id is required'); end if;
  select * into j from app.import_jobs where school_id = c.school_id and operation_id = p_operation_id;
  if found then
    return private.imp_job_json(j) || jsonb_build_object('replayed', true,
      'same_file_before', coalesce((select jsonb_agg(jsonb_build_object('job_id', o.id, 'created_at', o.created_at, 'status', o.status)
                                                     order by o.created_at desc)
                                      from app.import_jobs o where o.school_id = c.school_id and o.dataset = j.dataset
                                       and o.source_fingerprint = j.source_fingerprint and o.id <> j.id
                                       and o.created_at < j.created_at), '[]'::jsonb));
  end if;
  if p_dataset not in ('classes_sections','staff','students_guardians','placements','opening_balances') then
    perform private.fail('VALIDATION_ERROR', 'Unknown dataset');
  end if;
  if p_dataset = 'opening_balances' then perform private.require_cap('fees.manage'); end if;
  if p_dataset <> 'staff' then
    if p_academic_year_id is null then perform private.fail('VALIDATION_ERROR', 'Choose the academic year'); end if;
    if not exists (select 1 from app.academic_years where id = p_academic_year_id and school_id = c.school_id) then
      perform private.fail('NOT_FOUND', 'Academic year not found');
    end if;
  end if;
  if p_source_fingerprint is null or length(p_source_fingerprint) not between 16 and 128 then
    perform private.fail('VALIDATION_ERROR', 'File fingerprint is missing');
  end if;
  insert into app.import_jobs (school_id, academic_year_id, dataset, file_name, source_fingerprint, mapping, status,
                               operation_id, created_by)
  values (c.school_id, case when p_dataset = 'staff' then null else p_academic_year_id end, p_dataset,
          left(p_file_name, 255), p_source_fingerprint, coalesce(p_mapping, '{}'), 'validating', p_operation_id, c.account_id)
  returning * into j;
  perform private.log_event('imports.started', 'import_jobs', j.id::text,
                            jsonb_build_object('dataset', p_dataset, 'file_name', j.file_name), p_operation_id, j.academic_year_id);
  return private.imp_job_json(j) || jsonb_build_object(
    'same_file_before', coalesce((select jsonb_agg(jsonb_build_object('job_id', o.id, 'created_at', o.created_at, 'status', o.status)
                                                   order by o.created_at desc)
                                    from app.import_jobs o where o.school_id = c.school_id and o.dataset = p_dataset
                                     and o.source_fingerprint = p_source_fingerprint and o.id <> j.id
                                     and o.created_at < j.created_at), '[]'::jsonb));
end $$;


create or replace function private.commit_import_chunk(p_rev integer, p_job_id uuid, p_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c record; j app.import_jobs; ir app.import_rows; v record; v_id uuid; v_out jsonb := '[]'; v_msg text;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100); v_counts jsonb; v_dup boolean;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('imports.manage');
  j := private.imp_lock_job(c.school_id, p_job_id, true);
  if j.dataset in ('students_guardians') then perform private.require_cap('students.manage'); end if;
  if j.dataset = 'staff' then perform private.require_cap('staff.manage'); end if;
  if j.dataset = 'classes_sections' then perform private.require_cap('setup.manage'); end if;
  if j.dataset = 'placements' then perform private.require_cap('students.manage'); end if;
  if j.dataset = 'opening_balances' then perform private.require_cap('fees.manage'); end if;

  for ir in select * from app.import_rows r
             where r.import_job_id = j.id and r.status = 'draft' and r.errors is null
               and not (r.source_key is not null and exists (select 1 from app.import_rows o where o.import_job_id = j.id
                          and o.source_key = r.source_key and o.row_no < r.row_no and o.status <> 'removed'))
             order by r.row_no limit v_limit for update loop
    -- duplicate inside this file → leave as needing a fix
    v_dup := ir.source_key is not null and exists (select 1 from app.import_rows o where o.import_job_id = j.id
               and o.source_key = ir.source_key and o.row_no < ir.row_no and o.status <> 'removed');
    if v_dup then continue; end if;
    -- re-validate against the current database (things may have changed since preview)
    v := private.imp_validate(c.school_id, j.dataset, j.academic_year_id, ir.payload);
    if v.errors is not null then
      update app.import_rows set errors = v.errors, source_key = v.source_key, action = v.action, updated_at = now() where id = ir.id;
      v_out := v_out || jsonb_build_object('row_no', ir.row_no, 'outcome', 'needs_fixing', 'errors', v.errors);
      continue;
    end if;
    if v.action = 'skip' then
      update app.import_rows set status = 'committed', action = 'skip', source_key = v.source_key,
                                 result_entity_id = (v.info->>'existing_id')::uuid, chunk_no = 0, updated_at = now()
       where id = ir.id;
      v_out := v_out || jsonb_build_object('row_no', ir.row_no, 'outcome', 'skipped', 'entity_id', v.info->>'existing_id');
      continue;
    end if;
    begin
      v_id := private.imp_commit_row(c, j, v.norm);
      insert into app.import_source_keys (school_id, dataset, source_key, entity_id, import_job_id)
      values (c.school_id, j.dataset, v.source_key, v_id, j.id)
      on conflict (school_id, dataset, source_key) do nothing;
      update app.import_rows set status = 'committed', action = 'create', source_key = v.source_key,
                                 result_entity_id = v_id, errors = null, updated_at = now() where id = ir.id;
      v_out := v_out || jsonb_build_object('row_no', ir.row_no, 'outcome', 'created', 'entity_id', v_id);
    exception when others then
      v_msg := case
        when sqlstate = 'P0001' then sqlerrm
        when sqlstate = '23505' then 'Already exists (same name, code or number)'
        when sqlstate = '23P01' then 'Roll number already used in this section, or the dates overlap an existing placement'
        when sqlstate = '23514' then 'A value is not allowed'
        else 'Could not import this row' end;
      update app.import_rows set status = 'rejected',
                                 errors = jsonb_build_array(jsonb_build_object('field', null, 'message', v_msg)),
                                 updated_at = now() where id = ir.id;
      v_out := v_out || jsonb_build_object('row_no', ir.row_no, 'outcome', 'rejected', 'error', v_msg);
    end;
  end loop;

  v_counts := private.imp_counts(j.id);
  update app.import_jobs set status = 'committing',
         committed_rows = (v_counts->>'created')::int + (v_counts->>'skipped')::int,
         rejected_rows = (v_counts->>'rejected')::int, updated_at = now()
   where id = j.id returning * into j;
  if jsonb_array_length(v_out) > 0 then
    perform private.log_event('imports.chunk_committed', 'import_jobs', j.id::text,
      jsonb_build_object('dataset', j.dataset,
        'created', (select count(*) from jsonb_array_elements(v_out) x where x->>'outcome' = 'created'),
        'skipped', (select count(*) from jsonb_array_elements(v_out) x where x->>'outcome' = 'skipped'),
        'rejected', (select count(*) from jsonb_array_elements(v_out) x where x->>'outcome' = 'rejected')),
      j.operation_id, j.academic_year_id);
  end if;
  return jsonb_build_object('job', private.imp_job_json(j), 'processed', v_out,
                            'more_ready', (v_counts->>'ready')::int + (v_counts->>'will_skip')::int > 0);
end $$;


create or replace function private.get_import_job(p_rev integer, p_job_id uuid, p_filter text, p_after_row_no integer, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; j app.import_jobs; v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200); v_rows jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('imports.manage');
  select * into j from app.import_jobs where id = p_job_id and school_id = c.school_id;
  if not found then perform private.fail('NOT_FOUND', 'Import not found'); end if;
  if coalesce(p_filter, 'all') not in ('all','ready','will_skip','needs_fixing','created','skipped','rejected','removed') then
    perform private.fail('VALIDATION_ERROR', 'Unknown filter');
  end if;
  with r as (
    select ir.*, ir.source_key is not null and exists (
             select 1 from app.import_rows o where o.import_job_id = ir.import_job_id and o.source_key = ir.source_key
               and o.row_no < ir.row_no and o.status <> 'removed') as dup
      from app.import_rows ir
     where ir.import_job_id = j.id and ir.row_no > coalesce(p_after_row_no, 0))
  select coalesce(jsonb_agg(private.imp_row_json(row(r.id, r.school_id, r.import_job_id, r.row_no, r.source_key, r.action,
                    r.status, r.payload, r.errors, r.result_entity_id, r.expected_version, r.chunk_no, r.updated_at)::app.import_rows)
                    order by r.row_no), '[]'::jsonb)
    into v_rows
    from (select * from r where case coalesce(p_filter, 'all')
            when 'all' then true
            when 'ready' then status = 'draft' and errors is null and not dup and action = 'create'
            when 'will_skip' then status = 'draft' and errors is null and not dup and action = 'skip'
            when 'needs_fixing' then status = 'draft' and (errors is not null or dup)
            when 'created' then status = 'committed' and action = 'create'
            when 'skipped' then status = 'committed' and action = 'skip'
            when 'rejected' then status = 'rejected'
            when 'removed' then status = 'removed' end
          order by row_no limit v_limit) r;
  return jsonb_build_object('job', private.imp_job_json(j), 'columns', private.imp_columns(j.dataset), 'rows', v_rows,
    'next_cursor', case when jsonb_array_length(v_rows) = v_limit then (v_rows->-1->>'row_no')::int end,
    'amount_totals', case when j.dataset = 'opening_balances' then (
      with r as (
        select ir.status, ir.action, ir.errors, private.rupees_to_paise(ir.payload->>'amount') as amt,
               ir.source_key is not null and exists (
                 select 1 from app.import_rows o where o.import_job_id = ir.import_job_id and o.source_key = ir.source_key
                   and o.row_no < ir.row_no and o.status <> 'removed') as dup
          from app.import_rows ir where ir.import_job_id = j.id)
      select jsonb_build_object(
        'ready_paise', coalesce(sum(amt) filter (where status = 'draft' and errors is null and not dup and action = 'create'), 0),
        'created_paise', coalesce(sum(amt) filter (where status = 'committed' and action = 'create'), 0))
        from r) end);
end $$;


create or replace function private.get_student_statement(p_rev integer, p_student_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  if not (private.has_cap('fees.read') or p_student_id = private.ctx_child_id()) then
    perform private.fail('FORBIDDEN', 'Not permitted');
  end if;
  if not exists (select 1 from app.students where id = p_student_id and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Student not found');
  end if;
  return jsonb_build_object(
    'student_id', p_student_id,
    'invoices', coalesce((select jsonb_agg(jsonb_build_object(
        'invoice_id', b.invoice_id, 'invoice_no', b.invoice_no, 'due_date', b.due_date, 'status', b.status,
        'source', b.source, 'origin_label', i.origin_label, 'term', i.snapshot->>'term', 'year', i.snapshot->>'year',
        'charged_paise', b.charged_paise, 'adjustments_paise', b.adjustments_paise,
        'paid_paise', b.allocated_paise - b.reversed_paise, 'balance_paise', b.balance_paise,
        'payment_state', case when b.status = 'cancelled' then 'cancelled'
                              when b.balance_paise = 0 then 'paid'
                              when b.allocated_paise - b.reversed_paise > 0 then 'partial' else 'unpaid' end,
        'overdue', b.balance_paise > 0 and b.due_date < private.school_today(c.school_id),
        'lines', (select jsonb_agg(jsonb_build_object('fee_head_id', l.fee_head_id, 'label', l.label, 'gross_paise', l.gross_paise,
                                                      'concession_paise', l.concession_paise, 'net_paise', l.net_paise)
                                   order by l.sort_order) from app.invoice_lines l where l.invoice_id = b.invoice_id),
        'adjustments', (select jsonb_agg(jsonb_build_object('kind', ad.kind, 'amount_paise', ad.amount_paise,
                                                            'reason', ad.reason, 'at', ad.created_at) order by ad.created_at)
                          from app.invoice_adjustments ad where ad.invoice_id = b.invoice_id)
      ) order by b.due_date, b.invoice_no) from private.invoice_balances(c.school_id, p_student_id) b
        join app.invoices i on i.id = b.invoice_id), '[]'::jsonb),
    'collections', coalesce((select jsonb_agg(jsonb_build_object(
        'collection_id', col.id, 'receipt_id', r.id, 'receipt_no', r.receipt_no, 'received_on', col.received_on,
        'method', col.method, 'amount_paise', col.amount_paise, 'reference', col.external_ref,
        'allocations', (select jsonb_agg(jsonb_build_object('invoice_id', ca.invoice_id, 'invoice_no', i2.invoice_no,
                                                            'amount_paise', ca.amount_paise) order by i2.due_date, i2.invoice_no)
                          from app.collection_allocations ca join app.invoices i2 on i2.id = ca.invoice_id
                         where ca.collection_id = col.id),
        'reversed_paise', (select coalesce(sum(amount_paise), 0) from app.collection_reversals cr where cr.collection_id = col.id),
        'reversals', (select jsonb_agg(jsonb_build_object('amount_paise', cr.amount_paise, 'cause', cr.cause,
                                                          'reason', cr.reason, 'at', cr.created_at))
                        from app.collection_reversals cr where cr.collection_id = col.id)
      ) order by col.received_on, col.created_at)
      from app.collections col join app.receipts r on r.collection_id = col.id
     where col.student_id = p_student_id and col.school_id = c.school_id), '[]'::jsonb),
    'pending_cheques', coalesce((select jsonb_agg(jsonb_build_object('cheque_id', id, 'cheque_no', cheque_no,
                                   'bank_name', bank_name, 'amount_paise', amount_paise, 'received_on', received_on))
                                 from app.cheques where student_id = p_student_id and status = 'pending'), '[]'::jsonb),
    'bounced_cheques', coalesce((select jsonb_agg(jsonb_build_object('cheque_id', id, 'cheque_no', cheque_no,
                                   'amount_paise', amount_paise, 'bounced_on', bounced_on, 'reason', bounce_reason))
                                 from app.cheques where student_id = p_student_id and status = 'bounced'), '[]'::jsonb),
    'total_due_paise', (select coalesce(sum(balance_paise), 0) from private.invoice_balances(c.school_id, p_student_id)),
    'open_exceptions', (select count(*) from app.payment_exceptions where student_id = p_student_id and status = 'open'));
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
    'by_collector', coalesce((select jsonb_agg(jsonb_build_object('collector', a.display_name, 'amount_paise', q.amt))
                      from (select collected_by, sum(amount_paise) amt from app.collections
                             where school_id = c.school_id and received_on between p_from and p_to group by collected_by) q
                      join app.accounts a on a.id = q.collected_by), '[]'::jsonb),
    'by_account', coalesce((select jsonb_agg(jsonb_build_object('account', coalesce(ra.label, 'Cash'), 'amount_paise', q.amt))
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


drop function if exists private.get_dues_report(integer, uuid, uuid, uuid, boolean);

-- -----------------------------------------------------------------------------
-- Public wrappers
-- -----------------------------------------------------------------------------
create or replace function public.get_fee_setup(p_ctx_rev integer, p_academic_year_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_fee_setup(p_ctx_rev, p_academic_year_id) $$;
create or replace function public.list_student_concessions(p_ctx_rev integer, p_academic_year_id uuid default null, p_student_id uuid default null, p_include_revoked boolean default false, p_after_id uuid default null, p_limit integer default 100)
returns jsonb language sql security invoker set search_path = '' as $$ select private.list_student_concessions(p_ctx_rev, p_academic_year_id, p_student_id, p_include_revoked, p_after_id, p_limit) $$;
create or replace function public.list_optional_fee_roster(p_ctx_rev integer, p_academic_year_id uuid, p_fee_head_id uuid, p_section_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.list_optional_fee_roster(p_ctx_rev, p_academic_year_id, p_fee_head_id, p_section_id) $$;
create or replace function public.set_optional_fees(p_ctx_rev integer, p_operation_id uuid, p_academic_year_id uuid, p_fee_head_id uuid, p_changes jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select private.set_optional_fees(p_ctx_rev, p_operation_id, p_academic_year_id, p_fee_head_id, p_changes) $$;
create or replace function public.list_collections(p_ctx_rev integer, p_from date, p_to date, p_method text default null, p_receiving_account_id uuid default null, p_collected_by uuid default null, p_search text default null, p_before_date date default null, p_before_id uuid default null, p_limit integer default 50)
returns jsonb language sql security invoker set search_path = '' as $$ select private.list_collections(p_ctx_rev, p_from, p_to, p_method, p_receiving_account_id, p_collected_by, p_search, p_before_date, p_before_id, p_limit) $$;
create or replace function public.list_cheques(p_ctx_rev integer, p_status text default 'pending', p_from date default null, p_to date default null, p_before_date date default null, p_before_id uuid default null, p_limit integer default 50)
returns jsonb language sql security invoker set search_path = '' as $$ select private.list_cheques(p_ctx_rev, p_status, p_from, p_to, p_before_date, p_before_id, p_limit) $$;
create or replace function public.cancel_cheque(p_ctx_rev integer, p_cheque_id uuid, p_reason text, p_expected_version integer)
returns jsonb language sql security invoker set search_path = '' as $$ select private.cancel_cheque(p_ctx_rev, p_cheque_id, p_reason, p_expected_version) $$;
create or replace function public.record_payment_exception(p_ctx_rev integer, p_operation_id uuid, p_kind text, p_amount_paise bigint, p_note text, p_student_id uuid default null, p_collection_id uuid default null, p_reference text default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.record_payment_exception(p_ctx_rev, p_operation_id, p_kind, p_amount_paise, p_note, p_student_id, p_collection_id, p_reference) $$;
create or replace function public.list_payment_exceptions(p_ctx_rev integer, p_status text default 'open', p_before_id uuid default null, p_limit integer default 50)
returns jsonb language sql security invoker set search_path = '' as $$ select private.list_payment_exceptions(p_ctx_rev, p_status, p_before_id, p_limit) $$;
create or replace function public.resolve_payment_exception(p_ctx_rev integer, p_id uuid, p_note text, p_expected_version integer)
returns jsonb language sql security invoker set search_path = '' as $$ select private.resolve_payment_exception(p_ctx_rev, p_id, p_note, p_expected_version) $$;
create or replace function public.cancel_invoice(p_ctx_rev integer, p_operation_id uuid, p_invoice_id uuid, p_reason text)
returns jsonb language sql security invoker set search_path = '' as $$ select private.cancel_invoice(p_ctx_rev, p_operation_id, p_invoice_id, p_reason) $$;
create or replace function public.get_dues_report(p_ctx_rev integer, p_academic_year_id uuid default null, p_class_id uuid default null, p_section_id uuid default null, p_only_overdue boolean default false, p_fee_term_id uuid default null, p_only_with_balance boolean default false)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_dues_report(p_ctx_rev, p_academic_year_id, p_class_id, p_section_id, p_only_overdue, p_fee_term_id, p_only_with_balance) $$;
create or replace function public.save_fee_head(p_ctx_rev integer, p_name text, p_code text, p_kind text default 'regular', p_is_optional boolean default false, p_status text default 'active', p_id uuid default null, p_expected_version integer default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.save_fee_head(p_ctx_rev, p_name, p_code, p_kind, p_is_optional, p_status, p_id, p_expected_version) $$;
create or replace function public.save_receiving_account(p_ctx_rev integer, p jsonb, p_id uuid default null, p_expected_version integer default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.save_receiving_account(p_ctx_rev, p, p_id, p_expected_version) $$;
create or replace function public.save_fee_term(p_ctx_rev integer, p_academic_year_id uuid, p_name text, p_sort_order integer, p_due_date date, p_id uuid default null, p_expected_version integer default null, p_status text default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.save_fee_term(p_ctx_rev, p_academic_year_id, p_name, p_sort_order, p_due_date, p_id, p_expected_version, p_status) $$;
create or replace function public.save_fee_structure(p_ctx_rev integer, p_fee_term_id uuid, p_class_id uuid, p_lines jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select private.save_fee_structure(p_ctx_rev, p_fee_term_id, p_class_id, p_lines) $$;
create or replace function public.save_concession_preset(p_ctx_rev integer, p_name text, p_kind text, p_fee_head_ids uuid[], p_percent_bp integer default null, p_fixed_paise bigint default null, p_status text default 'active', p_id uuid default null, p_expected_version integer default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.save_concession_preset(p_ctx_rev, p_name, p_kind, p_fee_head_ids, p_percent_bp, p_fixed_paise, p_status, p_id, p_expected_version) $$;
create or replace function public.grant_concession(p_ctx_rev integer, p_operation_id uuid, p_student_id uuid, p_academic_year_id uuid, p_preset_id uuid, p_reason text, p_fee_term_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.grant_concession(p_ctx_rev, p_operation_id, p_student_id, p_academic_year_id, p_preset_id, p_reason, p_fee_term_id) $$;
create or replace function public.revoke_concession(p_ctx_rev integer, p_student_concession_id uuid, p_reason text)
returns jsonb language sql security invoker set search_path = '' as $$ select private.revoke_concession(p_ctx_rev, p_student_concession_id, p_reason) $$;
create or replace function public.save_late_fee_rule(p_ctx_rev integer, p_academic_year_id uuid, p_fee_head_id uuid, p_amount_paise bigint, p_grace_days integer default 0)
returns jsonb language sql security invoker set search_path = '' as $$ select private.save_late_fee_rule(p_ctx_rev, p_academic_year_id, p_fee_head_id, p_amount_paise, p_grace_days) $$;
create or replace function public.retire_late_fee_rule(p_ctx_rev integer, p_academic_year_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select private.retire_late_fee_rule(p_ctx_rev, p_academic_year_id) $$;

-- Lockdown (same block as 1400)
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on function
  private.get_fee_setup(integer, uuid),
  private.list_student_concessions(integer, uuid, uuid, boolean, uuid, integer),
  private.list_optional_fee_roster(integer, uuid, uuid, uuid),
  private.set_optional_fees(integer, uuid, uuid, uuid, jsonb),
  private.list_collections(integer, date, date, text, uuid, uuid, text, date, uuid, integer),
  private.list_cheques(integer, text, date, date, date, uuid, integer),
  private.cancel_cheque(integer, uuid, text, integer),
  private.record_payment_exception(integer, uuid, text, bigint, text, uuid, uuid, text),
  private.list_payment_exceptions(integer, text, uuid, integer),
  private.resolve_payment_exception(integer, uuid, text, integer),
  private.cancel_invoice(integer, uuid, uuid, text),
  private.rupees_to_paise(text), private.opening_key(text, text, text),
  private.get_dues_report(integer, uuid, uuid, uuid, boolean, uuid, boolean),
  private.save_fee_head(integer, text, text, text, boolean, text, uuid, integer),
  private.save_receiving_account(integer, jsonb, uuid, integer),
  private.save_fee_term(integer, uuid, text, integer, date, uuid, integer, text),
  private.save_fee_structure(integer, uuid, uuid, jsonb),
  private.save_concession_preset(integer, text, text, uuid[], integer, bigint, text, uuid, integer),
  private.grant_concession(integer, uuid, uuid, uuid, uuid, text, uuid),
  private.revoke_concession(integer, uuid, text),
  private.save_late_fee_rule(integer, uuid, uuid, bigint, integer),
  private.retire_late_fee_rule(integer, uuid),
  private.issue_opening_balance(integer, uuid, uuid, uuid, bigint, text, text, date),
  private.evaluate_late_fees(integer, date), private.waive_late_fee(integer, uuid, text),
  private.issue_term_invoices(integer, uuid, uuid, uuid, uuid[]),
  private.add_invoice_adjustment(integer, uuid, uuid, text, bigint, text, uuid),
  private.record_cheque(integer, uuid, uuid, text, text, date, bigint, uuid, date, jsonb),
  private.post_collection(integer, uuid, uuid, text, bigint, date, uuid, text, text, text, jsonb),
  private.get_student_statement(integer, uuid), private.get_collection_report(integer, date, date),
  private.get_import_template(integer, text), private.start_import(integer, uuid, text, uuid, text, text, jsonb),
  private.commit_import_chunk(integer, uuid, integer), private.get_import_job(integer, uuid, text, integer, integer)
to authenticated;
grant execute on function
  public.get_fee_setup(integer, uuid),
  public.list_student_concessions(integer, uuid, uuid, boolean, uuid, integer),
  public.list_optional_fee_roster(integer, uuid, uuid, uuid),
  public.set_optional_fees(integer, uuid, uuid, uuid, jsonb),
  public.list_collections(integer, date, date, text, uuid, uuid, text, date, uuid, integer),
  public.list_cheques(integer, text, date, date, date, uuid, integer),
  public.cancel_cheque(integer, uuid, text, integer),
  public.record_payment_exception(integer, uuid, text, bigint, text, uuid, uuid, text),
  public.list_payment_exceptions(integer, text, uuid, integer),
  public.resolve_payment_exception(integer, uuid, text, integer),
  public.cancel_invoice(integer, uuid, uuid, text),
  public.get_dues_report(integer, uuid, uuid, uuid, boolean, uuid, boolean),
  public.save_fee_head(integer, text, text, text, boolean, text, uuid, integer),
  public.save_receiving_account(integer, jsonb, uuid, integer),
  public.save_fee_term(integer, uuid, text, integer, date, uuid, integer, text),
  public.save_fee_structure(integer, uuid, uuid, jsonb),
  public.save_concession_preset(integer, text, text, uuid[], integer, bigint, text, uuid, integer),
  public.grant_concession(integer, uuid, uuid, uuid, uuid, text, uuid),
  public.revoke_concession(integer, uuid, text),
  public.save_late_fee_rule(integer, uuid, uuid, bigint, integer),
  public.retire_late_fee_rule(integer, uuid)
to authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
