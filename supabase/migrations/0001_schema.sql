-- OdontoCentral — schema base (PRD seção 4)
-- Convenções: uuid, timestamptz (UTC), dinheiro em centavos, clinic_id + RLS em toda tabela.

create extension if not exists btree_gist;

create schema if not exists app;

create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ───────────────────────── Configuração ─────────────────────────

create table clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'America/Sao_Paulo',
  -- { "mon": [["08:00","18:00"]], ..., "sun": [] }
  business_hours jsonb not null default '{"mon":[["08:00","18:00"]],"tue":[["08:00","18:00"]],"wed":[["08:00","18:00"]],"thu":[["08:00","18:00"]],"fri":[["08:00","18:00"]],"sat":[["08:00","12:00"]],"sun":[]}',
  assistant_name text not null default 'Assistente virtual',
  ai_enabled boolean not null default false,
  ai_kill_switch boolean not null default false,
  after_hours_message text not null default 'Recebemos sua mensagem. Nossa equipe retorna no próximo horário de atendimento.',
  -- Protocolo de sinais de alerta (PRD 7.4): precisa de aprovação antes de ativar a IA.
  alert_keywords text[] not null default '{}',
  alert_message text,
  alert_after_hours_message text,
  alert_approved_by uuid,
  alert_approved_at timestamptz,
  -- Regras configuráveis (defaults em src/domain/settings.ts)
  settings jsonb not null default '{}',
  status text not null default 'trial' check (status in ('trial','active','suspended')),
  is_demo boolean not null default false,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Operadores da plataforma (SaaS). acting_clinic_id = clínica que o operador está acessando.
create table platform_admins (
  auth_user_id uuid primary key,
  email text not null,
  acting_clinic_id uuid references clinics(id) on delete set null,
  created_at timestamptz not null default now()
);

