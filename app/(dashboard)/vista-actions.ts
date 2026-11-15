"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getCtx } from "@/auth/session";
import { VISTA_COOKIE, type Vista } from "@/lib/vista";

/** Troca a visualização (simples/detalhada) deste navegador. É só preferência de exibição: não muda permissões. */
export async function setVistaAction(vista: Vista): Promise<void> {
  if (!(await getCtx())) return;
  (await cookies()).set(VISTA_COOKIE, vista === "detalhada" ? "detalhada" : "simples", {
    path: "/", maxAge: 31536000, sameSite: "lax", secure: process.env.NODE_ENV === "production",
  });
  revalidatePath("/", "layout");
}
