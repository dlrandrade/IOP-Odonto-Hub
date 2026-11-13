import type { Sql } from "@/db/client";
import { validateStageMove, type OpportunityStage } from "@/domain/states";

export type MoveInput = {
  clinicId: string; opportunityId: string; to: OpportunityStage; actor: "ai" | "user" | "system";
  actorUserId?: string | null; lostReason?: string | null; evidence?: string | null; evidenceMessageId?: string | null;
};

/** Move a oportunidade respeitando as regras da seção 5 e grava o evento. */
export async function moveOpportunity(sql: Sql, i: MoveInput): Promise<{ ok: boolean; message?: string }> {
  const [opp] = await sql<{ stage: OpportunityStage; contact_id: string }[]>`
    select stage, contact_id from opportunities where id = ${i.opportunityId} and clinic_id = ${i.clinicId}`;
  if (!opp) return { ok: false, message: "Oportunidade não encontrada." };
  const [evalAppt] = await sql`
    select 1 from appointments a join services s on s.id = a.service_id
    where a.clinic_id = ${i.clinicId} and a.contact_id = ${opp.contact_id} and s.kind = 'evaluation' and a.status in ('scheduled','confirmed') limit 1`;
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

/** Depois que a avaliação foi gravada, a oportunidade correspondente avança (única promoção permitida à IA). */
export async function onEvaluationBooked(sql: Sql, clinicId: string, contactId: string, serviceId: string, actor: "ai" | "user"): Promise<void> {
  const opps = await sql<{ id: string }[]>`
    select o.id from opportunities o
    left join services s on s.id = o.service_id
    where o.clinic_id = ${clinicId} and o.contact_id = ${contactId} and o.stage in ('new','in_conversation')
      and (o.service_id is null or o.service_id = ${serviceId} or s.leads_to_evaluation_service_id = ${serviceId})`;
  for (const o of opps) await moveOpportunity(sql, { clinicId, opportunityId: o.id, to: "evaluation_scheduled", actor });
}
