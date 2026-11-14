-- Fixa o search_path das funções de gatilho (recomendação do advisor de segurança do Supabase).
alter function app.touch_updated_at() set search_path = public;
alter function app.professional_resource() set search_path = public;
