"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { VISTA_COOKIE } from "@/lib/vista";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminCreateUser } from "@/auth/provider";
import { getIdentity } from "@/auth/session";
import type { ActionState } from "@/components/client";
import { db } from "@/db/client";
import { createClinic } from "@/services/clinic-setup";
import { seedDemoActivity, seedDemoClinic } from "@/services/demo";

async function platform() {
  const me = await getIdentity();
  if (!me?.isPlatformAdmin) throw new Error("forbidden");
  return me;
}

/**
 * Entra em uma clínica como suporte (vira admin daquela clínica enquanto durar).
 * "vista=simples" abre como o cliente vê (visualização simples); o padrão do operador é a detalhada.
 */
export async function enterClinicAction(form: FormData): Promise<void> {
  const me = await platform();
  const clinicId = z.string().uuid().parse(form.get("clinicId"));
  const vista = form.get("vista") === "simples" ? "simples" : "detalhada";
  (await cookies()).set(VISTA_COOKIE, vista, { path: "/", maxAge: 31536000, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  await db()`update platform_admins set acting_clinic_id = ${clinicId} where auth_user_id = ${me.authUserId}`;
  await db()`insert into audit_events (clinic_id, actor_label, action, entity, entity_id) values (${clinicId}, ${`Plataforma (${me.email})`}, 'platform.enter', 'clinics', ${clinicId})`;
  redirect("/");
}

/** Recria o movimento do dia (conversas, tarefas, consultas de hoje) numa clínica de demonstração. */
export async function demoActivityAction(form: FormData): Promise<void> {
  await platform();
  const clinicId = z.string().uuid().parse(form.get("clinicId"));
  await seedDemoActivity(db(), clinicId);
  revalidatePath("/admin");
}

export async function leaveClinicAction(): Promise<void> {
  const me = await platform();
  await db()`update platform_admins set acting_clinic_id = null where auth_user_id = ${me.authUserId}`;
  redirect("/admin");
}

export async function clinicStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  await platform();
  const clinicId = z.string().uuid().parse(form.get("clinicId"));
  const status = z.enum(["trial", "active", "suspended"]).parse(form.get("status"));
  await db()`update clinics set status = ${status} where id = ${clinicId}`;
  revalidatePath("/admin");
  return { ok: true };
}

const newClinic = z.object({
  clinicName: z.string().trim().min(2, "Informe o nome da clínica."),
  ownerName: z.string().trim().min(2, "Informe o nome do responsável."),
  ownerEmail: z.string().trim().toLowerCase().email("E-mail inválido."),
  ownerPassword: z.string().min(8, "Senha provisória com ao menos 8 caracteres."),
  chairs: z.coerce.number().int().min(1).max(30),
  demo: z.boolean(),
});

/** Cria a clínica de um cliente já com o usuário administrador dele. */
export async function createClientClinicAction(_: ActionState, form: FormData): Promise<ActionState> {
  await platform();
  const p = newClinic.safeParse({
    clinicName: form.get("clinicName"), ownerName: form.get("ownerName"), ownerEmail: form.get("ownerEmail"),
    ownerPassword: form.get("ownerPassword"), chairs: form.get("chairs"), demo: form.get("demo") === "on",
  });
  if (!p.success) return { error: p.error.issues[0]?.message };
  const user = await adminCreateUser(p.data.ownerEmail, p.data.ownerPassword);
  if (!user.ok) return { error: user.error };
  const owner = { authUserId: user.userId, email: p.data.ownerEmail, name: p.data.ownerName };
  if (p.data.demo) await seedDemoClinic(db(), owner, p.data.clinicName);
  else await createClinic(db(), { clinicName: p.data.clinicName, owner, chairs: p.data.chairs, professionals: [] });
  revalidatePath("/admin");
  return { ok: true, message: "Clínica criada. Envie o e-mail e a senha provisória ao cliente." };
}
