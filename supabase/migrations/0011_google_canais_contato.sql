-- Dados de contato e presença digital da clínica (preenchidos na contratação e em Configurações).
alter table clinics
  add column contact_phone text,
  add column contact_email text,
  add column website_url text,
  add column instagram_handle text,
  -- Google Meu Negócio (Perfil da Empresa no Google)
  add column google_business_url text,   -- link do perfil (Maps)
  add column google_review_url text,     -- link direto "escrever avaliação"
  add column google_place_id text;       -- para buscar nota e total de avaliações automaticamente

-- Histórico de avaliações no Google: uma foto por dia (automática pela API do Google ou registrada à mão).
create table google_review_snapshots (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  taken_on date not null,
  rating numeric(2,1) check (rating is null or rating between 1 and 5),
  review_count integer not null check (review_count >= 0),
  source text not null default 'manual' check (source in ('manual', 'google')),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (clinic_id, taken_on)
);
create index google_review_snapshots_clinic on google_review_snapshots (clinic_id, taken_on desc);
grant select, insert, update, delete on google_review_snapshots to authenticated;
alter table google_review_snapshots enable row level security;
create policy tenant_select on google_review_snapshots for select to authenticated using (clinic_id = app.clinic_id());
create policy tenant_insert on google_review_snapshots for insert to authenticated with check (clinic_id = app.clinic_id());
create policy tenant_update on google_review_snapshots for update to authenticated using (clinic_id = app.clinic_id()) with check (clinic_id = app.clinic_id());
create policy tenant_delete on google_review_snapshots for delete to authenticated using (clinic_id = app.clinic_id());
create policy role_write on google_review_snapshots as restrictive for insert to authenticated with check (app.role() in ('admin','gestor'));
create policy role_update on google_review_snapshots as restrictive for update to authenticated using (app.role() in ('admin','gestor'));
create policy role_delete on google_review_snapshots as restrictive for delete to authenticated using (app.role() in ('admin','gestor'));

-- Pacientes: e-mail (para automações por e-mail) e origem ("como conheceu a clínica").
alter table patients
  add column email text,
  add column source text check (source is null or source in ('google', 'instagram', 'indicacao', 'whatsapp', 'site', 'facebook', 'passou_na_frente', 'convenio', 'outro'));
create index patients_source on patients (clinic_id, source) where source is not null;

-- Automações: por qual canal a mensagem sai.
alter table automation_rules
  add column channel text not null default 'whatsapp' check (channel in ('whatsapp', 'email', 'instagram'));
