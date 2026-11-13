import Link from "next/link";
import { Bot, CalendarClock, Plus, UserRound } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, Modal } from "@/components/client";
import { Badge, Button, buttonClass, Field, Input, PageHeader, Select } from "@/components/ui";
import { can } from "@/domain/permissions";
import { OPPORTUNITY_STAGES, OPPORTUNITY_STAGE_LABELS, type OpportunityStage } from "@/domain/states";
import { formatShort } from "@/lib/datetime";
import { cn, formatPhone } from "@/lib/format";
import { createOpportunityAction, moveOpportunityAction, updateOpportunityAction } from "./actions";

export const metadata = { title: "CRM" };

type Opp = {
  id: string; stage: OpportunityStage; service_interest: string; intent: string | null; next_step: string | null; next_step_due: Date | null; lost_reason: string | null;
  owner_id: string | null; owner: string | null; contact_id: string; phone_e164: string; wa_profile_name: string | null; patient: string | null; updated_at: Date; last_actor: string | null; conversation_id: string | null;
};
const INTENT: Record<string, string> = { curioso: "Curioso", considerando: "Considerando", quer_agendar: "Quer agendar" };

export default async function CrmPage({ searchParams }: { searchParams: Promise<{ fechadas?: string }> }) {
  const ctx = await requireCtx("crm.view");
  const showClosed = (await searchParams).fechadas === "1";
  const canWrite = can(ctx.role, "crm.write");
  const data = await q(ctx, async (tx) => {
    const [own] = ctx.role === "dentista" && ctx.userId ? await tx<{ id: string }[]>`select id from professionals where app_user_id = ${ctx.userId}` : [];
    const opps = await tx<Opp[]>`
      select o.id, o.stage, o.service_interest, o.intent, o.next_step, o.next_step_due, o.lost_reason, o.owner_id, u.name as owner, o.contact_id,
             ct.phone_e164, ct.wa_profile_name, p.full_name as patient, o.updated_at,
             (select e.actor from opportunity_events e where e.opportunity_id = o.id order by e.created_at desc limit 1) as last_actor,
             (select c.id from conversations c where c.contact_id = o.contact_id order by c.created_at desc limit 1) as conversation_id
      from opportunities o join contacts ct on ct.id = o.contact_id left join patients p on p.id = o.patient_id left join app_users u on u.id = o.owner_id
      where (${showClosed} or o.stage not in ('accepted','lost') or o.updated_at > now() - interval '14 days')
        ${ctx.role === "dentista" ? tx`and exists (select 1 from appointments a where a.contact_id = o.contact_id and a.professional_id = ${own?.id ?? null})` : tx``}
      order by o.updated_at desc limit 400`;
    const services = await tx<{ id: string; name: string }[]>`select id, name from services order by name`;
    const users = await tx<{ id: string; name: string }[]>`select id, name from app_users where active order by name`;
    const contacts = canWrite ? await tx<{ id: string; label: string }[]>`
      select ct.id, coalesce(ct.wa_profile_name, '') || ' ' || ct.phone_e164 as label from contacts ct where not ct.is_test order by ct.created_at desc limit 300` : [];
    return { opps, services, users, contacts };
  });

  return (
    <>
      <PageHeader title="CRM" subtitle="Interesses por estágio. Interesse não é tratamento contratado; consulta e relacionamento têm registros próprios.">
        <Link href={showClosed ? "/crm" : "/crm?fechadas=1"} className={buttonClass("outline")}>{showClosed ? "Ocultar antigas" : "Mostrar todas as finalizadas"}</Link>
        {canWrite && (
          <Modal trigger={<><Plus size={15} aria-hidden /> Nova oportunidade</>} title="Nova oportunidade" triggerClass={buttonClass("accent")}>
            <ActionForm action={createOpportunityAction} className="space-y-4">
              <Field label="Contato existente"><Select name="contactId" defaultValue=""><option value="">— novo contato —</option>{data.contacts.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Ou telefone (com DDD)"><Input name="phone" inputMode="tel" /></Field><Field label="Nome"><Input name="name" /></Field></div>
              <Field label="Serviço de interesse"><Select name="serviceId" defaultValue=""><option value="">Outro / não definido</option>{data.services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
              <Field label="Descrição do interesse"><Input name="interest" required placeholder="Ex.: implante no dente da frente" /></Field>
              <Button type="submit">Criar</Button>
            </ActionForm>
          </Modal>
        )}
      </PageHeader>

      <div className="scroll-thin -mx-3 overflow-x-auto px-3 pb-3 sm:-mx-5 sm:px-5">
        <div className="flex gap-3" style={{ minWidth: OPPORTUNITY_STAGES.length * 276 }}>
          {OPPORTUNITY_STAGES.map((stage) => {
            const list = data.opps.filter((o) => o.stage === stage);
            const tone = stage === "accepted" ? "bg-ok-soft" : stage === "lost" ? "bg-line" : "bg-surface/70";
            return (
              <section key={stage} aria-label={OPPORTUNITY_STAGE_LABELS[stage]} className={cn("w-[264px] shrink-0 rounded-[var(--radius-card)] p-2.5", tone)}>
                <h2 className="flex items-center justify-between px-2 py-1.5 text-sm font-semibold">{OPPORTUNITY_STAGE_LABELS[stage]}<span className="rounded-full bg-surface-2 px-2 text-[11px] text-white">{list.length}</span></h2>
                <ul className="mt-1 space-y-2">
                  {list.length === 0 && <li className="rounded-2xl border border-dashed border-line px-3 py-5 text-center text-xs text-bone-mute">Vazio</li>}
                  {list.map((o) => {
                    const overdue = o.next_step_due && o.next_step_due < new Date() && !["accepted", "lost"].includes(o.stage);
                    return (
                      <li key={o.id} className="rounded-2xl bg-surface p-3 border border-line">
                        <p className="truncate text-sm font-semibold">{o.patient ?? o.wa_profile_name ?? formatPhone(o.phone_e164)}</p>
                        <p className="truncate text-xs text-bone-mute">{o.service_interest}</p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {o.intent && <Badge>{INTENT[o.intent]}</Badge>}
                          {o.last_actor === "ai" && <Badge tone="ok"><Bot size={10} aria-hidden /> movido pela IA</Badge>}
                          {o.owner && <Badge><UserRound size={10} aria-hidden /> {o.owner.split(" ")[0]}</Badge>}
                        </div>
                        {(o.next_step || o.next_step_due) && (
                          <p className={cn("mt-2 flex items-center gap-1 text-[11px]", overdue ? "font-semibold text-danger" : "text-bone-dim")}>
                            <CalendarClock size={11} aria-hidden /> {o.next_step ?? "Próximo passo"}{o.next_step_due ? ` · ${formatShort(o.next_step_due, ctx.tz).slice(0, 5)}${overdue ? " (atrasado)" : ""}` : ""}
                          </p>
                        )}
                        {o.lost_reason && <p className="mt-2 text-[11px] text-bone-mute">Motivo: {o.lost_reason}</p>}
                        <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
                          {o.conversation_id && can(ctx.role, "conversations.view") ? <Link href={`/conversas?c=${o.conversation_id}`} className="text-[11px] font-semibold underline">Conversa</Link> : <span />}
                          {canWrite && (
                            <Modal trigger="Mover / editar" title={`${o.service_interest} — ${OPPORTUNITY_STAGE_LABELS[o.stage]}`} triggerClass="text-[11px] font-semibold underline">
                              <ActionForm action={moveOpportunityAction} className="space-y-3">
                                <input type="hidden" name="opportunityId" value={o.id} />
                                <Field label="Mover para"><Select name="to" defaultValue="">{OPPORTUNITY_STAGES.filter((s) => s !== o.stage).map((s) => <option key={s} value={s}>{OPPORTUNITY_STAGE_LABELS[s]}</option>)}</Select></Field>
                                <Field label="Evidência do aceite" hint="Obrigatória para “Aceito”: o que comprova (mensagem, assinatura, registro)."><Input name="evidence" /></Field>
                                <Field label="Motivo da perda" hint="Obrigatório para “Perdido”."><Input name="lostReason" /></Field>
                                <Button type="submit">Mover</Button>
                              </ActionForm>
                              <hr className="my-5 border-line" />
                              <ActionForm action={updateOpportunityAction} className="space-y-3">
                                <input type="hidden" name="opportunityId" value={o.id} />
                                <Field label="Responsável"><Select name="ownerId" defaultValue={o.owner_id ?? ""}><option value="">Sem responsável</option>{data.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
                                <div className="grid gap-3 sm:grid-cols-2">
                                  <Field label="Próximo passo"><Input name="nextStep" defaultValue={o.next_step ?? ""} /></Field>
                                  <Field label="Prazo"><Input type="date" name="nextStepDue" defaultValue={o.next_step_due?.toISOString().slice(0, 10) ?? ""} /></Field>
                                </div>
                                <Button type="submit" variant="outline">Salvar</Button>
                              </ActionForm>
                            </Modal>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}
