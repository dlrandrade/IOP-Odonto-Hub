-- Reforço de segurança (inspeção de 15/11/2026).

-- 1) Um número da Cloud API pertence a uma só clínica. A checagem no app roda sob a RLS da clínica
--    (que não enxerga as outras), então a garantia precisa estar no banco.
create unique index if not exists clinic_integrations_wa_phone_unique
  on clinic_integrations (wa_phone_number_id) where wa_phone_number_id is not null;

-- 2) Funções auxiliares de RLS não precisam ser executáveis por visitantes anônimos.
revoke execute on function app.clinic_id() from anon, public;
revoke execute on function app.role() from anon, public;
revoke execute on function app.is_platform_admin() from anon, public;
grant execute on function app.clinic_id(), app.role(), app.is_platform_admin() to authenticated;
