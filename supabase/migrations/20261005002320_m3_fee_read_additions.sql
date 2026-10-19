-- =============================================================================
-- PrimeCampus V1 — 2320 M3 fee read additions (found while planning the M3 screens)
--  * get_student_statement: `student` header {name, admission_no, status, class_id, section_id,
--    class_section} so every fees.read role (incl. Owner, who can't list students) sees who it is for;
--    pending cheques carry `planned_allocations` [{invoice_id, invoice_no, amount_paise}], cheque_date, version
--  * list_collections: `totals` {count, amount_paise, reversed_paise} for exactly the same filters
--    (not the cursor); name search uses starts_with (no LIKE wildcards from user input)
--  * issue_opening_balance: p_due_date optional (defaults to the year start, as before)
-- =============================================================================
create or replace function private.get_student_statement(p_rev integer, p_student_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_st record; v_year uuid; v_today date;
begin
  select * into c from private.require_ctx(p_rev);
  if not (private.has_cap('fees.read') or p_student_id = private.ctx_child_id()) then
    perform private.fail('FORBIDDEN', 'Not permitted');
  end if;
  select id, full_name, admission_no, status into v_st from app.students where id = p_student_id and school_id = c.school_id;
  if v_st.id is null then perform private.fail('NOT_FOUND', 'Student not found'); end if;
  v_today := private.school_today(c.school_id);
  v_year := (select id from app.academic_years where school_id = c.school_id and is_current);
  return jsonb_build_object(
    'student_id', p_student_id,
    'student', (select jsonb_build_object('name', v_st.full_name, 'admission_no', v_st.admission_no, 'status', v_st.status,
                  'class_id', fp.class_id, 'section_id', fp.section_id,
                  'class_section', case when fp.section_id is not null then fp.class_name || ' ' || fp.section_name end)
                from (select 1) one left join lateral private.fee_placement(v_st.id, v_year, v_today) fp on true),
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
    'pending_cheques', coalesce((select jsonb_agg(jsonb_build_object('cheque_id', ch.id, 'cheque_no', ch.cheque_no,
                                   'bank_name', ch.bank_name, 'cheque_date', ch.cheque_date, 'amount_paise', ch.amount_paise,
                                   'received_on', ch.received_on, 'version', ch.version,
                                   'planned_allocations', coalesce((select jsonb_agg(jsonb_build_object(
                                        'invoice_id', i.id, 'invoice_no', i.invoice_no,
                                        'amount_paise', (pa->>'amount_paise')::bigint) order by i.due_date, i.invoice_no)
                                      from jsonb_array_elements(ch.planned_allocations) pa
                                      join app.invoices i on i.id = (pa->>'invoice_id')::uuid), '[]'::jsonb))
                                   order by ch.received_on, ch.id)
                                 from app.cheques ch where ch.student_id = p_student_id and ch.status = 'pending'), '[]'::jsonb),
    'bounced_cheques', coalesce((select jsonb_agg(jsonb_build_object('cheque_id', id, 'cheque_no', cheque_no,
                                   'amount_paise', amount_paise, 'bounced_on', bounced_on, 'reason', bounce_reason))
                                 from app.cheques where student_id = p_student_id and status = 'bounced'), '[]'::jsonb),
    'total_due_paise', (select coalesce(sum(balance_paise), 0) from private.invoice_balances(c.school_id, p_student_id)),
    'open_exceptions', (select count(*) from app.payment_exceptions where student_id = p_student_id and status = 'open'));
end $$;



create or replace function private.list_collections(p_rev integer, p_from date, p_to date, p_method text, p_receiving_account_id uuid,
                                                    p_collected_by uuid, p_search text, p_before_date date, p_before_id uuid,
                                                    p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_totals jsonb; v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_items jsonb; v_q text := nullif(btrim(p_search), '');
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
            or col.external_ref_norm = private.normalize_ref(v_q) or starts_with(lower(st.full_name), lower(v_q)))
       and (p_before_date is null or (col.received_on, col.id) < (p_before_date, p_before_id))
     order by col.received_on desc, col.id desc limit v_limit) q;
  select jsonb_build_object('count', count(*), 'amount_paise', coalesce(sum(col.amount_paise), 0),
           'reversed_paise', coalesce(sum((select coalesce(sum(cr.amount_paise), 0) from app.collection_reversals cr
                                          where cr.collection_id = col.id)), 0))
    into v_totals
    from app.collections col
    join app.receipts r on r.collection_id = col.id
    join app.students st on st.id = col.student_id
   where col.school_id = c.school_id and col.received_on between p_from and p_to
     and (p_method is null or col.method = p_method)
     and (p_receiving_account_id is null or col.receiving_account_id = p_receiving_account_id)
     and (p_collected_by is null or col.collected_by = p_collected_by)
     and (v_q is null or upper(r.receipt_no) = upper(v_q) or upper(st.admission_no) = upper(v_q)
          or col.external_ref_norm = private.normalize_ref(v_q) or starts_with(lower(st.full_name), lower(v_q)));
  return jsonb_build_object('items', v_items, 'totals', v_totals,
    'next_cursor', case when jsonb_array_length(v_items) = v_limit
                        then jsonb_build_object('before_date', v_items->-1->>'received_on', 'before_id', v_items->-1->>'collection_id') end);
end $$;


-- p_due_date optional (null → year start)
create or replace function public.issue_opening_balance(p_ctx_rev integer, p_student_id uuid, p_academic_year_id uuid, p_fee_head_id uuid, p_amount_paise bigint, p_origin_label text, p_source_ref text, p_due_date date default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.issue_opening_balance(p_ctx_rev, p_student_id, p_academic_year_id, p_fee_head_id, p_amount_paise, p_origin_label, p_source_ref, p_due_date) $$;

-- Lockdown (same block as 1400)
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on function
  private.get_student_statement(integer, uuid),
  private.list_collections(integer, date, date, text, uuid, uuid, text, date, uuid, integer)
to authenticated;
grant execute on function
  public.issue_opening_balance(integer, uuid, uuid, uuid, bigint, text, text, date)
to authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
