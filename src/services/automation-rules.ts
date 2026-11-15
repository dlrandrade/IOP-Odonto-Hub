import type { Sql } from "@/db/client";
import { decideAutomation } from "@/domain/automation";
import { parseSettings } from "@/domain/settings";
import type { ConversationState } from "@/domain/states";
import { addMinutes, clampToQuietHours, formatFull, localDate, localParts, zonedToUtc } from "@/lib/datetime";
import { enforcesWindow, providerFor } from "@/integrations/whatsapp";
import { enqueueJob } from "./jobs-queue";
import { emailConfigured, isEmail, sendEmail } from "@/integrations/email";
import { reviewLink } from "./google-reviews";

/** Automações criadas pela clínica no construtor visual. As quatro nativas continuam em jobs.ts. */
export const RULE_TRIGGERS = ["before_appointment", "after_appointment", "no_show", "birthday"] as const;
export type RuleTrigger = (typeof RULE_TRIGGERS)[number];
export const RULE_ACTIONS = ["message", "task"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];
/**
 * Por onde a mensagem sai. "whatsapp_click": na hora certa vira um botão "Enviar no WhatsApp" para a equipe
 * (abre o WhatsApp Web/app com número e texto prontos). Instagram vira tarefa com o texto pronto.
 */
export const RULE_CHANNELS = ["whatsapp", "whatsapp_click", "email", "instagram"] as const;
export type RuleChannel = (typeof RULE_CHANNELS)[number];

export type AutomationRule = {
  id: string; clinic_id: string; name: string; trigger: RuleTrigger; offset_minutes: number; action: RuleAction;
  body: string | null; template_name: string | null; task_title: string | null; enabled: boolean; position: number; channel: RuleChannel;
};

