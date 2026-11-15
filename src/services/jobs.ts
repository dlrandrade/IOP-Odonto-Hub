import { db, type Sql } from "@/db/client";
import { processConversation } from "@/agent/orchestrator";
import { backoffMinutes, decideAutomation } from "@/domain/automation";
import { parseSettings } from "@/domain/settings";
import type { ConversationState } from "@/domain/states";
import { addMinutes, clampToQuietHours, formatFull, localParts } from "@/lib/datetime";
import { LlmUnavailableError } from "@/integrations/llm";
import { extensionFor, mediaStore } from "@/integrations/storage";
import { transcriptionProvider } from "@/integrations/transcription";
import { enforcesWindow, providerFor } from "@/integrations/whatsapp";
import { deliverMessage, sendOutbound } from "./conversations";
import { debounceConversationJob, enqueueJob } from "./jobs-queue";
import { runRuleJob, sweepBirthdays } from "./automation-rules";
import { sweepGoogleReviews } from "./google-reviews";

type Job = {
  id: string; clinic_id: string; type: string; attempts: number; payload: Record<string, unknown>;
  conversation_id: string | null; appointment_id: string | null; run_at: Date;
};

const MAX_ATTEMPTS = 5;

/**
 * Worker: pega jobs vencidos com FOR UPDATE SKIP LOCKED (dois workers nunca pegam o mesmo job),
 * executa e registra o desfecho. Chamado pelo cron e logo após cada webhook.
 */
export async function runDueJobs(opts: { now?: Date; limit?: number; clinicId?: string } = {}): Promise<{ ran: number; failed: number }> {
  const sql = db();
  const now = opts.now ?? new Date();
  let ran = 0;
  let failed = 0;
  // Jobs presos em "running" (worker morreu) voltam para a fila.
  await sql`update scheduled_jobs set status = 'pending' where status = 'running' and locked_at < now() - interval '5 minutes'`;
  // Automações de aniversário viram jobs aqui (idempotentes: um envio por paciente por ano).
  if (!opts.clinicId) await sweepBirthdays(sql, now).catch(() => 0);
  // Avaliações do Google: uma foto por clínica por dia (só com GOOGLE_PLACES_API_KEY).
  if (!opts.clinicId) await sweepGoogleReviews(sql, now).catch(() => 0);
  for (let i = 0; i < (opts.limit ?? 25); i++) {
    const [job] = await sql<Job[]>`
      update scheduled_jobs set status = 'running', attempts = attempts + 1, locked_at = now()
      where id = (
        select id from scheduled_jobs
        where status = 'pending' and run_at <= ${now} ${opts.clinicId ? sql`and clinic_id = ${opts.clinicId}` : sql``}
        order by run_at for update skip locked limit 1)
      returning id, clinic_id, type, attempts, payload, conversation_id, appointment_id, run_at`;
    if (!job) break;
    ran++;
    try {
      const result = await execute(sql, job, now);
      await sql`update scheduled_jobs set status = 'done', result = ${result}, last_error = null where id = ${job.id} and status = 'running'`;
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 300) : "erro desconhecido";
      const retryable = !(e instanceof LlmUnavailableError) || e.retryable;
      if (retryable && job.attempts < MAX_ATTEMPTS) {
        await sql`update scheduled_jobs set status = 'pending', run_at = ${addMinutes(now, backoffMinutes(job.attempts))}, last_error = ${message} where id = ${job.id}`;
      } else {
        failed++;
        await sql`update scheduled_jobs set status = 'failed', last_error = ${message} where id = ${job.id}`;
        await onFinalFailure(sql, job, message);
      }
    }
  }
  return { ran, failed };
}

/** Fila de erro: vira tarefa visível para a equipe; a operação humana nunca fica bloqueada. */
async function onFinalFailure(sql: Sql, job: Job, message: string): Promise<void> {
  await sql`
    insert into tasks (clinic_id, title, detail, kind, conversation_id, appointment_id)
    values (${job.clinic_id}, ${`Automação falhou: ${job.type}`}, ${message}, 'job_failure', ${job.conversation_id}, ${job.appointment_id})`;
  if (job.type === "process_conversation" && job.conversation_id) {
    const { requestHuman } = await import("./conversations");
    await requestHuman(sql, job.clinic_id, job.conversation_id, "IA indisponível — atendimento humano necessário", "normal");
  }
}

