import { db } from "@/db/client";
import { decryptField } from "@/lib/crypto";
import { parseWacliWebhook, verifyWacliSignature } from "@/integrations/whatsapp/wacli";
import { applyStatusUpdate, ingestInbound } from "./conversations";

export type WacliOutcome = { status: 200 | 401 | 404; accepted: number; clinicId: string | null };

/**
 * Entrada do gateway wacli. O token da URL identifica a clínica; a assinatura HMAC do corpo bruto
 * (X-Wacli-Signature, segredo próprio da clínica) prova que veio do gateway. Mesma idempotência dos outros canais.
 */
export async function handleWacliWebhook(token: string, rawBody: string, signature: string | null): Promise<WacliOutcome> {
  if (!/^[0-9a-f]{64}$/.test(token)) return { status: 404, accepted: 0, clinicId: null };
  const sql = db();
  const [row] = await sql<{ clinic_id: string; wa_provider: string; wacli_webhook_secret_enc: string | null }[]>`
    select clinic_id, wa_provider, wacli_webhook_secret_enc from clinic_integrations where wacli_webhook_token = ${token}`;
  if (!row || row.wa_provider !== "wacli") return { status: 404, accepted: 0, clinicId: null };
  const secret = decryptField(row.wacli_webhook_secret_enc);
  if (!secret || !verifyWacliSignature(secret, rawBody, signature)) return { status: 401, accepted: 0, clinicId: null };
  const clinicId = row.clinic_id;
  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { return { status: 200, accepted: 0, clinicId }; }
  const ev = parseWacliWebhook(payload);
  if (ev.kind === "statuses") {
    for (const s of ev.statuses) await applyStatusUpdate(sql, clinicId, s.waMessageId, s.status, s.error);
    return { status: 200, accepted: 0, clinicId };
  }
  if (ev.kind !== "message") return { status: 200, accepted: 0, clinicId };
  const m = ev.message;
  await sql`update clinic_integrations set wa_last_inbound_at = now(), wacli_connected_at = coalesce(wacli_connected_at, now()) where clinic_id = ${clinicId}`;
  const key = `wacli:${clinicId}:${m.waMessageId}`;
  const inserted = await sql`
    insert into webhook_events (clinic_id, provider, provider_event_id, payload)
    values (${clinicId}, 'wacli', ${key}, ${sql.json({ type: m.type, rawType: m.rawType } as never)})
    on conflict (provider_event_id) do nothing returning id`;
  if (inserted.length === 0) return { status: 200, accepted: 0, clinicId };
  try {
    const r = await ingestInbound(sql, clinicId, "whatsapp", m);
    await sql`update webhook_events set processed_at = now() where provider_event_id = ${key}`;
    return { status: 200, accepted: r.duplicate ? 0 : 1, clinicId };
  } catch (e) {
    await sql`delete from webhook_events where provider_event_id = ${key}`;
    throw e;
  }
}
