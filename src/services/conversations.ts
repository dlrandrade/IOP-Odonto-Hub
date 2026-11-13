import { inTx, pgErrorCode, PG_UNIQUE_VIOLATION, type Sql } from "@/db/client";
import { isOptOut } from "@/domain/alerts";
import { parseSettings } from "@/domain/settings";
import { reopenState, type ConversationState } from "@/domain/states";
import { addMinutes, isWithinBusinessHours, type BusinessHours } from "@/lib/datetime";
import { providerFor, ProviderError, type InboundMessage } from "@/integrations/whatsapp";
import { cancelJobs, debounceConversationJob, enqueueJob } from "./jobs-queue";
import { setAppointmentStatus } from "./booking";

export type ConversationRow = {
  id: string; clinic_id: string; contact_id: string; channel: string; state: ConversationState;
  assigned_to: string | null; row_version: number; window_expires_at: Date | null; last_inbound_at: Date | null;
  summary: string | null; pending_notes: string | null; handoff_reason: string | null; handoff_priority: string | null;
  verified_patient_ids: string[]; awaiting_confirmation_appointment_id: string | null; after_hours_notified_at: Date | null;
};

const WINDOW_HOURS = 24;

export type IngestResult = { duplicate: boolean; conversationId: string | null; messageId: string | null };

/**
 * Passo 2 do pipeline: contato → conversa → mensagem, idempotente por wa_message_id.
 * Reentrega do mesmo evento não cria nada novo nem agenda nova resposta.
 */
export async function ingestInbound(sql: Sql, clinicId: string, channel: "whatsapp" | "simulator", m: InboundMessage, now: Date = new Date()): Promise<IngestResult> {
  const outcome = await inTx(sql, async (tx) => {
    const [contact] = await tx<{ id: string; opted_out_at: Date | null }[]>`
      insert into contacts (clinic_id, phone_e164, wa_profile_name, is_test, source)
      values (${clinicId}, ${m.from}, ${m.profileName}, ${channel === "simulator"}, ${channel})
      on conflict (clinic_id, phone_e164) do update set wa_profile_name = coalesce(excluded.wa_profile_name, contacts.wa_profile_name)
      returning id, opted_out_at`;
    if (!contact) throw new Error("Falha ao registrar contato");

    let [conv] = await tx<ConversationRow[]>`
      select * from conversations where contact_id = ${contact.id} and channel = ${channel} and state <> 'closed' for update`;
    if (!conv) {
      const [last] = await tx<{ pending_notes: string | null }[]>`
        select pending_notes from conversations where contact_id = ${contact.id} and channel = ${channel} order by created_at desc limit 1`;
      [conv] = await tx<ConversationRow[]>`
        insert into conversations (clinic_id, contact_id, channel, state, first_inbound_at, pending_notes)
        values (${clinicId}, ${contact.id}, ${channel}, ${reopenState(!!last?.pending_notes)}, ${now}, ${last?.pending_notes ?? null})
        returning *`;
    }
    if (!conv) throw new Error("Falha ao abrir conversa");

    const isAudio = m.type === "audio";
    const body = m.type === "unsupported" ? `[Tipo de mensagem não suportado: ${m.rawType}]` : m.text;
    let messageId: string;
    try {
      const [msg] = await tx.savepoint((sp) => sp<{ id: string }[]>`
        insert into messages (clinic_id, conversation_id, direction, sender_type, type, body, wa_media_id, media_mime, wa_message_id, delivery_status, transcript_status, created_at)
        values (${clinicId}, ${conv.id}, 'inbound', 'patient', ${m.type}, ${body}, ${m.mediaId}, ${m.mediaMime}, ${m.waMessageId}, 'received', ${isAudio ? "pending" : null}, ${now})
        returning id`);
      if (!msg) throw new Error("Falha ao gravar mensagem");
      messageId = msg.id;
    } catch (e) {
      if (pgErrorCode(e) === PG_UNIQUE_VIOLATION) return { duplicate: true, conv, messageId: null, contact };
      throw e;
    }

    await tx`
      update conversations set
        last_inbound_at = ${now}, window_expires_at = ${addMinutes(now, WINDOW_HOURS * 60)},
        last_message_at = ${now}, last_message_direction = 'inbound',
        last_message_preview = ${preview(m.type, body)},
        first_inbound_at = coalesce(first_inbound_at, ${now}),
        unread_count = unread_count + 1
      where id = ${conv.id}`;
    // Resposta do paciente interrompe a sequência de follow-ups.
    await cancelJobs(tx, clinicId, { conversationId: conv.id, types: ["followup_1", "followup_2"] });
    return { duplicate: false, conv, messageId, contact };
  });

  if (outcome.duplicate || !outcome.messageId) return { duplicate: true, conversationId: outcome.conv.id, messageId: null };
  await afterInbound(sql, clinicId, outcome.conv, outcome.messageId, m, now);
  return { duplicate: false, conversationId: outcome.conv.id, messageId: outcome.messageId };
}

