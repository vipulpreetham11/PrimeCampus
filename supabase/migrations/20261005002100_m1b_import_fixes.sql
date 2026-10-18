-- =============================================================================
-- PrimeCampus V1 — 2100 Import fixes found in the M1b plan review
--  * imp_counts: 'rejected' counts every rejected row; 'needs_fixing' counts drafts only
--    (rejected rows always carry an error message, so they were miscounted as needs_fixing)
--  * commit_import_chunk: never selects in-file duplicate rows, so repeated calls always progress
--  * get_import_job: 'needs_fixing' filter = drafts only (rejected rows have their own filter)
--  * start_import: a replay (same operation id) also returns same_file_before
-- =============================================================================

create or replace function private.imp_counts(p_job uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with r as (
    select ir.status, ir.action, ir.errors is not null as has_errors,
           ir.source_key is not null and exists (
             select 1 from app.import_rows o where o.import_job_id = ir.import_job_id and o.source_key = ir.source_key
               and o.row_no < ir.row_no and o.status <> 'removed') as dup
      from app.import_rows ir where ir.import_job_id = p_job)
  select jsonb_build_object(
    'total', count(*) filter (where status <> 'removed'),
    'ready', count(*) filter (where status = 'draft' and not has_errors and not dup and action = 'create'),
    'will_skip', count(*) filter (where status = 'draft' and not has_errors and not dup and action = 'skip'),
    'needs_fixing', count(*) filter (where status = 'draft' and (has_errors or dup)),
    'created', count(*) filter (where status = 'committed' and action = 'create'),
    'skipped', count(*) filter (where status = 'committed' and action = 'skip'),
    'rejected', count(*) filter (where status = 'rejected'),
    'removed', count(*) filter (where status = 'removed'))
  from r
$$;

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
    'next_cursor', case when jsonb_array_length(v_rows) = v_limit then (v_rows->-1->>'row_no')::int end);
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
  if p_dataset = 'opening_balances' then
    perform private.fail('VALIDATION_ERROR', 'Opening fee balances are imported from Fees.');
  end if;
  if p_dataset not in ('classes_sections','staff','students_guardians','placements') then
    perform private.fail('VALIDATION_ERROR', 'Unknown dataset');
  end if;
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

-- keep the job's stored counters in line with the corrected counts
update app.import_jobs j set rejected_rows = (select count(*) from app.import_rows r where r.import_job_id = j.id and r.status = 'rejected');

-- Lockdown (same block as 1400)
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on function private.start_import(integer, uuid, text, uuid, text, text, jsonb),
  private.commit_import_chunk(integer, uuid, integer), private.get_import_job(integer, uuid, text, integer, integer)
to authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
