-- =============================================================================
-- PrimeCampus V1 — 1100 Fee RPCs (PRD §12, TRD §12)
-- One shared balance calculation; money posts atomically with allocations,
-- receipt number/snapshot and audit; every consequential call is idempotent.
-- =============================================================================

-- Single source of truth for invoice balances (reports, statements, posting)
create or replace function private.invoice_balances(p_school uuid, p_student uuid default null, p_year uuid default null)
returns table (invoice_id uuid, student_id uuid, academic_year_id uuid, invoice_no text, due_date date, status text,
               source text, charged_paise bigint, adjustments_paise bigint, allocated_paise bigint,
               reversed_paise bigint, balance_paise bigint)
language sql stable security definer set search_path = '' as $$
  select i.id, i.student_id, i.academic_year_id, i.invoice_no, i.due_date, i.status, i.source,
         l.v, a.v, al.v, r.v,
         case when i.status = 'cancelled' then 0 else l.v + a.v - al.v + r.v end
    from app.invoices i
    cross join lateral (select coalesce(sum(net_paise), 0)::bigint v from app.invoice_lines where invoice_id = i.id) l
    cross join lateral (select coalesce(sum(amount_paise), 0)::bigint v from app.invoice_adjustments where invoice_id = i.id) a
    cross join lateral (select coalesce(sum(amount_paise), 0)::bigint v from app.collection_allocations where invoice_id = i.id) al
    cross join lateral (select coalesce(sum(ra.amount_paise), 0)::bigint v
                          from app.reversal_allocations ra
                          join app.collection_allocations ca on ca.id = ra.allocation_id
                         where ca.invoice_id = i.id) r
   where i.school_id = p_school
     and (p_student is null or i.student_id = p_student)
     and (p_year is null or i.academic_year_id = p_year)
$$;

create or replace function private.invoice_balance(p_invoice_id uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select b.balance_paise
    from app.invoices i, private.invoice_balances(i.school_id, i.student_id) b
   where i.id = p_invoice_id and b.invoice_id = i.id
$$;

create or replace function private.next_doc_number(p_school uuid, p_year uuid, p_type text)
returns integer language sql security definer set search_path = '' as $$
  insert into app.doc_sequences as d (school_id, academic_year_id, doc_type, next_value)
  values (p_school, p_year, p_type, 2)
  on conflict (school_id, academic_year_id, doc_type) do update set next_value = d.next_value + 1
  returning next_value - 1
$$;

create or replace function private.year_for_date(p_school uuid, p_date date)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select id from app.academic_years where school_id = p_school and p_date between start_date and end_date),
    (select id from app.academic_years where school_id = p_school and is_current))
$$;

-- Student's placement for fee purposes: placement active today in that year, else latest in that year
create or replace function private.fee_placement(p_student uuid, p_year uuid, p_today date)
returns table (section_id uuid, class_id uuid, class_name text, section_name text, roll_no text)
language sql stable security definer set search_path = '' as $$
  select s.id, s.class_id, cl.name, s.name, p.roll_no
    from app.placements p
    join app.sections s on s.id = p.section_id
    join app.classes cl on cl.id = s.class_id
   where p.student_id = p_student and p.academic_year_id = p_year
   order by (p.effective_from <= p_today and (p.effective_to is null or p.effective_to > p_today)) desc,
            p.effective_from desc
   limit 1
$$;