function preview(type: string, body: string | null): string {
  if (type === "audio") return "🎤 Áudio";
  if (type === "image") return body ? `📷 ${body.slice(0, 80)}` : "📷 Imagem";
  return (body ?? "").slice(0, 120);
}

/** Decide o que acontece depois de gravar a mensagem: opt-out, confirmação 1/2, transcrição, IA ou aviso de fora do expediente. */
async function afterInbound(sql: Sql, clinicId: string, conv: ConversationRow, messageId: string, m: InboundMessage, now: Date): Promise<void> {
  const [clinic] = await sql<{ ai_enabled: boolean; ai_kill_switch: boolean; settings: unknown; timezone: string; business_hours: BusinessHours; after_hours_message: string }[]>`
    select ai_enabled, ai_kill_switch, settings, timezone, business_hours, after_hours_message from clinics where id = ${clinicId}`;
  if (!clinic) return;
  const settings = parseSettings(clinic.settings);
  const text = (m.text ?? "").trim();

  if (m.type === "text" && isOptOut(text)) {
    await sql`update contacts set opted_out_at = ${now}, marketing_allowed = false, service_messages_allowed = false where id = ${conv.contact_id}`;
    await cancelJobs(sql, clinicId, { conversationId: conv.id });
    await sendOutbound(sql, { clinicId, conversationId: conv.id, senderType: "system", body: "Tudo certo: você não receberá mais mensagens automáticas. Se precisar, é só escrever para nós." });
    return;
  }

  if (m.type === "unsupported") {
    await sendOutbound(sql, { clinicId, conversationId: conv.id, senderType: "system", body: "Ainda não consigo abrir esse tipo de mensagem por aqui. Pode enviar em texto, áudio ou foto?" });
    return;
  }

  // Resposta ao pedido de confirmação ("1 confirma, 2 remarca").
  if (conv.awaiting_confirmation_appointment_id && m.type === "text" && (text === "1" || text === "2")) {
    const appointmentId = conv.awaiting_confirmation_appointment_id;
    await sql`update conversations set awaiting_confirmation_appointment_id = null where id = ${conv.id}`;
    if (text === "1") {
      const r = await setAppointmentStatus(sql, clinicId, appointmentId, "confirmed", "system");
      await sendOutbound(sql, { clinicId, conversationId: conv.id, senderType: "system", body: r.ok ? "Consulta confirmada. Até lá!" : "Não consegui confirmar automaticamente; nossa equipe vai verificar e retornar." });
      if (!r.ok) await requestHuman(sql, clinicId, conv.id, "Confirmação de consulta não pôde ser registrada", "normal");
      return;
    }
    await sql`update conversations set pending_notes = 'Paciente pediu para remarcar a consulta após o lembrete.' where id = ${conv.id}`;
  }

  if (m.type === "audio") {
    await enqueueJob(sql, { clinicId, type: "transcribe", runAt: now, conversationId: conv.id, idempotencyKey: `transcribe:${messageId}`, payload: { messageId } });
    return; // o job de transcrição dispara a IA quando terminar
  }

  if (m.type === "image" && m.mediaId) {
    await enqueueJob(sql, { clinicId, type: "fetch_media", runAt: now, conversationId: conv.id, idempotencyKey: `media:${messageId}`, payload: { messageId } });
  }

  const aiOn = clinic.ai_enabled && !clinic.ai_kill_switch;
  if (conv.state === "ai_active" && aiOn) {
    await debounceConversationJob(sql, clinicId, conv.id, addMinutes(now, settings.debounceSeconds / 60));
    return;
  }

  // Sem IA atendendo e fora do expediente: avisa uma vez (sem promessa de prazo).
  const quiet = !conv.after_hours_notified_at || now.getTime() - conv.after_hours_notified_at.getTime() > 12 * 3600_000;
  if (conv.state !== "human_active" && quiet && !isWithinBusinessHours(now, clinic.timezone, clinic.business_hours)) {
    await sql`update conversations set after_hours_notified_at = ${now} where id = ${conv.id}`;
    await sendOutbound(sql, { clinicId, conversationId: conv.id, senderType: "system", body: clinic.after_hours_message });
  }
}

