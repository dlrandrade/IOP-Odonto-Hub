-- Perfil do próprio usuário: nome e foto (imagem pequena, já reduzida no navegador para ~160 px).
alter table app_users add column avatar_data text check (avatar_data is null or (avatar_data like 'data:image/%' and length(avatar_data) < 200000));
alter table platform_admins
  add column display_name text check (display_name is null or length(trim(display_name)) between 2 and 80),
  add column avatar_data text check (avatar_data is null or (avatar_data like 'data:image/%' and length(avatar_data) < 200000));

-- A RLS de app_users só deixa o admin da clínica escrever. Cada pessoa altera o próprio nome e foto por esta função,
-- que identifica o usuário pelo JWT (auth.uid()) e não toca em papel, e-mail ou situação.
create or replace function app.update_my_profile(p_name text, p_avatar text, p_keep_avatar boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_name is null or length(trim(p_name)) < 2 or length(trim(p_name)) > 80 then
    raise exception 'nome inválido';
  end if;
  update app_users set name = trim(p_name), avatar_data = case when p_keep_avatar then avatar_data else p_avatar end
  where auth_user_id = auth.uid();
  update platform_admins set display_name = trim(p_name), avatar_data = case when p_keep_avatar then avatar_data else p_avatar end
  where auth_user_id = auth.uid();
end $$;
revoke all on function app.update_my_profile(text, text, boolean) from public;
grant execute on function app.update_my_profile(text, text, boolean) to authenticated;
