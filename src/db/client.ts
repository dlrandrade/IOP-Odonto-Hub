import postgres from "postgres";
import { env } from "@/lib/env";

/** Conexão ou transação. Toda função de serviço recebe uma destas. */
export type Sql = postgres.Sql | postgres.TransactionSql;

const globalForDb = globalThis as unknown as { __ocSql?: postgres.Sql };

/**
 * Conexão de SISTEMA (dona das tabelas, ignora RLS). Use apenas em webhooks, jobs e fluxos
 * sem usuário — e SEMPRE filtrando por clinic_id. Telas usam `asUser`.
 */
export function db(): postgres.Sql {
  if (!globalForDb.__ocSql) {
    const url = env.databaseUrl;
    if (!url) throw new Error("DATABASE_URL não configurada");
    globalForDb.__ocSql = postgres(url, {
      prepare: false, // compatível com o pooler em modo transação do Supabase
      max: Number(process.env.DB_POOL_MAX ?? 5),
      idle_timeout: 20,
      onnotice: () => {},
    });
  }
  return globalForDb.__ocSql;
}

/** Executa como o usuário autenticado: RLS aplicada como no Supabase (role authenticated + JWT sub). */
export async function asUser<T>(authUserId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db().begin(async (tx) => {
    const claims = JSON.stringify({ sub: authUserId, role: "authenticated" });
    await tx`select set_config('request.jwt.claims', ${claims}, true), set_config('role', 'authenticated', true)`;
    return fn(tx);
  });
  return result as T;
}

/** Transação (ou savepoint, se já estivermos em uma). */
export async function inTx<T>(sql: Sql, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  if ("savepoint" in sql) return (await sql.savepoint((sp) => fn(sp))) as T;
  return (await sql.begin((tx) => fn(tx))) as T;
}

export function pgErrorCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

export const PG_EXCLUSION_VIOLATION = "23P01";
export const PG_UNIQUE_VIOLATION = "23505";