async function execute(sql: Sql, job: Job, now: Date): Promise<string> {
  switch (job.type) {
    case "process_conversation":
      return job.conversation_id ? processConversation(sql, job.clinic_id, job.conversation_id, now) : "skipped";
    case "transcribe":
      return transcribe(sql, job, now);
    case "fetch_media":
      return (await ensureMedia(sql, job.clinic_id, String(job.payload.messageId ?? ""))) ? "stored" : "unavailable";
    case "send_message": {
      const p = job.payload as { messageId?: string; attempt?: number; delivery?: { to: string; channel: string; body: string } };
      if (!p.messageId || !p.delivery) return "skipped";
      return (await deliverMessage(sql, job.clinic_id, p.messageId, p.delivery, p.attempt ?? 1)) ? "sent" : "retry_scheduled";
    }
    case "followup_1":
    case "followup_2":
      return followup(sql, job, now);
    case "reminder":
    case "confirmation_request":
      return reminder(sql, job, now);
    case "automation":
      return runRuleJob(sql, job, now);
    default:
      return "unknown_type";
  }
}

/** Baixa a mídia do provedor para o Storage privado (uma vez) e devolve o conteúdo. O original é sempre preservado. */
export async function ensureMedia(sql: Sql, clinicId: string, messageId: string): Promise<{ data: Buffer; mime: string } | null> {
  const [msg] = await sql<{ id: string; conversation_id: string; wa_media_id: string | null; media_path: string | null; media_mime: string | null; channel: string }[]>`
    select m.id, m.conversation_id, m.wa_media_id, m.media_path, m.media_mime, c.channel
    from messages m join conversations c on c.id = m.conversation_id where m.id = ${messageId} and m.clinic_id = ${clinicId}`;
  if (!msg) return null;
  const store = mediaStore();
  if (msg.media_path) {
    const data = await store.get(msg.media_path);
    return data ? { data, mime: msg.media_mime ?? "application/octet-stream" } : null;
  }
  if (!msg.wa_media_id) return null;
  const provider = await providerFor(sql, clinicId, msg.channel);
  if (!provider) throw new Error("sem provedor");
  const media = await provider.downloadMedia(msg.wa_media_id);
  const key = `${clinicId}/${msg.conversation_id}/${msg.id}.${extensionFor(media.mime)}`;
  await store.put(key, media.data, media.mime);
  await sql`update messages set media_path = ${key}, media_mime = ${media.mime} where id = ${msg.id}`;
  return media;
}

async function transcribe(sql: Sql, job: Job, now: Date): Promise<string> {
  const messageId = String(job.payload.messageId ?? "");
  const [msg] = await sql<{ id: string; conversation_id: string }[]>`
    select id, conversation_id from messages where id = ${messageId} and clinic_id = ${job.clinic_id}`;
  if (!msg) return "skipped";
  let outcome = "done";
  try {
    const media = await ensureMedia(sql, job.clinic_id, msg.id);
    const audio = media?.data ?? null;
    const mime = media?.mime ?? "audio/ogg";
    const stt = transcriptionProvider();
    if (!audio || !stt) throw new Error("transcrição indisponível");
    const text = await stt.transcribe(audio, mime);
    if (!text) throw new Error("áudio ininteligível");
    await sql`update messages set transcript = ${text}, transcript_original = ${text}, transcript_status = 'done' where id = ${msg.id}`;
  } catch {
    // Transcrição falhou: mantém o áudio e a IA pede para o paciente escrever.
    await sql`update messages set transcript_status = 'failed' where id = ${msg.id}`;
    outcome = "failed_kept_audio";
  }
  const [conv] = await sql<{ state: ConversationState }[]>`select state from conversations where id = ${msg.conversation_id}`;
  const [clinic] = await sql<{ ai_enabled: boolean; ai_kill_switch: boolean }[]>`select ai_enabled, ai_kill_switch from clinics where id = ${job.clinic_id}`;
  if (conv?.state === "ai_active" && clinic?.ai_enabled && !clinic.ai_kill_switch) {
    await debounceConversationJob(sql, job.clinic_id, msg.conversation_id, now);
  }
  return outcome;
}