export type OutboundInput = {
  clinicId: string;
  conversationId: string;
  senderType: "ai" | "human" | "system";
  senderUserId?: string | null;
  body: string;
  aiRunId?: string | null;
  /** Para respostas da IA: só envia se a conversa ainda estiver nesse estado/versão. */
  expect?: { state: ConversationState; rowVersion: number };
  template?: { name: string; language: string; params: string[] };
  now?: Date;
};

export type OutboundResult =
  | { status: "sent" | "queued"; messageId: string }
  | { status: "discarded"; reason: "handoff" }
  | { status: "blocked"; reason: "window_closed" | "no_provider" | "opted_out" };

/**
 * Passos 7–9 do pipeline: reconferir estado, respeitar a janela de 24 h, enviar e registrar.
 * Mensagem livre fora da janela nunca sai; só template aprovado.
 */
export async function sendOutbound(sql: Sql, o: OutboundInput): Promise<OutboundResult> {
  const now = o.now ?? new Date();
  const prepared = await inTx(sql, async (tx) => {
    const [conv] = await tx<(ConversationRow & { phone_e164: string })[]>`
      select c.*, ct.phone_e164 from conversations c join contacts ct on ct.id = c.contact_id
      where c.id = ${o.conversationId} and c.clinic_id = ${o.clinicId} for update of c`;
    if (!conv) throw new Error("Conversa não encontrada");
    if (o.expect && (conv.state !== o.expect.state || conv.row_version !== o.expect.rowVersion)) {
      return { kind: "discarded" as const };
    }
    const inWindow = !!conv.window_expires_at && now < conv.window_expires_at;
    if (!o.template && !inWindow && conv.channel === "whatsapp") return { kind: "window" as const };
    const [msg] = await tx<{ id: string }[]>`
      insert into messages (clinic_id, conversation_id, direction, sender_type, sender_user_id, type, body, delivery_status, ai_run_id, created_at)
      values (${o.clinicId}, ${conv.id}, 'outbound', ${o.senderType}, ${o.senderUserId ?? null}, ${o.template ? "template" : "text"}, ${o.body}, 'queued', ${o.aiRunId ?? null}, ${now})
      returning id`;
    if (!msg) throw new Error("Falha ao gravar mensagem");
    await tx`
      update conversations set
        last_message_at = ${now}, last_message_direction = 'outbound', last_message_preview = ${o.body.slice(0, 120)},
        unread_count = case when ${o.senderType} = 'human' then 0 else unread_count end,
        first_response_at = coalesce(first_response_at, case when ${o.senderType} in ('ai','human') then ${now}::timestamptz end),
        first_response_by = coalesce(first_response_by, case when ${o.senderType} in ('ai','human') then ${o.senderType} end)
      where id = ${conv.id}`;
    return { kind: "ok" as const, messageId: msg.id, to: conv.phone_e164, channel: conv.channel };
  });

  if (prepared.kind === "discarded") return { status: "discarded", reason: "handoff" };
  if (prepared.kind === "window") return { status: "blocked", reason: "window_closed" };
  const delivered = await deliverMessage(sql, o.clinicId, prepared.messageId, { to: prepared.to, channel: prepared.channel, body: o.body, template: o.template }, 0);
  return { status: delivered ? "sent" : "queued", messageId: prepared.messageId };
}

type Delivery = { to: string; channel: string; body: string; template?: OutboundInput["template"] };

