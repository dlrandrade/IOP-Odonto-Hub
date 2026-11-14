-- Automações criadas pela clínica no construtor visual (além das quatro nativas: follow-ups, lembrete e confirmação).
-- Cada regra: gatilho → espera → ação. O worker reavalia elegibilidade, horário permitido e limite diário na hora de enviar.

create table automation_rules (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  trigger text not null check (trigger in ('before_appointment', 'after_appointment', 'no_show', 'birthday')),
  -- minutos em relação ao gatilho (antes da consulta, depois da consulta/falta) ou hora local do envio no aniversário
  offset_minutes integer not null default 0 check (offset_minutes between 0 and 60 * 24 * 60),
  action text not null check (action in ('message', 'task')),
  body text,
  template_name text,
  task_title text,
  enabled boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (action <> 'message' or coalesce(length(trim(body)), 0) > 0),
  check (action <> 'task' or coalesce(length(trim(task_title)), 0) > 0)
);
create index automation_rules_clinic on automation_rules (clinic_id, trigger) where enabled;
create trigger automation_rules_touch before update on automation_rules for each row execute function app.touch_updated_at();

grant select, insert, update, delete on automation_rules to authenticated;
alter table automation_rules enable row level security;
create policy tenant_select on automation_rules for select to authenticated using (clinic_id = app.clinic_id());
create policy tenant_insert on automation_rules for insert to authenticated with check (clinic_id = app.clinic_id());
create policy tenant_update on automation_rules for update to authenticated using (clinic_id = app.clinic_id()) with check (clinic_id = app.clinic_id());
create policy tenant_delete on automation_rules for delete to authenticated using (clinic_id = app.clinic_id());
-- Escrita só por admin e gestor (mesma regra de templates e catálogo).
create policy role_insert on automation_rules as restrictive for insert to authenticated with check (app.role() in ('admin','gestor'));
create policy role_update on automation_rules as restrictive for update to authenticated using (app.role() in ('admin','gestor'));
create policy role_delete on automation_rules as restrictive for delete to authenticated using (app.role() in ('admin','gestor'));
