import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PATIENT_SOURCE_LABELS, PATIENT_SOURCES, whatsappLink, type PatientSource } from "@/domain/contact";
import { Compass } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, Modal } from "@/components/client";
import { Avatar, Badge, Button, buttonClass, Card, CardTitle, Empty, Field, Input, Notice, Select, Table, Textarea } from "@/components/ui";
import { can } from "@/domain/permissions";
import { APPOINTMENT_STATUS_LABELS, OPPORTUNITY_STAGE_LABELS, type AppointmentStatus, type OpportunityStage } from "@/domain/states";
import { formatFull, formatShort } from "@/lib/datetime";
import { cn, formatPhone } from "@/lib/format";
import { maskPhone } from "@/lib/crypto";
import { mergePatientsAction, savePatientAction, unlinkContactAction } from "../actions";

export const metadata = { title: "Ficha do paciente" };

export default async function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("patients.view");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const canWrite = can(ctx.role, "patients.write");
  const seesConversations = can(ctx.role, "conversations.view");
  const data = await q(ctx, async (tx) => {
    const [own] = ctx.role === "dentista" && ctx.userId ? await tx<{ id: string }[]>`select id from professionals where app_user_id = ${ctx.userId}` : [];
    const [patient] = await tx<{ id: string; full_name: string; birth_date: string | null; notes: string | null; has_cpf: boolean; merged_into_patient_id: string | null; created_at: Date; email: string | null; source: PatientSource | null; source_detail: string | null }[]>`
      select id, full_name, birth_date::text, notes, cpf_encrypted is not null as has_cpf, merged_into_patient_id, created_at, email, source, source_detail from patients where id = ${id}
        ${ctx.role === "dentista" ? tx`and exists (select 1 from appointments a where a.patient_id = patients.id and a.professional_id = ${own?.id ?? null})` : tx``}`;
    if (!patient) return null;
    const links = await tx<{ id: string; contact_id: string; phone_e164: string; wa_profile_name: string | null; relationship: string; is_guardian: boolean; is_payer: boolean; verified_at: Date | null; opted_out_at: Date | null }[]>`
      select l.id, l.contact_id, ct.phone_e164, ct.wa_profile_name, l.relationship, l.is_guardian, l.is_payer, l.verified_at, ct.opted_out_at
      from contact_patient_links l join contacts ct on ct.id = l.contact_id where l.patient_id = ${id} order by l.created_at`;
    const appointments = await tx<{ id: string; starts_at: Date; status: AppointmentStatus; service: string; professional: string; created_by_type: string }[]>`
      select a.id, a.starts_at, a.status, s.name as service, pr.name as professional, a.created_by_type
      from appointments a join services s on s.id = a.service_id join professionals pr on pr.id = a.professional_id
      where a.patient_id = ${id} order by a.starts_at desc limit 50`;
    const opportunities = can(ctx.role, "crm.view") ? await tx<{ id: string; service_interest: string; stage: OpportunityStage; updated_at: Date }[]>`
      select id, service_interest, stage, updated_at from opportunities where patient_id = ${id} or contact_id = any(${links.map((l) => l.contact_id)}::uuid[]) order by updated_at desc limit 20` : [];
    const conversations = seesConversations ? await tx<{ id: string; state: string; summary: string | null; summary_by: string | null; last_message_at: Date | null }[]>`
      select id, state, summary, summary_by, last_message_at from conversations where contact_id = any(${links.map((l) => l.contact_id)}::uuid[]) order by last_message_at desc nulls last limit 10` : [];
    const tasks = await tx<{ id: string; title: string; detail: string | null }[]>`
      select id, title, detail from tasks where status = 'open' and (contact_id = any(${links.map((l) => l.contact_id)}::uuid[]) or appointment_id = any(${appointments.map((a) => a.id)}::uuid[])) limit 10`;
    const others = can(ctx.role, "patients.merge") ? await tx<{ id: string; full_name: string; birth_date: string | null }[]>`
      select id, full_name, birth_date::text from patients where id <> ${id} and merged_into_patient_id is null order by full_name limit 1000` : [];
    return { patient, links, appointments, opportunities, conversations, tasks, others };
  });
  if (!data) notFound();
  const p = data.patient;
  const fullPhone = ctx.role !== "dentista";

  const age = (() => {
    if (!p.birth_date) return null;
    const [y, m, d] = p.birth_date.split("-").map(Number) as [number, number, number];
    const now = new Date();
    let years = now.getFullYear() - y;
    if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) years--;
    return years;
  })();
  const next = data.appointments.filter((a) => a.starts_at > new Date() && ["scheduled", "confirmed"].includes(a.status)).at(-1);
  const last = data.appointments.find((a) => a.starts_at <= new Date() && a.status === "completed");
  const mainPhone = data.links[0];

  return (
    <>
      <Link href="/pacientes" className={cn(buttonClass("ghost", "sm"), "-ml-3 mb-4")}><ArrowLeft aria-hidden /> Pacientes</Link>
      {p.merged_into_patient_id && <div className="mb-6"><Notice tone="sun">Este cadastro foi mesclado. <Link className="font-semibold underline" href={`/pacientes/${p.merged_into_patient_id}`}>Abrir o cadastro principal</Link></Notice></div>}

      {/* Cabeçalho da ficha: identidade e os fatos que a recepção mais consulta, numa linha só. */}
      <Card className="mb-6">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <Avatar name={p.full_name} size={56} />
          <div className="min-w-0 flex-1">
            <h1 className="t-h1 text-[28px] lg:text-[30px]">{p.full_name}</h1>
            {p.source && (
              <p className="mt-2 inline-flex max-w-full items-center gap-2 rounded-full bg-acento/12 py-1 pl-1.5 pr-3 text-[13px]" title={p.source_detail ?? undefined}>
                <span className="icone-app size-6 rounded-full"><Compass size={13} aria-hidden /></span>
                <span className="truncate">Veio por <strong>{PATIENT_SOURCE_LABELS[p.source]}</strong>{p.source_detail ? <span className="text-bone-dim"> · {p.source_detail}</span> : null}</span>
              </p>
            )}
            <p className="t-small mt-1">Cadastro desde {new Intl.DateTimeFormat("pt-BR").format(p.created_at)}{p.email ? ` · ${p.email}` : ""}<span className="simples:hidden"> · CPF {p.has_cpf ? "cadastrado (criptografado)" : "não informado"}</span></p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canWrite && (
              <Modal trigger="Editar cadastro" title="Editar cadastro" description="Dados administrativos. Não registre informação clínica." triggerClass={buttonClass("outline")}>
                <ActionForm action={savePatientAction} className="space-y-5" resetOnDone={false}>
                  <input type="hidden" name="patientId" value={p.id} />
                  <Field label="Nome completo"><Input name="fullName" defaultValue={p.full_name} required /></Field>
                  <div className="grid gap-6 sm:grid-cols-2">
                    <Field label="Data de nascimento"><Input type="date" name="birthDate" defaultValue={p.birth_date ?? ""} /></Field>
                    <Field label="CPF (opcional)" hint="Fica criptografado e nunca vai para a IA. Em branco mantém o atual."><Input name="cpf" inputMode="numeric" autoComplete="off" /></Field>
                    <Field label="E-mail"><Input name="email" type="email" defaultValue={p.email ?? ""} /></Field>
                    <Field label="Como conheceu a clínica"><Select name="source" defaultValue={p.source ?? ""}><option value="">Não informado</option>{PATIENT_SOURCES.map((k) => <option key={k} value={k}>{PATIENT_SOURCE_LABELS[k]}</option>)}</Select></Field>
                  </div>
                  <Field label="Observações administrativas"><Textarea name="notes" defaultValue={p.notes ?? ""} className="min-h-16" /></Field>
                  <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Salvar</Button></div>
                </ActionForm>
              </Modal>
            )}
            {data.others.length > 0 && !p.merged_into_patient_id && (
              <Modal trigger="Mesclar duplicado" title="Mesclar cadastro duplicado" description="Use quando o mesmo paciente foi cadastrado duas vezes. Consultas e contatos passam para este cadastro e a ação fica na auditoria." triggerClass={buttonClass("ghost")}>
                <ActionForm action={mergePatientsAction} className="space-y-5">
                  <input type="hidden" name="keepId" value={p.id} />
                  <Field label="Cadastro duplicado (será incorporado a este)">
                    <Select name="duplicateId" required defaultValue=""><option value="" disabled>Escolha…</option>{data.others.map((o) => <option key={o.id} value={o.id}>{o.full_name}{o.birth_date ? ` (${o.birth_date.split("-").reverse().join("/")})` : ""}</option>)}</Select>
                  </Field>
                  <div className="flex justify-end border-t border-line pt-5"><Button type="submit" variant="danger">Mesclar neste cadastro</Button></div>
                </ActionForm>
              </Modal>
            )}
            {can(ctx.role, "agenda.write") && <Link href="/agenda?nova=1" className={buttonClass("primary")}>Agendar</Link>}
          </div>
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line lg:grid-cols-4">
          {[
            ["Idade", age != null ? `${age} anos` : "—", p.birth_date ? `Nasceu em ${p.birth_date.split("-").reverse().join("/")}` : "Nascimento não informado"],
            ["WhatsApp", mainPhone ? (fullPhone ? formatPhone(mainPhone.phone_e164) : maskPhone(mainPhone.phone_e164)) : "—", data.links.length > 1 ? `+${data.links.length - 1} contato(s)` : mainPhone ? (mainPhone.relationship === "self" ? "do próprio paciente" : "de um responsável") : "sem telefone"],
            ["Última consulta", last ? formatShort(last.starts_at, ctx.tz) : "—", last ? last.service : "nenhuma concluída"],
            ["Próxima consulta", next ? formatShort(next.starts_at, ctx.tz) : "—", next ? next.service : "nada marcado"],
          ].map(([k, v, hint]) => (
            <div key={k} className="bg-surface px-5 py-4">
              <dt className="eyebrow text-bone-mute">{k}</dt>
              <dd className="mt-1.5 text-[17px] font-semibold">{v}</dd>
              <dd className="t-small truncate">{hint}</dd>
            </div>
          ))}
        </dl>
        {p.notes && <p className="mt-4 rounded-sm border-l-2 border-gold/70 bg-gold/[0.07] px-4 py-2.5 text-[13.5px]"><span className="font-medium">Observação:</span> {p.notes}</p>}
        {data.tasks.length > 0 && <div className="mt-4"><Notice tone="sun"><strong>Tarefas abertas:</strong> {data.tasks.map((t) => t.title).join(" · ")}</Notice></div>}
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardTitle hint={`${data.appointments.length} registro${data.appointments.length === 1 ? "" : "s"}, do mais recente ao mais antigo.`}>Consultas</CardTitle>
          {data.appointments.length === 0 ? <p className="t-small">Nenhuma consulta ainda.</p> : (
            <Table head={["Quando", "Serviço", "Dentista", "Situação"]}>
              {data.appointments.map((a) => (
                <tr key={a.id}><td className="whitespace-nowrap">{formatShort(a.starts_at, ctx.tz)}</td><td>{a.service}<span className="t-small block">{a.created_by_type === "ai" ? "marcada pela assistente" : "marcada pela equipe"}</span></td><td>{a.professional}</td>
                  <td><Badge tone={a.status === "completed" ? "ok" : a.status === "no_show" ? "danger" : a.status === "cancelled" ? "neutral" : "info"}>{APPOINTMENT_STATUS_LABELS[a.status]}</Badge></td></tr>
              ))}
            </Table>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardTitle hint="Quem fala por este paciente no WhatsApp.">Contatos e responsáveis</CardTitle>
            {data.links.length === 0 ? <p className="t-small">Sem telefone vinculado. Vincule pela tela de Conversas.</p> : (
              <ul className="divide-y divide-line">
                {data.links.map((l) => (
                  <li key={l.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-3">
                      <p className="t-h3 font-mono text-[14px]">{fullPhone ? formatPhone(l.phone_e164) : maskPhone(l.phone_e164)}</p>
                      {fullPhone && <a href={whatsappLink(l.phone_e164)} target="_blank" rel="noopener noreferrer" className={buttonClass("ghost", "sm") + " text-[#25D366]"} title="Abre o WhatsApp (Web ou app) com este número">WhatsApp</a>}
                      {canWrite && <ActionForm action={unlinkContactAction}><input type="hidden" name="linkId" value={l.id} /><button className={buttonClass("ghost", "sm")}>Desvincular</button></ActionForm>}
                    </div>
                    {l.wa_profile_name && <p className="t-small">{l.wa_profile_name}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge>{l.relationship === "self" ? "o próprio paciente" : `${l.relationship} do titular`}</Badge>
                      {l.is_guardian && <Badge tone="sun">responsável</Badge>}
                      {l.is_payer && <Badge>pagador</Badge>}
                      {l.verified_at && <Badge tone="ok">verificado</Badge>}
                      {l.opted_out_at && <Badge tone="danger">não receber mensagens</Badge>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {can(ctx.role, "crm.view") && (
            <Card>
              <CardTitle action={<Link href="/crm" className={buttonClass("outline", "sm")}>Abrir CRM</Link>}>Interesses</CardTitle>
              {data.opportunities.length === 0 ? <p className="t-small">Nenhum interesse registrado.</p> : (
                <ul className="divide-y divide-line">{data.opportunities.map((o) => (
                  <li key={o.id} className="flex h-11 items-center justify-between gap-3"><span className="truncate text-[14px]">{o.service_interest}</span><Badge tone="violet">{OPPORTUNITY_STAGE_LABELS[o.stage]}</Badge></li>
                ))}</ul>
              )}
            </Card>
          )}
          {seesConversations && (
            <Card>
              <CardTitle hint="Resumos são apoio administrativo, não evolução clínica.">Conversas</CardTitle>
              {data.conversations.length === 0 ? <p className="t-small">Nenhuma conversa.</p> : (
                <ul className="divide-y divide-line">{data.conversations.map((c) => (
                  <li key={c.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-3"><span className="t-small font-mono">{c.last_message_at ? formatShort(c.last_message_at, ctx.tz) : "—"}</span><Link href={`/conversas?c=${c.id}`} className={buttonClass("ghost", "sm")}>Abrir</Link></div>
                    <p className="mt-1 text-[13.5px] text-bone-dim">{c.summary ?? "Sem resumo."}</p>
                  </li>
                ))}</ul>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
