-- RLS: isolamento por clínica em todas as tabelas + restrições por papel (PRD seção 3).
-- O servidor valida permissões por ação (src/domain/permissions.ts); aqui fica a última barreira.

create or replace function app.clinic_id() returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select acting_clinic_id from platform_admins where auth_user_id = auth.uid()),
    (select clinic_id from app_users where auth_user_id = auth.uid() and active)
  )
$$;

create or replace function app.role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from platform_admins where auth_user_id = auth.uid() and acting_clinic_id is not null) then 'admin'
    else (select role from app_users where auth_user_id = auth.uid() and active)
  end
$$;

create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where auth_user_id = auth.uid())
$$;

grant usage on schema app to authenticated;
grant execute on all functions in schema app to authenticated;
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on all tables in schema public from anon;

-- 1) Isolamento por clínica (todas as tabelas com clinic_id).
do $$
declare t record;
begin
  for t in select table_name from information_schema.columns
           where table_schema = 'public' and column_name = 'clinic_id' loop
    execute format('alter table %I enable row level security', t.table_name);
    execute format('create policy tenant_select on %I for select to authenticated using (clinic_id = app.clinic_id())', t.table_name);
    execute format('create policy tenant_insert on %I for insert to authenticated with check (clinic_id = app.clinic_id())', t.table_name);
    execute format('create policy tenant_update on %I for update to authenticated using (clinic_id = app.clinic_id()) with check (clinic_id = app.clinic_id())', t.table_name);
    execute format('create policy tenant_delete on %I for delete to authenticated using (clinic_id = app.clinic_id())', t.table_name);
  end loop;
end $$;

alter table clinics enable row level security;
create policy clinic_select on clinics for select to authenticated using (id = app.clinic_id() or app.is_platform_admin());
create policy clinic_update on clinics for update to authenticated
  using ((id = app.clinic_id() and app.role() in ('admin','gestor')) or app.is_platform_admin())
  with check ((id = app.clinic_id() and app.role() in ('admin','gestor')) or app.is_platform_admin());

alter table platform_admins enable row level security;
create policy platform_self on platform_admins for select to authenticated using (auth_user_id = auth.uid());
create policy platform_self_update on platform_admins for update to authenticated
  using (auth_user_id = auth.uid()) with check (auth_user_id = auth.uid());

-- 2) Restrições por papel (políticas restritivas somam-se ao isolamento).
create or replace function app.restrict_writes(p_table text, p_roles text[]) returns void language plpgsql as $$
declare cond text := format('app.role() = any (%L::text[])', p_roles);
begin
  execute format('create policy role_insert on %I as restrictive for insert to authenticated with check (%s)', p_table, cond);
  execute format('create policy role_update on %I as restrictive for update to authenticated using (%s)', p_table, cond);
  execute format('create policy role_delete on %I as restrictive for delete to authenticated using (%s)', p_table, cond);
end $$;

create or replace function app.restrict_reads(p_table text, p_roles text[]) returns void language plpgsql as $$
begin
  execute format('create policy role_select on %I as restrictive for select to authenticated using (app.role() = any (%L::text[]))', p_table, p_roles);
end $$;

-- Configuração da clínica: só admin.
select app.restrict_writes(t, '{admin}') from unnest(array['app_users','units','clinic_integrations']) t;
select app.restrict_reads('clinic_integrations', '{admin}');
-- Agenda estrutural: admin e gestor.
select app.restrict_writes(t, '{admin,gestor}') from unnest(array['professionals','resources','availability_rules']) t;
select app.restrict_writes('time_blocks', '{admin,gestor,recepcao}');
-- Catálogo, conhecimento e templates: admin e gestor publicam.
select app.restrict_writes(t, '{admin,gestor}') from unnest(array['services','service_professionals','knowledge_docs','knowledge_doc_versions','message_templates']) t;
-- Conversas: financeiro não acessa.
select app.restrict_reads(t, '{admin,gestor,recepcao,dentista,comercial}') from unnest(array['conversations','messages']) t;
select app.restrict_writes(t, '{admin,gestor,recepcao,dentista,comercial}') from unnest(array['conversations','messages']) t;
-- Agenda: comercial e financeiro não alteram; dentista só lê.
select app.restrict_writes(t, '{admin,gestor,recepcao}') from unnest(array['appointments','appointment_resources']) t;
-- CRM: financeiro e dentista não alteram.
select app.restrict_writes(t, '{admin,gestor,recepcao,comercial}') from unnest(array['opportunities','opportunity_events']) t;
-- Pacientes: dentista só lê.
select app.restrict_writes(t, '{admin,gestor,recepcao,comercial,financeiro}') from unnest(array['patients','contacts','contact_patient_links']) t;
-- Auditoria e operação: leitura para admin/gestor; ninguém altera pelo cliente.
select app.restrict_reads(t, '{admin,gestor}') from unnest(array['audit_events','webhook_events','scheduled_jobs','ai_runs']) t;
drop policy tenant_update on audit_events;
drop policy tenant_delete on audit_events;
do $$
declare t text;
begin
  foreach t in array array['webhook_events','scheduled_jobs','ai_runs','slot_offers'] loop
    execute format('drop policy tenant_insert on %I', t);
    execute format('drop policy tenant_update on %I', t);
    execute format('drop policy tenant_delete on %I', t);
  end loop;
end $$;

drop function app.restrict_writes(text, text[]);
drop function app.restrict_reads(text, text[]);

-- 3) Supabase: Realtime da inbox e bucket privado de mídia (ignorado em Postgres puro).
do $$ begin
  if exists (select from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table messages, conversations;
  end if;
  if exists (select from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public) values ('media', 'media', false) on conflict (id) do nothing;
  end if;
end $$;
