import Link from "next/link";
import { AlertTriangle, ArrowLeft, Bot, Check, CheckCheck, Clock, Mic, Search, StickyNote, UserRound, XCircle } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, LiveRefresh, Modal, ScrollToEnd } from "@/components/client";
import { Avatar, Badge, Button, buttonClass, Card, Checkbox, Empty, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import { can } from "@/domain/permissions";
import { CONVERSATION_STATE_LABELS, type ConversationState } from "@/domain/states";
import { formatFull, formatShort, localTime } from "@/lib/datetime";
import { cn, formatPhone } from "@/lib/format";
import { contactFlagsAction, conversationStateAction, editTranscriptAction, killSwitchAction, linkPatientAction, saveSummaryAction, sendMessageAction, sendTemplateAction } from "./actions";

export const metadata = { title: "Conversas" };

const FILTERS = [
  ["abertas", "Abertas"], ["minhas", "Minhas"], ["nao-atribuidas", "Não atribuídas"], ["ia", "IA ativa"], ["humano", "Humano ativo"],
  ["aguardando-paciente", "Aguardando paciente"], ["urgentes", "Urgentes"], ["encerradas", "Encerradas"],
] as const;

type Row = {
  id: string; state: ConversationState; channel: string; assigned_to: string | null; assignee: string | null; unread_count: number;
  last_message_at: Date | null; last_message_preview: string | null; handoff_priority: string | null; phone_e164: string; wa_profile_name: string | null; patient_name: string | null;
};
type Message = {
  id: string; direction: string; sender_type: string; sender: string | null; type: string; body: string | null; media_path: string | null; wa_media_id: string | null;
  transcript: string | null; transcript_original: string | null; transcript_status: string | null; delivery_status: string; error: string | null; created_at: Date;
};

const STATE_TONE: Record<ConversationState, "ok" | "warn" | "navy" | "neutral"> = { ai_active: "ok", awaiting_human: "warn", human_active: "navy", closed: "neutral" };

function DeliveryIcon({ status }: { status: string }) {
  if (status === "failed") return <span className="inline-flex items-center gap-0.5 text-danger"><XCircle size={12} aria-hidden /> falhou</span>;
  if (status === "read") return <span className="inline-flex items-center gap-0.5"><CheckCheck size={13} className="text-sky-600" aria-hidden /> lida</span>;
  if (status === "delivered") return <span className="inline-flex items-center gap-0.5"><CheckCheck size={13} aria-hidden /> entregue</span>;
  if (status === "sent") return <span className="inline-flex items-center gap-0.5"><Check size={13} aria-hidden /> enviada</span>;
  return <span className="inline-flex items-center gap-0.5"><Clock size={12} aria-hidden /> na fila</span>;
}

export default async function ConversationsPage({ searchParams }: { searchParams: Promise<{ f?: string; q?: string; c?: string }> }) {
  const ctx = await requireCtx("conversations.view");
  const sp = await searchParams;
  const filter = FILTERS.some(([k]) => k === sp.f) ? sp.f! : "abertas";
  const search = (sp.q ?? "").trim().slice(0, 80);
  const selectedId = /^[0-9a-f-]{36}$/.test(sp.c ?? "") ? sp.c! : null;
  const me = ctx.userId ?? "00000000-0000-0000-0000-000000000000";

  const data = await q(ctx, async (tx) => {
    const like = `%${search}%`;
    const [ownProf] = ctx.role === "dentista" && ctx.userId ? await tx<{ id: string }[]>`select id from professionals where app_user_id = ${ctx.userId}` : [];
    const where = {
      abertas: tx`c.state <> 'closed'`, minhas: tx`c.assigned_to = ${me} and c.state <> 'closed'`,
      "nao-atribuidas": tx`c.state = 'awaiting_human'`, ia: tx`c.state = 'ai_active'`, humano: tx`c.state = 'human_active'`,
      "aguardando-paciente": tx`c.state <> 'closed' and c.last_message_direction = 'outbound'`,
      urgentes: tx`c.state = 'awaiting_human' and c.handoff_priority = 'urgente'`, encerradas: tx`c.state = 'closed'`,
    }[filter as (typeof FILTERS)[number][0]];
    const rows = await tx<Row[]>`
      select c.id, c.state, c.channel, c.assigned_to, u.name as assignee, c.unread_count, c.last_message_at, c.last_message_preview, c.handoff_priority,
             ct.phone_e164, ct.wa_profile_name,
             (select p.full_name from contact_patient_links l join patients p on p.id = l.patient_id where l.contact_id = ct.id order by (l.relationship = 'self') desc, l.created_at limit 1) as patient_name
      from conversations c join contacts ct on ct.id = c.contact_id left join app_users u on u.id = c.assigned_to
      where ${where}
        ${search ? tx`and (ct.phone_e164 ilike ${like} or ct.wa_profile_name ilike ${like}
              or exists (select 1 from contact_patient_links l join patients p on p.id = l.patient_id where l.contact_id = ct.id and p.full_name ilike ${like})
              or exists (select 1 from messages m where m.conversation_id = c.id and m.body ilike ${like}))` : tx``}
        ${ctx.role === "dentista" ? tx`and exists (select 1 from appointments a where a.contact_id = ct.id and a.professional_id = ${ownProf?.id ?? null})` : tx``}
      order by (c.state = 'awaiting_human' and c.handoff_priority = 'urgente') desc, c.last_message_at desc nulls last limit 80`;

    const selected = selectedId ? rows.find((r) => r.id === selectedId) ?? (await tx<Row[]>`
      select c.id, c.state, c.channel, c.assigned_to, u.name as assignee, c.unread_count, c.last_message_at, c.last_message_preview, c.handoff_priority, ct.phone_e164, ct.wa_profile_name, null as patient_name
      from conversations c join contacts ct on ct.id = c.contact_id left join app_users u on u.id = c.assigned_to where c.id = ${selectedId}`)[0] : undefined;
    if (!selected) return { rows, selected: null };
    const [detail] = await tx<{ contact_id: string; summary: string | null; summary_by: string | null; summary_updated_at: Date | null; pending_notes: string | null; handoff_reason: string | null; window_expires_at: Date | null; opted_out_at: Date | null; excluded_from_metrics: boolean; is_test: boolean }[]>`
      select c.contact_id, c.summary, c.summary_by, c.summary_updated_at, c.pending_notes, c.handoff_reason, c.window_expires_at, ct.opted_out_at, ct.excluded_from_metrics, ct.is_test
      from conversations c join contacts ct on ct.id = c.contact_id where c.id = ${selected.id}`;
    const messages = (await tx<Message[]>`
      select m.id, m.direction, m.sender_type, u.name as sender, m.type, m.body, m.media_path, m.wa_media_id, m.transcript, m.transcript_original, m.transcript_status, m.delivery_status, m.error, m.created_at
      from messages m left join app_users u on u.id = m.sender_user_id where m.conversation_id = ${selected.id} order by m.created_at desc, m.id desc limit 200`).reverse();
    const patients = await tx<{ id: string; full_name: string; relationship: string; verified_at: Date | null }[]>`
      select p.id, p.full_name, l.relationship, l.verified_at from contact_patient_links l join patients p on p.id = l.patient_id
      where l.contact_id = ${detail!.contact_id} and p.merged_into_patient_id is null order by l.created_at`;
    const appointments = await tx<{ id: string; starts_at: Date; status: string; service: string; patient: string }[]>`
      select a.id, a.starts_at, a.status, s.name as service, p.full_name as patient from appointments a
      join services s on s.id = a.service_id join patients p on p.id = a.patient_id
      where a.patient_id = any(${patients.map((p) => p.id)}::uuid[]) and a.starts_at > now() - interval '1 day' and a.status in ('scheduled','confirmed')
      order by a.starts_at limit 5`;
    const users = await tx<{ id: string; name: string }[]>`select id, name from app_users where active and role <> 'financeiro' order by name`;
    const allPatients = await tx<{ id: string; full_name: string }[]>`select id, full_name from patients where merged_into_patient_id is null order by full_name limit 500`;
    const [template] = await tx`select 1 from message_templates where name = 'retomada_contato' and wa_template_status = 'approved'`;
    if (selected.unread_count > 0 && selected.assigned_to === ctx.userId) await tx`update conversations set unread_count = 0 where id = ${selected.id}`;
    return { rows, selected, detail: detail!, messages, patients, appointments, users, allPatients, hasTemplate: !!template };
  });

  const href = (params: Record<string, string | null>) => {
    const merged: Record<string, string | null> = { f: filter === "abertas" ? null : filter, q: search || null, c: selectedId, ...params };
    const qs = Object.entries(merged).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
    return qs ? `/conversas?${qs}` : "/conversas";
  };
  const sel = data.selected;
  const displayName = (r: Row) => r.patient_name ?? r.wa_profile_name ?? formatPhone(r.phone_e164);
  const inWindow = sel && "detail" in data && (sel.channel === "simulator" || (!!data.detail.window_expires_at && data.detail.window_expires_at > new Date()));
  const canReply = can(ctx.role, "conversations.reply");

  return (
    <div className="grid gap-3 lg:h-[calc(100dvh-8.5rem)] lg:grid-cols-[340px_minmax(0,1fr)_300px]">
      <LiveRefresh seconds={5} clinicId={ctx.clinicId} />

      {/* Lista */}
      <Card className={cn("flex min-h-0 flex-col p-0", sel && "hidden lg:flex")}>
        <div className="space-y-3 border-b border-cream-200 p-4">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold">Conversas</h1>
            {can(ctx.role, "ai.kill_switch") && (
              <ActionForm action={killSwitchAction}>
                <input type="hidden" name="on" value={String(!ctx.clinic.ai_kill_switch)} />
                <Button size="sm" variant={ctx.clinic.ai_kill_switch ? "accent" : "outline"} title="Interruptor global da IA">
                  <Bot size={13} aria-hidden /> {ctx.clinic.ai_kill_switch ? "Religar IA" : "Pausar IA"}
                </Button>
              </ActionForm>
            )}
          </div>
          <form className="relative" action="/conversas">
            {filter !== "abertas" && <input type="hidden" name="f" value={filter} />}
            <Search size={15} className="absolute left-3 top-3 text-navy-300" aria-hidden />
            <Input name="q" defaultValue={search} placeholder="Nome, telefone ou texto" aria-label="Buscar conversas" className="pl-9" />
          </form>
          <div className="scroll-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
            {FILTERS.map(([key, label]) => (
              <Link key={key} href={href({ f: key === "abertas" ? null : key, c: null })}
                className={cn("shrink-0 rounded-full px-3 py-1 text-xs font-medium", filter === key ? "bg-navy-900 text-white" : "bg-cream-100 text-navy-700 hover:bg-cream-200")}>{label}</Link>
            ))}
          </div>
        </div>
        <ul className="scroll-thin min-h-0 flex-1 divide-y divide-cream-100 overflow-y-auto">
          {data.rows.length === 0 && <li className="p-4"><Empty title="Nenhuma conversa aqui">Use o Simulador para testar o atendimento sem WhatsApp.</Empty></li>}
          {data.rows.map((r) => {
            const urgent = r.state === "awaiting_human" && r.handoff_priority === "urgente";
            return (
              <li key={r.id}>
                <Link href={href({ c: r.id })} className={cn("flex gap-3 px-4 py-3 hover:bg-cream-50", r.id === selectedId && "bg-sun-100", urgent && "border-l-4 border-danger")}>
                  <Avatar name={displayName(r)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate font-semibold">{displayName(r)}</p>
                      <span className="shrink-0 text-[11px] text-navy-500">{r.last_message_at ? formatShort(r.last_message_at, ctx.tz) : ""}</span>
                    </div>
                    <p className="truncate text-xs text-navy-500">{r.last_message_preview ?? "—"}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {urgent && <Badge tone="danger"><AlertTriangle size={10} aria-hidden /> Urgente</Badge>}
                      <Badge tone={STATE_TONE[r.state]}>{CONVERSATION_STATE_LABELS[r.state]}{r.assignee ? ` · ${r.assignee.split(" ")[0]}` : ""}</Badge>
                      {r.channel === "simulator" && <Badge>Simulador</Badge>}
                      {r.unread_count > 0 && <Badge tone="sun">{r.unread_count} nova{r.unread_count > 1 ? "s" : ""}</Badge>}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>

      {/* Histórico */}
      {!sel || !("detail" in data) ? (
        <Card className="hidden items-center justify-center lg:col-span-2 lg:flex"><Empty title="Selecione uma conversa">O histórico, a ficha e as ações aparecem aqui.</Empty></Card>
      ) : (
        <>
          <Card className="flex min-h-[70dvh] flex-col p-0 lg:min-h-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cream-200 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <Link href={href({ c: null })} aria-label="Voltar para a lista" className="rounded-full p-1.5 hover:bg-cream-100 lg:hidden"><ArrowLeft size={18} /></Link>
                <Avatar name={displayName(sel)} />
                <div className="min-w-0">
                  <p className="truncate font-semibold">{displayName(sel)}</p>
                  <p className="text-xs text-navy-500">{formatPhone(sel.phone_e164)} · <span className="font-medium">{CONVERSATION_STATE_LABELS[sel.state]}</span>{sel.assignee ? ` com ${sel.assignee}` : ""}</p>
                </div>
              </div>
              {canReply && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {sel.state !== "human_active" || sel.assigned_to !== ctx.userId ? (
                    <ActionForm action={conversationStateAction}><input type="hidden" name="conversationId" value={sel.id} /><input type="hidden" name="op" value="take" /><Button size="sm" variant="accent"><UserRound size={13} aria-hidden /> Assumir</Button></ActionForm>
                  ) : null}
                  {(sel.state === "human_active" || sel.state === "awaiting_human") && (
                    <Modal trigger={<><Bot size={13} aria-hidden /> Devolver à IA</>} title="Devolver à IA" triggerClass={buttonClass("primary", "sm")}>
                      <ActionForm action={conversationStateAction} className="space-y-4">
                        <input type="hidden" name="conversationId" value={sel.id} /><input type="hidden" name="op" value="handback" />
                        <Field label="Pendências para a IA (opcional)" hint="A IA recebe o resumo, as últimas mensagens e este texto, para não repetir perguntas já respondidas.">
                          <Textarea name="pending" placeholder="Ex.: paciente já informou que prefere manhã; falta escolher o dia." />
                        </Field>
                        <Button type="submit">Devolver</Button>
                      </ActionForm>
                    </Modal>
                  )}
                  <Modal trigger="Transferir" title="Transferir conversa" triggerClass={buttonClass("outline", "sm")}>
                    <ActionForm action={conversationStateAction} className="space-y-4">
                      <input type="hidden" name="conversationId" value={sel.id} /><input type="hidden" name="op" value="transfer" />
                      <Field label="Para quem?"><Select name="to" required>{data.users.filter((u) => u.id !== ctx.userId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
                      <Button type="submit">Transferir</Button>
                    </ActionForm>
                  </Modal>
                  {sel.state !== "closed" && (
                    <ActionForm action={conversationStateAction}><input type="hidden" name="conversationId" value={sel.id} /><input type="hidden" name="op" value="close" /><Button size="sm" variant="ghost">Encerrar</Button></ActionForm>
                  )}
                </div>
              )}
            </div>
            {sel.state === "awaiting_human" && (
              <div className={cn("flex items-center gap-2 px-4 py-2 text-sm font-medium", sel.handoff_priority === "urgente" ? "bg-danger text-white" : "bg-warn-soft text-warn")} role="alert">
                <AlertTriangle size={15} aria-hidden /> {sel.handoff_priority === "urgente" ? "ATENDIMENTO URGENTE — " : "Aguardando a equipe — "}{data.detail.handoff_reason}
              </div>
            )}
            <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto bg-cream-50 px-4 py-4">
              {data.messages.map((m) => {
                if (m.type === "note") {
                  return (
                    <div key={m.id} className="mx-auto flex max-w-[85%] items-start gap-2 rounded-xl bg-sun-100 px-3 py-2 text-xs text-navy-800">
                      <StickyNote size={13} className="mt-0.5 shrink-0" aria-hidden />
                      <span><span className="font-semibold">{m.sender_type === "system" ? "Sistema" : `Nota interna${m.sender ? ` · ${m.sender}` : ""}`}:</span> {m.body} <span className="text-navy-500">· {localTime(m.created_at, ctx.tz)}</span></span>
                    </div>
                  );
                }
                const out = m.direction === "outbound";
                const who = m.sender_type === "patient" ? "Paciente" : m.sender_type === "ai" ? ctx.clinic.assistant_name + " (IA)" : m.sender_type === "human" ? m.sender ?? "Equipe" : "Automação";
                return (
                  <div key={m.id} className={cn("flex", out ? "justify-end" : "justify-start")}>
                    <div className={cn("max-w-[78%] rounded-2xl px-3.5 py-2.5 shadow-sm", out ? (m.sender_type === "ai" ? "bg-navy-900 text-white" : "bg-navy-700 text-white") : "bg-white")}>
                      <p className={cn("mb-0.5 text-[10px] font-bold uppercase tracking-wider", out ? "text-sun-500" : "text-navy-500")}>{who}</p>
                      {m.type === "audio" && (
                        <div className="space-y-1.5">
                          <p className="flex items-center gap-1 text-xs"><Mic size={12} aria-hidden /> Áudio</p>
                          {(m.media_path || m.wa_media_id) && <audio controls preload="none" src={`/api/media/${m.id}`} className="h-9 w-56 max-w-full" />}
                          {m.transcript_status === "pending" && <p className="text-xs italic text-navy-500">Transcrevendo…</p>}
                          {m.transcript_status === "failed" && !m.transcript && <p className="text-xs italic text-warn">Não foi possível transcrever. O áudio original foi preservado.</p>}
                          {m.transcript && <p className="whitespace-pre-wrap text-sm">“{m.transcript}”{m.transcript !== m.transcript_original && <span className="text-[10px] text-navy-500"> (editada)</span>}</p>}
                          {canReply && (
                            <details className="text-xs"><summary className="cursor-pointer text-navy-500">Corrigir transcrição</summary>
                              <ActionForm action={editTranscriptAction} className="mt-1 space-y-1"><input type="hidden" name="messageId" value={m.id} /><Textarea name="transcript" defaultValue={m.transcript ?? ""} className="min-h-16 text-xs" required /><Button size="sm" variant="outline">Salvar</Button></ActionForm>
                            </details>
                          )}
                        </div>
                      )}
                      {m.type === "image" && (m.media_path || m.wa_media_id) && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/api/media/${m.id}`} alt="Imagem enviada pelo paciente" className="mb-1 max-h-64 rounded-xl" loading="lazy" />
                      )}
                      {m.type === "image" && !m.media_path && !m.wa_media_id && <p className="text-xs italic">📷 Imagem (simulada)</p>}
                      {m.type !== "audio" && m.body && <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>}
                      <p className={cn("mt-1 flex items-center justify-end gap-2 text-[10px]", out ? "text-navy-100" : "text-navy-500")}>
                        {m.type === "template" && <span>template</span>}
                        <time dateTime={m.created_at.toISOString()}>{formatShort(m.created_at, ctx.tz)}</time>
                        {out && <DeliveryIcon status={m.delivery_status} />}
                      </p>
                      {m.error && m.delivery_status === "failed" && <p className="mt-1 rounded bg-danger-soft px-2 py-1 text-[11px] text-danger">Falha no envio: {m.error}</p>}
                    </div>
                  </div>
                );
              })}
              <ScrollToEnd dep={data.messages.length} />
            </div>
            {canReply && (
              <div className="border-t border-cream-200 p-3">
                {!inWindow && (
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn">
                    <span>Janela de 24 h encerrada: o WhatsApp só permite template aprovado. Notas internas continuam liberadas.</span>
                    {data.hasTemplate && <ActionForm action={sendTemplateAction}><input type="hidden" name="conversationId" value={sel.id} /><Button size="sm" variant="outline">Enviar template de retomada</Button></ActionForm>}
                  </div>
                )}
                <ActionForm action={sendMessageAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="conversationId" value={sel.id} />
                  <Textarea name="body" required placeholder="Escreva sua resposta…" aria-label="Mensagem" className="min-h-11 flex-1 basis-64" rows={2} />
                  <Select name="mode" aria-label="Tipo de envio" className="w-auto" defaultValue={inWindow ? "message" : "note"}>
                    <option value="message" disabled={!inWindow}>Enviar ao paciente</option>
                    <option value="note">Nota interna</option>
                  </Select>
                  <Button type="submit">Enviar</Button>
                </ActionForm>
                {sel.state !== "human_active" && <p className="mt-1 text-[11px] text-navy-500">Ao responder, você assume a conversa e a IA para de responder nela.</p>}
              </div>
            )}
          </Card>

          {/* Ficha lateral */}
          <div className="scroll-thin space-y-3 overflow-y-auto lg:min-h-0">
            <Card>
              <p className="eyebrow text-navy-500">Contato</p>
              <p className="mt-1 font-semibold">{sel.wa_profile_name ?? "Sem nome no WhatsApp"}</p>
              <p className="text-xs text-navy-500">{formatPhone(sel.phone_e164)}</p>
              {data.detail.opted_out_at && <div className="mt-2"><Notice tone="danger">Pediu para não receber mensagens automáticas.</Notice></div>}
              {data.detail.window_expires_at && sel.channel === "whatsapp" && (
                <p className="mt-2 text-xs text-navy-500">Janela de 24 h {inWindow ? "aberta até" : "encerrada em"} {formatShort(data.detail.window_expires_at, ctx.tz)}</p>
              )}
              {canReply && !data.detail.is_test && (
                <ActionForm action={contactFlagsAction} className="mt-3 space-y-2">
                  <input type="hidden" name="contactId" value={data.detail.contact_id} />
                  <Checkbox name="excluded" defaultChecked={data.detail.excluded_from_metrics} label="Spam ou fornecedor" hint="Fica fora dos indicadores." />
                  <Button size="sm" variant="outline">Salvar</Button>
                </ActionForm>
              )}
            </Card>
            <Card>
              <div className="mb-2 flex items-center justify-between">
                <p className="eyebrow text-navy-500">Pacientes neste telefone</p>
                {can(ctx.role, "patients.write") && (
                  <Modal trigger="Vincular" title="Vincular paciente ao contato" triggerClass="text-xs font-semibold underline">
                    <ActionForm action={linkPatientAction} className="space-y-4">
                      <input type="hidden" name="contactId" value={data.detail.contact_id} />
                      <Field label="Paciente já cadastrado"><Select name="patientId" defaultValue=""><option value="">— novo paciente —</option>{data.allPatients.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</Select></Field>
                      <Field label="Ou nome completo do novo paciente"><Input name="fullName" /></Field>
                      <Field label="Data de nascimento" hint="Usada para verificar a identidade antes de revelar histórico."><Input name="birthDate" type="date" /></Field>
                      <Field label="Quem é o paciente para o dono do telefone?">
                        <Select name="relationship" defaultValue="self"><option value="self">A própria pessoa</option><option value="filho">Filho(a)</option><option value="conjuge">Cônjuge</option><option value="dependente">Dependente</option><option value="outro">Outro</option></Select>
                      </Field>
                      <Button type="submit">Vincular</Button>
                    </ActionForm>
                  </Modal>
                )}
              </div>
              {data.patients.length === 0 ? <p className="text-sm text-navy-500">Nenhum paciente vinculado ainda.</p> : (
                <ul className="space-y-1.5">
                  {data.patients.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                      <Link href={`/pacientes/${p.id}`} className="truncate font-medium underline decoration-cream-300 underline-offset-2">{p.full_name}</Link>
                      <Badge>{p.relationship === "self" ? "titular" : p.relationship}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <p className="eyebrow text-navy-500">Próximas consultas</p>
              {data.appointments.length === 0 ? <p className="mt-2 text-sm text-navy-500">Nenhuma consulta futura.</p> : (
                <ul className="mt-2 space-y-2 text-sm">
                  {data.appointments.map((a) => (
                    <li key={a.id}><p className="font-medium">{a.service} · {a.patient}</p><p className="text-xs text-navy-500">{formatFull(a.starts_at, ctx.tz)}</p></li>
                  ))}
                </ul>
              )}
              <Link href="/agenda" className="mt-3 inline-block text-xs font-semibold underline">Abrir agenda</Link>
            </Card>
            <Card>
              <p className="eyebrow text-navy-500">Resumo do atendimento</p>
              <p className="mb-2 mt-1 text-[11px] text-navy-500">
                {data.detail.summary_by === "ai" ? "Gerado por IA" : data.detail.summary_by === "human" ? "Editado pela equipe" : "Ainda sem resumo"}
                {data.detail.summary_updated_at ? ` · ${formatShort(data.detail.summary_updated_at, ctx.tz)}` : ""} · Não é evolução clínica.
              </p>
              <ActionForm action={saveSummaryAction} resetOnDone={false} className="space-y-2">
                <input type="hidden" name="conversationId" value={sel.id} />
                <Textarea name="summary" defaultValue={data.detail.summary ?? ""} key={data.detail.summary_updated_at?.getTime() ?? 0} aria-label="Resumo" readOnly={!canReply} />
                {canReply && <Button size="sm" variant="outline">Salvar resumo</Button>}
              </ActionForm>
              {data.detail.pending_notes && <p className="mt-2 rounded-xl bg-sun-100 px-3 py-2 text-xs"><span className="font-semibold">Pendências:</span> {data.detail.pending_notes}</p>}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