/** Envia pelo provedor. Falha temporária → fila com recuo exponencial (máx. 5). Nunca reenvia o que já foi aceito. */
export async function deliverMessage(sql: Sql, clinicId: string, messageId: string, d: Delivery, attempt: number): Promise<boolean> {
  const [msg] = await sql<{ wa_message_id: string | null; delivery_status: string }[]>`
    select wa_message_id, delivery_status from messages where id = ${messageId} and clinic_id = ${clinicId}`;
  if (!msg || msg.wa_message_id) return true;
  const provider = await providerFor(sql, clinicId, d.channel);
  if (!provider) {
    await sql`update messages set delivery_status = 'failed', error = 'WhatsApp não conectado' where id = ${messageId}`;
    return false;
  }
  try {
    const res = d.template
      ? await provider.sendTemplate(d.to, d.template.name, d.template.language, d.template.params)
      : await provider.sendText(d.to, d.body);
    await sql`update messages set wa_message_id = ${res.waMessageId}, delivery_status = 'sent', error = null where id = ${messageId}`;
    return true;
  } catch (e) {
    const retryable = e instanceof ProviderError ? e.retryable : true;
    const detail = e instanceof ProviderError ? e.message : "Falha de envio";
    if (retryable && attempt < 5) {
      await sql`update messages set error = ${detail} where id = ${messageId}`;
      await enqueueJob(sql, {
        clinicId, type: "send_message", runAt: addMinutes(new Date(), 2 ** attempt / 2),
        idempotencyKey: `send:${messageId}:${attempt + 1}`, payload: { messageId, attempt: attempt + 1, delivery: d },
      });
    } else {
      await sql`update messages set delivery_status = 'failed', error = ${detail} where id = ${messageId}`;
      await sql`
        insert into tasks (clinic_id, title, detail, kind, conversation_id)
        select ${clinicId}, 'Mensagem não entregue', ${detail}, 'delivery_failure', conversation_id from messages where id = ${messageId}`;
    }
    return false;
  }
}

export async function applyStatusUpdate(sql: Sql, clinicId: string, waMessageId: string, status: string, error: string | null): Promise<void> {
  const rank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };
  const [msg] = await sql<{ id: string; delivery_status: string }[]>`
    select id, delivery_status from messages where clinic_id = ${clinicId} and wa_message_id = ${waMessageId}`;
  if (!msg) return;
  if (status === "failed") {
    await sql`update messages set delivery_status = 'failed', error = ${error} where id = ${msg.id}`;
  } else if ((rank[status] ?? 0) > (rank[msg.delivery_status] ?? 0)) {
    await sql`update messages set delivery_status = ${status} where id = ${msg.id}`;
  }
}

// ───────────── Transições de estado (PRD seção 5) — sempre incrementam row_version ─────────────

async function transition(sql: Sql, clinicId: string, conversationId: string, patch: (tx: Sql) => Promise<unknown>, note: string, userId: string | null): Promise<void> {
  await inTx(sql, async (tx) => {
    await patch(tx);
    await tx`
      insert into messages (clinic_id, conversation_id, direction, sender_type, sender_user_id, type, body, delivery_status)
      values (${clinicId}, ${conversationId}, 'internal', 'system', ${userId}, 'note', ${note}, 'received')`;
  });
}

/** Assumir: qualquer estado → human_active. Cancela respostas da IA ainda na fila. */
export async function takeOver(sql: Sql, clinicId: string, conversationId: string, user: { id: string | null; name: string }): Promise<void> {
  await transition(sql, clinicId, conversationId, async (tx) => {
    await tx`
      update conversations set state = 'human_active', assigned_to = ${user.id}, row_version = row_version + 1, unread_count = 0, closed_at = null
      where id = ${conversationId} and clinic_id = ${clinicId}`;
    await cancelJobs(tx, clinicId, { conversationId, types: ["process_conversation", "followup_1", "followup_2"] });
  }, `${user.name} assumiu a conversa.`, user.id);
}

/** Devolver à IA com resumo e pendências, para ela não repetir perguntas. */
export async function handBack(sql: Sql, clinicId: string, conversationId: string, user: { id: string | null; name: string }, pending: string | null): Promise<void> {
  await transition(sql, clinicId, conversationId, (tx) => tx`
    update conversations set state = 'ai_active', assigned_to = null, row_version = row_version + 1,
      pending_notes = ${pending?.trim() || null}, handoff_reason = null, handoff_priority = null
    where id = ${conversationId} and clinic_id = ${clinicId} and state in ('human_active','awaiting_human')`,
  `${user.name} devolveu a conversa à IA.${pending?.trim() ? ` Pendências: ${pending.trim()}` : ""}`, user.id);
}

