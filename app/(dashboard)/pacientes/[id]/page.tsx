import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, Modal } from "@/components/client";
import { Avatar, Badge, Button, buttonClass, Card, CardTitle, Empty, Field, Input, Notice, Select, Table, Textarea } from "@/components/ui";
import { can } from "@/domain/permissions";
import { APPOINTMENT_STATUS_LABELS, OPPORTUNITY_STAGE_LABELS, type AppointmentStatus, type OpportunityStage } from "@/domain/states";
import { formatFull, formatShort } from "@/lib/datetime";
import { formatPhone } from "@/lib/format";
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
    const [patient] = await tx<{ id: string; full_name: string; birth_date: string | null; notes: string | null; has_cpf: boolean; merged_into_patient_id: string | null; created_at: Date }[]>`
      select id, full_name, birth_date::text, notes, cpf_encrypted is not null as has_cpf, merged_into_patient_id, created_at from patients where id = ${id}
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

  return (
    <>
      <Link href="/pacientes" className="mb-3 inline-flex items-center gap-1 text-sm font-semibold"><ArrowLeft size={15} aria-hidden /> Pacientes</Link>
      {p.merged_into_patient_id && <div className="mb-3"><Notice tone="sun">Este cadastro foi mesclado. <Link className="font-semibold underline" href={`/pacientes/${p.merged_into_patient_id}`}>Abrir o cadastro principal</Link></Notice></div>}
      <div className="grid gap-3 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className="space-y-3">
          <Card>
            <div className="flex items-center gap-3"><Avatar name={p.full_name} size={52} /><div><h1 className="text-xl font-bold leading-tight">{p.full_name}</h1><p className="text-xs text-bone-mute">Cadastro desde {new Intl.DateTimeFormat("pt-BR").format(p.created_at)}</p></div></div>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-bone-mute">Nascimento</dt><dd>{p.birth_date ? p.birth_date.split("-").reverse().join("/") : "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-bone-mute">CPF</dt><dd>{p.has_cpf ? "cadastrado (criptografado)" : "não informado"}</dd></div>
            </dl>
            {p.notes && <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-sm">{p.notes}</p>}
            {canWrite && (
              <div className="mt-4">
                <Modal trigger="Editar cadastro" title="Editar cadastro" triggerClass={buttonClass("outline", "sm")}>
                  <ActionForm action={savePatientAction} className="space-y-4" resetOnDone={false}>
                    <input type="hidden" name="patientId" value={p.id} />
                    <Field label="Nome completo"><Input name="fullName" defaultValue={p.full_name} required /></Field>
                    <Field label="Data de nascimento"><Input type="date" name="birthDate" defaultValue={p.birth_date ?? ""} /></Field>
                    <Field label="CPF (opcional)" hint="Peça apenas com finalidade definida (ex.: nota fiscal). Fica criptografado e nunca é enviado à IA. Deixe em branco para manter."><Input name="cpf" inputMode="numeric" autoComplete="off" /></Field>
                    <Field label="Observações administrativas"><Textarea name="notes" defaultValue={p.notes ?? ""} className="min-h-16" /></Field>
                    <Button type="submit">Salvar</Button>
                  </ActionForm>
                </Modal>
              </div>
            )}
          </Card>
          <Card>
            <CardTitle hint="Quem fala por este paciente no WhatsApp">Contatos e responsáveis</CardTitle>
            {data.links.length === 0 ? <p className="text-sm text-bone-mute">Sem telefone vinculado. Vincule pela tela de Conversas.</p> : (
              <ul className="space-y-3">
                {data.links.map((l) => (
                  <li key={l.id} className="text-sm">
                    <p className="font-medium">{fullPhone ? formatPhone(l.phone_e164) : maskPhone(l.phone_e164)} {l.wa_profile_name && <span className="font-normal text-bone-mute">· {l.wa_profile_name}</span>}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <Badge>{l.relationship === "self" ? "o próprio paciente" : `é ${l.relationship} do titular do telefone`}</Badge>
                      {l.is_guardian && <Badge tone="sun">responsável</Badge>}
                      {l.is_payer && <Badge>pagador</Badge>}
                      {l.verified_at && <Badge tone="ok">identidade verificada</Badge>}
                      {l.opted_out_at && <Badge tone="danger">não receber mensagens</Badge>}
                      {canWrite && <ActionForm action={unlinkContactAction}><input type="hidden" name="linkId" value={l.id} /><button className="text-[11px] text-bone-mute underline">desvincular</button></ActionForm>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {data.others.length > 0 && !p.merged_into_patient_id && (
            <Card>
              <CardTitle hint="Use quando o mesmo paciente foi cadastrado duas vezes. A ação fica registrada na auditoria.">Mesclar duplicado</CardTitle>
              <ActionForm action={mergePatientsAction} className="space-y-3">
                <input type="hidden" name="keepId" value={p.id} />
                <Field label="Cadastro duplicado (será incorporado a este)">
                  <Select name="duplicateId" required defaultValue=""><option value="" disabled>Escolha…</option>{data.others.map((o) => <option key={o.id} value={o.id}>{o.full_name}{o.birth_date ? ` (${o.birth_date.split("-").reverse().join("/")})` : ""}</option>)}</Select>
                </Field>
                <Button size="sm" variant="outline">Mesclar neste cadastro</Button>
              </ActionForm>
            </Card>
          )}
        </div>
        <div className="space-y-3">
          {data.tasks.length > 0 && <Notice tone="sun"><strong>Tarefas abertas:</strong> {data.tasks.map((t) => t.title).join(" · ")}</Notice>}
          <Card>
            <CardTitle action={can(ctx.role, "agenda.write") ? <Link href="/agenda" className="text-xs font-semibold underline">Agendar</Link> : undefined}>Consultas</CardTitle>
            {data.appointments.length === 0 ? <Empty title="Nenhuma consulta" /> : (
              <Table head={["Quando", "Serviço", "Dentista", "Status", "Origem"]}>
                {data.appointments.map((a) => (
                  <tr key={a.id}><td>{formatFull(a.starts_at, ctx.tz)}</td><td>{a.service}</td><td>{a.professional}</td>
                    <td><Badge tone={a.status === "completed" ? "ok" : a.status === "no_show" ? "danger" : a.status === "cancelled" ? "neutral" : "sun"}>{APPOINTMENT_STATUS_LABELS[a.status]}</Badge></td>
                    <td className="text-xs text-bone-mute">{a.created_by_type === "ai" ? "IA" : "Equipe"}</td></tr>
                ))}
              </Table>
            )}
          </Card>
          {can(ctx.role, "crm.view") && (
            <Card>
              <CardTitle action={<Link href="/crm" className="text-xs font-semibold underline">Abrir CRM</Link>}>Interesses</CardTitle>
              {data.opportunities.length === 0 ? <Empty title="Nenhum interesse registrado" /> : (
                <ul className="divide-y divide-line">{data.opportunities.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-2 py-2 text-sm"><span>{o.service_interest}</span><Badge>{OPPORTUNITY_STAGE_LABELS[o.stage]}</Badge></li>
                ))}</ul>
              )}
            </Card>
          )}
          {seesConversations && (
            <Card>
              <CardTitle hint="Resumos são apoio administrativo, não evolução clínica.">Conversas</CardTitle>
              {data.conversations.length === 0 ? <Empty title="Nenhuma conversa" /> : (
                <ul className="space-y-3">{data.conversations.map((c) => (
                  <li key={c.id} className="rounded-2xl border border-line p-3 text-sm">
                    <div className="flex items-center justify-between gap-2"><span className="text-xs text-bone-mute">{c.last_message_at ? formatShort(c.last_message_at, ctx.tz) : "—"}</span><Link href={`/conversas?c=${c.id}`} className="text-xs font-semibold underline">Abrir conversa</Link></div>
                    <p className="mt-1">{c.summary ?? <span className="text-bone-mute">Sem resumo.</span>}</p>
                    {c.summary && <p className="mt-1 text-[11px] text-bone-mute">{c.summary_by === "ai" ? "Resumo gerado por IA" : "Resumo editado pela equipe"}</p>}
                  </li>
                ))}</ul>
              )}
            </Card>
          )}
          <Card><CardTitle>Propostas e pagamentos</CardTitle><p className="text-sm text-bone-mute">Disponíveis no módulo P1 (propostas versionadas e registro de pagamentos).</p></Card>
        </div>
      </div>
    </>
  );
}
