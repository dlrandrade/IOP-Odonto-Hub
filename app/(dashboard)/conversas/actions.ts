"use server";

import { z } from "zod";
import { q } from "@/auth/session";
import type { ActionState } from "@/components/client";
import { can } from "@/domain/permissions";
import { act, actorOf, optStr, str, UserError } from "@/lib/action";
import { audit } from "@/services/audit";
import { addNote, closeConversation, handBack, sendOutbound, takeOver, transferConversation } from "@/services/conversations";

const PATH = "/conversas";
const id = z.string().uuid();

export async function sendMessageAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("conversations.reply", PATH, async (ctx) => {
    const conversationId = id.parse(form.get("conversationId"));
    const body = str(form, "body");
    if (!body) throw new UserError("Escreva a mensagem.");
    if (body.length > 4000) throw new UserError("Mensagem muito longa.");
    const who = { id: ctx.userId, name: ctx.name };
    await q(ctx, async (tx) => {
      if (form.get("mode") === "note") return addNote(tx, ctx.clinicId, conversationId, ctx.userId, body);
      const [conv] = await tx<{ state: string; assigned_to: string | null }[]>`select state, assigned_to from conversations where id = ${conversationId}`;
      if (!conv) throw new UserError("Conversa não encontrada.");
      if (conv.state === "human_active" && conv.assigned_to && conv.assigned_to !== ctx.userId && !can(ctx.role, "conversations.reassign")) {
        throw new UserError("Esta conversa está com outra pessoa. Peça a transferência.");
      }
      // Responder é assumir: a IA para de responder nesta conversa.
      if (conv.state !== "human_active" || conv.assigned_to !== ctx.userId) await takeOver(tx, ctx.clinicId, conversationId, who);
      const sent = await sendOutbound(tx, { clinicId: ctx.clinicId, conversationId, senderType: "human", senderUserId: ctx.userId, body });
      if (sent.status === "blocked") {
        throw new UserError(sent.reason === "window_closed"
          ? "Janela de 24 h encerrada: o WhatsApp só permite template aprovado. Use o botão de template."
          : "Não foi possível enviar.");
      }
    });
  });
}

export async function sendTemplateAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("conversations.reply", PATH, async (ctx) => {
    const conversationId = id.parse(form.get("conversationId"));
    await q(ctx, async (tx) => {
      const [t] = await tx<{ name: string; language: string; body: string }[]>`
        select name, language, body from message_templates where name = 'retomada_contato' and wa_template_status = 'approved'`;
      if (!t) throw new UserError("Nenhum template aprovado. Cadastre e aprove em Automações.");
      await takeOver(tx, ctx.clinicId, conversationId, { id: ctx.userId, name: ctx.name });
      await sendOutbound(tx, { clinicId: ctx.clinicId, conversationId, senderType: "human", senderUserId: ctx.userId, body: t.body, template: { name: t.name, language: t.language, params: [] } });
    });
  });
}

export async function conversationStateAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("conversations.reply", PATH, async (ctx) => {
    const conversationId = id.parse(form.get("conversationId"));
    const op = str(form, "op");
    const who = { id: ctx.userId, name: ctx.name };
    await q(ctx, async (tx) => {
      const [conv] = await tx<{ state: string; assigned_to: string | null }[]>`select state, assigned_to from conversations where id = ${conversationId}`;
      if (!conv) throw new UserError("Conversa não encontrada.");
      const mine = !conv.assigned_to || conv.assigned_to === ctx.userId;
      // Só uma pessoa responsável por vez; supervisor (admin/gestor) reatribui.
      if (conv.state === "human_active" && !mine && !can(ctx.role, "conversations.reassign")) throw new UserError("Esta conversa está com outra pessoa.");
      if (op === "take") await takeOver(tx, ctx.clinicId, conversationId, who);
      else if (op === "handback") await handBack(tx, ctx.clinicId, conversationId, who, optStr(form, "pending"));
      else if (op === "close") await closeConversation(tx, ctx.clinicId, conversationId, who);
      else if (op === "transfer") {
        const [to] = await tx<{ id: string; name: string }[]>`select id, name from app_users where id = ${id.parse(form.get("to"))} and active`;
        if (!to) throw new UserError("Usuário não encontrado.");
        await transferConversation(tx, ctx.clinicId, conversationId, who, to);
      } else throw new UserError("Operação inválida.");
    });
  });
}

