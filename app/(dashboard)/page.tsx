import Link from "next/link";
import { ArrowRight, Ban, CalendarCheck, Check, CircleDashed, DoorOpen, Stethoscope, UserX, type LucideIcon } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { Badge, Empty } from "@/components/ui";
import { can } from "@/domain/permissions";
import { APPOINTMENT_STATUS_LABELS, type AppointmentStatus } from "@/domain/states";
import { addDays, formatDay, formatShort, localDate, localParts, localTime, zonedToUtc } from "@/lib/datetime";
import { formatPhone } from "@/lib/format";
import { loadDashboard } from "@/services/dashboard";

export const metadata = { title: "Hoje" };

const ICON: Record<AppointmentStatus, LucideIcon> = {
  scheduled: CircleDashed, confirmed: CalendarCheck, arrived: DoorOpen, in_service: Stethoscope, completed: Check, no_show: UserX, cancelled: Ban,
};

function Section({ title, hint, href, linkLabel, children }: { title: string; hint?: string; href?: string; linkLabel?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-end justify-between gap-4 border-b border-line pb-3">
        <div>
          <h2 className="font-display text-[20px] font-bold tracking-[-0.01em]">{title}</h2>
          {hint && <p className="mt-0.5 text-[12.5px] text-bone-mute">{hint}</p>}
        </div>
        {href && <Link href={href} className="flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-bone-dim transition-colors hover:text-bone">{linkLabel} <ArrowRight size={13} aria-hidden /></Link>}
      </div>
      {children}
    </section>
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
      select id, title, detail, conversation_id from tasks where status = 'open' order by created_at desc limit 5`;
    const week = can(ctx.role, "dashboard.view") && ctx.role !== "financeiro" && ctx.role !== "dentista"
      ? await loadDashboard(tx, { clinicId: ctx.clinicId, tz: ctx.tz, from: addDays(today, -6), to: today, professionalId: null }) : null;
    return { waiting, mine, appts, tasks, week };
  });

  const nowMs = now.getTime();
  const nextId = data.appts.find((a) => a.ends_at.getTime() > nowMs && ["scheduled", "confirmed", "arrived"].includes(a.status))?.id;
  const open = data.appts.filter((a) => ["scheduled", "confirmed", "arrived", "in_service"].includes(a.status)).length;

  return (
    <div className="space-y-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[13px] text-bone-mute first-letter:uppercase">{formatDay(today)}</p>
          <h1 className="display mt-1 text-[34px] leading-[1.05] lg:text-[44px]">{greeting}, {ctx.name.split(" ")[0]}</h1>
        </div>
        <p className="max-w-sm text-[14px] text-bone-dim">
          {data.waiting.length > 0 ? `${data.waiting.length === 6 ? "6 ou mais" : data.waiting.length} conversa${data.waiting.length > 1 ? "s" : ""} esperando você. ` : "Nenhuma conversa esperando. "}
          {seesAgenda ? `${open} consulta${open === 1 ? "" : "s"} por atender hoje.` : ""}
        </p>
      </header>

      <div className="grid gap-12 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-12">
          {seesChats && ctx.role !== "dentista" && (
            <Section title="Esperando você" hint="Conversas que a assistente passou para a equipe. As urgentes vêm primeiro." href="/conversas?f=nao-atribuidas" linkLabel="Ver todas">
              {data.waiting.length === 0 ? (
                <Empty title="Fila vazia">Quando a assistente chamar a equipe, a conversa aparece aqui.</Empty>
              ) : (
                <ul className="divide-y divide-line">
                  {data.waiting.map((c) => (
                    <li key={c.id}>
                      <Link href={`/conversas?c=${c.id}`} className="group -mx-3 flex items-start gap-4 rounded-md px-3 py-3.5 transition-colors hover:bg-surface">
                        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${c.urgent ? "bg-danger" : "bg-gold"}`} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-[15px] font-medium">{c.patient ?? c.name ?? formatPhone(c.phone)}</span>
                            {c.urgent && <Badge tone="danger">Urgente</Badge>}
                          </span>
                          <span className="mt-0.5 block truncate text-[13px] text-bone-dim">{c.reason ?? c.preview}</span>
                        </span>
                        <span className="shrink-0 pt-0.5 text-[12px] text-bone-mute">{c.at ? formatShort(c.at, ctx.tz).slice(-5) : ""}</span>
                        <ArrowRight size={15} aria-hidden className="mt-1 shrink-0 text-bone-mute transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {data.mine > 0 && <p className="mt-3 text-[13px] text-bone-mute">Você também está com <Link href="/conversas?f=minhas" className="font-medium text-bone underline underline-offset-2">{data.mine} conversa{data.mine > 1 ? "s" : ""} em atendimento</Link>.</p>}
            </Section>
          )}

          {seesAgenda && (
            <Section title="Agenda de hoje" hint={`${data.appts.length} consulta${data.appts.length === 1 ? "" : "s"} · ${ctx.tz}`} href={`/agenda?d=${today}`} linkLabel="Abrir agenda">
              {data.appts.length === 0 ? (
                <Empty title="Nenhuma consulta hoje">Aproveite para revisar a agenda dos próximos dias.</Empty>
              ) : (
                <ol className="divide-y divide-line">
                  {data.appts.map((a) => {
                    const Icon = ICON[a.status];
                    const isNext = a.id === nextId;
                    return (
                      <li key={a.id} className={isNext ? "relative -mx-3 rounded-md bg-surface px-3" : ""}>
                        {isNext && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-acento" />}
                        <Link href={`/pacientes/${a.patient_id}`} className="flex items-center gap-4 py-3.5">
                          <span className="w-12 shrink-0 font-mono text-[13px] tabular-nums text-bone-dim">{localTime(a.starts_at, ctx.tz)}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[15px] font-medium">{a.patient}</span>
                            <span className="block truncate text-[13px] text-bone-mute">{a.service} · {a.professional}</span>
                          </span>
                          {isNext && <span className="hidden text-[12px] font-medium text-acento sm:inline">Próxima</span>}
                          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-bone-dim"><Icon size={14} aria-hidden /><span className="hidden sm:inline">{APPOINTMENT_STATUS_LABELS[a.status]}</span></span>
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              )}
            </Section>
          )}
        </div>

        <aside className="space-y-12">
          {data.tasks.length > 0 && (
            <Section title="Tarefas" hint="Coisas que a automação não consegue fazer sozinha." href="/automacoes" linkLabel="Ver todas">
              <ul className="divide-y divide-line">
                {data.tasks.map((t) => (
                  <li key={t.id} className="py-3">
                    <p className="text-[14px] font-medium">{t.title}</p>
                    {t.detail && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-bone-mute">{t.detail}</p>}
                    {t.conversation_id && <Link href={`/conversas?c=${t.conversation_id}`} className="mt-1.5 inline-block text-[12.5px] font-medium text-bone-dim underline underline-offset-2 hover:text-bone">Abrir conversa</Link>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {data.week && (
            <Section title="Últimos 7 dias" href="/indicadores" linkLabel="Indicadores">
              <dl className="divide-y divide-line">
                {[
                  ["Novos contatos", String(data.week.newContacts)],
                  ["Consultas marcadas", String(data.week.appointmentsBooked)],
                  ["Contato → avaliação", data.week.conversion.rate == null ? "—" : `${Math.round(data.week.conversion.rate * 100)}%`],
                  ["Gasto estimado com IA", `US$ ${(data.week.aiCostCents / 100).toFixed(2)}`],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-4 py-3">
                    <dt className="text-[13.5px] text-bone-dim">{k}</dt>
                    <dd className="display num text-[22px] leading-none">{v}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}
        </aside>
      </div>
    </div>
  );
}