create table clinic_integrations (
  clinic_id uuid primary key references clinics(id) on delete cascade,
  wa_phone_number_id text unique,
  wa_business_account_id text,
  wa_display_phone text,
  wa_access_token_enc text,
  wa_app_secret_enc text,
  wa_verify_token text not null default replace(gen_random_uuid()::text, '-', ''),
  wa_connected_at timestamptz,
  wa_last_inbound_at timestamptz,
  wa_last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table units (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  address text,
  accessibility_info text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app_users (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  auth_user_id uuid not null unique,
  email text not null,
  name text not null,
  role text not null check (role in ('admin','gestor','recepcao','dentista','comercial','financeiro')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table professionals (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  specialty text,
  council_number text,
  app_user_id uuid references app_users(id) on delete set null,
  color text not null default '#0F2A3D',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Cadeiras, equipamentos, auxiliares e o próprio dentista (kind = professional).
create table resources (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  unit_id uuid references units(id) on delete set null,
  name text not null,
  kind text not null check (kind in ('chair','equipment','assistant','professional')),
  professional_id uuid unique references professionals(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'professional') = (professional_id is not null))
);

-- Todo dentista ganha automaticamente um recurso, usado na constraint anti-conflito.
create or replace function app.professional_resource() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into resources (clinic_id, name, kind, professional_id, active)
    values (new.clinic_id, new.name, 'professional', new.id, new.active);
  else
    update resources set name = new.name, active = new.active where professional_id = new.id;
  end if;
  return new;
end $$;
create trigger professionals_resource after insert or update of name, active on professionals
  for each row execute function app.professional_resource();

create table availability_rules (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  professional_id uuid not null references professionals(id) on delete cascade,
  unit_id uuid references units(id) on delete set null,
  weekday smallint not null check (weekday between 0 and 6), -- 0 = domingo
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time > start_time)
);

-- Bloqueio de dentista, de recurso ou (ambos nulos) da clínica toda — feriado, por exemplo.
create table time_blocks (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  professional_id uuid references professionals(id) on delete cascade,
  resource_id uuid references resources(id) on delete cascade,
  during tstzrange not null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ───────────────────── Serviços e conhecimento ─────────────────────

create table services (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  specialty text,
  kind text not null default 'procedure' check (kind in ('evaluation','procedure','return')),
  duration_min integer not null default 30 check (duration_min > 0),
  buffer_min integer not null default 0 check (buffer_min >= 0),
  required_resource_kinds text[] not null default '{chair}',
  price_mode text not null default 'on_evaluation' check (price_mode in ('fixed','range','on_evaluation')),
  price_min_cents integer check (price_min_cents >= 0),
  price_max_cents integer check (price_max_cents >= 0),
  bookable_directly boolean not null default false,
  leads_to_evaluation_service_id uuid references services(id) on delete set null,
  patient_description text,
  preparation text,
  status text not null default 'draft' check (status in ('draft','published')),
  version integer not null default 1,
  approved_by uuid references app_users(id) on delete set null,
  approved_at timestamptz,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table service_professionals (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  service_id uuid not null references services(id) on delete cascade,
  professional_id uuid not null references professionals(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (service_id, professional_id)
);

create table knowledge_docs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  title text not null,
  body text not null default '',
  status text not null default 'draft' check (status in ('draft','published')),
  version integer not null default 1,
  author_id uuid references app_users(id) on delete set null,
  approved_by uuid references app_users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table knowledge_doc_versions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  doc_id uuid not null references knowledge_docs(id) on delete cascade,
  version integer not null,
  title text not null,
  body text not null,
  status text not null,
  author_id uuid,
  approved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ───────────────────── Contatos e pacientes ─────────────────────

create table contacts (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  phone_e164 text not null,
  wa_profile_name text,
  service_messages_allowed boolean not null default true,
  marketing_allowed boolean not null default false,
  opted_out_at timestamptz,
  is_test boolean not null default false,          -- simulador / testes: fora dos indicadores
  excluded_from_metrics boolean not null default false, -- spam, fornecedor
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, phone_e164)
);

create table patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  full_name text not null,
  birth_date date,
  cpf_encrypted text,
  notes text,
  merged_into_patient_id uuid references patients(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table contact_patient_links (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  relationship text not null default 'self', -- self, mae, pai, responsavel, conjuge, outro
  is_guardian boolean not null default false,
  is_payer boolean not null default false,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contact_id, patient_id)
);

-- ───────────────────────── Conversas ─────────────────────────

create table conversations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  channel text not null default 'whatsapp' check (channel in ('whatsapp','simulator')),
  state text not null default 'ai_active' check (state in ('ai_active','awaiting_human','human_active','closed')),
  assigned_to uuid references app_users(id) on delete set null,
  last_inbound_at timestamptz,
  window_expires_at timestamptz,
  last_message_at timestamptz,
  last_message_preview text,
  last_message_direction text,
  first_inbound_at timestamptz,
  first_response_at timestamptz,
  first_response_by text,
  summary text,
  summary_updated_at timestamptz,
  summary_by text,
  pending_notes text,
  unread_count integer not null default 0,
  row_version integer not null default 0,
  handoff_reason text,
  handoff_priority text check (handoff_priority in ('normal','urgente')),
  verified_patient_ids uuid[] not null default '{}',
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Uma conversa aberta por contato e canal.
create unique index conversations_one_open on conversations (contact_id, channel) where state <> 'closed';

create table messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound','internal')),
  sender_type text not null check (sender_type in ('patient','ai','human','system')),
  sender_user_id uuid references app_users(id) on delete set null,
  type text not null default 'text' check (type in ('text','audio','image','template','note','unsupported')),
  body text,
  media_path text,
  media_mime text,
  wa_media_id text,
  transcript text,
  transcript_original text,
  transcript_status text check (transcript_status in ('pending','done','failed')),
  wa_message_id text,
  delivery_status text not null default 'received' check (delivery_status in ('received','queued','sent','delivered','read','failed')),
  error text,
  ai_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index messages_wa_unique on messages (clinic_id, wa_message_id) where wa_message_id is not null;
create index messages_conversation on messages (conversation_id, created_at);

create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id) on delete cascade,
  provider text not null default 'whatsapp',
  provider_event_id text not null unique,
  payload jsonb not null,
  processed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ───────────────────────── Funil e agenda ─────────────────────────

create table opportunities (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  patient_id uuid references patients(id) on delete set null,
  service_id uuid references services(id) on delete set null,
  service_interest text not null,
  intent text check (intent in ('curioso','considerando','quer_agendar')),
  stage text not null default 'new' check (stage in ('new','in_conversation','evaluation_scheduled','evaluation_done','proposal_presented','following_up','accepted','lost')),
  owner_id uuid references app_users(id) on delete set null,
  next_step text,
  next_step_due timestamptz,
  lost_reason text,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table opportunity_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  from_stage text,
  to_stage text not null,
  actor text not null check (actor in ('ai','user','system')),
  actor_user_id uuid,
  evidence_message_id uuid,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table appointments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete restrict,
  contact_id uuid references contacts(id) on delete set null,
  service_id uuid not null references services(id) on delete restrict,
  professional_id uuid not null references professionals(id) on delete restrict,
  unit_id uuid references units(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled','confirmed','arrived','in_service','completed','no_show','cancelled')),
  rescheduled_from_id uuid references appointments(id) on delete set null,
  created_by_type text not null default 'user' check (created_by_type in ('ai','user','system')),
  created_by_user_id uuid,
  confirmed_at timestamptz,
  cancel_reason text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index appointments_time on appointments (clinic_id, starts_at);

create table appointment_resources (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  appointment_id uuid not null references appointments(id) on delete cascade,
  resource_id uuid not null references resources(id) on delete restrict,
  during tstzrange not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Proteção contra corrida de reservas: um recurso (cadeira ou dentista) não pode ter dois intervalos ativos sobrepostos.
  constraint appointment_resources_no_overlap exclude using gist (resource_id with =, during with &&) where (active)
);

create table slot_offers (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  conversation_id uuid references conversations(id) on delete cascade,
  service_id uuid not null references services(id) on delete cascade,
  professional_id uuid not null references professionals(id) on delete cascade,
  starts_at timestamptz not null,
  expires_at timestamptz not null default now() + interval '10 minutes',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ───────────────────── Automação e operação ─────────────────────

create table scheduled_jobs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  type text not null,
  run_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','running','done','failed','cancelled')),
  attempts integer not null default 0,
  idempotency_key text not null unique,
  payload jsonb not null default '{}',
  conversation_id uuid references conversations(id) on delete cascade,
  appointment_id uuid references appointments(id) on delete cascade,
  last_error text,
  result text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index scheduled_jobs_due on scheduled_jobs (run_at) where status = 'pending';

create table message_templates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  category text not null default 'utility' check (category in ('utility','marketing')),
  language text not null default 'pt_BR',
  body text not null,
  wa_template_status text not null default 'not_submitted' check (wa_template_status in ('not_submitted','pending','approved','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, name)
);

create table ai_runs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  model text,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  cost_cents numeric(10,4) not null default 0,
  tools_called jsonb not null default '[]',
  latency_ms integer,
  outcome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  title text not null,
  detail text,
  kind text not null default 'manual',
  status text not null default 'open' check (status in ('open','done','cancelled')),
  due_at timestamptz,
  assigned_to uuid references app_users(id) on delete set null,
  conversation_id uuid references conversations(id) on delete cascade,
  contact_id uuid references contacts(id) on delete cascade,
  opportunity_id uuid references opportunities(id) on delete cascade,
  appointment_id uuid references appointments(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  actor_id uuid,
  actor_label text,
  action text not null,
  entity text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index audit_events_recent on audit_events (clinic_id, created_at desc);

-- Índices de clinic_id e updated_at automático em todas as tabelas.
do $$
declare t record;
begin
  for t in select c.table_name from information_schema.columns c
           join information_schema.tables tb on tb.table_name = c.table_name and tb.table_schema = 'public' and tb.table_type = 'BASE TABLE'
           where c.table_schema = 'public' and c.column_name = 'updated_at' loop
    execute format('create trigger %I before update on %I for each row execute function app.touch_updated_at()', t.table_name || '_touch', t.table_name);
  end loop;
  for t in select table_name from information_schema.columns where table_schema = 'public' and column_name = 'clinic_id'
           and table_name not in ('clinic_integrations') loop
    execute format('create index if not exists %I on %I (clinic_id)', t.table_name || '_clinic_idx', t.table_name);
  end loop;
end $$;

create index conversations_inbox on conversations (clinic_id, last_message_at desc);
create index opportunities_stage on opportunities (clinic_id, stage);
create index contact_links_patient on contact_patient_links (patient_id);
