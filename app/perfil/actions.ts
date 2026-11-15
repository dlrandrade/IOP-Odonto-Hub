"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminSetPassword, signIn } from "@/auth/provider";
import { getIdentity } from "@/auth/session";
import type { ActionState } from "@/components/client";
import { asUser } from "@/db/client";

const AVATAR = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

/** Cada pessoa altera o próprio nome e foto (a função do banco identifica o usuário pela sessão). */
export async function saveProfileAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await getIdentity();
  if (!me) return { error: "Sua sessão expirou. Entre de novo." };
  const parsed = z.string().trim().min(2, "Informe seu nome.").max(80, "Nome muito longo.").safeParse(form.get("name"));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Nome inválido." };
  const avatar = String(form.get("avatar") ?? "");
  const keep = avatar === "keep";
  if (!keep && avatar !== "" && (!AVATAR.test(avatar) || avatar.length >= 200_000)) return { error: "Foto inválida ou grande demais. Use JPG ou PNG." };
  await asUser(me.authUserId, (tx) => tx`select app.update_my_profile(${parsed.data}, ${keep || avatar === "" ? null : avatar}, ${keep})`);
  revalidatePath("/", "layout");
  return { ok: true, message: "Perfil atualizado." };
}

export async function changePasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await getIdentity();
  if (!me) return { error: "Sua sessão expirou. Entre de novo." };
  const current = String(form.get("current") ?? "");
  const next = String(form.get("next") ?? "");
  if (next.length < 8) return { error: "A nova senha precisa ter ao menos 8 caracteres." };
  if (next !== String(form.get("confirm") ?? "")) return { error: "A confirmação não confere com a nova senha." };
  const check = await signIn(me.email, current);
  if (!check.ok) return { error: "Senha atual incorreta." };
  if (!(await adminSetPassword(me.authUserId, next))) return { error: "Não foi possível trocar a senha agora. Tente de novo." };
  return { ok: true, message: "Senha alterada. Use a nova no próximo acesso." };
}
