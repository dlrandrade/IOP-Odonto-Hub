-- Envio por clique (WhatsApp Web/app): a tarefa guarda o número e o texto pronto.
alter table tasks
  add column wa_phone text,
  add column message_text text;

alter table automation_rules drop constraint if exists automation_rules_channel_check;
alter table automation_rules add constraint automation_rules_channel_check check (channel in ('whatsapp', 'whatsapp_click', 'email', 'instagram'));

-- Origem do paciente: mais canais e como foi detectada.
alter table patients drop constraint if exists patients_source_check;
alter table patients add constraint patients_source_check check (source is null or source in
  ('google', 'instagram', 'facebook', 'tiktok', 'youtube', 'email', 'indicacao', 'whatsapp', 'site', 'passou_na_frente', 'convenio', 'outro'));
alter table patients add column source_detail text;
-- contacts.source guarda o canal de entrada (whatsapp, simulator, manual); a origem detectada fica à parte.
alter table contacts add column origin text, add column origin_detail text;

-- Google Agenda (ou qualquer agenda iCal): espelhar a agenda da clínica e puxar compromissos como bloqueios.
alter table clinic_integrations
  add column calendar_feed_token text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  add column calendar_feed_privacy text not null default 'name_service' check (calendar_feed_privacy in ('busy', 'service', 'name_service'));
create unique index clinic_integrations_calendar_token on clinic_integrations (calendar_feed_token);

create table calendar_imports (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  professional_id uuid references professionals(id) on delete cascade, -- nulo = bloqueia a clínica toda
  label text not null,
  url_enc text not null,                                                  -- endereço secreto iCal, criptografado
  active boolean not null default true,
  last_synced_at timestamptz,
  last_error text,
  events_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index calendar_imports_clinic on calendar_imports (clinic_id);
create trigger calendar_imports_touch before update on calendar_imports for each row execute function app.touch_updated_at();
grant select, insert, update, delete on calendar_imports to authenticated;
alter table calendar_imports enable row level security;
create policy tenant_select on calendar_imports for select to authenticated using (clinic_id = app.clinic_id());
create policy tenant_insert on calendar_imports for insert to authenticated with check (clinic_id = app.clinic_id());
create policy tenant_update on calendar_imports for update to authenticated using (clinic_id = app.clinic_id()) with check (clinic_id = app.clinic_id());
create policy tenant_delete on calendar_imports for delete to authenticated using (clinic_id = app.clinic_id());
create policy role_insert on calendar_imports as restrictive for insert to authenticated with check (app.role() = 'admin');
create policy role_update on calendar_imports as restrictive for update to authenticated using (app.role() = 'admin');
create policy role_delete on calendar_imports as restrictive for delete to authenticated using (app.role() = 'admin');

-- Bloqueios vindos de uma agenda externa: substituídos a cada sincronização.
alter table time_blocks
  add column import_id uuid references calendar_imports(id) on delete cascade,
  add column external_uid text;
create index time_blocks_import on time_blocks (import_id) where import_id is not null;
