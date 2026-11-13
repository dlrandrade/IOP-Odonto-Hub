import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
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
  role: Role;
  isPlatformAdmin: boolean;
  actingAsPlatform: boolean;
  clinicId: string;
  clinic: ClinicRow;
  settings: ClinicSettings;
  tz: string;
};

function platformEmails(): string[] {
  return (process.env.PLATFORM_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export type Identity = {
  authUserId: string; email: string; isPlatformAdmin: boolean; actingClinicId: string | null;
  appUser: { id: string; clinic_id: string; name: string; role: Role; active: boolean } | null;
};

/** Quem é o usuário logado (sem exigir clínica). */
export const getIdentity = cache(async (): Promise<Identity | null> => {
  if (missingEnv().length > 0) return null;
  const user = await getAuthUser();
  if (!user) return null;
  const sql = db();
  if (platformEmails().includes(user.email.toLowerCase())) {
    await sql`insert into platform_admins (auth_user_id, email) values (${user.id}, ${user.email}) on conflict (auth_user_id) do nothing`;
  }
  const [pa] = await sql<{ acting_clinic_id: string | null }[]>`select acting_clinic_id from platform_admins where auth_user_id = ${user.id}`;
  const [appUser] = await sql<{ id: string; clinic_id: string; name: string; role: Role; active: boolean }[]>`
    select id, clinic_id, name, role, active from app_users where auth_user_id = ${user.id}`;
  return { authUserId: user.id, email: user.email, isPlatformAdmin: !!pa, actingClinicId: pa?.acting_clinic_id ?? null, appUser: appUser ?? null };
});

export const getCtx = cache(async (): Promise<Ctx | null> => {
  const me = await getIdentity();
  if (!me) return null;
  const acting = me.isPlatformAdmin && !!me.actingClinicId;
  // Usuário desativado perde o acesso imediatamente (conferido a cada requisição).
  const member = me.appUser?.active ? me.appUser : null;
  const clinicId = acting ? me.actingClinicId : member?.clinic_id;
  if (!clinicId) return null;
  const [clinic] = await db()<ClinicRow[]>`select * from clinics where id = ${clinicId}`;
  if (!clinic) return null;
  if (clinic.status === "suspended" && !me.isPlatformAdmin) return null;
  return {
    authUserId: me.authUserId, email: me.email,
    userId: acting ? null : member?.id ?? null,
    name: acting ? "Suporte da plataforma" : member?.name ?? me.email,
    role: acting ? "admin" : member?.role ?? "recepcao",
    isPlatformAdmin: me.isPlatformAdmin, actingAsPlatform: acting,
    clinicId, clinic, settings: parseSettings(clinic.settings), tz: clinic.timezone,
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