async function automatedCount(sql: Sql, conversationId: string, now: Date): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    select count(*)::int as n from scheduled_jobs
    where conversation_id = ${conversationId} and status = 'done' and result in ('sent','sent_template')
      and type in ('followup_1','followup_2','reminder','confirmation_request','automation') and updated_at > ${addMinutes(now, -24 * 60)}`;
  return r?.n ?? 0;
}

async function humanTask(sql: Sql, clinicId: string, title: string, detail: string, ids: { conversationId?: string | null; appointmentId?: string | null }): Promise<void> {
  await sql`
    insert into tasks (clinic_id, title, detail, kind, conversation_id, appointment_id)
    values (${clinicId}, ${title}, ${detail}, 'automation', ${ids.conversationId ?? null}, ${ids.appointmentId ?? null})`;
}

async function approvedTemplate(sql: Sql, clinicId: string, name: string): Promise<{ name: string; language: string; body: string } | null> {
  const [t] = await sql<{ name: string; language: string; body: string }[]>`
    select name, language, body from message_templates where clinic_id = ${clinicId} and name = ${name} and wa_template_status = 'approved'`;
  return t ?? null;
}

async function followup(sql: Sql, job: Job, now: Date): Promise<string> {
  if (!job.conversation_id) return "skipped";
  const [c] = await sql<{ state: ConversationState; last_inbound_at: Date | null; window_expires_at: Date | null; last_message_at: Date | null; last_message_direction: string | null; contact_id: string; opted_out_at: Date | null; service_messages_allowed: boolean; settings: unknown; timezone: string }[]>`
    select c.state, c.last_inbound_at, c.window_expires_at, c.last_message_at, c.last_message_direction, c.contact_id,
           ct.opted_out_at, ct.service_messages_allowed, cl.settings, cl.timezone
    from conversations c join contacts ct on ct.id = c.contact_id join clinics cl on cl.id = c.clinic_id
    where c.id = ${job.conversation_id} and c.clinic_id = ${job.clinic_id}`;
  if (!c) return "skipped";
  const settings = parseSettings(c.settings);
  const hour = localParts(now, c.timezone).hour;
  if (hour < settings.quietStartHour || hour >= settings.quietEndHour) {
    // Fora do horário permitido: reagenda para a próxima janela (a elegibilidade é reavaliada lá).
    const next = clampToQuietHours(now, c.timezone, settings.quietStartHour, settings.quietEndHour);
    await enqueueJob(sql, { clinicId: job.clinic_id, type: job.type as "followup_1", runAt: next, conversationId: job.conversation_id, idempotencyKey: `${job.id}:quiet`, payload: job.payload });
    return "deferred_quiet_hours";
  }
  const [future] = await sql`
    select 1 from appointments where clinic_id = ${job.clinic_id} and contact_id = ${c.contact_id} and starts_at > ${now} and status in ('scheduled','confirmed') limit 1`;
  const template = await approvedTemplate(sql, job.clinic_id, "retomada_contato");
  const scheduledAfter = typeof job.payload.scheduledAfter === "string" ? new Date(job.payload.scheduledAfter) : null;
  const decision = decideAutomation({
    now, kind: job.type as "followup_1" | "followup_2", conversationState: c.state, lastInboundAt: c.last_inbound_at,
    lastOutboundAt: c.last_message_direction === "outbound" ? c.last_message_at : null,
    windowExpiresAt: (await enforcesWindow(sql, job.clinic_id)) ? c.window_expires_at : addMinutes(now, 60),
    optedOut: !!c.opted_out_at, serviceMessagesAllowed: c.service_messages_allowed,
    automatedSentLast24h: await automatedCount(sql, job.conversation_id, now), maxAutomatedPerDay: settings.maxAutomatedPerDay,
    scheduledAfter, hasFutureAppointment: !!future, hasApprovedTemplate: !!template,
  });
  if (decision.action === "skip") return `skipped:${decision.reason}`;
  if (decision.action === "create_human_task") {
    await humanTask(sql, job.clinic_id, "Retomar contato manualmente", "Follow-up fora da janela de 24 h e sem template aprovado.", { conversationId: job.conversation_id });
    return "human_task";
  }
  const body = job.type === "followup_1" ? settings.followup1Text : settings.followup2Text;
  const sent = await sendOutbound(sql, {
    clinicId: job.clinic_id, conversationId: job.conversation_id, senderType: "system", now,
    body: decision.action === "send_template" && template ? template.body : body,
    template: decision.action === "send_template" && template ? { name: template.name, language: template.language, params: [] } : undefined,
  });
  return sent.status === "sent" || sent.status === "queued" ? (decision.action === "send_template" ? "sent_template" : "sent") : `blocked:${sent.status}`;
}

async function reminder(sql: Sql, job: Job, now: Date): Promise<string> {
  if (!job.appointment_id) return "skipped";
  const [a] = await sql<{ status: string; starts_at: Date; contact_id: string | null; patient: string; service: string; professional: string; timezone: string; settings: unknown; clinic: string }[]>`
    select a.status, a.starts_at, a.contact_id, p.full_name as patient, s.name as service, pr.name as professional, cl.timezone, cl.settings, cl.name as clinic
    from appointments a join patients p on p.id = a.patient_id join services s on s.id = a.service_id
    join professionals pr on pr.id = a.professional_id join clinics cl on cl.id = a.clinic_id
    where a.id = ${job.appointment_id} and a.clinic_id = ${job.clinic_id}`;
  if (!a || !["scheduled", "confirmed"].includes(a.status) || a.starts_at <= now) return "skipped:consulta_indisponivel";
  const isConfirmation = job.type === "confirmation_request" && a.status === "scheduled";
  // Contato para avisar: o da consulta ou, na falta, o responsável vinculado ao paciente.
  const [contact] = await sql<{ id: string; opted_out_at: Date | null; service_messages_allowed: boolean; is_test: boolean }[]>`
    select ct.id, ct.opted_out_at, ct.service_messages_allowed, ct.is_test from contacts ct
    where ct.clinic_id = ${job.clinic_id} and ct.id = coalesce(${a.contact_id}, (
      select l.contact_id from contact_patient_links l join appointments ap on ap.patient_id = l.patient_id
      where ap.id = ${job.appointment_id} order by l.is_guardian desc, l.created_at limit 1))`;
  if (!contact) {
    await humanTask(sql, job.clinic_id, "Lembrar paciente da consulta", `${a.patient} não tem contato de WhatsApp vinculado.`, { appointmentId: job.appointment_id });
    return "human_task";
  }
  const channel = contact.is_test ? "simulator" : "whatsapp";
  let [conv] = await sql<{ id: string; state: ConversationState; window_expires_at: Date | null; last_inbound_at: Date | null }[]>`
    select id, state, window_expires_at, last_inbound_at from conversations where contact_id = ${contact.id} and channel = ${channel} and state <> 'closed'`;
  if (!conv) {
    [conv] = await sql<{ id: string; state: ConversationState; window_expires_at: Date | null; last_inbound_at: Date | null }[]>`
      insert into conversations (clinic_id, contact_id, channel, state) values (${job.clinic_id}, ${contact.id}, ${channel}, 'ai_active')
      returning id, state, window_expires_at, last_inbound_at`;
  }
  if (!conv) return "skipped";
  const settings = parseSettings(a.settings);
  const templateName = isConfirmation ? "confirmacao_consulta" : "lembrete_consulta";
  const template = await approvedTemplate(sql, job.clinic_id, templateName);
  const decision = decideAutomation({
    now, kind: isConfirmation ? "confirmation" : "reminder", conversationState: conv.state, lastInboundAt: conv.last_inbound_at, lastOutboundAt: null,
    windowExpiresAt: channel === "simulator" || !(await enforcesWindow(sql, job.clinic_id)) ? addMinutes(now, 60) : conv.window_expires_at,
    optedOut: !!contact.opted_out_at, serviceMessagesAllowed: contact.service_messages_allowed,
    automatedSentLast24h: await automatedCount(sql, conv.id, now), maxAutomatedPerDay: settings.maxAutomatedPerDay,
    scheduledAfter: null, hasFutureAppointment: true, hasApprovedTemplate: !!template,
  });
  if (decision.action === "skip") return `skipped:${decision.reason}`;
  if (decision.action === "create_human_task") {
    await humanTask(sql, job.clinic_id, isConfirmation ? "Confirmar consulta por telefone" : "Lembrar paciente da consulta",
      `${a.patient} — ${formatFull(a.starts_at, a.timezone)}. Fora da janela de 24 h e sem template "${templateName}" aprovado.`, { conversationId: conv.id, appointmentId: job.appointment_id });
    return "human_task";
  }
  const when = formatFull(a.starts_at, a.timezone);
  const body = isConfirmation
    ? `Olá! Lembrete da ${a.clinic}: ${a.patient} tem ${a.service} com ${a.professional} em ${when}. Responda 1 para confirmar ou 2 para remarcar.`
    : `Olá! Lembrete da ${a.clinic}: ${a.patient} tem ${a.service} com ${a.professional} em ${when}.`;
  const sent = await sendOutbound(sql, {
    clinicId: job.clinic_id, conversationId: conv.id, senderType: "system", body, now,
    template: decision.action === "send_template" && template ? { name: template.name, language: template.language, params: [a.patient, a.service, a.professional, when] } : undefined,
  });
  if (sent.status !== "sent" && sent.status !== "queued") return `blocked:${sent.status}`;
  if (isConfirmation) await sql`update conversations set awaiting_confirmation_appointment_id = ${job.appointment_id} where id = ${conv.id}`;
  return decision.action === "send_template" ? "sent_template" : "sent";
}
