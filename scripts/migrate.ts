/**
 * Aplica as migrações de supabase/migrations em ordem (controle na tabela app_migrations).
 *   npm run db:migrate            → banco apontado por DATABASE_URL (Supabase ou outro)
 *   npm run db:local              → Postgres puro: aplica antes o shim local (papéis, auth.users)
 *   npm run db:seed               → cria a Clínica Sorriso Demo (dados fictícios)
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Defina DATABASE_URL");
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
const args = new Set(process.argv.slice(2));

async function main() {
  if (args.has("--local")) await sql.unsafe(readFileSync("supabase/local/shim.sql", "utf8"));
  await sql`create table if not exists app_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const dir = "supabase/migrations";
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const [done] = await sql`select 1 from app_migrations where name = ${file}`;
    if (done) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(path.join(dir, file), "utf8"));
      await tx`insert into app_migrations (name) values (${file})`;
    });
    console.log(`✔ ${file}`);
  }
  if (args.has("--seed")) {
    const { seedDemoClinic } = await import("../src/services/demo");
    const [exists] = await sql`select 1 from clinics where is_demo and name = 'Clínica Sorriso Demo'`;
    if (exists) console.log("Clínica demo já existe.");
    else console.log(`✔ Clínica Sorriso Demo criada (${await seedDemoClinic(sql, null)})`);
  }
  console.log("Banco atualizado.");
}

main().then(() => sql.end()).catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