export async function saveSummaryAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("conversations.reply", PATH, async (ctx) => {
    await q(ctx, (tx) => tx`
      update conversations set summary = ${optStr(form, "summary")}, summary_updated_at = now(), summary_by = 'human'
      where id = ${id.parse(form.get("conversationId"))}`);
    return { ok: true, message: "Resumo salvo." };
  });
}

/** Corrige a transcrição sem sobrescrever a original. */
export async function editTranscriptAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("conversations.reply", PATH, async (ctx) => {
    await q(ctx, (tx) => tx`update messages set transcript = ${str(form, "transcript")}, transcript_status = 'done' where id = ${id.parse(form.get("messageId"))} and type = 'audio'`);
  });
}

export async function contactFlagsAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("conversations.reply", PATH, async (ctx) => {
    const contactId = id.parse(form.get("contactId"));
    const excluded = form.get("excluded") === "on";
    await q(ctx, async (tx) => {
      await tx`update contacts set excluded_from_metrics = ${excluded} where id = ${contactId}`;
      await audit(tx, actorOf(ctx), "contact.flags", "contacts", contactId, null, { excluded_from_metrics: excluded });
    });
  });
}

const linkSchema = z.object({
  contactId: id, patientId: z.string().uuid().optional(), fullName: z.string().trim().optional(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), relationship: z.enum(["self", "filho", "conjuge", "dependente", "outro"]),
});

export async function linkPatientAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("patients.write", [PATH, "/pacientes"], async (ctx) => {
    const data = linkSchema.parse({
      contactId: form.get("contactId"), patientId: optStr(form, "patientId") ?? undefined, fullName: optStr(form, "fullName") ?? undefined,
      birthDate: optStr(form, "birthDate") ?? undefined, relationship: form.get("relationship"),
    });
    await q(ctx, async (tx) => {
      let patientId = data.patientId;
      if (!patientId) {
        if (!data.fullName || data.fullName.length < 3) throw new UserError("Informe o nome completo ou escolha um paciente.");
        const [p] = await tx<{ id: string }[]>`insert into patients (clinic_id, full_name, birth_date) values (${ctx.clinicId}, ${data.fullName}, ${data.birthDate ?? null}) returning id`;
        patientId = p?.id;
      }
      if (!patientId) throw new UserError("Não foi possível vincular.");
      const guardian = data.relationship === "filho" || data.relationship === "dependente";
      await tx`
        insert into contact_patient_links (clinic_id, contact_id, patient_id, relationship, is_guardian)
        values (${ctx.clinicId}, ${data.contactId}, ${patientId}, ${data.relationship}, ${guardian})
        on conflict (contact_id, patient_id) do update set relationship = excluded.relationship, is_guardian = excluded.is_guardian`;
      // Origem detectada no contato (anúncio, "vi no Instagram"…) passa para o paciente que ainda não tem.
      await tx`update patients p set source = c.origin, source_detail = 'Detectado: ' || coalesce(c.origin_detail, '')
               from contacts c where c.id = ${data.contactId} and c.origin is not null and p.id = ${patientId} and p.source is null`;
    });
  });
}

export async function killSwitchAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("ai.kill_switch", ["/", PATH, "/configuracoes", "/indicadores"], async (ctx) => {
    const on = form.get("on") === "true";
    await q(ctx, async (tx) => {
      await tx`update clinics set ai_kill_switch = ${on} where id = ${ctx.clinicId}`;
      await audit(tx, actorOf(ctx), "ai.kill_switch", "clinics", ctx.clinicId, { ai_kill_switch: !on }, { ai_kill_switch: on });
    });
  });
}
