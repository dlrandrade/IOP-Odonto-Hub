import { db } from "@/db/client";
import { parseEvolutionWebhook } from "@/integrations/whatsapp/evolution";
import { applyStatusUpdate, ingestInbound } from "./conversations";

export type EvolutionOutcome = { status: 200 | 404; accepted: number; clinicId: string | null };

/**
 * Entrada da Evolution API. A Evolution não assina os eventos, então a autenticação é o token secreto
 * na URL (64 caracteres, único por clínica). Mesma idempotência do webhook oficial.
 */
export async function handleEvolutionWebhook(token: string, payload: unknown): Promise<EvolutionOutcome> {
  if (!/^[0-9a-f]{64}$/.test(token)) return { status: 404, accepted: 0, clinicId: null };
  const sql = db();
  const [row] = await sql<{ clinic_id: string; wa_provider: string }[]>`
    select clinic_id, wa_provider from clinic_integrations where evo_webhook_token = ${token}`;
  if (!row || row.wa_provider !== "evolution") return { status: 404, accepted: 0, clinicId: null };
  const clinicId = row.clinic_id;
  const ev = parseEvolutionWebhook(payload);
  let accepted = 0;

  if (ev.kind === "messages") {
    await sql`update clinic_integrations set wa_last_inbound_at = now() where clinic_id = ${clinicId}`;
    for (const m of ev.messages) {
      const key = `evo:${clinicId}:${m.waMessageId}`;
      const inserted = await sql`
        insert into webhook_events (clinic_id, provider, provider_event_id, payload)
        values (${clinicId}, 'evolution', ${key}, ${sql.json({ type: m.type, rawType: m.rawType } as never)})
        on conflict (provider_event_id) do nothing returning id`;
      if (inserted.length === 0) continue;
      try {
        const r = await ingestInbound(sql, clinicId, "whatsapp", m);
        if (!r.duplicate) accepted++;
        await sql`update webhook_events set processed_at = now() where provider_event_id = ${key}`;
      } catch (e) {
        await sql`delete from webhook_events where provider_event_id = ${key}`;
        throw e;
      }
    }
  } else if (ev.kind === "statuses") {
    for (const s of ev.statuses) await applyStatusUpdate(sql, clinicId, s.waMessageId, s.status, s.error);
  } else if (ev.kind === "connection") {
    if (ev.state === "open") await sql`update clinic_integrations set evo_connected_at = now(), wa_last_error = null where clinic_id = ${clinicId}`;
    if (ev.state === "close") await sql`update clinic_integrations set evo_connected_at = null, wa_last_error = 'Celular desconectado da Evolution API' where clinic_id = ${clinicId}`;
  }
  return { status: 200, accepted, clinicId };
}
