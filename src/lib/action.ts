import "server-only";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { actionCtx, type Ctx } from "@/auth/session";
import { ForbiddenError, type Permission } from "@/domain/permissions";
import type { ActionState } from "@/components/client";

/** Invólucro das server actions: sessão + permissão no servidor, erros amigáveis, revalidação. */
export async function act(permission: Permission, paths: string | string[], fn: (ctx: Ctx) => Promise<ActionState | void>): Promise<ActionState> {
  try {
    const ctx = await actionCtx(permission);
    const result = await fn(ctx);
    for (const p of Array.isArray(paths) ? paths : [paths]) revalidatePath(p);
    return result ?? { ok: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "Você não tem permissão para esta ação." };
    if (e instanceof ZodError) return { error: e.issues[0]?.message ?? "Dados inválidos." };
    if (e instanceof UserError) return { error: e.message };
    // Logs sem conteúdo de paciente: só o tipo do erro e o código do banco. O detalhe aparece apenas em desenvolvimento.
    const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
    console.error("[action]", e instanceof Error ? e.name : "erro", code, process.env.NODE_ENV === "development" && e instanceof Error ? e.message : "");
    return { error: "Não foi possível concluir. Tente novamente." };
  }
}

export class UserError extends Error {}

export const str = (f: FormData, k: string): string => String(f.get(k) ?? "").trim();
export const optStr = (f: FormData, k: string): string | null => str(f, k) || null;
export const bool = (f: FormData, k: string): boolean => f.get(k) === "on" || f.get(k) === "true";
export const actorOf = (ctx: Ctx) => ({ clinicId: ctx.clinicId, userId: ctx.userId, label: ctx.name });