export async function transferConversation(sql: Sql, clinicId: string, conversationId: string, user: { id: string | null; name: string }, to: { id: string; name: string }): Promise<void> {
  await transition(sql, clinicId, conversationId, (tx) => tx`
    update conversations set state = 'human_active', assigned_to = ${to.id}, row_version = row_version + 1
    where id = ${conversationId} and clinic_id = ${clinicId}`,
  `${user.name} transferiu a conversa para ${to.name}.`, user.id);
}

export async function closeConversation(sql: Sql, clinicId: string, conversationId: string, user: { id: string | null; name: string }): Promise<void> {
  await transition(sql, clinicId, conversationId, async (tx) => {
    await tx`
      update conversations set state = 'closed', closed_at = now(), row_version = row_version + 1, unread_count = 0,
        handoff_reason = null, handoff_priority = null
      where id = ${conversationId} and clinic_id = ${clinicId}`;
    await cancelJobs(tx, clinicId, { conversationId, types: ["process_conversation", "followup_1", "followup_2"] });
  }, `${user.name} encerrou a conversa.`, user.id);
}

/** ai_active → awaiting_human. Devolve a nova versão para a IA poder enviar a mensagem de despedida. */
export async function requestHuman(sql: Sql, clinicId: string, conversationId: string, reason: string, priority: "normal" | "urgente"): Promise<number | null> {
  return inTx(sql, async (tx) => {
    const [row] = await tx<{ row_version: number }[]>`
      update conversations set state = 'awaiting_human', row_version = row_version + 1, handoff_reason = ${reason}, handoff_priority = ${priority}
      where id = ${conversationId} and clinic_id = ${clinicId} and state in ('ai_active','awaiting_human')
      returning row_version`;
    if (!row) return null;
    await tx`
      insert into messages (clinic_id, conversation_id, direction, sender_type, type, body, delivery_status)
      values (${clinicId}, ${conversationId}, 'internal', 'system', 'note', ${`${priority === "urgente" ? "⚠ URGENTE — " : ""}Encaminhada para atendimento humano: ${reason}`}, 'received')`;
    await cancelJobs(tx, clinicId, { conversationId, types: ["followup_1", "followup_2"] });
    return row.row_version;
  });
}

export async function addNote(sql: Sql, clinicId: string, conversationId: string, userId: string | null, body: string): Promise<void> {
  await sql`
    insert into messages (clinic_id, conversation_id, direction, sender_type, sender_user_id, type, body, delivery_status)
    values (${clinicId}, ${conversationId}, 'internal', 'human', ${userId}, 'note', ${body}, 'received')`;
}

/** Follow-ups após resposta da IA: 3 h após a última mensagem e 20 h após a última mensagem do paciente (dentro da janela). */
export async function scheduleFollowups(sql: Sql, clinicId: string, conversationId: string, lastInboundAt: Date, now: Date): Promise<void> {
  const [clinic] = await sql<{ settings: unknown }[]>`select settings from clinics where id = ${clinicId}`;
  const s = parseSettings(clinic?.settings);
  if (!s.followupsEnabled) return;
  await cancelJobs(sql, clinicId, { conversationId, types: ["followup_1", "followup_2"] });
  const anchor = now.toISOString();
  await enqueueJob(sql, { clinicId, type: "followup_1", runAt: addMinutes(now, s.followup1Hours * 60), conversationId, idempotencyKey: `fu1:${conversationId}:${now.getTime()}`, payload: { scheduledAfter: anchor } });
  const second = addMinutes(lastInboundAt, s.followup2Hours * 60);
  if (second > addMinutes(now, s.followup1Hours * 60)) {
    await enqueueJob(sql, { clinicId, type: "followup_2", runAt: second, conversationId, idempotencyKey: `fu2:${conversationId}:${lastInboundAt.getTime()}`, payload: { scheduledAfter: anchor } });
  }
}
