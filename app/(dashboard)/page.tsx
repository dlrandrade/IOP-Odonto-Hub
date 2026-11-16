import Link from "next/link";
import { ArrowRight, Ban, BarChart3, CalendarCheck, CalendarDays, CalendarPlus, Check, CircleDashed, DoorOpen, KanbanSquare, MessageCircle, Send, Stethoscope, UserPlus, Users, UserX, type LucideIcon } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { Badge, buttonClass, Card, CardTitle, Empty, Tile } from "@/components/ui";
import { ClickToSend } from "@/components/click-to-send";
import { temaDaRota } from "@/lib/tema";
import { can } from "@/domain/permissions";
import { APPOINTMENT_STATUS_LABELS, type AppointmentStatus } from "@/domain/states";
import { addDays, formatDay, formatShort, localDate, localParts, localTime, zonedToUtc } from "@/lib/datetime";
import { formatPhone } from "@/lib/format";
import { loadDashboard } from "@/services/dashboard";

export const metadata = { title: "Hoje" };

const ICON: Record<AppointmentStatus, LucideIcon> = {
  scheduled: CircleDashed, confirmed: CalendarCheck, arrived: DoorOpen, in_service: Stethoscope, completed: Check, no_show: UserX, cancelled: Ban,
};

/** Bloco da tela inicial: cartão com título, apoio e um botão de ação no canto. Mesma altura dos vizinhos. */
function Block({ title, hint, href, linkLabel, children }: { title: string; hint?: string; href?: string; linkLabel?: string; children: React.ReactNode }) {
  return (
    <Card className="min-h-[380px]">
      <CardTitle hint={hint} action={href ? <Link href={href} className={buttonClass("outline", "sm")}>{linkLabel} <ArrowRight aria-hidden /></Link> : undefined}>{title}</CardTitle>
      <div className="flex flex-1 flex-col">{children}</div>
    </Card>
  );
}

