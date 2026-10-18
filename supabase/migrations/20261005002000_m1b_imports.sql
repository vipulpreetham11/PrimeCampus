-- =============================================================================
-- PrimeCampus V1 — 2000 Spreadsheet imports (PRD IMPORT-01, TRD §14.2) + save_lead fix
--
-- The browser parses XLSX/CSV and maps columns to the canonical field names returned by
-- get_import_template(). The server then re-validates every row (scope, keys, allowed fields,
-- relationships), shows a preview, lets the user fix/remove draft rows, and commits in chunks
-- of ≤100 rows. Each row is atomic (one subtransaction); a file may be partially committed.
--
-- Datasets in this migration: classes_sections, staff, students_guardians, placements.
-- opening_balances arrives with Fees (M3).
--
-- Row lifecycle: draft (errors = null → ready, errors ≠ null → needs fixing) · removed ·
-- committed (action create = new record, skip = already existed, nothing changed) · rejected
-- (failed at commit; can be fixed and retried). Existing records are never updated by import.
-- Duplicate rows inside the same file are detected at read/commit time (later row loses).
-- =============================================================================

-- duplicate-in-file detection looks rows up by key
create index if not exists import_rows_key_idx on app.import_rows (import_job_id, source_key) where source_key is not null;

-- -----------------------------------------------------------------------------
-- Normalisers (pure helpers; return null for blank, raise nothing)
-- -----------------------------------------------------------------------------
create or replace function private.imp_text(p jsonb, k text)
returns text language sql immutable set search_path = '' as $$
  select nullif(btrim(regexp_replace(coalesce(p->>k, ''), '\s+', ' ', 'g')), '')
$$;

-- Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY. Returns null if blank or invalid.
create or replace function private.imp_date(p_text text)
returns date language plpgsql immutable set search_path = '' as $$
declare t text := btrim(coalesce(p_text, '')); m text[];
begin
  if t = '' then return null; end if;
  if t ~ '^\d{4}-\d{2}-\d{2}' then return left(t, 10)::date; end if;
  m := regexp_match(t, '^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$');
  if m is not null then return make_date(m[3]::int, m[2]::int, m[1]::int); end if;
  return null;
exception when others then return null;
end $$;

-- 10-digit Indian mobile: strips spaces/dashes, +91/91 and a leading 0. Null if it can't be made valid.
create or replace function private.imp_phone(p_text text)
returns text language plpgsql immutable set search_path = '' as $$
declare d text := regexp_replace(coalesce(p_text, ''), '\D', '', 'g');
begin
  if d = '' then return null; end if;
  if length(d) = 12 and left(d, 2) = '91' then d := substr(d, 3); end if;
  if length(d) = 11 and left(d, 1) = '0' then d := substr(d, 2); end if;
  if d ~ '^[0-9]{10}$' then return d; end if;
  return null;
end $$;

create or replace function private.imp_bool(p_text text)
returns boolean language sql immutable set search_path = '' as $$
  select case lower(btrim(coalesce(p_text, '')))
           when 'yes' then true when 'y' then true when 'true' then true when '1' then true
           when 'no' then false when 'n' then false when 'false' then false when '0' then false
         end
$$;

create or replace function private.imp_gender(p_text text)
returns text language sql immutable set search_path = '' as $$
  select case lower(btrim(coalesce(p_text, '')))
           when 'm' then 'male' when 'male' then 'male' when 'boy' then 'male'
           when 'f' then 'female' when 'female' then 'female' when 'girl' then 'female'
           when 't' then 'transgender' when 'transgender' then 'transgender'
         end
$$;

create or replace function private.imp_relationship(p_text text)
returns text language sql immutable set search_path = '' as $$
  select case lower(btrim(coalesce(p_text, '')))
           when '' then null
           when 'father' then 'father' when 'dad' then 'father'
           when 'mother' then 'mother' when 'mom' then 'mother' when 'mum' then 'mother'
           when 'guardian' then 'guardian' when 'grandparent' then 'grandparent' when 'grandfather' then 'grandparent'
           when 'grandmother' then 'grandparent' when 'sibling' then 'sibling' when 'brother' then 'sibling'
           when 'sister' then 'sibling' when 'other' then 'other'
           else 'invalid' end
$$;

-- -----------------------------------------------------------------------------
-- Templates: the single source of truth for canonical column names
-- -----------------------------------------------------------------------------
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
  end