-- Computed (not yet issued) lines for one student + term. Deterministic:
-- one concession per line; percent rounds to paise per line and is capped at the line.
create or replace function private.compute_term_lines(p_school uuid, p_term uuid, p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_term app.fee_terms; v_pl record; v_lines jsonb; v_conflict jsonb; v_missing jsonb;
begin
  select * into v_term from app.fee_terms where id = p_term and school_id = p_school;
  select * into v_pl from private.fee_placement(p_student, v_term.academic_year_id, private.school_today(p_school));
  if v_pl.section_id is null then
    return jsonb_build_object('student_id', p_student, 'skip_reason', 'No placement in this academic year');
  end if;

  with heads as (
    select fsl.fee_head_id, fh.name, fh.is_optional, fsl.amount_paise as gross, fh.code
      from app.fee_structure_lines fsl
      join app.fee_heads fh on fh.id = fsl.fee_head_id and fh.status = 'active'
     where fsl.fee_term_id = p_term and fsl.class_id = v_pl.class_id and fsl.status = 'active'
       and (not fh.is_optional or exists (select 1 from app.student_optional_fees so
                                            where so.student_id = p_student and so.fee_head_id = fh.id
                                              and so.academic_year_id = v_term.academic_year_id and so.status = 'active'))
  ), conc as (
    select h.fee_head_id, sc.id as sc_id, cp.kind, cp.percent_bp, cp.fixed_paise, cp.name as preset_name
      from heads h
      join app.student_concessions sc on sc.student_id = p_student and sc.academic_year_id = v_term.academic_year_id
                                     and sc.status = 'active' and (sc.fee_term_id is null or sc.fee_term_id = p_term)
      join app.concession_presets cp on cp.id = sc.preset_id
      join app.concession_preset_heads cph on cph.preset_id = cp.id and cph.fee_head_id = h.fee_head_id
  ), conflicts as (
    select fee_head_id from conc group by fee_head_id having count(*) > 1
  )
  select
    (select jsonb_agg(jsonb_build_object(
        'fee_head_id', h.fee_head_id, 'label', h.name, 'gross_paise', h.gross,
        'student_concession_id', c1.sc_id, 'concession_name', c1.preset_name,
        'concession_paise', case when c1.sc_id is null then 0
                                 when c1.kind = 'percent' then least(h.gross, round(h.gross * c1.percent_bp / 10000.0)::bigint)
                                 else least(h.gross, c1.fixed_paise) end) order by h.code)
       from heads h left join conc c1 on c1.fee_head_id = h.fee_head_id
                                      and h.fee_head_id not in (select fee_head_id from conflicts)),
    (select jsonb_agg(fee_head_id) from conflicts),
    -- heads priced for other classes this term but not this class = "missing price", not zero
    (select jsonb_agg(distinct fh.name) from app.fee_structure_lines o
       join app.fee_heads fh on fh.id = o.fee_head_id and not fh.is_optional and fh.kind = 'regular'
      where o.fee_term_id = p_term and o.status = 'active'
        and not exists (select 1 from app.fee_structure_lines x where x.fee_term_id = p_term and x.class_id = v_pl.class_id
                          and x.fee_head_id = o.fee_head_id and x.status = 'active'))
  into v_lines, v_conflict, v_missing;

  return jsonb_build_object(
    'student_id', p_student, 'class_id', v_pl.class_id, 'class', v_pl.class_name, 'section', v_pl.section_name,
    'roll_no', v_pl.roll_no, 'lines', coalesce(v_lines, '[]'),
    'concession_conflicts', coalesce(v_conflict, '[]'), 'missing_prices', coalesce(v_missing, '[]'),
    'gross_paise', (select coalesce(sum((l->>'gross_paise')::bigint), 0) from jsonb_array_elements(coalesce(v_lines, '[]')) l),
    'concession_paise', (select coalesce(sum((l->>'concession_paise')::bigint), 0) from jsonb_array_elements(coalesce(v_lines, '[]')) l),
    'net_paise', (select coalesce(sum((l->>'gross_paise')::bigint - (l->>'concession_paise')::bigint), 0)
                    from jsonb_array_elements(coalesce(v_lines, '[]')) l));
end $$;

create or replace function private.term_target_students(p_school uuid, p_term uuid, p_section uuid, p_students uuid[])
returns setof uuid language sql stable security definer set search_path = '' as $$
  select e.student_id
    from app.fee_terms t
    join app.enrollments e on e.academic_year_id = t.academic_year_id and e.status = 'active'
    join app.students st on st.id = e.student_id and st.status = 'active'
   where t.id = p_term and t.school_id = p_school
     and (p_students is null or e.student_id = any (p_students))
     and (p_section is null or exists (select 1 from app.placements p where p.student_id = e.student_id
                                         and p.section_id = p_section and p.academic_year_id = t.academic_year_id
                                         and (p.effective_to is null or p.effective_to > private.school_today(p_school))))
$$;

create or replace function private.preview_term_invoices(p_rev integer, p_term_id uuid, p_section_id uuid, p_student_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if not exists (select 1 from app.fee_terms where id = p_term_id and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Term not found');
  end if;
  return coalesce((
    select jsonb_agg(private.compute_term_lines(c.school_id, p_term_id, s)
                     || jsonb_build_object('already_issued', exists (
                          select 1 from app.invoices i where i.school_id = c.school_id
                             and i.source_key = 'term:' || p_term_id || ':' || s)))
      from private.term_target_students(c.school_id, p_term_id, p_section_id, p_student_ids) s), '[]'::jsonb);
end $$;

-- Issue term demands. Idempotent per (term, student) via source_key. Students with
-- concession conflicts are skipped and reported rather than guessed.
create or replace function private.issue_term_invoices(p_rev integer, p_operation_id uuid, p_term_id uuid,
                                                       p_section_id uuid, p_student_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_term app.fee_terms; v_school text; v_year text; s uuid; v jsonb; v_inv uuid; v_no integer;
        v_issued integer := 0; v_existing integer := 0; v_skipped jsonb := '[]'; v_fp text; v_prev jsonb; v_st record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  select * into v_term from app.fee_terms where id = p_term_id and school_id = c.school_id;
  if not found then perform private.fail('NOT_FOUND', 'Term not found'); end if;
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
    if v ? 'skip_reason' or jsonb_array_length(v->'concession_conflicts') > 0 or jsonb_array_length(v->'lines') = 0 then
      v_skipped := v_skipped || jsonb_build_object('student_id', s,
                     'reason', coalesce(v->>'skip_reason',
                                        case when jsonb_array_length(v->'lines') = 0 then 'No fee lines configured for this class/term'
                                             else 'More than one concession applies to the same fee head' end));
      continue;
    end if;
    select full_name, admission_no into v_st from app.students where id = s;
    v_no := private.next_doc_number(c.school_id, v_term.academic_year_id, 'invoice');
    insert into app.invoices (school_id, academic_year_id, student_id, invoice_no, fee_term_id, source, source_key,
                              due_date, snapshot, issued_by)
    values (c.school_id, v_term.academic_year_id, s, 'INV/' || v_year || '/' || lpad(v_no::text, 5, '0'),
            p_term_id, 'term', 'term:' || p_term_id || ':' || s, v_term.due_date,
            jsonb_build_object('school_name', v_school, 'year', v_year, 'term', v_term.name,
                               'student_name', v_st.full_name, 'admission_no', v_st.admission_no,
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

-- Opening balance carried from before PrimeCampus (imports). Keeps origin; never regenerated.
create or replace function private.issue_opening_balance(p_rev integer, p_student_id uuid, p_academic_year_id uuid,
                                                         p_fee_head_id uuid, p_amount_paise bigint, p_origin_label text,
                                                         p_source_ref text, p_due_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_inv uuid; v_no integer; v_year text; v_st record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if p_amount_paise <= 0 then perform private.fail('VALIDATION_ERROR', 'Opening balance must be positive'); end if;
  if coalesce(btrim(p_source_ref), '') = '' then perform private.fail('VALIDATION_ERROR', 'A source reference is required'); end if;
  select full_name, admission_no into v_st from app.students where id = p_student_id and school_id = c.school_id;
  if v_st.full_name is null then perform private.fail('NOT_FOUND', 'Student not found'); end if;
  select id into v_inv from app.invoices where school_id = c.school_id and source_key = 'opening:' || p_source_ref;
  if v_inv is not null then
    return jsonb_build_object('invoice_id', v_inv, 'replayed', true);
  end if;
  select name into v_year from app.academic_years where id = p_academic_year_id and school_id = c.school_id;
  v_no := private.next_doc_number(c.school_id, p_academic_year_id, 'invoice');
  insert into app.invoices (school_id, academic_year_id, student_id, invoice_no, source, source_key, origin_label,
                            due_date, snapshot, issued_by)
  values (c.school_id, p_academic_year_id, p_student_id, 'INV/' || v_year || '/' || lpad(v_no::text, 5, '0'),
          'opening_balance', 'opening:' || p_source_ref, p_origin_label, p_due_date,
          jsonb_build_object('student_name', v_st.full_name, 'admission_no', v_st.admission_no, 'year', v_year,
                             'origin', p_origin_label),
          c.account_id)
  returning id into v_inv;
  insert into app.invoice_lines (school_id, invoice_id, fee_head_id, label, gross_paise)
  values (c.school_id, v_inv, p_fee_head_id, 'Opening balance' || coalesce(' (' || p_origin_label || ')', ''), p_amount_paise);
  return jsonb_build_object('invoice_id', v_inv);
end $$;

-- Explicit manual adjustment (discount / extra charge / correction). Dues never go below zero.
create or replace function private.add_invoice_adjustment(p_rev integer, p_operation_id uuid, p_invoice_id uuid,
                                                          p_kind text, p_amount_paise bigint, p_reason text, p_fee_head_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_inv app.invoices; v_bal bigint; v_id uuid;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if p_kind not in ('discount','additional_charge','correction') then
    perform private.fail('VALIDATION_ERROR', 'Use the late-fee actions for late fees');
  end if;
  select id into v_id from app.invoice_adjustments where school_id = c.school_id and operation_id = p_operation_id;
  if v_id is not null then return jsonb_build_object('adjustment_id', v_id, 'replayed', true); end if;
  select * into v_inv from app.invoices where id = p_invoice_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Invoice not found'); end if;
  if v_inv.status <> 'issued' then perform private.fail('VALIDATION_ERROR', 'Invoice is cancelled'); end if;
  v_bal := private.invoice_balance(v_inv.id);
  if v_bal + p_amount_paise < 0 then
    perform private.fail('VALIDATION_ERROR', 'This would make the amount due negative',
                         jsonb_build_object('balance_paise', v_bal));
  end if;
  insert into app.invoice_adjustments (school_id, invoice_id, student_id, kind, amount_paise, fee_head_id, reason,
                                       operation_id, created_by)
  values (c.school_id, v_inv.id, v_inv.student_id, p_kind, p_amount_paise, p_fee_head_id, p_reason, p_operation_id, c.account_id)
  returning id into v_id;
  return jsonb_build_object('adjustment_id', v_id, 'balance_paise', v_bal + p_amount_paise);
end $$;

-- Fixed late fee: one per invoice per rule; re-running never duplicates (unique index).
-- Invoices covered by a pending cheque are reported, not charged.
create or replace function private.evaluate_late_fees(p_rev integer, p_as_of date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_added integer; v_pending jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if p_as_of > private.school_today(c.school_id) then perform private.fail('VALIDATION_ERROR', 'Date is in the future'); end if;

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
  if coalesce(btrim(p_reason), '') = '' then perform private.fail('VALIDATION_ERROR', 'A reason is required'); end if;
  perform 1 from app.invoices where id = p_invoice_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Invoice not found'); end if;
  select * into v_lf from app.invoice_adjustments where invoice_id = p_invoice_id and kind = 'late_fee';
  if not found then perform private.fail('VALIDATION_ERROR', 'No late fee on this invoice'); end if;
  select id into v_id from app.invoice_adjustments where invoice_id = p_invoice_id and kind = 'late_fee_waiver';
  if v_id is not null then return jsonb_build_object('adjustment_id', v_id, 'replayed', true); end if;
  v_bal := private.invoice_balance(p_invoice_id);
  if v_bal < v_lf.amount_paise then
    perform private.fail('VALIDATION_ERROR', 'Late fee is already paid; reverse the collection first if it was wrong');
  end if;
  insert into app.invoice_adjustments (school_id, invoice_id, student_id, kind, amount_paise, fee_head_id,
                                       late_fee_rule_id, reason, created_by)
  values (c.school_id, p_invoice_id, v_lf.student_id, 'late_fee_waiver', -v_lf.amount_paise, v_lf.fee_head_id,
          v_lf.late_fee_rule_id, p_reason, c.account_id)
  returning id into v_id;
  return jsonb_build_object('adjustment_id', v_id, 'balance_paise', v_bal - v_lf.amount_paise);
end $$;

-- =============================================================================
-- Posting money
-- =============================================================================
create or replace function private.normalize_ref(p text)
returns text language sql immutable set search_path = '' as $$
  select nullif(upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')), '')
$$;

-- Internal. Caller has already checked context + capability.
create or replace function private._post_collection(p_school uuid, p_actor uuid, p_operation_id uuid, p_student uuid,
                                                    p_method text, p_amount bigint, p_received_on date,
                                                    p_account uuid, p_ref text, p_payer text, p_notes text,
                                                    p_allocs jsonb, p_cheque uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ref text := private.normalize_ref(p_ref); v_acc app.receiving_accounts; v_year uuid; v_year_name text;
  v_col uuid; v_rec uuid; v_seq integer; v_no text; a jsonb; v_bal bigint; v_sum bigint := 0; v_dup record;
  v_st record; v_lines jsonb;
begin
  if p_amount is null or p_amount <= 0 then perform private.fail('VALIDATION_ERROR', 'Amount must be positive'); end if;
  if p_received_on > private.school_today(p_school) then perform private.fail('VALIDATION_ERROR', 'Received date is in the future'); end if;
  select s.full_name, s.admission_no into v_st from app.students s where s.id = p_student and s.school_id = p_school;
  if v_st.full_name is null then perform private.fail('NOT_FOUND', 'Student not found'); end if;

  if p_method <> 'cash' or p_account is not null then
    select * into v_acc from app.receiving_accounts where id = p_account and school_id = p_school and status = 'active';
    if not found then perform private.fail('VALIDATION_ERROR', 'Choose an active receiving account of this school'); end if;
    if (p_method = 'upi' and v_acc.kind not in ('upi','bank')) or (p_method in ('bank_transfer','cheque') and v_acc.kind <> 'bank')
       or (p_method = 'cash' and v_acc.kind <> 'cash_desk') then
      perform private.fail('VALIDATION_ERROR', 'Receiving account type does not match the payment method');
    end if;
  end if;
  if v_ref is not null and p_method <> 'cash' then
    select c.id, r.receipt_no into v_dup from app.collections c left join app.receipts r on r.collection_id = c.id
     where c.school_id = p_school and c.receiving_account_id = p_account and c.external_ref_norm = v_ref;
    if v_dup.id is not null then
      perform private.fail('DUPLICATE', 'This transaction reference was already posted',
                           jsonb_build_object('collection_id', v_dup.id, 'receipt_no', v_dup.receipt_no));
    end if;
  end if;

  if jsonb_typeof(p_allocs) <> 'array' or jsonb_array_length(p_allocs) = 0 then
    perform private.fail('VALIDATION_ERROR', 'Allocate the amount to at least one invoice');
  end if;
  -- lock invoices in a stable order, then validate against live balances
  perform 1 from app.invoices i
   where i.id in (select (x->>'invoice_id')::uuid from jsonb_array_elements(p_allocs) x)
   order by i.id for update;
  for a in select * from jsonb_array_elements(p_allocs) loop
    if not exists (select 1 from app.invoices i where i.id = (a->>'invoice_id')::uuid and i.school_id = p_school
                     and i.student_id = p_student and i.status = 'issued') then
      perform private.fail('VALIDATION_ERROR', 'Allocation must target an issued invoice of this student');
    end if;
    if (a->>'amount_paise')::bigint <= 0 then perform private.fail('VALIDATION_ERROR', 'Allocation amounts must be positive'); end if;
    v_bal := private.invoice_balance((a->>'invoice_id')::uuid);
    if (a->>'amount_paise')::bigint > v_bal then
      perform private.fail('VALIDATION_ERROR', 'Allocation exceeds the amount due on an invoice',
                           jsonb_build_object('invoice_id', a->>'invoice_id', 'balance_paise', v_bal));
    end if;
    v_sum := v_sum + (a->>'amount_paise')::bigint;
  end loop;
  if (select count(distinct x->>'invoice_id') from jsonb_array_elements(p_allocs) x) <> jsonb_array_length(p_allocs) then
    perform private.fail('VALIDATION_ERROR', 'An invoice appears twice');
  end if;
  if v_sum <> p_amount then
    perform private.fail('VALIDATION_ERROR', 'Allocations must add up to the amount received',
                         jsonb_build_object('allocated_paise', v_sum, 'amount_paise', p_amount));
  end if;

  v_year := private.year_for_date(p_school, p_received_on);
  select name into v_year_name from app.academic_years where id = v_year;
  insert into app.collections (school_id, academic_year_id, student_id, method, amount_paise, received_on,
                               receiving_account_id, external_ref, external_ref_norm, payer_name, cheque_id,
                               collected_by, verified_by, verified_at, notes, operation_id)
  values (p_school, v_year, p_student, p_method, p_amount, p_received_on, p_account, p_ref,
          case when p_method <> 'cash' then v_ref end, p_payer, p_cheque, p_actor,
          case when p_method <> 'cash' then p_actor end, case when p_method <> 'cash' then now() end,
          p_notes, p_operation_id)
  returning id into v_col;
  insert into app.collection_allocations (school_id, collection_id, invoice_id, student_id, amount_paise)
  select p_school, v_col, (x->>'invoice_id')::uuid, p_student, (x->>'amount_paise')::bigint
    from jsonb_array_elements(p_allocs) x;

  v_seq := private.next_doc_number(p_school, v_year, 'receipt');
  v_no := 'RCT/' || v_year_name || '/' || lpad(v_seq::text, 5, '0');
  select jsonb_agg(jsonb_build_object('invoice_no', i.invoice_no, 'term', i.snapshot->>'term',
                                      'amount_paise', ca.amount_paise) order by i.due_date)
    into v_lines
    from app.collection_allocations ca join app.invoices i on i.id = ca.invoice_id where ca.collection_id = v_col;
  insert into app.receipts (school_id, academic_year_id, collection_id, student_id, receipt_seq, receipt_no, snapshot)
  values (p_school, v_year, v_col, p_student, v_seq, v_no,
          jsonb_build_object(
            'school_name', (select name from app.schools where id = p_school),
            'school_address', (select concat_ws(', ', address_line, city, pincode) from app.schools where id = p_school),
            'receipt_no', v_no, 'date', p_received_on, 'student_name', v_st.full_name, 'admission_no', v_st.admission_no,
            'class_section', (select class_name || ' ' || section_name from private.fee_placement(p_student, v_year, p_received_on)),
            'method', p_method, 'reference', p_ref, 'account', v_acc.label, 'payer', p_payer,
            'amount_paise', p_amount, 'allocations', v_lines,
            'collected_by', (select display_name from app.accounts where id = p_actor)))
  returning id into v_rec;

  perform private.log_event('fees.collection.posted', 'collections', v_col::text,
    jsonb_build_object('student_id', p_student, 'amount_paise', p_amount, 'method', p_method, 'receipt_no', v_no),
    p_operation_id, v_year);
  return jsonb_build_object('collection_id', v_col, 'receipt_id', v_rec, 'receipt_no', v_no, 'amount_paise', p_amount);
end $$;

-- Cash / UPI / bank transfer (cheques use record_cheque + clear_cheque)
create or replace function private.post_collection(p_rev integer, p_operation_id uuid, p_student_id uuid, p_method text,
                                                   p_amount_paise bigint, p_received_on date, p_receiving_account_id uuid,
                                                   p_external_ref text, p_payer_name text, p_notes text, p_allocations jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_existing record; v_fp text;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if p_method not in ('cash','upi','bank_transfer') then
    perform private.fail('VALIDATION_ERROR', 'Use the cheque register for cheques');
  end if;
  v_fp := private.fingerprint(jsonb_build_object('s', p_student_id, 'm', p_method, 'a', p_amount_paise,
                                                 'd', p_received_on, 'acc', p_receiving_account_id,
                                                 'ref', p_external_ref, 'al', p_allocations));
  -- replay of the same operation returns the original receipt (lost response / double click)
  select col.id, r.id as receipt_id, r.receipt_no, col.amount_paise into v_existing
    from app.collections col join app.receipts r on r.collection_id = col.id
   where col.school_id = c.school_id and col.operation_id = p_operation_id;
  if v_existing.id is not null then
    perform private.idem_lookup(c.school_id, 'fees.post_collection', p_operation_id, v_fp);
    return jsonb_build_object('collection_id', v_existing.id, 'receipt_id', v_existing.receipt_id,
                              'receipt_no', v_existing.receipt_no, 'amount_paise', v_existing.amount_paise, 'replayed', true);
  end if;
  perform private.idem_store(c.school_id, 'fees.post_collection', p_operation_id, v_fp, '{}'::jsonb);
  return private._post_collection(c.school_id, c.account_id, p_operation_id, p_student_id, p_method, p_amount_paise,
                                  p_received_on, p_receiving_account_id, p_external_ref, p_payer_name, p_notes,
                                  p_allocations, null);
end $$;

-- Internal reversal: caps at remaining reversible value; reopens dues newest-invoice first.
create or replace function private._reverse_collection(p_school uuid, p_actor uuid, p_operation_id uuid,
                                                       p_collection_id uuid, p_amount bigint, p_cause text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_col app.collections; v_reversible bigint; v_left bigint; v_rev uuid; a record; v_take bigint;
begin
  select * into v_col from app.collections where id = p_collection_id and school_id = p_school for update;
  if not found then perform private.fail('NOT_FOUND', 'Collection not found'); end if;
  select v_col.amount_paise - coalesce(sum(amount_paise), 0) into v_reversible
    from app.collection_reversals where collection_id = v_col.id;
  v_left := coalesce(p_amount, v_reversible);
  if v_left <= 0 or v_left > v_reversible then
    perform private.fail('VALIDATION_ERROR', 'Reversal exceeds the amount still reversible',
                         jsonb_build_object('reversible_paise', v_reversible));
  end if;
  perform 1 from app.invoices where id in (select invoice_id from app.collection_allocations where collection_id = v_col.id)
   order by id for update;
  insert into app.collection_reversals (school_id, collection_id, student_id, amount_paise, cause, reason, reversed_by, operation_id)
  values (p_school, v_col.id, v_col.student_id, v_left, p_cause, p_reason, p_actor, p_operation_id)
  returning id into v_rev;
  for a in select ca.id, ca.amount_paise - coalesce((select sum(ra.amount_paise) from app.reversal_allocations ra
                                                      where ra.allocation_id = ca.id), 0) as remaining
             from app.collection_allocations ca join app.invoices i on i.id = ca.invoice_id
            where ca.collection_id = v_col.id
            order by i.due_date desc, i.id desc loop
    exit when v_left = 0;
    continue when a.remaining <= 0;
    v_take := least(a.remaining, v_left);
    insert into app.reversal_allocations (school_id, reversal_id, allocation_id, amount_paise)
    values (p_school, v_rev, a.id, v_take);
    v_left := v_left - v_take;
  end loop;
  perform private.log_event('fees.collection.reversed', 'collections', v_col.id::text,
    jsonb_build_object('reversal_id', v_rev, 'amount_paise', coalesce(p_amount, v_reversible), 'cause', p_cause, 'reason', p_reason),
    p_operation_id, v_col.academic_year_id);
  return jsonb_build_object('reversal_id', v_rev, 'collection_id', v_col.id,
                            'reversed_paise', coalesce(p_amount, v_reversible),
                            'still_reversible_paise', v_reversible - coalesce(p_amount, v_reversible));
end $$;

create or replace function private.reverse_collection(p_rev integer, p_operation_id uuid, p_collection_id uuid,
                                                      p_amount_paise bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_id uuid;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if coalesce(btrim(p_reason), '') = '' then perform private.fail('VALIDATION_ERROR', 'A reason is required'); end if;
  select id into v_id from app.collection_reversals where school_id = c.school_id and operation_id = p_operation_id;
  if v_id is not null then return jsonb_build_object('reversal_id', v_id, 'replayed', true); end if;
  if exists (select 1 from app.collections where id = p_collection_id and method = 'cheque') then
    perform private.fail('VALIDATION_ERROR', 'Use "bounce cheque" for cheque payments');
  end if;
  return private._reverse_collection(c.school_id, c.account_id, p_operation_id, p_collection_id, p_amount_paise, 'error', p_reason);
end $$;

-- Cheques: Pending never settles dues
create or replace function private.record_cheque(p_rev integer, p_operation_id uuid, p_student_id uuid, p_cheque_no text,
                                                 p_bank_name text, p_cheque_date date, p_amount_paise bigint,
                                                 p_receiving_account_id uuid, p_received_on date, p_allocations jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_id uuid; v_sum bigint;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  select id into v_id from app.cheques where school_id = c.school_id and operation_id = p_operation_id;
  if v_id is not null then return jsonb_build_object('cheque_id', v_id, 'replayed', true); end if;
  if not exists (select 1 from app.receiving_accounts where id = p_receiving_account_id and school_id = c.school_id
                   and kind = 'bank' and status = 'active') then
    perform private.fail('VALIDATION_ERROR', 'Choose the bank account the cheque will be deposited into');
  end if;
  select coalesce(sum((x->>'amount_paise')::bigint), 0) into v_sum from jsonb_array_elements(p_allocations) x;
  if v_sum <> p_amount_paise then perform private.fail('VALIDATION_ERROR', 'Planned allocations must equal the cheque amount'); end if;
  if exists (select 1 from jsonb_array_elements(p_allocations) x
              where not exists (select 1 from app.invoices i where i.id = (x->>'invoice_id')::uuid
                                  and i.student_id = p_student_id and i.school_id = c.school_id and i.status = 'issued')) then
    perform private.fail('VALIDATION_ERROR', 'Allocations must target issued invoices of this student');
  end if;
  insert into app.cheques (school_id, student_id, cheque_no, bank_name, cheque_date, amount_paise, receiving_account_id,
                           received_on, planned_allocations, operation_id, recorded_by)
  values (c.school_id, p_student_id, p_cheque_no, p_bank_name, p_cheque_date, p_amount_paise, p_receiving_account_id,
          p_received_on, p_allocations, p_operation_id, c.account_id)
  returning id into v_id;
  return jsonb_build_object('cheque_id', v_id, 'status', 'pending');
end $$;

create or replace function private.clear_cheque(p_rev integer, p_cheque_id uuid, p_cleared_on date, p_allocations jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_ch app.cheques; v_res jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  select * into v_ch from app.cheques where id = p_cheque_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Cheque not found'); end if;
  if v_ch.status = 'cleared' then
    return jsonb_build_object('cheque_id', v_ch.id, 'collection_id', v_ch.collection_id, 'replayed', true);
  end if;
  if v_ch.status <> 'pending' then perform private.fail('VALIDATION_ERROR', 'Only pending cheques can clear'); end if;
  v_res := private._post_collection(c.school_id, c.account_id, md5('cheque-clear:' || v_ch.id)::uuid, v_ch.student_id,
                                    'cheque', v_ch.amount_paise, p_cleared_on, v_ch.receiving_account_id,
                                    v_ch.bank_name || ' #' || v_ch.cheque_no, null, null,
                                    coalesce(p_allocations, v_ch.planned_allocations), v_ch.id);
  update app.cheques set status = 'cleared', cleared_on = p_cleared_on, collection_id = (v_res->>'collection_id')::uuid
   where id = v_ch.id;
  return v_res || jsonb_build_object('cheque_id', v_ch.id);
end $$;

create or replace function private.bounce_cheque(p_rev integer, p_cheque_id uuid, p_bounced_on date, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_ch app.cheques; v_res jsonb := '{}';
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.manage');
  if coalesce(btrim(p_reason), '') = '' then perform private.fail('VALIDATION_ERROR', 'A reason is required'); end if;
  select * into v_ch from app.cheques where id = p_cheque_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Cheque not found'); end if;
  if v_ch.status = 'bounced' then return jsonb_build_object('cheque_id', v_ch.id, 'replayed', true); end if;
  if v_ch.status = 'cancelled' then perform private.fail('VALIDATION_ERROR', 'Cheque was cancelled'); end if;
  if v_ch.status = 'cleared' then
    v_res := private._reverse_collection(c.school_id, c.account_id, md5('cheque-bounce:' || v_ch.id)::uuid,
                                         v_ch.collection_id, null, 'cheque_bounce', p_reason);
  end if;
  update app.cheques set status = 'bounced', bounced_on = p_bounced_on, bounce_reason = p_reason where id = v_ch.id;
  return v_res || jsonb_build_object('cheque_id', v_ch.id, 'status', 'bounced', 'was_cleared', v_ch.status = 'cleared');
end $$;

-- =============================================================================
-- Reads
-- =============================================================================
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
        'lines', (select jsonb_agg(jsonb_build_object('label', l.label, 'gross_paise', l.gross_paise,
                                                      'concession_paise', l.concession_paise, 'net_paise', l.net_paise)
                                   order by l.sort_order) from app.invoice_lines l where l.invoice_id = b.invoice_id),
        'adjustments', (select jsonb_agg(jsonb_build_object('kind', ad.kind, 'amount_paise', ad.amount_paise,
                                                            'reason', ad.reason, 'at', ad.created_at) order by ad.created_at)
                          from app.invoice_adjustments ad where ad.invoice_id = b.invoice_id)
      ) order by b.due_date, b.invoice_no) from private.invoice_balances(c.school_id, p_student_id) b
        join app.invoices i on i.id = b.invoice_id), '[]'::jsonb),
    'collections', coalesce((select jsonb_agg(jsonb_build_object(
        'collection_id', col.id, 'receipt_id', r.id, 'receipt_no', r.receipt_no, 'received_on', col.received_on,
        'method', col.method, 'amount_paise', col.amount_paise,
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

create or replace function private.get_receipt(p_rev integer, p_receipt_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_r app.receipts;
begin
  select * into c from private.require_ctx(p_rev);
  select * into v_r from app.receipts where id = p_receipt_id and school_id = c.school_id;
  if not found then perform private.fail('NOT_FOUND', 'Receipt not found'); end if;
  if not (private.has_cap('fees.read') or v_r.student_id = private.ctx_child_id()) then
    perform private.fail('FORBIDDEN', 'Not permitted');
  end if;
  return jsonb_build_object('receipt_id', v_r.id, 'receipt_no', v_r.receipt_no, 'issued_at', v_r.issued_at,
    'template_version', v_r.template_version, 'snapshot', v_r.snapshot,
    'reversals', (select jsonb_agg(jsonb_build_object('amount_paise', amount_paise, 'cause', cause, 'reason', reason,
                                                      'at', created_at)) from app.collection_reversals
                   where collection_id = v_r.collection_id));
end $$;

-- Dues by student (filters: year, class, section). Summary rows reconcile with statements.
create or replace function private.get_dues_report(p_rev integer, p_academic_year_id uuid, p_class_id uuid, p_section_id uuid,
                                                   p_only_overdue boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_today date;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.read');
  v_today := private.school_today(c.school_id);
  return coalesce((
    select jsonb_agg(x order by x->>'class_section', x->>'name') from (
      select jsonb_build_object(
        'student_id', st.id, 'name', st.full_name, 'admission_no', st.admission_no,
        'class_section', fp.class_name || ' ' || fp.section_name,
        'charged_paise', sum(b.charged_paise + b.adjustments_paise),
        'paid_paise', sum(b.allocated_paise - b.reversed_paise),
        'balance_paise', sum(b.balance_paise),
        'overdue_paise', sum(b.balance_paise) filter (where b.due_date < v_today),
        'pending_cheque_paise', (select coalesce(sum(amount_paise), 0) from app.cheques ch
                                   where ch.student_id = st.id and ch.status = 'pending')) as x
        from private.invoice_balances(c.school_id, null, p_academic_year_id) b
        join app.students st on st.id = b.student_id
        cross join lateral private.fee_placement(st.id, coalesce(p_academic_year_id, b.academic_year_id), v_today) fp
       where (p_class_id is null or fp.class_id = p_class_id)
         and (p_section_id is null or fp.section_id = p_section_id)
       group by st.id, st.full_name, st.admission_no, fp.class_name, fp.section_name
      having not coalesce(p_only_overdue, false) or sum(b.balance_paise) filter (where b.due_date < v_today) > 0
    ) q), '[]'::jsonb);
end $$;

-- Daily collections by method / collector / account; reversals shown separately; pending excluded
create or replace function private.get_collection_report(p_rev integer, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.read');
  if p_to - p_from > 400 then perform private.fail('LIMIT_REACHED', 'Range too long'); end if;
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
                        where school_id = c.school_id and (created_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
    'pending_cheques', (select jsonb_build_object('count', count(*), 'amount_paise', coalesce(sum(amount_paise), 0))
                          from app.cheques where school_id = c.school_id and status = 'pending'),
    'bounced_cheques_in_range', (select count(*) from app.cheques where school_id = c.school_id and status = 'bounced'
                                   and bounced_on between p_from and p_to),
    'concessions_paise', (select coalesce(sum(l.concession_paise), 0) from app.invoice_lines l join app.invoices i on i.id = l.invoice_id
                           where i.school_id = c.school_id and i.status = 'issued'
                             and (i.issued_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
    'waivers_paise', (select coalesce(-sum(amount_paise), 0) from app.invoice_adjustments
                       where school_id = c.school_id and kind in ('late_fee_waiver','discount')
                         and (created_at at time zone 'Asia/Kolkata')::date between p_from and p_to));
end $$;

-- ---------------------------------------------------------------- public wrappers
create or replace function public.preview_term_invoices(p_ctx_rev integer, p_term_id uuid, p_section_id uuid default null, p_student_ids uuid[] default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.preview_term_invoices(p_ctx_rev, p_term_id, p_section_id, p_student_ids) $$;
create or replace function public.issue_term_invoices(p_ctx_rev integer, p_operation_id uuid, p_term_id uuid, p_section_id uuid default null, p_student_ids uuid[] default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.issue_term_invoices(p_ctx_rev, p_operation_id, p_term_id, p_section_id, p_student_ids) $$;
create or replace function public.issue_opening_balance(p_ctx_rev integer, p_student_id uuid, p_academic_year_id uuid, p_fee_head_id uuid, p_amount_paise bigint, p_origin_label text, p_source_ref text, p_due_date date)
returns jsonb language sql security invoker set search_path = '' as $$ select private.issue_opening_balance(p_ctx_rev, p_student_id, p_academic_year_id, p_fee_head_id, p_amount_paise, p_origin_label, p_source_ref, p_due_date) $$;
create or replace function public.add_invoice_adjustment(p_ctx_rev integer, p_operation_id uuid, p_invoice_id uuid, p_kind text, p_amount_paise bigint, p_reason text, p_fee_head_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.add_invoice_adjustment(p_ctx_rev, p_operation_id, p_invoice_id, p_kind, p_amount_paise, p_reason, p_fee_head_id) $$;
create or replace function public.evaluate_late_fees(p_ctx_rev integer, p_as_of date)
returns jsonb language sql security invoker set search_path = '' as $$ select private.evaluate_late_fees(p_ctx_rev, p_as_of) $$;
create or replace function public.waive_late_fee(p_ctx_rev integer, p_invoice_id uuid, p_reason text)
returns jsonb language sql security invoker set search_path = '' as $$ select private.waive_late_fee(p_ctx_rev, p_invoice_id, p_reason) $$;
create or replace function public.post_collection(p_ctx_rev integer, p_operation_id uuid, p_student_id uuid, p_method text, p_amount_paise bigint, p_received_on date, p_allocations jsonb, p_receiving_account_id uuid default null, p_external_ref text default null, p_payer_name text default null, p_notes text default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.post_collection(p_ctx_rev, p_operation_id, p_student_id, p_method, p_amount_paise, p_received_on, p_receiving_account_id, p_external_ref, p_payer_name, p_notes, p_allocations) $$;
create or replace function public.reverse_collection(p_ctx_rev integer, p_operation_id uuid, p_collection_id uuid, p_reason text, p_amount_paise bigint default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.reverse_collection(p_ctx_rev, p_operation_id, p_collection_id, p_amount_paise, p_reason) $$;
create or replace function public.record_cheque(p_ctx_rev integer, p_operation_id uuid, p_student_id uuid, p_cheque_no text, p_bank_name text, p_cheque_date date, p_amount_paise bigint, p_receiving_account_id uuid, p_received_on date, p_allocations jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select private.record_cheque(p_ctx_rev, p_operation_id, p_student_id, p_cheque_no, p_bank_name, p_cheque_date, p_amount_paise, p_receiving_account_id, p_received_on, p_allocations) $$;
create or replace function public.clear_cheque(p_ctx_rev integer, p_cheque_id uuid, p_cleared_on date, p_allocations jsonb default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.clear_cheque(p_ctx_rev, p_cheque_id, p_cleared_on, p_allocations) $$;
create or replace function public.bounce_cheque(p_ctx_rev integer, p_cheque_id uuid, p_bounced_on date, p_reason text)
returns jsonb language sql security invoker set search_path = '' as $$ select private.bounce_cheque(p_ctx_rev, p_cheque_id, p_bounced_on, p_reason) $$;
create or replace function public.get_student_statement(p_ctx_rev integer, p_student_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_student_statement(p_ctx_rev, p_student_id) $$;
create or replace function public.get_receipt(p_ctx_rev integer, p_receipt_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_receipt(p_ctx_rev, p_receipt_id) $$;
create or replace function public.get_dues_report(p_ctx_rev integer, p_academic_year_id uuid default null, p_class_id uuid default null, p_section_id uuid default null, p_only_overdue boolean default false)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_dues_report(p_ctx_rev, p_academic_year_id, p_class_id, p_section_id, p_only_overdue) $$;
create or replace function public.get_collection_report(p_ctx_rev integer, p_from date, p_to date)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_collection_report(p_ctx_rev, p_from, p_to) $$;

grant execute on function
  private.preview_term_invoices(integer, uuid, uuid, uuid[]), private.issue_term_invoices(integer, uuid, uuid, uuid, uuid[]),
  private.issue_opening_balance(integer, uuid, uuid, uuid, bigint, text, text, date),
  private.add_invoice_adjustment(integer, uuid, uuid, text, bigint, text, uuid), private.evaluate_late_fees(integer, date),
  private.waive_late_fee(integer, uuid, text),
  private.post_collection(integer, uuid, uuid, text, bigint, date, uuid, text, text, text, jsonb),
  private.reverse_collection(integer, uuid, uuid, bigint, text),
  private.record_cheque(integer, uuid, uuid, text, text, date, bigint, uuid, date, jsonb),
  private.clear_cheque(integer, uuid, date, jsonb), private.bounce_cheque(integer, uuid, date, text),
  private.get_student_statement(integer, uuid), private.get_receipt(integer, uuid),
  private.get_dues_report(integer, uuid, uuid, uuid, boolean), private.get_collection_report(integer, date, date)
to authenticated;
grant execute on function
  public.preview_term_invoices(integer, uuid, uuid, uuid[]), public.issue_term_invoices(integer, uuid, uuid, uuid, uuid[]),
  public.issue_opening_balance(integer, uuid, uuid, uuid, bigint, text, text, date),
  public.add_invoice_adjustment(integer, uuid, uuid, text, bigint, text, uuid), public.evaluate_late_fees(integer, date),
  public.waive_late_fee(integer, uuid, text),
  public.post_collection(integer, uuid, uuid, text, bigint, date, jsonb, uuid, text, text, text),
  public.reverse_collection(integer, uuid, uuid, text, bigint),
  public.record_cheque(integer, uuid, uuid, text, text, date, bigint, uuid, date, jsonb),
  public.clear_cheque(integer, uuid, date, jsonb), public.bounce_cheque(integer, uuid, date, text),
  public.get_student_statement(integer, uuid), public.get_receipt(integer, uuid),
  public.get_dues_report(integer, uuid, uuid, uuid, boolean), public.get_collection_report(integer, date, date)
to authenticated;
