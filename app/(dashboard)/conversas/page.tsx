import Link from "next/link";
import { AlertTriangle, ArrowLeft, Bot, Check, CheckCheck, Clock, Mic, Plus, Search, Send, StickyNote, UserRound, XCircle } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { db } from "@/db/client";
import { ActionForm, LiveRefresh, Modal, ScrollToEnd, SubmitOnChange } from "@/components/client";
import { Avatar, Badge, Button, buttonClass, Card, Checkbox, Empty, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import { can } from "@/domain/permissions";
import { CONVERSATION_STATE_LABELS, type ConversationState } from "@/domain/states";
import { formatFull, formatShort, localTime } from "@/lib/datetime";
import { cn, formatPhone } from "@/lib/format";
import { StateTag } from "@/components/tags";
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

/** "Hoje", "Ontem" ou a data, para separar o histórico por dia. */
function dayLabel(d: Date, tz: string): string {
  const key = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(x);
  const today = key(new Date());
  const yesterday = key(new Date(Date.now() - 86_400_000));
  const k = key(d);
  if (k === today) return "Hoje";
  if (k === yesterday) return "Ontem";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(d);
}

function DeliveryIcon({ status }: { status: string }) {
  if (status === "failed") return <span className="inline-flex items-center gap-0.5 text-danger"><XCircle size={12} aria-hidden /> falhou</span>;
  if (status === "read") return <span className="inline-flex items-center gap-0.5"><CheckCheck size={13} className="text-info" aria-hidden /> lida</span>;
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
    const [integ] = await db()<{ wa_provider: string }[]>`select wa_provider from clinic_integrations where clinic_id = ${ctx.clinicId}`;
    if (selected.unread_count > 0 && selected.assigned_to === ctx.userId) await tx`update conversations set unread_count = 0 where id = ${selected.id}`;
    return { rows, selected, detail: detail!, messages, patients, appointments, users, allPatients, hasTemplate: !!template, windowRule: integ?.wa_provider !== "evolution" };
  });

  const href = (params: Record<string, string | null>) => {
    const merged: Record<string, string | null> = { f: filter === "abertas" ? null : filter, q: search || null, c: selectedId, ...params };
    const qs = Object.entries(merged).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
    return qs ? `/conversas?${qs}` : "/conversas";
  };
  const sel = data.selected;
  const displayName = (r: Row) => r.patient_name ?? r.wa_profile_name ?? formatPhone(r.phone_e164);
  const inWindow = sel && "detail" in data && (sel.channel === "simulator" || !data.windowRule || (!!data.detail.window_expires_at && data.detail.window_expires_at > new Date()));
  const canReply = can(ctx.role, "conversations.reply");

  return (
    <div className="grid gap-6 lg:h-[calc(100dvh-9.5rem)] lg:grid-cols-[360px_minmax(0,1fr)_300px]">
      <LiveRefresh seconds={5} clinicId={ctx.clinicId} />

      {/* Lista */}
      <Card className={cn("flex min-h-0 flex-col p-0", sel && "hidden lg:flex")}>
        <div className="space-y-4 border-b border-line p-5">
          <div className="flex items-center justify-between">
            <h1 className="t-h2">Conversas</h1>
            {can(ctx.role, "ai.kill_switch") && (
              <ActionForm action={killSwitchAction}>
                <input type="hidden" name="on" value={String(!ctx.clinic.ai_kill_switch)} />
                <Button size="sm" variant={ctx.clinic.ai_kill_switch ? "accent" : "outline"} title="Interruptor global da IA">
                  <Bot size={13} aria-hidden /> {ctx.clinic.ai_kill_switch ? "Religar IA" : "Pausar IA"}
                </Button>
              </ActionForm>
            )}
          </div>
          <SubmitOnChange className="grid grid-cols-[minmax(0,1fr)_150px] gap-2">
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-bone-mute" aria-hidden />
              <Input name="q" defaultValue={search} placeholder="Buscar" aria-label="Buscar conversas por nome, telefone ou texto" className="pl-9" />
            </div>
            <Select name="f" defaultValue={filter} aria-label="Mostrar conversas">
              {FILTERS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </Select>
          </SubmitOnChange>
        </div>
        <ul className="scroll-thin min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {data.rows.length === 0 && <li className="p-4"><Empty title="Nenhuma conversa aqui">Use o Simulador para testar o atendimento sem WhatsApp.</Empty></li>}
          {data.rows.map((r) => {
            const urgent = r.state === "awaiting_human" && r.handoff_priority === "urgente";
            return (
              <li key={r.id}>
                <Link href={href({ c: r.id })} aria-current={r.id === selectedId ? "true" : undefined}
                  className={cn("relative flex gap-3 px-5 py-4 transition-colors hover:bg-surface-2/70", r.id === selectedId && "bg-acento/[0.08]")}>
                  {(r.id === selectedId || urgent) && <span aria-hidden className={cn("absolute inset-y-3 left-0 w-0.5 rounded-full", urgent ? "bg-danger" : "bg-acento")} />}
                  <Avatar name={displayName(r)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className={cn("t-h3 truncate", r.unread_count > 0 && "font-bold")}>{displayName(r)}</p>
                      <span className="shrink-0 font-mono text-[11px] text-bone-mute">{r.last_message_at ? (dayLabel(r.last_message_at, ctx.tz) === "Hoje" ? localTime(r.last_message_at, ctx.tz) : formatShort(r.last_message_at, ctx.tz).slice(0, 5)) : ""}</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-3">
                      <p className={cn("t-small truncate", r.unread_count > 0 && "text-bone-dim")}>{r.last_message_preview ?? "—"}</p>
                      {r.unread_count > 0 && <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-acento px-1.5 font-mono text-[10.5px] font-semibold text-on" aria-label={`${r.unread_count} não lidas`}>{r.unread_count}</span>}
                    </div>
                    <div className="mt-2 flex items-center gap-1.5">
                      <StateTag state={r.state} urgent={urgent} assignee={r.assignee} />
                      {r.channel === "simulator" && <Badge>Simulador</Badge>}
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
        <Card className="hidden p-3 lg:col-span-2 lg:flex"><Empty title="Selecione uma conversa à esquerda">O histórico de mensagens, a ficha do paciente e os botões de ação aparecem aqui.</Empty></Card>
      ) : (
        <>
          <Card className="flex min-h-[70dvh] flex-col p-0 lg:min-h-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <Link href={href({ c: null })} aria-label="Voltar para a lista" className="rounded-full p-1.5 hover:bg-surface-2 lg:hidden"><ArrowLeft size={18} /></Link>
                <Avatar name={displayName(sel)} />
                <div className="min-w-0">
                  <p className="t-h3 truncate">{displayName(sel)}</p>
                  <div className="mt-1 flex items-center gap-2"><span className="t-small font-mono">{formatPhone(sel.phone_e164)}</span><StateTag state={sel.state} assignee={sel.assignee} /></div>
                </div>
              </div>
              {canReply && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {sel.state !== "human_active" || sel.assigned_to !== ctx.userId ? (
                    <ActionForm action={conversationStateAction}><input type="hidden" name="conversationId" value={sel.id} /><input type="hidden" name="op" value="take" /><Button size="sm" variant="accent"><UserRound size={13} aria-hidden /> Assumir</Button></ActionForm>
                  ) : null}
                  {(sel.state === "human_active" || sel.state === "awaiting_human") && (
                    <Modal trigger={<><Bot size={13} aria-hidden /> Devolver à IA</>} title="Devolver à IA" description="A assistente volta a responder esta conversa." triggerClass={buttonClass("primary", "sm")}>
                      <ActionForm action={conversationStateAction} className="space-y-4">
                        <input type="hidden" name="conversationId" value={sel.id} /><input type="hidden" name="op" value="handback" />
                        <Field label="Pendências para a IA (opcional)" hint="A IA recebe o resumo, as últimas mensagens e este texto, para não repetir perguntas já respondidas.">
                          <Textarea name="pending" placeholder="Ex.: paciente já informou que prefere manhã; falta escolher o dia." />
                        </Field>
                        <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Devolver</Button></div>
                      </ActionForm>
                    </Modal>
                  )}
                  <Modal trigger="Transferir" title="Transferir conversa" description="A conversa passa para outra pessoa da equipe." triggerClass={buttonClass("outline", "sm")}>
                    <ActionForm action={conversationStateAction} className="space-y-4">
                      <input type="hidden" name="conversationId" value={sel.id} /><input type="hidden" name="op" value="transfer" />
                      <Field label="Para quem?"><Select name="to" required>{data.users.filter((u) => u.id !== ctx.userId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
                      <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Transferir</Button></div>
                    </ActionForm>
                  </Modal>
                  {sel.state !== "closed" && (
                    <ActionForm action={conversationStateAction}><input type="hidden" name="conversationId" value={sel.id} /><input type="hidden" name="op" value="close" /><Button size="sm" variant="ghost">Encerrar</Button></ActionForm>
                  )}
                </div>
              )}
            </div>
            {sel.state === "awaiting_human" && (
              <div className={cn("flex items-center gap-2 border-b px-6 py-2.5 text-[13px] font-medium", sel.handoff_priority === "urgente" ? "border-danger/30 bg-danger-soft text-danger" : "border-warn/20 bg-warn-soft text-warn")} role="alert">
                <AlertTriangle size={15} aria-hidden className="shrink-0" /> <span><strong>{sel.handoff_priority === "urgente" ? "Atendimento urgente" : "Aguardando a equipe"}:</strong> {data.detail.handoff_reason}</span>
              </div>
            )}
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-surface-2/40">
              <div className="mx-auto w-full max-w-[820px] space-y-3 px-6 py-6">
              {data.messages.map((m, i) => {
                const prev = data.messages[i - 1];
                const newDay = !prev || dayLabel(prev.created_at, ctx.tz) !== dayLabel(m.created_at, ctx.tz);
                const separator = newDay && (
                  <div className="flex items-center gap-3 py-2" aria-hidden>
                    <span className="h-px flex-1 bg-line" /><span className="eyebrow text-bone-mute first-letter:uppercase">{dayLabel(m.created_at, ctx.tz)}</span><span className="h-px flex-1 bg-line" />
                  </div>
                );
                if (m.type === "note") {
                  return (
                    <div key={m.id}>
                      {separator}
                      <div className="flex justify-center">
                        <p className="flex max-w-[90%] items-start gap-2 rounded-md border border-dashed border-line bg-surface/60 px-3 py-2 text-[12.5px] text-bone-dim">
                          <StickyNote size={13} className="mt-0.5 shrink-0 text-gold" aria-hidden />
                          <span><span className="font-medium text-bone">{m.sender_type === "system" ? "Sistema" : `Nota interna${m.sender ? ` · ${m.sender}` : ""}`}</span> — {m.body} <span className="font-mono text-[11px] text-bone-mute">{localTime(m.created_at, ctx.tz)}</span></span>
                        </p>
                      </div>
                    </div>
                  );
                }
                const out = m.direction === "outbound";
                const who = m.sender_type === "patient" ? "Paciente" : m.sender_type === "ai" ? ctx.clinic.assistant_name + " · assistente" : m.sender_type === "human" ? m.sender ?? "Equipe" : "Automação";
                const tone = !out ? "border-line bg-surface" : m.sender_type === "ai" ? "border-info/25 bg-info-soft" : "border-violet/25 bg-violet-soft";
                const dot = !out ? "bg-bone-mute" : m.sender_type === "ai" ? "bg-info" : "bg-violet";
                return (
                  <div key={m.id}>
                    {separator}
                    <div className={cn("flex", out ? "justify-end" : "justify-start")}>
                    <div className={cn("max-w-[80%] rounded-md border px-4 py-3", tone, out ? "rounded-tr-sm" : "rounded-tl-sm")}>
                      <p className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-bone-dim"><span aria-hidden className={cn("size-1.5 rounded-full", dot)} />{who}</p>
                      {m.type === "audio" && (
                        <div className="space-y-1.5">
                          <p className="flex items-center gap-1 text-xs"><Mic size={12} aria-hidden /> Áudio</p>
                          {(m.media_path || m.wa_media_id) && <audio controls preload="none" src={`/api/media/${m.id}`} className="h-9 w-56 max-w-full" />}
                          {m.transcript_status === "pending" && <p className="text-xs italic text-bone-mute">Transcrevendo…</p>}
                          {m.transcript_status === "failed" && !m.transcript && <p className="text-xs italic text-warn">Não foi possível transcrever. O áudio original foi preservado.</p>}
                          {m.transcript && <p className="whitespace-pre-wrap text-sm">“{m.transcript}”{m.transcript !== m.transcript_original && <span className="text-[10px] text-bone-mute"> (editada)</span>}</p>}
                          {canReply && (
                            <details className="text-xs"><summary className="cursor-pointer text-bone-mute">Corrigir transcrição</summary>
                              <ActionForm action={editTranscriptAction} className="mt-1 space-y-1"><input type="hidden" name="messageId" value={m.id} /><Textarea name="transcript" defaultValue={m.transcript ?? ""} className="min-h-16 text-xs" required /><Button size="sm" variant="outline">Salvar</Button></ActionForm>
                            </details>
                          )}
                        </div>
                      )}
                      {m.type === "image" && (m.media_path || m.wa_media_id) && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/api/media/${m.id}`} alt="Imagem enviada pelo paciente" className="mb-1 max-h-64 rounded-md" loading="lazy" />
                      )}
                      {m.type === "image" && !m.media_path && !m.wa_media_id && <p className="text-xs italic">📷 Imagem (simulada)</p>}
                      {m.type !== "audio" && m.body && <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">{m.body}</p>}
                      <p className="mt-1.5 flex items-center justify-end gap-2 font-mono text-[10.5px] text-bone-mute">
                        {m.type === "template" && <span>template</span>}
                        <time dateTime={m.created_at.toISOString()}>{localTime(m.created_at, ctx.tz)}</time>
                        {out && <DeliveryIcon status={m.delivery_status} />}
                      </p>
                      {m.error && m.delivery_status === "failed" && <p className="mt-1 rounded-sm bg-danger-soft px-2 py-1 text-[11px] text-danger">Falha no envio: {m.error}</p>}
                    </div>
                    </div>
                  </div>
                );
              })}
              <ScrollToEnd dep={data.messages.length} />
              </div>
            </div>
            {canReply && (
              <div className="border-t border-line">
              <div className="mx-auto w-full max-w-[820px] space-y-3 px-6 py-5">
                {sel.state === "ai_active" && (
                  <p className="flex items-center gap-2 rounded-sm bg-ok-soft px-3 py-2 text-[13px] text-ok"><Bot size={15} aria-hidden /> A assistente está cuidando desta conversa. Se você escrever, a conversa passa para você.</p>
                )}
                {!inWindow && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm bg-warn-soft px-3 py-2 text-[13px] text-warn">
                    <span>Passaram 24 h da última mensagem do paciente: o WhatsApp oficial só aceita uma mensagem pronta (template). Notas internas continuam liberadas.</span>
                    {data.hasTemplate && <ActionForm action={sendTemplateAction}><input type="hidden" name="conversationId" value={sel.id} /><Button size="sm" variant="outline">Enviar mensagem pronta</Button></ActionForm>}
                  </div>
                )}
                <ActionForm action={sendMessageAction} className="space-y-3">
                  <input type="hidden" name="conversationId" value={sel.id} />
                  <Textarea name="body" required placeholder={inWindow ? "Escreva a mensagem para o paciente…" : "Escreva uma nota interna…"} aria-label="Mensagem" className="min-h-[76px] resize-none" rows={3} />
                  <div className="flex flex-wrap items-center justify-end gap-3">
                    <span className="t-small mr-auto hidden sm:inline">Notas internas só a equipe vê.</span>
                    <Button type="submit" name="mode" value="note" variant="outline"><StickyNote aria-hidden /> Salvar como nota</Button>
                    <Button type="submit" name="mode" value="message" disabled={!inWindow}><Send aria-hidden /> Enviar ao paciente</Button>
                  </div>
                </ActionForm>
              </div>
              </div>
            )}
          </Card>

          {/* Ficha lateral: um só painel, seções separadas por linhas finas (mais leve que vários cartões). */}
          <Card className="scroll-thin gap-0 overflow-y-auto p-0 lg:min-h-0">
            <SidePart title="Contato">
              <p className="t-h3">{sel.wa_profile_name ?? "Sem nome no WhatsApp"}</p>
              <p className="t-small font-mono">{formatPhone(sel.phone_e164)}</p>
              {data.detail.opted_out_at && <div className="mt-3"><Notice tone="danger">Pediu para não receber mensagens automáticas.</Notice></div>}
              {data.windowRule && data.detail.window_expires_at && sel.channel === "whatsapp" && (
                <p className="t-small mt-2">Pode receber mensagem livre {inWindow ? "até" : "— encerrado em"} {formatShort(data.detail.window_expires_at, ctx.tz)}</p>
              )}
              {canReply && !data.detail.is_test && (
                <ActionForm action={contactFlagsAction} className="mt-4 flex items-center justify-between gap-3">
                  <input type="hidden" name="contactId" value={data.detail.contact_id} />
                  <Checkbox name="excluded" defaultChecked={data.detail.excluded_from_metrics} label="É spam ou fornecedor" />
                  <Button size="sm" variant="ghost">Salvar</Button>
                </ActionForm>
              )}
            </SidePart>
            <SidePart title="Pacientes deste telefone" action={can(ctx.role, "patients.write") ? (
              <Modal trigger={<><Plus aria-hidden /> Vincular</>} title="Vincular paciente ao telefone" description="Um telefone pode atender várias pessoas, como uma mãe e os filhos." triggerClass={buttonClass("ghost", "sm")}>
                <ActionForm action={linkPatientAction} className="space-y-5">
                  <input type="hidden" name="contactId" value={data.detail.contact_id} />
                  <Field label="Paciente já cadastrado"><Select name="patientId" defaultValue=""><option value="">Escolha na lista ou cadastre abaixo…</option>{data.allPatients.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</Select></Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Ou nome completo do novo"><Input name="fullName" /></Field>
                    <Field label="Data de nascimento" hint="Usada para confirmar a identidade."><Input name="birthDate" type="date" /></Field>
                  </div>
                  <Field label="Quem é o paciente para o dono do telefone?">
                    <Select name="relationship" defaultValue="self"><option value="self">A própria pessoa</option><option value="filho">Filho(a)</option><option value="conjuge">Cônjuge</option><option value="dependente">Dependente</option><option value="outro">Outro</option></Select>
                  </Field>
                  <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Vincular paciente</Button></div>
                </ActionForm>
              </Modal>
            ) : undefined}>
              {data.patients.length === 0 ? <p className="t-small">Nenhum paciente vinculado ainda.</p> : (
                <ul className="space-y-2">
                  {data.patients.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3">
                      <Link href={`/pacientes/${p.id}`} className="truncate text-[14px] font-medium hover:underline">{p.full_name}</Link>
                      <Badge>{p.relationship === "self" ? "titular" : p.relationship}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </SidePart>
            <SidePart title="Próximas consultas" action={<Link href="/agenda" className={buttonClass("ghost", "sm")}>Agenda</Link>}>
              {data.appointments.length === 0 ? <p className="t-small">Nenhuma consulta marcada.</p> : (
                <ul className="space-y-6">
                  {data.appointments.map((a) => (
                    <li key={a.id}><p className="text-[14px] font-medium">{a.service} · {a.patient}</p><p className="t-small">{formatFull(a.starts_at, ctx.tz)}</p></li>
                  ))}
                </ul>
              )}
            </SidePart>
            <SidePart title="Resumo do atendimento" last>
              <p className="t-small mb-3">
                {data.detail.summary_by === "ai" ? "Escrito pela assistente" : data.detail.summary_by === "human" ? "Editado pela equipe" : "Ainda sem resumo"}
                {data.detail.summary_updated_at ? ` · ${formatShort(data.detail.summary_updated_at, ctx.tz)}` : ""}. Não é registro clínico.
              </p>
              <ActionForm action={saveSummaryAction} resetOnDone={false} className="space-y-6">
                <input type="hidden" name="conversationId" value={sel.id} />
                <Textarea name="summary" defaultValue={data.detail.summary ?? ""} key={data.detail.summary_updated_at?.getTime() ?? 0} aria-label="Resumo" readOnly={!canReply} className="min-h-24 resize-none" />
                {canReply && <div className="flex justify-end"><Button size="sm" variant="outline">Salvar resumo</Button></div>}
              </ActionForm>
              {data.detail.pending_notes && <p className="mt-3 rounded-sm border-l-2 border-gold/70 bg-gold/[0.07] px-3 py-2 text-[13px]"><span className="font-medium">Pendências:</span> {data.detail.pending_notes}</p>}
            </SidePart>
          </Card>
        </>
      )}
    </div>
  );
}

function SidePart({ title, action, children, last }: { title: string; action?: React.ReactNode; children: React.ReactNode; last?: boolean }) {
  return (
    <section className={cn("px-6 py-5", !last && "border-b border-line")}>
      <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
        <h2 className="eyebrow text-bone-mute">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
