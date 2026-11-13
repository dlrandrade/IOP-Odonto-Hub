/**
 * Cria (ou atualiza a senha de) um operador da plataforma.
 *   ADMIN_EMAIL=voce@exemplo.com ADMIN_PASSWORD='sua-senha' npm run setup:admin
 * A senha nunca é gravada no repositório: vem só do ambiente.
 */
import { existsSync } from "node:fs";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const url = process.env.DATABASE_URL;
if (!email || !password || !url) throw new Error("Defina ADMIN_EMAIL, ADMIN_PASSWORD e DATABASE_URL");
if (password.length < 8) throw new Error("A senha precisa ter ao menos 8 caracteres");

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

async function main(email: string, password: string) {
  let userId: string | undefined;
  if (process.env.AUTH_MODE === "local") {
    const [row] = await sql<{ id: string }[]>`
      insert into auth.users (email, encrypted_password) values (${email}, crypt(${password}, gen_salt('bf')))
      on conflict (email) do update set encrypted_password = excluded.encrypted_password returning id`;
    userId = row?.id;
  } else {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !key) throw new Error("Defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
    const admin = createClient(supabaseUrl, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    userId = created.data.user?.id;
    if (!userId) {
      const [existing] = await sql<{ id: string }[]>`select id from auth.users where email = ${email}`;
      if (!existing) throw new Error(`Não foi possível criar o usuário: ${created.error?.message ?? "erro"}`);
      await admin.auth.admin.updateUserById(existing.id, { password });
      userId = existing.id;
    }
  }
  if (!userId) throw new Error("Usuário não criado");
  await sql`insert into platform_admins (auth_user_id, email) values (${userId}, ${email}) on conflict (auth_user_id) do nothing`;
  console.log(`✔ Operador da plataforma pronto: ${email}`);
}

main(email, password).then(() => sql.end()).catch(async (e) => { console.error(e instanceof Error ? e.message : e); await sql.end(); process.exit(1); });
