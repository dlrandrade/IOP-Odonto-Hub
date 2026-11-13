import { createHash } from "node:crypto";
import { db } from "@/db/client";
import { decryptField, verifyMetaSignature } from "@/lib/crypto";
import { env } from "@/lib/env";
import { parseCloudWebhook } from "@/integrations/whatsapp/cloud";
import { applyStatusUpdate, ingestInbound } from "./conversations";

export type WebhookOutcome = { status: 200 | 401; accepted: number; duplicates: number; clinicIds: string[] };

async function clinicForPhoneId(phoneNumberId: string | null): Promise<{ clinicId: string; appSecret: string | null } | null> {
  const sql = db();
  if (phoneNumberId) {
    const [row] = await sql<{ clinic_id: string; wa_app_secret_enc: string | null }[]>`
      select clinic_id, wa_app_secret_enc from clinic_integrations where wa_phone_number_id = ${phoneNumberId}`;
    if (row) return { clinicId: row.clinic_id, appSecret: decryptField(row.wa_app_secret_enc) ?? env.wa.appSecret ?? null };
  }
  // Instalação de clínica única configurada só por variáveis de ambiente.
  if (env.wa.phoneNumberId && (!phoneNumberId || phoneNumberId === env.wa.phoneNumberId)) {
    const [only] = await sql<{ id: string }[]>`select id from clinics order by created_at limit 1`;
    if (only) return { clinicId: only.id, appSecret: env.wa.appSecret ?? null };
  }
  return null;
}

/**
 * Passo 1 do pipeline: valida a assinatura, registra o evento (idempotente) e normaliza.
 * Sempre responde rápido; o processamento da IA acontece em job com debounce.
 */
export async function handleWhatsAppWebhook(rawBody: string, signature: string | null): Promise<WebhookOutcome> {
  const sql = db();
  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { return { status: 200, accepted: 0, duplicates: 0, clinicIds: [] }; }
  const groups = parseCloudWebhook(payload);
  let accepted = 0;
  let duplicates = 0;
  const clinicIds = new Set<string>();
  let anyVerified = false;

  for (const g of groups) {
    const target = await clinicForPhoneId(g.phoneNumberId);
    if (!target?.appSecret || !verifyMetaSignature(rawBody, signature, target.appSecret)) continue;
    anyVerified = true;
    clinicIds.add(target.clinicId);
    await sql`update clinic_integrations set wa_last_inbound_at = now() where clinic_id = ${target.clinicId}`;

    for (const m of g.messages) {
      const inserted = await sql`
        insert into webhook_events (clinic_id, provider_event_id, payload)
        values (${target.clinicId}, ${`msg:${m.waMessageId}`}, ${sql.json({ type: m.type, rawType: m.rawType } as never)})
        on conflict (provider_event_id) do nothing returning id`;
      if (inserted.length === 0) { duplicates++; continue; }
      try {
        const r = await ingestInbound(sql, target.clinicId, "whatsapp", m);
        if (r.duplicate) duplicates++; else accepted++;
        await sql`update webhook_events set processed_at = now() where provider_event_id = ${`msg:${m.waMessageId}`}`;
      } catch (e) {
        // Libera o evento para a reentrega do provedor tentar de novo.
        await sql`delete from webhook_events where provider_event_id = ${`msg:${m.waMessageId}`}`;
        throw e;
      }
    }
    for (const s of g.statuses) {
      const key = `status:${s.waMessageId}:${s.status}`;
      const inserted = await sql`
        insert into webhook_events (clinic_id, provider_event_id, payload, processed_at)
        values (${target.clinicId}, ${key}, ${sql.json({ status: s.status } as never)}, now())
        on conflict (provider_event_id) do nothing returning id`;
      if (inserted.length) await applyStatusUpdate(sql, target.clinicId, s.waMessageId, s.status, s.error);
    }
  }
  if (groups.length > 0 && !anyVerified) return { status: 401, accepted: 0, duplicates: 0, clinicIds: [] };
  return { status: 200, accepted, duplicates, clinicIds: [...clinicIds] };
}

/** Verificação GET da Meta (hub.challenge). */
export async function verifyWebhookToken(token: string | null): Promise<boolean> {
  if (!token) return false;
  if (env.wa.verifyToken && token === env.wa.verifyToken) return true;
  const [row] = await db()`select 1 from clinic_integrations where wa_verify_token = ${token}`;
  return !!row;
}

export function simulatorMessageId(): string {
  return `sim.in.${createHash("sha1").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 20)}`;
}
