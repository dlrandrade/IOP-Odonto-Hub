import Link from "next/link";
import { DragCard, DropColumn } from "@/components/kanban";
import { Bot, CalendarCheck, CalendarClock, Hand, Info, Plus, UserRound } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, Modal } from "@/components/client";
import { Badge, Button, buttonClass, Field, Input, PageHeader, Select } from "@/components/ui";
import { can } from "@/domain/permissions";
import { OPPORTUNITY_STAGES, OPPORTUNITY_STAGE_LABELS, type OpportunityStage } from "@/domain/states";
import { formatShort } from "@/lib/datetime";
import { cn, formatPhone } from "@/lib/format";
import { createOpportunityAction, moveOpportunityAction, updateOpportunityAction } from "./actions";

export const metadata = { title: "Oportunidades" };

type Opp = {
  id: string; stage: OpportunityStage; service_interest: string; intent: string | null; next_step: string | null; next_step_due: Date | null; lost_reason: string | null;
  owner_id: string | null; owner: string | null; contact_id: string | null; phone_e164: string | null; wa_profile_name: string | null; patient: string | null; patient_id: string | null; updated_at: Date; last_actor: string | null; conversation_id: string | null;
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
             ct.phone_e164, ct.wa_profile_name, p.full_name as patient, o.patient_id, o.updated_at,
             (select e.actor from opportunity_events e where e.opportunity_id = o.id order by e.created_at desc limit 1) as last_actor,
             (select c.id from conversations c where c.contact_id = o.contact_id order by c.created_at desc limit 1) as conversation_id
      from opportunities o left join contacts ct on ct.id = o.contact_id left join patients p on p.id = o.patient_id left join app_users u on u.id = o.owner_id
      where (${showClosed} or o.stage not in ('accepted','lost') or o.updated_at > now() - interval '14 days')
        ${ctx.role === "dentista" ? tx`and exists (select 1 from appointments a where (a.contact_id = o.contact_id or a.patient_id = o.patient_id) and a.professional_id = ${own?.id ?? null})` : tx``}
      order by o.updated_at desc limit 400`;
    const services = await tx<{ id: string; name: string }[]>`select id, name from services order by name`;
    const users = await tx<{ id: string; name: string }[]>`select id, name from app_users where active order by name`;
    const contacts = canWrite ? await tx<{ id: string; label: string }[]>`
      select ct.id, coalesce(ct.wa_profile_name, '') || ' ' || ct.phone_e164 as label from contacts ct where not ct.is_test order by ct.created_at desc limit 300` : [];
    return { opps, services, users, contacts };
  });

  return (
    <>
      <PageHeader title="Oportunidades" subtitle="Acompanhe cada paciente do primeiro contato até o tratamento aceito.">
        <Link href={showClosed ? "/crm" : "/crm?fechadas=1"} className={buttonClass("outline")}>{showClosed ? "Ocultar antigas" : "Mostrar todas as finalizadas"}</Link>
        {canWrite && (
          <Modal trigger={<><Plus size={15} aria-hidden /> Nova oportunidade</>} title="Nova oportunidade" description="Registre o interesse de um contato em um serviço. Entra na coluna “Novo”." triggerClass={buttonClass("accent")}>
            <ActionForm action={createOpportunityAction} className="space-y-4">
              <Field label="Contato existente"><Select name="contactId" defaultValue=""><option value="">— novo contato —</option>{data.contacts.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
              <div className="grid gap-6 sm:grid-cols-2"><Field label="Ou telefone (com DDD)"><Input name="phone" inputMode="tel" /></Field><Field label="Nome"><Input name="name" /></Field></div>
              <Field label="Serviço de interesse"><Select name="serviceId" defaultValue=""><option value="">Outro / não definido</option>{data.services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
              <Field label="Descrição do interesse"><Input name="interest" required placeholder="Ex.: implante no dente da frente" /></Field>
              <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Criar</Button></div>
            </ActionForm>
          </Modal>
        )}
      </PageHeader>

      <ul className="-mt-4 mb-6 flex flex-wrap gap-2" aria-label="Como funciona">
        {[
          [Hand, "Arraste o cartão para mudar o estágio"],
          [CalendarCheck, "Consultas agendadas entram aqui sozinhas"],
          [Info, "Interesse não é tratamento contratado"],
        ].map(([Icon, text]) => {
          const I = Icon as typeof Hand;
          return <li key={String(text)} className="inline-flex h-8 items-center gap-2 rounded-sm border border-line bg-surface/60 px-3 text-[12.5px] text-bone-dim"><I size={14} aria-hidden className="text-acento" />{String(text)}</li>;
        })}
      </ul>
      {/* Funil em largura total: as colunas dividem a tela igualmente, sem rolagem lateral escondida. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 min-[1760px]:grid-cols-8">
          {OPPORTUNITY_STAGES.map((stage) => {
            const list = data.opps.filter((o) => o.stage === stage);
            const tone = stage === "accepted" ? "vidro bg-ok-soft/50" : stage === "lost" ? "vidro opacity-90" : "vidro";
            return (
              <DropColumn key={stage} stage={stage} label={OPPORTUNITY_STAGE_LABELS[stage]} move={moveOpportunityAction} enabled={canWrite}
                className={cn("flex min-h-[220px] min-w-0 flex-col rounded-lg p-3", tone)}>
                <h2 className="flex h-9 items-center justify-between gap-2 px-1.5">
                  <span className="t-h3 truncate text-[14px]">{OPPORTUNITY_STAGE_LABELS[stage]}</span>
                  <span className="flex h-6 min-w-6 items-center justify-center rounded-sm bg-surface-2 px-1.5 font-mono text-[11px] text-bone-dim">{list.length}</span>
                </h2>
                <ul className="mt-2 flex-1 space-y-2">
                  {list.length === 0 && <li className="flex h-20 items-center justify-center rounded-md border border-dashed border-line text-[12px] text-bone-mute">Solte aqui</li>}
                  {list.map((o) => {
                    const overdue = o.next_step_due && o.next_step_due < new Date() && !["accepted", "lost"].includes(o.stage);
                    return (
                      <DragCard key={o.id} id={o.id} enabled={canWrite} className="rounded-md border border-line bg-surface/80 p-3.5 shadow-[inset_0_1px_0_var(--glass-shine)] transition-colors hover:border-bone-mute/50">
                        {o.patient_id ? (
                          <Link href={`/pacientes/${o.patient_id}`} draggable={false} className="t-h3 block truncate text-[14px] underline-offset-2 hover:underline" title="Abrir ficha do paciente">{o.patient ?? "Paciente"}</Link>
                        ) : <p className="t-h3 truncate text-[14px]">{o.wa_profile_name ?? (o.phone_e164 ? formatPhone(o.phone_e164) : "Sem nome")}</p>}
                        <p className="t-small truncate">{o.service_interest}</p>
                        <div className="mt-2.5 flex flex-wrap gap-1">
                          {o.intent && <Badge>{INTENT[o.intent]}</Badge>}
                          {o.last_actor === "ai" && <Badge tone="info"><Bot aria-hidden /> pela IA</Badge>}
                          {o.owner && <Badge tone="violet"><UserRound aria-hidden /> {o.owner.split(" ")[0]}</Badge>}
                        </div>
                        {(o.next_step || o.next_step_due) && (
                          <p className={cn("mt-2 flex items-center gap-1 text-[11px]", overdue ? "font-semibold text-danger" : "text-bone-dim")}>
                            <CalendarClock size={11} aria-hidden /> {o.next_step ?? "Próximo passo"}{o.next_step_due ? ` · ${formatShort(o.next_step_due, ctx.tz).slice(0, 5)}${overdue ? " (atrasado)" : ""}` : ""}
                          </p>
                        )}
                        {o.lost_reason && <p className="mt-2 text-[11px] text-bone-mute">Motivo: {o.lost_reason}</p>}
                        <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
                          {o.conversation_id && can(ctx.role, "conversations.view") ? <Link href={`/conversas?c=${o.conversation_id}`} className={buttonClass("ghost", "sm")}>Conversa</Link> : o.patient_id ? <Link href={`/pacientes/${o.patient_id}`} className={buttonClass("ghost", "sm")}>Ficha</Link> : <span />}
                          {canWrite && (
                            <Modal trigger="Mover / editar" title={o.patient ?? o.wa_profile_name ?? (o.phone_e164 ? formatPhone(o.phone_e164) : "Sem nome")} description={`${o.service_interest} · hoje em “${OPPORTUNITY_STAGE_LABELS[o.stage]}”`} triggerClass={buttonClass("outline", "sm")}>
                              <h3 className="t-h3 mb-4">Mudar de estágio</h3>
                              <ActionForm action={moveOpportunityAction} className="space-y-5">
                                <input type="hidden" name="opportunityId" value={o.id} />
                                <Field label="Mover para"><Select name="to" defaultValue="">{OPPORTUNITY_STAGES.filter((s) => s !== o.stage).map((s) => <option key={s} value={s}>{OPPORTUNITY_STAGE_LABELS[s]}</option>)}</Select></Field>
                                <Field label="Evidência do aceite" hint="Obrigatória para “Aceito”: o que comprova (mensagem, assinatura, registro)."><Input name="evidence" /></Field>
                                <Field label="Motivo da perda" hint="Obrigatório para “Perdido”."><Input name="lostReason" /></Field>
                                <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Mover</Button></div>
                              </ActionForm>
                              <h3 className="t-h3 mb-4 mt-8 border-t border-line pt-6">Responsável e próximo passo</h3>
                              <ActionForm action={updateOpportunityAction} className="space-y-5">
                                <input type="hidden" name="opportunityId" value={o.id} />
                                <Field label="Responsável"><Select name="ownerId" defaultValue={o.owner_id ?? ""}><option value="">Sem responsável</option>{data.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
                                <div className="grid gap-6 sm:grid-cols-2">
                                  <Field label="Próximo passo"><Input name="nextStep" defaultValue={o.next_step ?? ""} /></Field>
                                  <Field label="Prazo"><Input type="date" name="nextStepDue" defaultValue={o.next_step_due?.toISOString().slice(0, 10) ?? ""} /></Field>
                                </div>
                                <div className="flex justify-end border-t border-line pt-5"><Button type="submit" variant="outline">Salvar</Button></div>
                              </ActionForm>
                            </Modal>
                          )}
                        </div>
                      </DragCard>
                    );
                  })}
                </ul>
              </DropColumn>
            );
          })}
      </div>
    </>
  );
}