/** Tela inicial: só o que pede ação agora — conversas à espera, agenda do dia e tarefas. Métricas ficam em Indicadores. */
export default async function TodayPage() {
  const ctx = await requireCtx();
  const now = new Date();
  const today = localDate(now, ctx.tz);
  const start = zonedToUtc(today, "00:00", ctx.tz);
  const end = zonedToUtc(addDays(today, 1), "00:00", ctx.tz);
  const hour = localParts(now, ctx.tz).hour;
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  const seesChats = can(ctx.role, "conversations.view");
  const seesAgenda = can(ctx.role, "agenda.view");

  const data = await q(ctx, async (tx) => {
    const [own] = ctx.role === "dentista" && ctx.userId ? await tx<{ id: string }[]>`select id from professionals where app_user_id = ${ctx.userId}` : [];
    const waiting = seesChats && ctx.role !== "dentista" ? await tx<{ id: string; urgent: boolean; reason: string | null; preview: string | null; at: Date | null; name: string | null; phone: string; patient: string | null }[]>`
      select c.id, (c.handoff_priority = 'urgente') as urgent, c.handoff_reason as reason, c.last_message_preview as preview, c.last_message_at as at,
             ct.wa_profile_name as name, ct.phone_e164 as phone,
             (select p.full_name from contact_patient_links l join patients p on p.id = l.patient_id where l.contact_id = ct.id order by (l.relationship = 'self') desc limit 1) as patient
      from conversations c join contacts ct on ct.id = c.contact_id
      where c.state = 'awaiting_human' order by (c.handoff_priority = 'urgente') desc, c.last_message_at asc limit 6` : [];
    const mine = seesChats && ctx.userId ? (await tx<{ n: number }[]>`select count(*)::int as n from conversations where state = 'human_active' and assigned_to = ${ctx.userId}`)[0]?.n ?? 0 : 0;
    const appts = seesAgenda ? await tx<{ id: string; starts_at: Date; ends_at: Date; status: AppointmentStatus; service: string; patient: string; patient_id: string; professional: string }[]>`
      select a.id, a.starts_at, a.ends_at, a.status, s.name as service, p.full_name as patient, p.id as patient_id, pr.name as professional
      from appointments a join services s on s.id = a.service_id join patients p on p.id = a.patient_id join professionals pr on pr.id = a.professional_id
      where a.starts_at >= ${start} and a.starts_at < ${end} and a.status <> 'cancelled'
        ${ctx.role === "dentista" ? tx`and a.professional_id = ${own?.id ?? null}` : tx``}
      order by a.starts_at` : [];
    const tasks = ctx.role === "dentista" ? [] : await tx<{ id: string; title: string; detail: string | null; conversation_id: string | null }[]>`
      select id, title, detail, conversation_id from tasks where status = 'open' and wa_phone is null order by created_at desc limit 5`;
    // Envios por clique que já chegaram na hora: ficam em destaque no topo.
    const toSend = ctx.role === "dentista" ? [] : await tx<{ id: string; title: string; detail: string | null; wa_phone: string; message_text: string }[]>`
      select id, title, detail, wa_phone, message_text from tasks where status = 'open' and wa_phone is not null and message_text is not null
      order by coalesce(due_at, created_at) limit 8`;
    const week = can(ctx.role, "dashboard.view") && ctx.role !== "financeiro" && ctx.role !== "dentista"
      ? await loadDashboard(tx, { clinicId: ctx.clinicId, tz: ctx.tz, from: addDays(today, -6), to: today, professionalId: null }) : null;
    return { waiting, mine, appts, tasks, week, toSend };
  });

  const nowMs = now.getTime();
  const nextId = data.appts.find((a) => a.ends_at.getTime() > nowMs && ["scheduled", "confirmed", "arrived"].includes(a.status))?.id;
  const open = data.appts.filter((a) => ["scheduled", "confirmed", "arrived", "in_service"].includes(a.status)).length;

  // Atalhos em blocos quadrados (como ícones de aplicativo): o que a recepção mais faz, com o número do momento.
  const count = (n: number) => <span className="min-w-6 rounded-full bg-bone/[0.1] px-2 py-0.5 text-center text-[12px] font-bold text-bone">{n}</span>;
  const urgentBadge = data.waiting.length ? <span className="min-w-6 rounded-full bg-danger px-2 py-0.5 text-center text-[12px] font-bold text-on-danger">{data.waiting.length === 6 ? "6+" : data.waiting.length}</span> : undefined;
  type TileItem = { href: string; icon: LucideIcon; title: string; text: string; rgb: string; badge?: React.ReactNode };
  const tiles = ([
    seesChats && ctx.role !== "dentista" && { href: "/conversas?f=nao-atribuidas", icon: MessageCircle, title: "Conversas", text: data.waiting.length ? "Esperando resposta" : "Ninguém esperando", rgb: temaDaRota("/conversas").rgb, badge: urgentBadge },
    seesAgenda && { href: `/agenda?d=${today}`, icon: CalendarDays, title: "Agenda de hoje", text: open ? "Por atender hoje" : "Agenda livre", rgb: temaDaRota("/agenda").rgb, badge: count(open) },
    can(ctx.role, "agenda.write") && { href: "/agenda?nova=1", icon: CalendarPlus, title: "Nova consulta", text: "Marcar um horário", rgb: temaDaRota("/agenda").rgb },
    can(ctx.role, "patients.write") && { href: "/pacientes?novo=1", icon: UserPlus, title: "Novo paciente", text: "Cadastro em 1 minuto", rgb: temaDaRota("/pacientes").rgb },
    can(ctx.role, "patients.view") && { href: "/pacientes", icon: Users, title: "Pacientes", text: "Fichas e histórico", rgb: temaDaRota("/pacientes").rgb },
    can(ctx.role, "crm.view") && { href: "/crm", icon: KanbanSquare, title: "Oportunidades", text: "Tratamentos em decisão", rgb: temaDaRota("/crm").rgb },
    can(ctx.role, "dashboard.view") && { href: "/indicadores", icon: BarChart3, title: "Indicadores", text: "Como a clínica está indo", rgb: temaDaRota("/indicadores").rgb },
  ] as (TileItem | false)[]).filter((x): x is TileItem => !!x).slice(0, 6);

  return (
    <div className="space-y-10">
      <header>
        <p className="t-small first-letter:uppercase">{formatDay(today)}</p>
        <h1 className="t-h1 mt-1">{greeting}, {ctx.name.split(" ")[0]}</h1>
      </header>

      {/* Blocos quadrados grandes: um toque e a pessoa já está fazendo o que precisa. */}
      <nav aria-label="Atalhos" className="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-6 xl:grid-cols-6">
        {tiles.map((t) => <Tile key={t.href} href={t.href} icon={t.icon} title={t.title} text={t.text} rgb={t.rgb} badge={t.badge} />)}
      </nav>

      {data.toSend.length > 0 && (
        <section aria-labelledby="enviar" className="vidro rounded-lg border-[#25D366]/40 p-5 sm:p-6">
          <div className="mb-4 flex items-center gap-3">
            <span className="icone-app size-10 rounded-[12px]" style={{ "--icone-rgb": "37 211 102" } as React.CSSProperties}><Send size={18} aria-hidden /></span>
            <div>
              <h2 id="enviar" className="t-h2">Mensagens para enviar agora</h2>
              <p className="t-small">Um clique abre o WhatsApp com o paciente e o texto prontos. Confira e envie.</p>
            </div>
          </div>
          <ul className="divide-y divide-line">
            {data.toSend.map((t) => (
              <li key={t.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="t-h3 truncate">{t.detail?.replace(/^Para /, "") ?? t.title} <span className="t-small font-normal">· {t.title.replace(/: enviar no WhatsApp$/, "")}</span></p>
                  <p className="t-small line-clamp-1">{t.message_text}</p>
                </div>
                <ClickToSend taskId={t.id} phone={t.wa_phone} text={t.message_text} compact />
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {seesChats && ctx.role !== "dentista" && (
          <Block title="Esperando você" hint="Conversas que a assistente passou para a equipe responder. Urgentes no topo; clique para abrir." href="/conversas?f=nao-atribuidas" linkLabel="Ver todas">
            {data.waiting.length === 0 ? (
              <Empty title="Tudo em dia ✓">Nenhum paciente esperando resposta da equipe agora. Quando a assistente passar uma conversa para vocês, ela aparece aqui.</Empty>
            ) : (
              <ul className="-mx-2 divide-y divide-line">
                {data.waiting.map((c) => (
                  <li key={c.id}>
                    <Link href={`/conversas?c=${c.id}`} className="group flex h-16 items-center gap-4 rounded-sm px-2 transition-colors hover:bg-surface-2/60">
                      <span className={`size-2 shrink-0 rounded-full ${c.urgent ? "bg-danger" : "bg-gold"}`} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2"><span className="t-h3 truncate">{c.patient ?? c.name ?? formatPhone(c.phone)}</span>{c.urgent && <Badge tone="danger">Urgente</Badge>}</span>
                        <span className="t-small block truncate">{c.reason ?? c.preview}</span>
                      </span>
                      <span className="t-small shrink-0 font-mono">{c.at ? formatShort(c.at, ctx.tz).slice(-5) : ""}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {data.mine > 0 && <p className="t-small mt-auto pt-4">Você está atendendo <Link href="/conversas?f=minhas" className="text-bone underline underline-offset-2">{data.mine} conversa{data.mine > 1 ? "s" : ""}</Link>.</p>}
          </Block>
        )}

        {seesAgenda && (
          <Block title="Agenda de hoje" hint={`${data.appts.length} consulta${data.appts.length === 1 ? "" : "s"} hoje, por horário. A próxima fica destacada; clique para abrir a ficha.`} href={`/agenda?d=${today}`} linkLabel="Abrir agenda">
            {data.appts.length === 0 ? (
              <Empty title="Nenhuma consulta hoje" action={can(ctx.role, "agenda.write") ? <Link href="/agenda?nova=1" className={buttonClass("outline", "sm")}>Agendar consulta</Link> : undefined}>A agenda está livre.</Empty>
            ) : (
              <ol className="-mx-2 divide-y divide-line">
                {data.appts.map((a) => {
                  const Icon = ICON[a.status];
                  const isNext = a.id === nextId;
                  return (
                    <li key={a.id}>
                      <Link href={`/pacientes/${a.patient_id}`} className={`relative flex h-16 items-center gap-4 rounded-sm px-2 transition-colors hover:bg-surface-2/60 ${isNext ? "bg-acento/[0.06]" : ""}`}>
                        {isNext && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-acento" />}
                        <span className="w-12 shrink-0 font-mono text-[13px] tabular-nums text-bone-dim">{localTime(a.starts_at, ctx.tz)}</span>
                        <span className="min-w-0 flex-1">
                          <span className="t-h3 block truncate">{a.patient}</span>
                          <span className="t-small block truncate">{a.service} · {a.professional}</span>
                        </span>
                        {isNext ? <Badge className="bg-acento/15 text-acento">Próxima</Badge> : <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-bone-dim"><Icon size={14} aria-hidden /><span className="hidden sm:inline">{APPOINTMENT_STATUS_LABELS[a.status]}</span></span>}
                      </Link>
                    </li>
                  );
                })}
              </ol>
            )}
          </Block>
        )}

        {ctx.role !== "dentista" && (
          <Block title="Tarefas" hint="Pendências que a automação não resolveu sozinha, como ligar para confirmar presença." href="/automacoes" linkLabel="Ver todas">
            {data.tasks.length === 0 ? <Empty title="Nenhuma tarefa pendente">Tudo em dia por aqui.</Empty> : (
              <ul className="-mx-2 divide-y divide-line">
                {data.tasks.map((t) => (
                  <li key={t.id} className="flex min-h-16 items-center gap-4 px-2 py-2">
                    <span className="min-w-0 flex-1"><span className="t-h3 block">{t.title}</span>{t.detail && <span className="t-small line-clamp-1 block">{t.detail}</span>}</span>
                    {t.conversation_id && <Link href={`/conversas?c=${t.conversation_id}`} className={buttonClass("ghost", "sm")}>Abrir</Link>}
                  </li>
                ))}
              </ul>
            )}
          </Block>
        )}

        {data.week && (
          <Block title="Últimos 7 dias" hint="Resumo da semana. Os números completos e como cada um é calculado ficam em Indicadores." href="/indicadores" linkLabel="Indicadores">
            <dl className="grid flex-1 grid-cols-2 gap-px overflow-hidden rounded-md bg-line/70">
              {[
                ["Novos contatos", String(data.week.newContacts)],
                ["Consultas marcadas", String(data.week.appointmentsBooked)],
                ["Contato → avaliação", data.week.conversion.rate == null ? "—" : `${Math.round(data.week.conversion.rate * 100)}%`],
                ["Gasto com IA", `US$ ${(data.week.aiCostCents / 100).toFixed(2).replace(".", ",")}`],
                ["Conversas recebidas", String(data.week.conversations)],
              ].map(([k, v]) => (
                // Custo da IA é detalhe técnico: na visualização simples, o quarto número é o de conversas.
                <div key={k} className={`flex flex-col justify-between gap-3 bg-surface/90 p-5 ${k === "Gasto com IA" ? "simples:hidden" : k === "Conversas recebidas" ? "detalhado:hidden" : ""}`}>
                  <dt className="eyebrow text-bone-mute">{k}</dt>
                  <dd className="display num text-[32px] leading-none">{v}</dd>
                </div>
              ))}
            </dl>
          </Block>
        )}
      </div>
    </div>
  );
}
