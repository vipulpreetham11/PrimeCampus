-- =============================================================================
-- PrimeCampus V1 — 0600 Fees & collections (PRD §12, TRD §12)
-- Money = integer paise (bigint). No floats anywhere.
-- Ledger rows (invoice lines, adjustments, collections, allocations, reversals,
-- receipts) are immutable; corrections are new linked rows.
-- Balance = Σ line net + Σ adjustments − Σ allocations + Σ reversed allocations.
-- =============================================================================

create table app.fee_heads (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references app.schools(id),
  name        text not null check (length(btrim(name)) between 1 and 80),
  code        text not null check (code ~ '^[A-Za-z0-9_-]{1,20}$'),
  kind        text not null default 'regular' check (kind in ('regular','late_fee','other')),
  is_optional boolean not null default false,
  status      text not null default 'active' check (status in ('active','retired')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     integer not null default 1,
  unique (school_id, id),
  check (kind <> 'late_fee' or not is_optional)
);
create unique index fee_heads_code_uq on app.fee_heads (school_id, upper(code));

create table app.receiving_accounts (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references app.schools(id),
  label          text not null check (length(btrim(label)) between 1 and 80),
  kind           text not null check (kind in ('cash_desk','bank','upi')),
  bank_name      text check (length(bank_name) <= 120),
  account_last4  text check (account_last4 ~ '^[0-9]{4}$'),
  ifsc           text check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  upi_id         text check (upi_id ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z]{2,32}$'),
  status         text not null default 'active' check (status in ('active','retired')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  version        integer not null default 1,
  unique (school_id, id)
);

create table app.fee_terms (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null,
  academic_year_id  uuid not null,
  name              text not null check (length(btrim(name)) between 1 and 60),
  sort_order        smallint not null,
  due_date          date not null,
  status            text not null default 'active' check (status in ('active','retired')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           integer not null default 1,
  unique (school_id, id),
  unique (school_id, id, academic_year_id),
  unique (academic_year_id, name),
  foreign key (school_id, academic_year_id) references app.academic_years (school_id, id)
);

-- Price list: missing row = "no price configured", 0 = configured free (PRD FEE-01)
create table app.fee_structure_lines (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null,
  academic_year_id  uuid not null,
  fee_term_id       uuid not null,
  class_id          uuid not null,
  fee_head_id       uuid not null,
  amount_paise      bigint not null check (amount_paise between 0 and 10000000000),
  status            text not null default 'active' check (status in ('active','retired')),
  created_by        uuid references app.accounts(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           integer not null default 1,
  unique (school_id, id),
  foreign key (school_id, fee_term_id, academic_year_id) references app.fee_terms (school_id, id, academic_year_id),
  foreign key (school_id, class_id)    references app.classes (school_id, id),
  foreign key (school_id, fee_head_id) references app.fee_heads (school_id, id)
);
create unique index fee_structure_active_uq on app.fee_structure_lines (fee_term_id, class_id, fee_head_id) where status = 'active';

-- Optional heads apply only to selected students
create table app.student_optional_fees (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null,
  student_id        uuid not null,
  academic_year_id  uuid not null,
  fee_head_id       uuid not null,
  status            text not null default 'active' check (status in ('active','removed')),
  created_by        uuid references app.accounts(id),
  created_at        timestamptz not null default now(),
  unique (school_id, id),
  foreign key (school_id, student_id)       references app.students (school_id, id),
  foreign key (school_id, academic_year_id) references app.academic_years (school_id, id),
  foreign key (school_id, fee_head_id)      references app.fee_heads (school_id, id)
);
create unique index student_optional_fees_uq on app.student_optional_fees (student_id, academic_year_id, fee_head_id) where status = 'active';

-- Concession presets: fixed paise or percentage in basis points (1% = 100 bp)
create table app.concession_presets (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references app.schools(id),
  name         text not null check (length(btrim(name)) between 1 and 80),
  kind         text not null check (kind in ('fixed','percent')),
  percent_bp   integer check (percent_bp between 1 and 10000),
  fixed_paise  bigint check (fixed_paise > 0),
  status       text not null default 'active' check (status in ('active','retired')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  version      integer not null default 1,
  unique (school_id, id),
  check ((kind = 'percent') = (percent_bp is not null)),
  check ((kind = 'fixed')   = (fixed_paise is not null))
);
create unique index concession_presets_name_uq on app.concession_presets (school_id, lower(name));

create table app.concession_preset_heads (
  school_id    uuid not null,
  preset_id    uuid not null,
  fee_head_id  uuid not null,
  primary key (preset_id, fee_head_id),
  foreign key (school_id, preset_id)   references app.concession_presets (school_id, id),
  foreign key (school_id, fee_head_id) references app.fee_heads (school_id, id)
);

create table app.student_concessions (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null,
  student_id        uuid not null,
  academic_year_id  uuid not null,
  preset_id         uuid not null,
  fee_term_id       uuid,             -- null = every term of the year
  reason            text not null check (length(btrim(reason)) between 1 and 500),
  status            text not null default 'active' check (status in ('active','revoked')),
  granted_by        uuid not null references app.accounts(id),
  granted_at        timestamptz not null default now(),
  revoked_by        uuid references app.accounts(id),
  revoked_at        timestamptz,
  revoke_reason     text check (length(revoke_reason) <= 500),
  unique (school_id, id),
  check ((status = 'revoked') = (revoked_at is not null)),
  foreign key (school_id, student_id)       references app.students (school_id, id),
  foreign key (school_id, academic_year_id) references app.academic_years (school_id, id),
  foreign key (school_id, preset_id)        references app.concession_presets (school_id, id),
  foreign key (school_id, fee_term_id, academic_year_id) references app.fee_terms (school_id, id, academic_year_id)
);
create unique index student_concessions_active_uq on app.student_concessions
  (student_id, academic_year_id, preset_id, coalesce(fee_term_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'active';

-- One fixed late charge per invoice per rule; no compounding (PRD FEE-02)
create table app.late_fee_rules (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null,
  academic_year_id  uuid not null,
  fee_head_id       uuid not null,          -- a head of kind 'late_fee'
  amount_paise      bigint not null check (amount_paise between 1 and 10000000),
  grace_days        smallint not null default 0 check (grace_days between 0 and 120),
  status            text not null default 'active' check (status in ('active','retired')),
  created_by        uuid references app.accounts(id),
  created_at        timestamptz not null default now(),
  unique (school_id, id),
  foreign key (school_id, academic_year_id) references app.academic_years (school_id, id),
  foreign key (school_id, fee_head_id)      references app.fee_heads (school_id, id)
);
create unique index late_fee_rules_one_active on app.late_fee_rules (academic_year_id) where status = 'active';

-- Per-school/year document numbering (receipts, invoices). Row-locked allocation.
create table app.doc_sequences (
  school_id         uuid not null,
  academic_year_id  uuid not null,
  doc_type          text not null check (doc_type in ('receipt','invoice')),
  next_value        integer not null default 1 check (next_value > 0),
  primary key (school_id, academic_year_id, doc_type),
  foreign key (school_id, academic_year_id) references app.academic_years (school_id, id)
);

-- -----------------------------------------------------------------------------
-- Demands
-- -----------------------------------------------------------------------------
create table app.invoices (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null,
  academic_year_id  uuid not null,
  student_id        uuid not null,
  invoice_no        text not null,
  fee_term_id       uuid,
  source            text not null check (source in ('term','opening_balance','manual')),
  -- idempotency: e.g. 'term:<term_id>:<student_id>' or 'opening:<import_key>'
  source_key        text not null check (length(source_key) between 3 and 200),
  origin_label      text check (length(origin_label) <= 120),   -- e.g. original year of an opening balance
  due_date          date not null,
  status            text not null default 'issued' check (status in ('issued','cancelled')),
  snapshot          jsonb not null,           -- student/class/school display data at issue time
  issued_by         uuid not null references app.accounts(id),
  issued_at         timestamptz not null default now(),
  cancelled_by      uuid references app.accounts(id),
  cancelled_at      timestamptz,
  cancel_reason     text check (length(cancel_reason) <= 500),
  unique (school_id, id),
  unique (school_id, id, student_id),
  unique (school_id, invoice_no),
  unique (school_id, source_key),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check (source <> 'term' or fee_term_id is not null),
  foreign key (school_id, academic_year_id) references app.academic_years (school_id, id),
  foreign key (school_id, student_id)       references app.students (school_id, id),
  foreign key (school_id, fee_term_id, academic_year_id) references app.fee_terms (school_id, id, academic_year_id)
);
create index invoices_student_idx on app.invoices (student_id, due_date);
create index invoices_year_idx on app.invoices (school_id, academic_year_id, due_date) where status = 'issued';

create table app.invoice_lines (
  id                     uuid primary key default gen_random_uuid(),
  school_id              uuid not null,
  invoice_id             uuid not null,
  fee_head_id            uuid not null,
  label                  text not null,
  gross_paise            bigint not null check (gross_paise >= 0),
  concession_paise       bigint not null default 0 check (concession_paise >= 0),
  net_paise              bigint generated always as (gross_paise - concession_paise) stored,
  student_concession_id  uuid,
  sort_order             smallint not null default 0,
  unique (school_id, id),
  check (concession_paise <= gross_paise),
  foreign key (school_id, invoice_id)            references app.invoices (school_id, id),
  foreign key (school_id, fee_head_id)           references app.fee_heads (school_id, id),
  foreign key (school_id, student_concession_id) references app.student_concessions (school_id, id)
);
create index invoice_lines_invoice_idx on app.invoice_lines (invoice_id);
create index invoice_lines_head_idx on app.invoice_lines (school_id, fee_head_id);

create table app.invoice_adjustments (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null,
  invoice_id        uuid not null,
  student_id        uuid not null,
  kind              text not null check (kind in ('late_fee','late_fee_waiver','discount','additional_charge','correction')),
  amount_paise      bigint not null check (amount_paise <> 0),    -- signed: + charge, − reduction
  fee_head_id       uuid,
  late_fee_rule_id  uuid,
  reason            text not null check (length(btrim(reason)) between 1 and 500),
  operation_id      uuid,
  created_by        uuid not null references app.accounts(id),
  created_at        timestamptz not null default now(),
  unique (school_id, id),
  check (kind not in ('late_fee','additional_charge') or amount_paise > 0),
  check (kind not in ('late_fee_waiver','discount')   or amount_paise < 0),
  check (kind not in ('late_fee','late_fee_waiver')   or late_fee_rule_id is not null),
  foreign key (school_id, invoice_id, student_id) references app.invoices (school_id, id, student_id),
  foreign key (school_id, fee_head_id)            references app.fee_heads (school_id, id),
  foreign key (school_id, late_fee_rule_id)       references app.late_fee_rules (school_id, id)
);
create index invoice_adjustments_invoice_idx on app.invoice_adjustments (invoice_id);
-- re-running late-fee evaluation can never duplicate the charge or the waiver
create unique index invoice_adjustments_one_late_fee on app.invoice_adjustments (invoice_id, late_fee_rule_id) where kind = 'late_fee';
create unique index invoice_adjustments_one_waiver   on app.invoice_adjustments (invoice_id, late_fee_rule_id) where kind = 'late_fee_waiver';
create unique index invoice_adjustments_operation    on app.invoice_adjustments (school_id, operation_id) where operation_id is not null;

-- -----------------------------------------------------------------------------
-- Money received
-- -----------------------------------------------------------------------------
create table app.cheques (
  id                    uuid primary key default gen_random_uuid(),
  school_id             uuid not null,
  student_id            uuid not null,
  cheque_no             text not null check (cheque_no ~ '^[0-9]{6,10}$'),
  bank_name             text not null check (length(btrim(bank_name)) between 1 and 120),
  cheque_date           date not null,
  amount_paise          bigint not null check (amount_paise > 0),
  receiving_account_id  uuid not null,
  received_on           date not null,
  planned_allocations   jsonb not null,    -- [{invoice_id, amount_paise}] applied on clearing
  status                text not null default 'pending' check (status in ('pending','cleared','bounced','cancelled')),
  cleared_on            date,
  bounced_on            date,
  bounce_reason         text check (length(bounce_reason) <= 500),
  collection_id         uuid,
  operation_id          uuid not null,
  recorded_by           uuid not null references app.accounts(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  version               integer not null default 1,
  unique (school_id, id),
  unique (school_id, id, student_id),
  unique (school_id, operation_id),
  -- a cleared cheque can later bounce, so cleared_on survives into 'bounced'
  check (status <> 'cleared' or cleared_on is not null),
  check ((status = 'bounced') = (bounced_on is not null)),
  check (status not in ('pending','cancelled') or cleared_on is null),
  foreign key (school_id, student_id)           references app.students (school_id, id),
  foreign key (school_id, receiving_account_id) references app.receiving_accounts (school_id, id)
);
create unique index cheques_number_uq on app.cheques (school_id, upper(bank_name), cheque_no) where status <> 'cancelled';
create index cheques_status_idx on app.cheques (school_id, status, received_on);

create table app.collections (
  id                    uuid primary key default gen_random_uuid(),
  school_id             uuid not null,
  academic_year_id      uuid not null,
  student_id            uuid not null,
  method                text not null check (method in ('cash','bank_transfer','upi','cheque')),
  amount_paise          bigint not null check (amount_paise > 0),
  received_on           date not null,
  receiving_account_id  uuid,
  external_ref          text check (length(external_ref) <= 80),
  external_ref_norm     text,       -- upper-cased, spaces/dashes removed; blanks never collide
  payer_name            text check (length(payer_name) <= 200),
  cheque_id             uuid,
  collected_by          uuid not null references app.accounts(id),
  verified_by           uuid references app.accounts(id),
  verified_at           timestamptz,
  notes                 text check (length(notes) <= 1000),
  operation_id          uuid not null,
  created_at            timestamptz not null default now(),
  unique (school_id, id),
  unique (school_id, id, student_id),
  unique (school_id, operation_id),
  check (method = 'cash' or receiving_account_id is not null),
  check (method not in ('bank_transfer','upi') or (verified_by is not null and verified_at is not null)),
  check ((method = 'cheque') = (cheque_id is not null)),
  check (external_ref_norm is null or external_ref_norm ~ '^[A-Z0-9]{3,80}$'),
  foreign key (school_id, academic_year_id)     references app.academic_years (school_id, id),
  foreign key (school_id, student_id)           references app.students (school_id, id),
  foreign key (school_id, receiving_account_id) references app.receiving_accounts (school_id, id),
  foreign key (school_id, cheque_id, student_id) references app.cheques (school_id, id, student_id)
);
-- the same bank/UPI transaction cannot be posted twice
create unique index collections_external_ref_uq on app.collections (school_id, receiving_account_id, external_ref_norm)
  where external_ref_norm is not null;
create unique index collections_one_per_cheque on app.collections (cheque_id) where cheque_id is not null;
create index collections_student_idx on app.collections (student_id, received_on);
create index collections_day_idx on app.collections (school_id, received_on);

alter table app.cheques add constraint cheques_collection_fk
  foreign key (school_id, collection_id, student_id) references app.collections (school_id, id, student_id);

-- Allocation must hit an invoice of the SAME student in the SAME school (composite FKs)
create table app.collection_allocations (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null,
  collection_id  uuid not null,
  invoice_id     uuid not null,
  student_id     uuid not null,
  amount_paise   bigint not null check (amount_paise > 0),
  unique (school_id, id),
  unique (collection_id, invoice_id),
  foreign key (school_id, collection_id, student_id) references app.collections (school_id, id, student_id),
  foreign key (school_id, invoice_id, student_id)    references app.invoices (school_id, id, student_id)
);
create index collection_allocations_invoice_idx on app.collection_allocations (invoice_id);

create table app.collection_reversals (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null,
  collection_id  uuid not null,
  student_id     uuid not null,
  amount_paise   bigint not null check (amount_paise > 0),
  cause          text not null check (cause in ('error','cheque_bounce')),
  reason         text not null check (length(btrim(reason)) between 1 and 500),
  reversed_by    uuid not null references app.accounts(id),
  operation_id   uuid not null,
  created_at     timestamptz not null default now(),
  unique (school_id, id),
  unique (school_id, operation_id),
  foreign key (school_id, collection_id, student_id) references app.collections (school_id, id, student_id)
);
create index collection_reversals_collection_idx on app.collection_reversals (collection_id);

create table app.reversal_allocations (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null,
  reversal_id    uuid not null,
  allocation_id  uuid not null,
  amount_paise   bigint not null check (amount_paise > 0),
  unique (reversal_id, allocation_id),
  foreign key (school_id, reversal_id)   references app.collection_reversals (school_id, id),
  foreign key (school_id, allocation_id) references app.collection_allocations (school_id, id)
);
create index reversal_allocations_alloc_idx on app.reversal_allocations (allocation_id);

-- Receipt = immutable snapshot of a posted collection. Reprints render the snapshot.
create table app.receipts (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null,
  academic_year_id  uuid not null,
  collection_id     uuid not null unique,
  student_id        uuid not null,
  receipt_seq       integer not null check (receipt_seq > 0),
  receipt_no        text not null,
  template_version  smallint not null default 1,
  snapshot          jsonb not null,
  issued_at         timestamptz not null default now(),
  unique (school_id, id),
  unique (school_id, receipt_no),
  unique (school_id, academic_year_id, receipt_seq),
  foreign key (school_id, collection_id, student_id) references app.collections (school_id, id, student_id),
  foreign key (school_id, academic_year_id) references app.academic_years (school_id, id)
);

-- Money that cannot be allocated (overpayment etc.). Never becomes a credit wallet.
create table app.payment_exceptions (
  id               uuid primary key default gen_random_uuid(),
  school_id        uuid not null,
  student_id       uuid,
  kind             text not null check (kind in ('overpayment','unidentified','other')),
  amount_paise     bigint not null check (amount_paise > 0),
  collection_id    uuid,
  reference        text check (length(reference) <= 120),
  note             text not null check (length(btrim(note)) between 1 and 1000),
  status           text not null default 'open' check (status in ('open','resolved')),
  resolution_note  text check (length(resolution_note) <= 1000),
  created_by       uuid not null references app.accounts(id),
  created_at       timestamptz not null default now(),
  resolved_by      uuid references app.accounts(id),
  resolved_at      timestamptz,
  updated_at       timestamptz not null default now(),
  version          integer not null default 1,
  unique (school_id, id),
  check ((status = 'resolved') = (resolved_at is not null)),
  foreign key (school_id, student_id)    references app.students (school_id, id),
  foreign key (school_id, collection_id) references app.collections (school_id, id)
);

do $$ declare t text; begin
  foreach t in array array['fee_heads','receiving_accounts','fee_terms','fee_structure_lines','concession_presets',
                           'cheques','payment_exceptions'] loop
    execute format('create trigger %1$s_touch before update on app.%1$s for each row execute function app.tg_touch()', t);
  end loop;
  foreach t in array array['fee_heads','receiving_accounts','fee_terms','fee_structure_lines','concession_presets',
                           'student_concessions','late_fee_rules','invoices','invoice_lines','invoice_adjustments',
                           'cheques','collections','collection_allocations','collection_reversals',
                           'reversal_allocations','receipts','payment_exceptions','doc_sequences'] loop
    execute format('create trigger %1$s_no_del before delete on app.%1$s for each row execute function app.tg_no_delete()', t);
  end loop;
  foreach t in array array['invoice_lines','invoice_adjustments','collections','collection_allocations',
                           'collection_reversals','reversal_allocations','receipts'] loop
    execute format('create trigger %1$s_immutable before update on app.%1$s for each row execute function app.tg_immutable()', t);
  end loop;
end $$;

-- Invoices: only cancellation fields may change after issue
create or replace function app.tg_invoice_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.school_id, new.student_id, new.academic_year_id, new.invoice_no, new.source_key, new.due_date,
      new.snapshot, new.issued_at, new.issued_by, new.fee_term_id, new.source)
     is distinct from
     (old.school_id, old.student_id, old.academic_year_id, old.invoice_no, old.source_key, old.due_date,
      old.snapshot, old.issued_at, old.issued_by, old.fee_term_id, old.source) then
    raise exception 'Issued invoices are immutable; use an adjustment' using errcode = 'P0001', hint = 'VALIDATION_ERROR';
  end if;
  if old.status = 'cancelled' then
    raise exception 'Cancelled invoices cannot change' using errcode = 'P0001', hint = 'VALIDATION_ERROR';
  end if;
  return new;
end $$;
create trigger invoices_guard before update on app.invoices for each row execute function app.tg_invoice_guard();
