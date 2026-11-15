"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionCtx, q } from "@/auth/session";

/** Marca a tarefa como feita (usado pelo botão "Enviar no WhatsApp", logo depois de abrir o WhatsApp). */
export async function markTaskDoneAction(taskId: string): Promise<void> {
  const ctx = await actionCtx("conversations.reply");
  const id = z.string().uuid().parse(taskId);
  await q(ctx, (tx) => tx`update tasks set status = 'done' where id = ${id}`);
  revalidatePath("/");
  revalidatePath("/automacoes");
  revalidatePath("/indicadores");
}
