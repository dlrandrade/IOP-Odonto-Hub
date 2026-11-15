import type { Sql } from "@/db/client";
import { validateStageMove, type OpportunityStage } from "@/domain/states";

export type MoveInput = {
  clinicId: string; opportunityId: string; to: OpportunityStage; actor: "ai" | "user" | "system";
  actorUserId?: string | null; lostReason?: string | null; evidence?: string | null; evidenceMessageId?: string | null;
};

/** Move a oportunidade respeitando as regras da seção 5 e grava o evento. */
export async function moveOpportunity(sql: Sql, i: MoveInput): Promise<{ ok: boolean; message?: string }> {
  const [opp] = await sql<{ stage: OpportunityStage; contact_id: string | null; patient_id: string | null }[]>`
    select stage, contact_id, patient_id from opportunities where id = ${i.opportunityId} and clinic_id = ${i.clinicId}`;
  if (!opp) return { ok: false, message: "Oportunidade não encontrada." };
  const [evalAppt] = await sql`
    select 1 from appointments a join services s on s.id = a.service_id
    where a.clinic_id = ${i.clinicId} and (a.contact_id = ${opp.contact_id} or a.patient_id = ${opp.patient_id})
      and s.kind = 'evaluation' and a.status in ('scheduled','confirmed') limit 1`;
  const refusal = validateStageMove({ from: opp.stage, to: i.to, actor: i.actor, hasScheduledEvaluation: !!evalAppt, lostReason: i.lostReason, evidence: i.evidence });
  if (refusal) return { ok: false, message: refusal };
  await sql`
    update opportunities set stage = ${i.to}, lost_reason = ${i.to === "lost" ? i.lostReason ?? null : null}
    where id = ${i.opportunityId} and clinic_id = ${i.clinicId}`;
  await sql`
    insert into opportunity_events (clinic_id, opportunity_id, from_stage, to_stage, actor, actor_user_id, evidence_message_id, note)
    values (${i.clinicId}, ${i.opportunityId}, ${opp.stage}, ${i.to}, ${i.actor}, ${i.actorUserId ?? null}, ${i.evidenceMessageId ?? null}, ${i.evidence ?? i.lostReason ?? null})`;
  return { ok: true };
}

export type InterestInput = {
  clinicId: string; contactId: string; patientId?: string | null; serviceId?: string | null;
  text: string; intent: "curioso" | "considerando" | "quer_agendar"; actor: "ai" | "user"; source?: string;
};

/** Registra interesse: cria ou atualiza a oportunidade aberta daquele serviço. Interesse não é tratamento contratado. */
export async function registerInterest(sql: Sql, i: InterestInput): Promise<string> {
  const [existing] = await sql<{ id: string; stage: OpportunityStage }[]>`
    select id, stage from opportunities
    where clinic_id = ${i.clinicId} and contact_id = ${i.contactId} and stage not in ('accepted','lost')
      and service_id is not distinct from ${i.serviceId ?? null}
    order by created_at desc limit 1`;
  if (existing) {
    await sql`update opportunities set intent = ${i.intent}, service_interest = ${i.text}, patient_id = coalesce(${i.patientId ?? null}, patient_id) where id = ${existing.id}`;
    if (existing.stage === "new") await moveOpportunity(sql, { clinicId: i.clinicId, opportunityId: existing.id, to: "in_conversation", actor: i.actor });
    return existing.id;
  }
  const [opp] = await sql<{ id: string }[]>`
    insert into opportunities (clinic_id, contact_id, patient_id, service_id, service_interest, intent, stage, source)
    values (${i.clinicId}, ${i.contactId}, ${i.patientId ?? null}, ${i.serviceId ?? null}, ${i.text}, ${i.intent}, 'in_conversation', ${i.source ?? "whatsapp"})
    returning id`;
  if (!opp) throw new Error("Falha ao registrar interesse");
  await sql`
    insert into opportunity_events (clinic_id, opportunity_id, from_stage, to_stage, actor)
    values (${i.clinicId}, ${opp.id}, null, 'in_conversation', ${i.actor})`;
  return opp.id;
}

/**
 * Toda consulta agendada aparece no CRM (agenda e IA chamam isto depois de gravar a consulta):
 * - avaliação: a oportunidade aberta avança para "Avaliação agendada"; sem nenhuma, nasce nesse estágio;
 * - procedimento marcado pela equipe: vai para "Aceito", com o agendamento como evidência;
 * - procedimento marcado pela IA: nasce "Em conversa" com o agendamento no próximo passo (a IA não promove além da avaliação);
 * - retorno: não é interesse novo, o CRM não muda.
 */
export async function syncOpportunityOnBooking(sql: Sql, i: {
  clinicId: string; patientId: string; contactId: string | null; serviceId: string; actor: "ai" | "user"; actorUserId?: string | null; when: string;
}): Promise<void> {
  const [svc] = await sql<{ name: string; kind: string }[]>`select name, kind from services where id = ${i.serviceId} and clinic_id = ${i.clinicId}`;
  if (!svc || svc.kind === "return") return;
  const open = await sql<{ id: string; stage: OpportunityStage; service_id: string | null; leads_to: string | null }[]>`
    select o.id, o.stage, o.service_id, s.leads_to_evaluation_service_id as leads_to from opportunities o left join services s on s.id = o.service_id
    where o.clinic_id = ${i.clinicId} and o.stage not in ('accepted','lost')
      and (o.patient_id = ${i.patientId} or o.contact_id = ${i.contactId}
           or o.contact_id in (select l.contact_id from contact_patient_links l where l.patient_id = ${i.patientId}))
    order by o.updated_at desc`;
  const related = open.filter((o) => !o.service_id || o.service_id === i.serviceId || o.leads_to === i.serviceId);
  for (const o of related) await sql`update opportunities set patient_id = coalesce(patient_id, ${i.patientId}) where id = ${o.id}`;

  const create = async (stage: OpportunityStage, note: string, nextStep: string | null = null) => {
    const [opp] = await sql<{ id: string }[]>`
      insert into opportunities (clinic_id, contact_id, patient_id, service_id, service_interest, stage, source, next_step)
      values (${i.clinicId}, ${i.contactId}, ${i.patientId}, ${i.serviceId}, ${svc.name}, ${stage}, 'agenda', ${nextStep}) returning id`;
    await sql`insert into opportunity_events (clinic_id, opportunity_id, from_stage, to_stage, actor, actor_user_id, note)
              values (${i.clinicId}, ${opp!.id}, null, ${stage}, ${i.actor === "user" ? "user" : "system"}, ${i.actorUserId ?? null}, ${note})`;
  };

  if (svc.kind === "evaluation") {
    const early = related.filter((o) => o.stage === "new" || o.stage === "in_conversation");
    for (const o of early) await moveOpportunity(sql, { clinicId: i.clinicId, opportunityId: o.id, to: "evaluation_scheduled", actor: i.actor, actorUserId: i.actorUserId });
    if (related.length === 0) await create("evaluation_scheduled", `Avaliação agendada para ${i.when}`);
    return;
  }
  const evidence = `Procedimento agendado pela equipe: ${svc.name} em ${i.when}`;
  if (i.actor === "user") {
    const target = related.find((o) => o.service_id === i.serviceId) ?? related[0];
    if (target) await moveOpportunity(sql, { clinicId: i.clinicId, opportunityId: target.id, to: "accepted", actor: "user", actorUserId: i.actorUserId, evidence });
    else await create("accepted", evidence);
    return;
  }
  if (related.length === 0) await create("in_conversation", "Procedimento agendado pela assistente", `Confirmar aceite: ${svc.name} agendado para ${i.when}`);
}
