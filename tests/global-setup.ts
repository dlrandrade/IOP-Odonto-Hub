import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";

/** Recria o banco de teste do zero e aplica shim + migrações reais antes da suíte. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/odonto_test";
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql.unsafe("drop schema if exists public cascade; drop schema if exists app cascade; drop schema if exists auth cascade; create schema public;");
  await sql.unsafe(readFileSync("supabase/local/shim.sql", "utf8"));
  for (const f of readdirSync("supabase/migrations").filter((x) => x.endsWith(".sql")).sort()) {
    await sql.unsafe(readFileSync(`supabase/migrations/${f}`, "utf8"));
  }
  await sql.end();
}