$$;

-- -----------------------------------------------------------------------------
-- Row validation. Returns errors (array of {field,message}), source key, action
-- (create | skip), normalised record, and info for the preview.
-- Runs as definer: reads only rows of p_school.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- Jobs
-- -----------------------------------------------------------------------------
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
    'needs_fixing', count(*) filter (where status in ('draft','rejected') and (has_errors or dup)),
    'created', count(*) filter (where status = 'committed' and action = 'create'),
    'skipped', count(*) filter (where status = 'committed' and action = 'skip'),
    'rejected', count(*) filter (where status = 'rejected' and not has_errors and not dup),
    'removed', count(*) filter (where status = 'removed'))
  from r
$$;

create or replace function private.imp_job_json(p_job app.import_jobs)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('job_id', p_job.id, 'dataset', p_job.dataset, 'academic_year_id', p_job.academic_year_id,
           'academic_year', (select name from app.academic_years where id = p_job.academic_year_id),
           'file_name', p_job.file_name, 'status', p_job.status, 'created_at', p_job.created_at,
           'created_by', (select display_name from app.accounts where id = p_job.created_by),
           'updated_at', p_job.updated_at, 'counts', private.imp_counts(p_job.id))
$$;

create or replace function private.imp_lock_job(p_school uuid, p_job_id uuid, p_for_change boolean)
returns app.import_jobs language plpgsql security definer set search_path = '' as $$
declare j app.import_jobs;
begin
  select * into j from app.import_jobs where id = p_job_id and school_id = p_school for update;
  if not found then perform private.fail('NOT_FOUND', 'Import not found'); end if;
  if p_for_change and j.status in ('completed','partially_completed','cancelled','failed') then
    perform private.fail('VALIDATION_ERROR', 'This import is closed. Start a new import.');
  end if;
  return j;
end $$;

create or replace function private.get_import_template(p_rev integer, p_dataset text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('imports.manage');
  if p_dataset not in ('classes_sections','staff','students_guardians','placements') then
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
  if found then return private.imp_job_json(j) || jsonb_build_object('replayed', true); end if;
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
                                     and o.source_fingerprint = p_source_fingerprint and o.id <> j.id), '[]'::jsonb));
end $$;

