import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { db } from "@/db/client";
import { env } from "@/lib/env";
import { hmacHex, safeEqual } from "@/lib/crypto";

/**
 * Autenticação atrás de uma interface pequena.
 * - Produção: Supabase Auth (cookies via @supabase/ssr).
 * - AUTH_MODE=local: login contra auth.users do Postgres local (desenvolvimento e testes sem Supabase).
 */
export type AuthUser = { id: string; email: string };
export type AuthResult = { ok: true; userId: string } | { ok: false; error: string };

const LOCAL_COOKIE = "oc_session";
const WEEK = 7 * 24 * 3600;

async function supabaseServer() {
  const store = await cookies();
  return createServerClient(env.supabaseUrl ?? "", env.supabaseAnonKey ?? "", {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Chamado de um Server Component: o middleware cuida de renovar a sessão.
        }
      },
    },
  });
}

export function supabaseAdmin() {
  if (!env.supabaseUrl || !env.supabaseServiceKey) throw new Error("Supabase não configurado");
  return createClient(env.supabaseUrl, env.supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

function localSecret(): string {
  return env.fieldKey ?? "dev-only-secret";
}

async function setLocalCookie(userId: string) {
  const exp = Math.floor(Date.now() / 1000) + WEEK;
  const payload = `${userId}.${exp}`;
  (await cookies()).set(LOCAL_COOKIE, `${payload}.${hmacHex(localSecret(), payload)}`, { httpOnly: true, sameSite: "lax", path: "/", maxAge: WEEK });
}

export async function getAuthUser(): Promise<AuthUser | null> {
  if (env.authMode === "local") {
    const raw = (await cookies()).get(LOCAL_COOKIE)?.value;
    if (!raw) return null;
    const [userId, exp, sig] = raw.split(".");
    if (!userId || !exp || !sig || !safeEqual(sig, hmacHex(localSecret(), `${userId}.${exp}`))) return null;
    if (Number(exp) < Date.now() / 1000) return null;
    const [row] = await db()<{ id: string; email: string }[]>`select id, email from auth.users where id = ${userId}`;
    return row ?? null;
  }
  if (!env.supabaseUrl || !env.supabaseAnonKey) return null;
  // getClaims valida a assinatura do JWT localmente (chaves assimétricas, JWKS em cache) e só
  // consulta o servidor de Auth quando precisa — evita uma viagem de rede a cada página.
  const { data, error } = await (await supabaseServer()).auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub || typeof claims.email !== "string" || !claims.email) return null;
  return { id: claims.sub, email: claims.email };
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  if (env.authMode === "local") {
    const [row] = await db()<{ id: string }[]>`
      select id from auth.users where email = ${email.toLowerCase()} and encrypted_password = crypt(${password}, encrypted_password)`;
    if (!row) return { ok: false, error: "E-mail ou senha inválidos." };
    await setLocalCookie(row.id);
    return { ok: true, userId: row.id };
  }
  const { data, error } = await (await supabaseServer()).auth.signInWithPassword({ email, password });
  if (error || !data.user) return { ok: false, error: "E-mail ou senha inválidos." };
  return { ok: true, userId: data.user.id };
}

/** Cria o usuário sem depender de e-mail de confirmação (cadastro e convites). */
export async function adminCreateUser(email: string, password: string): Promise<AuthResult> {
  const lower = email.toLowerCase();
  if (env.authMode === "local") {
    const [existing] = await db()`select 1 from auth.users where email = ${lower}`;
    if (existing) return { ok: false, error: "Já existe uma conta com este e-mail." };
    const [row] = await db()<{ id: string }[]>`
      insert into auth.users (email, encrypted_password) values (${lower}, crypt(${password}, gen_salt('bf'))) returning id`;
    return row ? { ok: true, userId: row.id } : { ok: false, error: "Não foi possível criar a conta." };
  }
  const { data, error } = await supabaseAdmin().auth.admin.createUser({ email: lower, password, email_confirm: true });
  if (error || !data.user) {
    const exists = error?.message?.toLowerCase().includes("already");
    return { ok: false, error: exists ? "Já existe uma conta com este e-mail." : "Não foi possível criar a conta." };
  }
  return { ok: true, userId: data.user.id };
}

export async function adminSetPassword(userId: string, password: string): Promise<boolean> {
  if (env.authMode === "local") {
    await db()`update auth.users set encrypted_password = crypt(${password}, gen_salt('bf')) where id = ${userId}`;
    return true;
  }
  const { error } = await supabaseAdmin().auth.admin.updateUserById(userId, { password });
  return !error;
}

export async function signUp(email: string, password: string): Promise<AuthResult> {
  const created = await adminCreateUser(email, password);
  if (!created.ok) return created;
  return signIn(email, password);
}

export async function signOut(): Promise<void> {
  if (env.authMode === "local") {
    (await cookies()).delete(LOCAL_COOKIE);
    return;
  }
  await (await supabaseServer()).auth.signOut();
}