/** Variáveis aceitas no texto: {paciente} {primeiro_nome} {servico} {dentista} {data} {clinica} {link_avaliacao} {instagram}. */
export function renderRuleText(text: string, v: { patient: string; service?: string | null; professional?: string | null; when?: string | null; clinic: string; reviewUrl?: string | null; instagram?: string | null }): string {
  const first = v.patient.split(" ")[0] ?? v.patient;
  return text
    .replaceAll("{paciente}", v.patient).replaceAll("{primeiro_nome}", first)
    .replaceAll("{servico}", v.service ?? "").replaceAll("{dentista}", v.professional ?? "")
    .replaceAll("{data}", v.when ?? "").replaceAll("{clinica}", v.clinic)
    .replaceAll("{link_avaliacao}", v.reviewUrl ?? "").replaceAll("{instagram}", v.instagram ? `@${v.instagram.replace(/^@/, "")}` : "")
    .replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Agenda os jobs das regras ativas de um gatilho ligado a uma consulta.
 * Antes da consulta: âncora = início, envio = início − espera. Depois/falta: âncora = agora, envio = agora + espera.
 */
export async function scheduleRuleJobs(sql: Sql, clinicId: string, trigger: Exclude<RuleTrigger, "birthday">, o: { appointmentId: string; anchor: Date; now: Date }): Promise<void> {
  const rules = await sql<AutomationRule[]>`select * from automation_rules where clinic_id = ${clinicId} and trigger = ${trigger} and enabled`;
  if (rules.length === 0) return;
  const [clinic] = await sql<{ timezone: string; settings: unknown }[]>`select timezone, settings from clinics where id = ${clinicId}`;
  const settings = parseSettings(clinic?.settings);
  const tz = clinic?.timezone ?? "America/Sao_Paulo";
  for (const r of rules) {
    const ideal = trigger === "before_appointment" ? addMinutes(o.anchor, -r.offset_minutes) : addMinutes(o.anchor, r.offset_minutes);
    if (trigger === "before_appointment" && ideal <= o.now) continue; // não envia retroativo
    const runAt = r.action === "task" ? ideal : clampToQuietHours(ideal, tz, settings.quietStartHour, settings.quietEndHour);
    if (trigger === "before_appointment" && runAt >= o.anchor) continue;
    await enqueueJob(sql, {
      clinicId, type: "automation", runAt, appointmentId: o.appointmentId,
      idempotencyKey: `rule:${r.id}:${o.appointmentId}:${trigger}`, payload: { ruleId: r.id },
    });
  }
}

/** Aniversários: roda junto com o worker; a chave de idempotência garante um envio por paciente por ano. */
export async function sweepBirthdays(sql: Sql, now: Date): Promise<number> {
  const rules = await sql<(AutomationRule & { timezone: string })[]>`
    select r.*, c.timezone from automation_rules r join clinics c on c.id = r.clinic_id
    where r.trigger = 'birthday' and r.enabled and c.status <> 'suspended'`;
  let n = 0;
  for (const r of rules) {
    const today = localDate(now, r.timezone);
    const sendAt = zonedToUtc(today, `${String(Math.floor(r.offset_minutes / 60)).padStart(2, "0")}:${String(r.offset_minutes % 60).padStart(2, "0")}`, r.timezone);
    if (sendAt > now) continue;
    const [, month, day] = today.split("-").map(Number) as [number, number, number];
    const patients = await sql<{ id: string }[]>`
      select id from patients where clinic_id = ${r.clinic_id} and merged_into_patient_id is null
        and extract(month from birth_date) = ${month} and extract(day from birth_date) = ${day}`;
    for (const p of patients) {
      await enqueueJob(sql, {
        clinicId: r.clinic_id, type: "automation", runAt: now,
        idempotencyKey: `rule:${r.id}:birthday:${p.id}:${today.slice(0, 4)}`, payload: { ruleId: r.id, patientId: p.id },
      });
      n++;
    }
  }
  return n;
}

type RuleJob = { id: string; clinic_id: string; appointment_id: string | null; payload: Record<string, unknown> };

/** Executa uma regra: confere se ainda vale, respeita horário e limites, e envia a mensagem ou cria a tarefa. */
export async function runRuleJob(sql: Sql, job: RuleJob, now: Date): Promise<string> {
  const ruleId = typeof job.payload.ruleId === "string" ? job.payload.ruleId : null;
  if (!ruleId) return "skipped";
  const [rule] = await sql<AutomationRule[]>`select * from automation_rules where id = ${ruleId} and clinic_id = ${job.clinic_id}`;
  if (!rule || !rule.enabled) return "skipped:regra_desativada";
  const [clinic] = await sql<{ name: string; timezone: string; settings: unknown; google_review_url: string | null; google_place_id: string | null; instagram_handle: string | null; contact_email: string | null }[]>`
    select name, timezone, settings, google_review_url, google_place_id, instagram_handle, contact_email from clinics where id = ${job.clinic_id}`;
  if (!clinic) return "skipped";
  const settings = parseSettings(clinic.settings);

  // Quem é o paciente e qual consulta (quando houver).
  let patientId = typeof job.payload.patientId === "string" ? job.payload.patientId : null;
  type Appt = { status: string; starts_at: Date; contact_id: string | null; service: string; professional: string; patient_id: string };
  let appt: Appt | undefined;
  if (job.appointment_id) {
    [appt] = await sql<Appt[]>`
      select a.status, a.starts_at, a.contact_id, a.patient_id, s.name as service, pr.name as professional
      from appointments a join services s on s.id = a.service_id join professionals pr on pr.id = a.professional_id
      where a.id = ${job.appointment_id} and a.clinic_id = ${job.clinic_id}`;
    if (!appt) return "skipped:consulta_indisponivel";
    if (rule.trigger === "before_appointment" && (!["scheduled", "confirmed"].includes(appt.status) || appt.starts_at <= now)) return "skipped:consulta_indisponivel";
    if (rule.trigger === "after_appointment" && appt.status !== "completed") return "skipped:consulta_nao_concluida";
    if (rule.trigger === "no_show" && appt.status !== "no_show") return "skipped:sem_falta";
    patientId = appt.patient_id;
  }
  if (!patientId) return "skipped";
  const [patient] = await sql<{ full_name: string; email: string | null }[]>`select full_name, email from patients where id = ${patientId} and clinic_id = ${job.clinic_id}`;
  if (!patient) return "skipped";
  const when = appt ? formatFull(appt.starts_at, clinic.timezone) : null;
  const vars = { patient: patient.full_name, service: appt?.service, professional: appt?.professional, when, clinic: clinic.name, reviewUrl: reviewLink(clinic), instagram: clinic.instagram_handle };
  // Texto pede o link de avaliação mas a clínica ainda não cadastrou o Google: não envia link vazio.
  if (rule.action === "message" && (rule.body ?? "").includes("{link_avaliacao}") && !vars.reviewUrl) return "skipped:sem_link_do_google";

  if (rule.action === "task") {
    await sql`insert into tasks (clinic_id, title, detail, kind, appointment_id)
              values (${job.clinic_id}, ${renderRuleText(rule.task_title ?? rule.name, vars)}, ${`${rule.name} · ${patient.full_name}${when ? ` · ${when}` : ""}`}, 'automation', ${job.appointment_id})`;
    return "human_task";
  }

  // Mensagem: só no horário permitido; fora dele, reagenda para a próxima janela.
  const hour = localParts(now, clinic.timezone).hour;
  if (hour < settings.quietStartHour || hour >= settings.quietEndHour) {
    const next = clampToQuietHours(now, clinic.timezone, settings.quietStartHour, settings.quietEndHour);
    await enqueueJob(sql, { clinicId: job.clinic_id, type: "automation", runAt: next, appointmentId: job.appointment_id, idempotencyKey: `${job.id}:quiet`, payload: job.payload });
    return "deferred_quiet_hours";
  }
  const text = renderRuleText(rule.body ?? "", vars);

  // Instagram: enquanto o Instagram Direct não estiver conectado, a equipe recebe o texto pronto para enviar.
  if (rule.channel === "instagram") {
    await sql`insert into tasks (clinic_id, title, detail, kind, appointment_id)
              values (${job.clinic_id}, ${`${rule.name}: enviar pelo Instagram`}, ${`Para ${patient.full_name}: ${text}`}, 'automation', ${job.appointment_id})`;
    return "human_task:instagram";
  }

  // E-mail: precisa do e-mail do paciente e do serviço de e-mail da plataforma; senão, vira tarefa.
  if (rule.channel === "email") {
    const optedOut = (await sql<{ out: boolean }[]>`
      select exists (select 1 from contact_patient_links l join contacts ct on ct.id = l.contact_id
                     where l.patient_id = ${patientId} and ct.opted_out_at is not null) as out`)[0]?.out;
    if (optedOut) return "skipped:opt_out";
    if (!isEmail(patient.email) || !emailConfigured()) {
      await sql`insert into tasks (clinic_id, title, detail, kind, appointment_id)
                values (${job.clinic_id}, ${`${rule.name}: enviar manualmente`}, ${`${patient.full_name} ${isEmail(patient.email) ? "— e-mail da plataforma não configurado" : "não tem e-mail cadastrado"}. Texto: ${text}`}, 'automation', ${job.appointment_id})`;
      return "human_task";
    }
    const r = await sendEmail({ to: patient.email, subject: `${clinic.name}`, text, replyTo: clinic.contact_email, fromName: clinic.name });
    if (!r.ok) { if (r.retryable) throw new Error(r.error); return `blocked:email`; }
    return "sent_email";
  }
  const [contact] = await sql<{ id: string; phone_e164: string; opted_out_at: Date | null; service_messages_allowed: boolean; is_test: boolean }[]>`
    select ct.id, ct.phone_e164, ct.opted_out_at, ct.service_messages_allowed, ct.is_test from contacts ct
    where ct.clinic_id = ${job.clinic_id} and ct.id = coalesce(${appt?.contact_id ?? null}, (
      select l.contact_id from contact_patient_links l where l.patient_id = ${patientId} order by l.is_guardian desc, l.created_at limit 1))`;
  if (!contact) {
    await sql`insert into tasks (clinic_id, title, detail, kind, appointment_id)
              values (${job.clinic_id}, ${`${rule.name}: avisar manualmente`}, ${`${patient.full_name} não tem WhatsApp vinculado.`}, 'automation', ${job.appointment_id})`;
    return "human_task";
  }
  if (contact.opted_out_at || !contact.service_messages_allowed) return "skipped:opt_out";
  // Envio por clique: escolhido na automação ou porque a clínica ainda não conectou o WhatsApp.
  if (!contact.is_test && (rule.channel === "whatsapp_click" || !(await providerFor(sql, job.clinic_id, "whatsapp")))) {
    await createClickTask(sql, { clinicId: job.clinic_id, title: `${rule.name}: enviar no WhatsApp`, patient: patient.full_name, phone: contact.phone_e164, text, appointmentId: job.appointment_id, contactId: contact.id });
    return "human_task:clique";
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
  const [template] = rule.template_name ? await sql<{ name: string; language: string; body: string }[]>`
    select name, language, body from message_templates where clinic_id = ${job.clinic_id} and name = ${rule.template_name} and wa_template_status = 'approved'` : [];
  const [sentToday] = await sql<{ n: number }[]>`
    select count(*)::int as n from scheduled_jobs where conversation_id = ${conv.id} and status = 'done' and result in ('sent','sent_template')
      and type in ('followup_1','followup_2','reminder','confirmation_request','automation') and updated_at > ${addMinutes(now, -24 * 60)}`;
  const decision = decideAutomation({
    now, kind: "reminder", conversationState: conv.state, lastInboundAt: conv.last_inbound_at, lastOutboundAt: null,
    windowExpiresAt: channel === "simulator" || !(await enforcesWindow(sql, job.clinic_id)) ? addMinutes(now, 60) : conv.window_expires_at,
    optedOut: !!contact.opted_out_at, serviceMessagesAllowed: contact.service_messages_allowed,
    automatedSentLast24h: sentToday?.n ?? 0, maxAutomatedPerDay: settings.maxAutomatedPerDay,
    scheduledAfter: null, hasFutureAppointment: true, hasApprovedTemplate: !!template,
  });
  if (decision.action === "skip") return `skipped:${decision.reason}`;
  if (decision.action === "create_human_task") {
    await sql`insert into tasks (clinic_id, title, detail, kind, conversation_id, appointment_id)
              values (${job.clinic_id}, ${`${rule.name}: enviar manualmente`}, ${`${patient.full_name}: fora da janela de 24 h e sem template aprovado.`}, 'automation', ${conv.id}, ${job.appointment_id})`;
    return "human_task";
  }
  const { sendOutbound } = await import("./conversations");
  const body = text;
  const sent = await sendOutbound(sql, {
    clinicId: job.clinic_id, conversationId: conv.id, senderType: "system", body, now,
    template: decision.action === "send_template" && template ? { name: template.name, language: template.language, params: [patient.full_name, appt?.service ?? "", appt?.professional ?? "", when ?? ""] } : undefined,
  });
  if (sent.status !== "sent" && sent.status !== "queued") return `blocked:${sent.status}`;
  return decision.action === "send_template" ? "sent_template" : "sent";
}

/** Tarefa "Enviar no WhatsApp": guarda número e texto; a tela mostra o botão que abre o WhatsApp já preenchido. */
export async function createClickTask(sql: Sql, t: { clinicId: string; title: string; patient: string; phone: string; text: string; appointmentId?: string | null; contactId?: string | null; conversationId?: string | null }): Promise<void> {
  await sql`insert into tasks (clinic_id, title, detail, kind, appointment_id, contact_id, conversation_id, wa_phone, message_text, due_at)
            values (${t.clinicId}, ${t.title}, ${`Para ${t.patient}`}, 'whatsapp_click', ${t.appointmentId ?? null}, ${t.contactId ?? null}, ${t.conversationId ?? null}, ${t.phone}, ${t.text}, now())`;
}