-- p_rows: [{row_no, data:{canonical_key: value,...}}], ≤500 per call. Re-staging a row number replaces its draft.
create or replace function private.stage_import_rows(p_rev integer, p_job_id uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; j app.import_jobs; x jsonb; v record; v_no integer; v_skipped jsonb := '[]'; v_cur text;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('imports.manage');
  j := private.imp_lock_job(c.school_id, p_job_id, true);
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 500 then
    perform private.fail('LIMIT_REACHED', 'Send 1–500 rows at a time');
  end if;
  if pg_column_size(p_rows) > 1048576 then perform private.fail('LIMIT_REACHED', 'Too much data in one upload; send fewer rows'); end if;
  for x in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(x->'row_no') <> 'number' or (x->>'row_no')::numeric <> floor((x->>'row_no')::numeric)
       or (x->>'row_no')::numeric not between 1 and 100000 then
      perform private.fail('VALIDATION_ERROR', 'Each row needs a row_no between 1 and 100000');
    end if;
    v_no := (x->>'row_no')::integer;
    select status into v_cur from app.import_rows where import_job_id = j.id and row_no = v_no for update;
    if v_cur in ('committed') then v_skipped := v_skipped || to_jsonb(v_no); continue; end if;
    if pg_column_size(coalesce(x->'data', '{}')) > 8000 then
      v := row(jsonb_build_array(jsonb_build_object('field', null, 'message', 'Row is too large')), null, 'create', '{}'::jsonb, '{}'::jsonb);
    else
      v := private.imp_validate(c.school_id, j.dataset, j.academic_year_id, coalesce(x->'data', '{}'));
    end if;
    insert into app.import_rows (school_id, import_job_id, row_no, source_key, action, status, payload, errors)
    values (c.school_id, j.id, v_no, v.source_key, v.action, 'draft',
            case when pg_column_size(coalesce(x->'data', '{}')) > 8000 then '{}'::jsonb else coalesce(x->'data', '{}') end, v.errors)
    on conflict (import_job_id, row_no) do update
      set source_key = excluded.source_key, action = excluded.action, status = 'draft', payload = excluded.payload,
          errors = excluded.errors, result_entity_id = null, updated_at = now();
  end loop;
  if (select count(*) from app.import_rows where import_job_id = j.id) > 10000 then
    perform private.fail('LIMIT_REACHED', 'An import can have at most 10,000 rows');
  end if;
  update app.import_jobs set total_rows = (select count(*) from app.import_rows where import_job_id = j.id and status <> 'removed'),
                             updated_at = now() where id = j.id;
  return jsonb_build_object('job_id', j.id, 'counts', private.imp_counts(j.id), 'already_committed_rows', v_skipped);
end $$;

create or replace function private.imp_row_json(ir app.import_rows)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('row_no', ir.row_no, 'status', ir.status, 'action', ir.action, 'data', ir.payload,
           'errors', coalesce(ir.errors, '[]'::jsonb) || coalesce((
               select jsonb_build_array(jsonb_build_object('field', null, 'message',
                        'Same record as row ' || min(o.row_no) || ' in this file'))
                 from app.import_rows o where o.import_job_id = ir.import_job_id and o.source_key = ir.source_key
                  and o.row_no < ir.row_no and o.status <> 'removed' having count(*) > 0), '[]'::jsonb),
           'result_entity_id', ir.result_entity_id,
           'info', case when ir.status = 'draft' and ir.action = 'skip' then jsonb_build_object('note', 'Already exists — nothing will change') end)
$$;

create or replace function private.update_import_row(p_rev integer, p_job_id uuid, p_row_no integer, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; j app.import_jobs; ir app.import_rows; v record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('imports.manage');
  j := private.imp_lock_job(c.school_id, p_job_id, true);
  select * into ir from app.import_rows where import_job_id = j.id and row_no = p_row_no for update;
  if not found then perform private.fail('NOT_FOUND', 'Row not found'); end if;
  if ir.status not in ('draft','rejected') then
    perform private.fail('VALIDATION_ERROR', 'Only rows not yet imported can be edited');
  end if;
  if pg_column_size(coalesce(p_data, '{}')) > 8000 then perform private.fail('LIMIT_REACHED', 'Row is too large'); end if;
  v := private.imp_validate(c.school_id, j.dataset, j.academic_year_id, coalesce(p_data, '{}'));
  update app.import_rows set payload = coalesce(p_data, '{}'), errors = v.errors, source_key = v.source_key,
                             action = v.action, status = 'draft', updated_at = now()
   where id = ir.id returning * into ir;
  update app.import_jobs set updated_at = now() where id = j.id;
  return jsonb_build_object('row', private.imp_row_json(ir), 'counts', private.imp_counts(j.id));
end $$;

-- Removing a preview row never deletes a school record.
create or replace function private.set_import_row_removed(p_rev integer, p_job_id uuid, p_row_no integer, p_removed boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; j app.import_jobs; ir app.import_rows;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('imports.manage');
  j := private.imp_lock_job(c.school_id, p_job_id, true);
  select * into ir from app.import_rows where import_job_id = j.id and row_no = p_row_no for update;
  if not found then perform private.fail('NOT_FOUND', 'Row not found'); end if;
  if ir.status = 'committed' then perform private.fail('VALIDATION_ERROR', 'This row is already imported'); end if;
  update app.import_rows set status = case when p_removed then 'removed' else 'draft' end, updated_at = now()
   where id = ir.id returning * into ir;
  update app.import_jobs set total_rows = (select count(*) from app.import_rows where import_job_id = j.id and status <> 'removed'),
                             updated_at = now() where id = j.id;
  return jsonb_build_object('row', private.imp_row_json(ir), 'counts', private.imp_counts(j.id));
end $$;

-- -----------------------------------------------------------------------------
-- Commit one row (called inside a subtransaction). Returns entity id.
-- -----------------------------------------------------------------------------
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
  end if;
  perform private.fail('VALIDATION_ERROR', 'Unknown dataset');
end $$;

-- Commits the next ≤p_limit (max 100) ready rows in row order. Safe to call repeatedly:
-- committed rows are never redone, and the job row lock serialises concurrent callers.
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

-- Ends an import. Rows not imported stay recorded with their errors; nothing is deleted.
create or replace function private.close_import(p_rev integer, p_job_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; j app.import_jobs; v_counts jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('imports.manage');
  j := private.imp_lock_job(c.school_id, p_job_id, false);
  if j.status in ('completed','partially_completed','cancelled','failed') then return private.imp_job_json(j); end if;
  v_counts := private.imp_counts(j.id);
  update app.import_jobs set status = case
           when (v_counts->>'created')::int + (v_counts->>'skipped')::int = 0 then 'cancelled'
           when (v_counts->>'ready')::int + (v_counts->>'will_skip')::int + (v_counts->>'needs_fixing')::int
                + (v_counts->>'rejected')::int = 0 then 'completed'
           else 'partially_completed' end,
         updated_at = now()
   where id = j.id returning * into j;
  perform private.log_event('imports.closed', 'import_jobs', j.id::text,
                            jsonb_build_object('status', j.status, 'counts', v_counts), j.operation_id, j.academic_year_id);
  return private.imp_job_json(j);
end $$;

create or replace function private.list_import_jobs(p_rev integer, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('imports.manage');
  return coalesce((select jsonb_agg(private.imp_job_json(j) order by j.created_at desc)
                     from (select * from app.import_jobs where school_id = c.school_id
                            order by created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) j), '[]'::jsonb);
end $$;

-- p_filter: all | ready | will_skip | needs_fixing | created | skipped | rejected | removed
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
            when 'needs_fixing' then status in ('draft','rejected') and (errors is not null or dup)
            when 'created' then status = 'committed' and action = 'create'
            when 'skipped' then status = 'committed' and action = 'skip'
            when 'rejected' then status = 'rejected'
            when 'removed' then status = 'removed' end
          order by row_no limit v_limit) r;
  return jsonb_build_object('job', private.imp_job_json(j), 'columns', private.imp_columns(j.dataset), 'rows', v_rows,
    'next_cursor', case when jsonb_array_length(v_rows) = v_limit then (v_rows->-1->>'row_no')::int end);
end $$;

-- -----------------------------------------------------------------------------
-- save_lead: source_detail can now be cleared (was coalesce → impossible to blank)
-- -----------------------------------------------------------------------------
create or replace function private.save_lead(p_rev integer, p_lead_id uuid, p_lead jsonb, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_id uuid; v_ver integer;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('admissions.manage');
  if p_lead ? 'stage' and p_lead->>'stage' = 'converted' then
    perform private.fail('VALIDATION_ERROR', 'Use convert/admit to mark a lead converted');
  end if;
  if p_lead_id is null then
    insert into app.leads (school_id, academic_year_id, parent_name, phone, alt_phone, email, child_name, child_dob,
                           interested_class_id, source, source_detail, assigned_to, next_follow_up_on, notes, created_by)
    values (c.school_id, (p_lead->>'academic_year_id')::uuid, p_lead->>'parent_name', p_lead->>'phone',
            p_lead->>'alt_phone', p_lead->>'email', p_lead->>'child_name', (p_lead->>'child_dob')::date,
            (p_lead->>'interested_class_id')::uuid, p_lead->>'source', p_lead->>'source_detail',
            coalesce((p_lead->>'assigned_to')::uuid, c.account_id), (p_lead->>'next_follow_up_on')::date,
            p_lead->>'notes', c.account_id)
    returning id, version into v_id, v_ver;
  else
    update app.leads set
      parent_name = coalesce(p_lead->>'parent_name', parent_name), phone = coalesce(p_lead->>'phone', phone),
      alt_phone = case when p_lead ? 'alt_phone' then p_lead->>'alt_phone' else alt_phone end,
      email = case when p_lead ? 'email' then p_lead->>'email' else email end,
      child_name = case when p_lead ? 'child_name' then p_lead->>'child_name' else child_name end,
      child_dob = case when p_lead ? 'child_dob' then (p_lead->>'child_dob')::date else child_dob end,
      interested_class_id = case when p_lead ? 'interested_class_id' then (p_lead->>'interested_class_id')::uuid else interested_class_id end,
      source = coalesce(p_lead->>'source', source),
      source_detail = case when p_lead ? 'source_detail' then p_lead->>'source_detail' else source_detail end,
      stage = coalesce(p_lead->>'stage', stage), lost_reason = case when p_lead ? 'lost_reason' then p_lead->>'lost_reason' else lost_reason end,
      assigned_to = coalesce((p_lead->>'assigned_to')::uuid, assigned_to),
      next_follow_up_on = case when p_lead ? 'next_follow_up_on' then (p_lead->>'next_follow_up_on')::date else next_follow_up_on end,
      notes = case when p_lead ? 'notes' then p_lead->>'notes' else notes end
    where id = p_lead_id and school_id = c.school_id and version = p_expected_version and stage <> 'converted'
    returning id, version into v_id, v_ver;
    if v_id is null then perform private.fail('CONFLICT', 'Lead changed, was converted, or does not exist. Reload.'); end if;
  end if;
  return jsonb_build_object('lead_id', v_id, 'version', v_ver,
    'possible_duplicates', coalesce((select jsonb_agg(jsonb_build_object('lead_id', l.id, 'parent_name', l.parent_name,
                                       'child_name', l.child_name, 'stage', l.stage))
                                      from app.leads l where l.school_id = c.school_id and l.id <> v_id
                                        and l.phone = (select phone from app.leads where id = v_id)), '[]'::jsonb));
end $$;

-- -----------------------------------------------------------------------------
-- Public wrappers
-- -----------------------------------------------------------------------------
create or replace function public.get_import_template(p_ctx_rev integer, p_dataset text)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_import_template(p_ctx_rev, p_dataset) $$;
create or replace function public.start_import(p_ctx_rev integer, p_operation_id uuid, p_dataset text, p_academic_year_id uuid,
                                               p_file_name text, p_source_fingerprint text, p_mapping jsonb default '{}')
returns jsonb language sql security invoker set search_path = '' as $$
  select private.start_import(p_ctx_rev, p_operation_id, p_dataset, p_academic_year_id, p_file_name, p_source_fingerprint, p_mapping) $$;
create or replace function public.stage_import_rows(p_ctx_rev integer, p_job_id uuid, p_rows jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select private.stage_import_rows(p_ctx_rev, p_job_id, p_rows) $$;
create or replace function public.update_import_row(p_ctx_rev integer, p_job_id uuid, p_row_no integer, p_data jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select private.update_import_row(p_ctx_rev, p_job_id, p_row_no, p_data) $$;
create or replace function public.set_import_row_removed(p_ctx_rev integer, p_job_id uuid, p_row_no integer, p_removed boolean)
returns jsonb language sql security invoker set search_path = '' as $$ select private.set_import_row_removed(p_ctx_rev, p_job_id, p_row_no, p_removed) $$;
create or replace function public.commit_import_chunk(p_ctx_rev integer, p_job_id uuid, p_limit integer default 100)
returns jsonb language sql security invoker set search_path = '' as $$ select private.commit_import_chunk(p_ctx_rev, p_job_id, p_limit) $$;
create or replace function public.close_import(p_ctx_rev integer, p_job_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select private.close_import(p_ctx_rev, p_job_id) $$;
create or replace function public.list_import_jobs(p_ctx_rev integer, p_limit integer default 30)
returns jsonb language sql security invoker set search_path = '' as $$ select private.list_import_jobs(p_ctx_rev, p_limit) $$;
create or replace function public.get_import_job(p_ctx_rev integer, p_job_id uuid, p_filter text default 'all',
                                                 p_after_row_no integer default null, p_limit integer default 100)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.get_import_job(p_ctx_rev, p_job_id, p_filter, p_after_row_no, p_limit) $$;

-- Lockdown (same block as 1400)
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on function
  private.get_import_template(integer, text), private.start_import(integer, uuid, text, uuid, text, text, jsonb),
  private.stage_import_rows(integer, uuid, jsonb), private.update_import_row(integer, uuid, integer, jsonb),
  private.set_import_row_removed(integer, uuid, integer, boolean), private.commit_import_chunk(integer, uuid, integer),
  private.close_import(integer, uuid), private.list_import_jobs(integer, integer),
  private.get_import_job(integer, uuid, text, integer, integer)
to authenticated;
grant execute on function
  public.get_import_template(integer, text), public.start_import(integer, uuid, text, uuid, text, text, jsonb),
  public.stage_import_rows(integer, uuid, jsonb), public.update_import_row(integer, uuid, integer, jsonb),
  public.set_import_row_removed(integer, uuid, integer, boolean), public.commit_import_chunk(integer, uuid, integer),
  public.close_import(integer, uuid), public.list_import_jobs(integer, integer),
  public.get_import_job(integer, uuid, text, integer, integer)
to authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
