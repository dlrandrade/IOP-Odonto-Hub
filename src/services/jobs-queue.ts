import type { Sql } from "@/db/client";

export type JobType =
  | "process_conversation" | "transcribe" | "fetch_media" | "send_message"
  | "followup_1" | "followup_2" | "reminder" | "confirmation_request" | "automation";

export type EnqueueInput = {
  clinicId: string;
  type: JobType;
  runAt: Date;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  conversationId?: string | null;
  appointmentId?: string | null;
};

/** Enfileira um job. A chave de idempotência garante que o mesmo gatilho não agenda duas vezes. */
export async function enqueueJob(sql: Sql, j: EnqueueInput): Promise<void> {
  await sql`
    insert into scheduled_jobs (clinic_id, type, run_at, idempotency_key, payload, conversation_id, appointment_id)
    values (${j.clinicId}, ${j.type}, ${j.runAt}, ${j.idempotencyKey}, ${sql.json((j.payload ?? {}) as never)}, ${j.conversationId ?? null}, ${j.appointmentId ?? null})
    on conflict (idempotency_key) do nothing`;
}

/** Debounce: empurra o job pendente da conversa em vez de criar outro (agrupa mensagens consecutivas). */
export async function debounceConversationJob(sql: Sql, clinicId: string, conversationId: string, runAt: Date): Promise<void> {
  const updated = await sql`
    update scheduled_jobs set run_at = ${runAt}
    where clinic_id = ${clinicId} and conversation_id = ${conversationId} and type = 'process_conversation' and status = 'pending'
    returning id`;
  if (updated.length === 0) {
    await enqueueJob(sql, {
      clinicId, type: "process_conversation", runAt, conversationId,
      idempotencyKey: `process:${conversationId}:${runAt.getTime()}`,
    });
  }
}

export async function cancelJobs(sql: Sql, clinicId: string, where: { conversationId?: string; appointmentId?: string; types?: JobType[] }): Promise<number> {
  const rows = await sql`
    update scheduled_jobs set status = 'cancelled'
    where clinic_id = ${clinicId} and status = 'pending'
      ${where.conversationId ? sql`and conversation_id = ${where.conversationId}` : sql``}
      ${where.appointmentId ? sql`and appointment_id = ${where.appointmentId}` : sql``}
      ${where.types ? sql`and type in ${sql(where.types)}` : sql``}
    returning id`;
  return rows.length;
}
