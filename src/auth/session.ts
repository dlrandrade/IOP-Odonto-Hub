import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { resolveVista, VISTA_COOKIE } from "@/lib/vista";
import { db, asUser } from "@/db/client";
import type postgres from "postgres";
import { getAuthUser } from "./provider";
import { can, ForbiddenError, type Permission, type Role } from "@/domain/permissions";
import { parseSettings, type ClinicSettings } from "@/domain/settings";
import type { BusinessHours } from "@/lib/datetime";
import { missingEnv } from "@/lib/env";

export type ClinicRow = {
  id: string; name: string; timezone: string; business_hours: BusinessHours; assistant_name: string;
  ai_enabled: boolean; ai_kill_switch: boolean; after_hours_message: string;
  alert_keywords: string[]; alert_message: string | null; alert_after_hours_message: string | null;
  alert_approved_at: Date | null; alert_approved_by: string | null;
  settings: unknown; status: string; is_demo: boolean; onboarding_completed_at: Date | null; created_at: Date;
};

export type Ctx = {
  authUserId: string;
  email: string;
  /** app_users.id; nulo quando é o operador da plataforma acessando a clínica. */
  userId: string | null;
  name: string;
  /** Foto do perfil (data URL pequena) ou null para mostrar as iniciais. */
  avatar: string | null;
  role: Role;
  isPlatformAdmin: boolean;
  actingAsPlatform: boolean;
  clinicId: string;
  clinic: ClinicRow;
  settings: ClinicSettings;
  tz: string;
  /** Visualização detalhada (termos técnicos, custos, históricos). Falso = visualização simples. */
  detailed: boolean;
};


export type Identity = {
  authUserId: string; email: string; isPlatformAdmin: boolean; actingClinicId: string | null;
  appUser: { id: string; clinic_id: string; name: string; role: Role; active: boolean; avatar: string | null } | null;
  /** Nome e foto do operador da plataforma (perfil próprio). */
  platformName: string | null; platformAvatar: string | null;
};

/** Quem é o usuário logado (sem exigir clínica). */
export const getIdentity = cache(async (): Promise<Identity | null> => {
  return (await loadSession())?.identity ?? null;
});

/**
 * Identidade e clínica em uma única ida ao banco (consultas em paralelo). Cada viagem conta:
 * esta função roda em toda página.
 */
const loadSession = cache(async (): Promise<{ identity: Identity; clinic: ClinicRow | null } | null> => {
  if (missingEnv().length > 0) return null;
  const user = await getAuthUser();
  if (!user) return null;
  const sql = db();
  const [[row], [clinic]] = await Promise.all([
    sql<{ pa: boolean; acting_clinic_id: string | null; pa_name: string | null; pa_avatar: string | null; au_id: string | null; au_clinic: string | null; au_name: string | null; au_role: Role | null; au_active: boolean | null; au_avatar: string | null }[]>`
      select pa.auth_user_id is not null as pa, pa.acting_clinic_id, pa.display_name as pa_name, pa.avatar_data as pa_avatar,
             au.id as au_id, au.clinic_id as au_clinic, au.name as au_name, au.role as au_role, au.active as au_active, au.avatar_data as au_avatar
      from (select 1) one
      left join platform_admins pa on pa.auth_user_id = ${user.id}
      left join app_users au on au.auth_user_id = ${user.id}`,
    sql<ClinicRow[]>`
      select c.* from clinics c
      where c.id = coalesce(
        (select acting_clinic_id from platform_admins where auth_user_id = ${user.id}),
        (select clinic_id from app_users where auth_user_id = ${user.id} and active))`,
  ]);
  // Operador da plataforma só existe se cadastrado explicitamente em platform_admins (npm run setup:admin).
  // Nunca promovemos alguém por e-mail no login: o cadastro público não pode virar porta de entrada para o painel.
  const isPlatformAdmin = !!row?.pa;
  const appUser = row?.au_id ? { id: row.au_id, clinic_id: row.au_clinic!, name: row.au_name!, role: row.au_role!, active: !!row.au_active, avatar: row.au_avatar } : null;
  return {
    identity: { authUserId: user.id, email: user.email, isPlatformAdmin, actingClinicId: row?.acting_clinic_id ?? null, appUser, platformName: row?.pa_name ?? null, platformAvatar: row?.pa_avatar ?? null },
    clinic: clinic ?? null,
  };
});

export const getCtx = cache(async (): Promise<Ctx | null> => {
  const session = await loadSession();
  if (!session) return null;
  const me = session.identity;
  const acting = me.isPlatformAdmin && !!me.actingClinicId;
  // Usuário desativado perde o acesso imediatamente (conferido a cada requisição).
  const member = me.appUser?.active ? me.appUser : null;
  const clinicId = acting ? me.actingClinicId : member?.clinic_id;
  const clinic = session.clinic;
  if (!clinicId || !clinic || clinic.id !== clinicId) return null;
  if (clinic.status === "suspended" && !me.isPlatformAdmin) return null;
  return {
    authUserId: me.authUserId, email: me.email,
    userId: acting ? null : member?.id ?? null,
    name: acting ? me.platformName ?? "Suporte da plataforma" : member?.name ?? me.email,
    avatar: acting ? me.platformAvatar : member?.avatar ?? null,
    role: acting ? "admin" : member?.role ?? "recepcao",
    isPlatformAdmin: me.isPlatformAdmin, actingAsPlatform: acting,
    clinicId, clinic, settings: parseSettings(clinic.settings), tz: clinic.timezone,
    detailed: resolveVista((await cookies()).get(VISTA_COOKIE)?.value, me.isPlatformAdmin) === "detalhada",
  };
});

export async function requireCtx(permission?: Permission): Promise<Ctx> {
  if (missingEnv().length > 0) redirect("/setup");
  const me = await getIdentity();
  if (!me) redirect("/login");
  const ctx = await getCtx();
  if (!ctx) {
    if (me.isPlatformAdmin) redirect("/admin");
    if (me.appUser && !me.appUser.active) redirect("/login?erro=desativado");
    if (me.appUser) redirect("/login?erro=suspensa");
    redirect("/onboarding");
  }
  if (permission && !can(ctx.role, permission)) redirect("/");
  return ctx;
}

/** Para server actions: lança em vez de redirecionar. */
export async function actionCtx(permission: Permission): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) throw new ForbiddenError("sessão");
  if (!can(ctx.role, permission)) throw new ForbiddenError(permission);
  return ctx;
}

/** Roda consultas com RLS do usuário atual. */
export function q<T>(ctx: Pick<Ctx, "authUserId">, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return asUser(ctx.authUserId, fn);
}
