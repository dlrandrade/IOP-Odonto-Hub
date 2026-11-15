import Link from "next/link";
import { Ban, CalendarCheck, Check, ChevronLeft, ChevronRight, CircleDashed, DoorOpen, Lock, Plus, Stethoscope, UserX, type LucideIcon } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, Modal, SubmitOnChange } from "@/components/client";
import { Badge, Button, buttonClass, Card, Checkbox, Empty, Field, Input, PageHeader, Segmented, Select } from "@/components/ui";
import { can } from "@/domain/permissions";
import { APPOINTMENT_STATUSES, APPOINTMENT_STATUS_LABELS, type AppointmentStatus } from "@/domain/states";
import { addDays, formatDay, formatFull, formatShort, localDate, localParts, localTime, WEEKDAY_LABELS, weekdayOf, zonedToUtc } from "@/lib/datetime";
import { cn } from "@/lib/format";
import { appointmentStatusAction, createBlockAction, deleteBlockAction } from "./actions";
import { BookingForm } from "./booking-form";

export const metadata = { title: "Agenda" };

type Appt = {
  id: string; starts_at: Date; ends_at: Date; status: AppointmentStatus; professional_id: string; service_id: string; service: string;
  patient: string; patient_id: string; created_by_type: string; notes: string | null; chair: string | null; cancel_reason: string | null;
};

/** Status nunca depende só de cor: cada um tem ícone e rótulo. */
const STATUS: Record<AppointmentStatus, { icon: LucideIcon; cls: string }> = {
  scheduled: { icon: CircleDashed, cls: "bg-surface-2 border-bone-mute text-bone" },
  confirmed: { icon: CalendarCheck, cls: "bg-gold/15 border-gold text-bone" },
  arrived: { icon: DoorOpen, cls: "bg-info-soft border-info text-bone" },
  in_service: { icon: Stethoscope, cls: "bg-acento/15 border-acento text-bone" },
  completed: { icon: Check, cls: "bg-ok-soft border-ok text-ok" },
  no_show: { icon: UserX, cls: "bg-danger-soft border-danger text-danger" },
  cancelled: { icon: Ban, cls: "bg-surface-2 border-line text-bone-mute line-through" },
};
const NEXT: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled: ["confirmed", "arrived", "no_show"], confirmed: ["arrived", "no_show"], arrived: ["in_service", "completed"],
  in_service: ["completed"], completed: [], no_show: [], cancelled: [],
};
const DAY_START = 7;
const DAY_END = 20;
const PPM = 1.15; // pixels por minuto

export default async function AgendaPage({ searchParams }: { searchParams: Promise<{ d?: string; v?: string; prof?: string; esp?: string; st?: string; nova?: string }> }) {
  const ctx = await requireCtx("agenda.view");
  const sp = await searchParams;
  const today = localDate(new Date(), ctx.tz);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.d ?? "") ? sp.d! : today;
  const view = sp.v === "semana" || sp.v === "mes" ? sp.v : "dia";
  const canWrite = can(ctx.role, "agenda.write");

  const weekStart = addDays(day, -((weekdayOf(day) + 6) % 7));
  const monthStart = `${day.slice(0, 8)}01`;
  const gridStart = addDays(monthStart, -((weekdayOf(monthStart) + 6) % 7));
  const [from, to] = view === "dia" ? [day, day] : view === "semana" ? [weekStart, addDays(weekStart, 6)] : [gridStart, addDays(gridStart, 41)];

  const data = await q(ctx, async (tx) => {
    const [own] = ctx.role === "dentista" && ctx.userId ? await tx<{ id: string }[]>`select id from professionals where app_user_id = ${ctx.userId}` : [];
    const onlyProf = ctx.role === "dentista" ? own?.id ?? "00000000-0000-0000-0000-000000000000" : /^[0-9a-f-]{36}$/.test(sp.prof ?? "") ? sp.prof! : null;
    const allProfessionals = await tx<{ id: string; name: string; specialty: string | null; color: string }[]>`select id, name, specialty, color from professionals where active order by name`;
    const professionals = allProfessionals.filter((p) => (!onlyProf || p.id === onlyProf) && (!sp.esp || p.specialty === sp.esp));
    const start = zonedToUtc(from, "00:00", ctx.tz);
    const end = zonedToUtc(addDays(to, 1), "00:00", ctx.tz);
    const status = APPOINTMENT_STATUSES.find((s) => s === sp.st);
    const appts = await tx<Appt[]>`
      select a.id, a.starts_at, a.ends_at, a.status, a.professional_id, a.service_id, s.name as service, p.full_name as patient, a.patient_id, a.created_by_type, a.notes, a.cancel_reason,
             (select r.name from appointment_resources ar join resources r on r.id = ar.resource_id where ar.appointment_id = a.id and r.kind = 'chair' limit 1) as chair
      from appointments a join services s on s.id = a.service_id join patients p on p.id = a.patient_id
      where a.starts_at >= ${start} and a.starts_at < ${end}
        and a.professional_id = any(${professionals.map((p) => p.id)}::uuid[])
        ${status ? tx`and a.status = ${status}` : tx`and a.status <> 'cancelled'`}
      order by a.starts_at`;
    // Para a legenda clicável: todas as consultas do período visível, inclusive canceladas.
    const byStatus = await tx<{ id: string; starts_at: Date; status: AppointmentStatus; patient: string; patient_id: string; service: string; professional: string }[]>`
      select a.id, a.starts_at, a.status, p.full_name as patient, a.patient_id, s.name as service, pr.name as professional
      from appointments a join services s on s.id = a.service_id join patients p on p.id = a.patient_id join professionals pr on pr.id = a.professional_id
      where a.starts_at >= ${start} and a.starts_at < ${end} and a.professional_id = any(${professionals.map((p) => p.id)}::uuid[])
      order by a.starts_at`;
    const blocks = await tx<{ id: string; professional_id: string | null; s: Date; e: Date; reason: string | null }[]>`
      select id, professional_id, lower(during) as s, upper(during) as e, reason from time_blocks
      where during && tstzrange(${start}, ${end}) and resource_id is null order by lower(during)`;
    const services = canWrite ? await tx<{ id: string; name: string; professional_ids: string[] }[]>`
      select s.id, s.name, coalesce(array_agg(sp.professional_id) filter (where sp.professional_id is not null), '{}') as professional_ids
      from services s left join service_professionals sp on sp.service_id = s.id group by s.id order by s.name` : [];
    const patients = canWrite ? await tx<{ id: string; name: string }[]>`select id, full_name as name from patients where merged_into_patient_id is null order by full_name limit 1000` : [];
    return { professionals, allProfessionals, appts, blocks, services, patients, onlyProf, byStatus };
  });

  const href = (params: Record<string, string | null>) => {
    const merged: Record<string, string | null | undefined> = { d: day === today ? null : day, v: view === "dia" ? null : view, prof: sp.prof, esp: sp.esp, st: sp.st, ...params };
    const qs = Object.entries(merged).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
    return qs ? `/agenda?${qs}` : "/agenda";
  };
  const step = view === "dia" ? 1 : view === "semana" ? 7 : 31;
  const shift = (dir: number) => view === "mes" ? `${addDays(dir > 0 ? addDays(monthStart, 32) : addDays(monthStart, -1), 0).slice(0, 8)}01` : addDays(day, dir * step);
  const specialties = [...new Set(data.allProfessionals.map((p) => p.specialty).filter((s): s is string => !!s))];
  const bookingProps = {
    services: data.services.map((s) => ({ id: s.id, name: s.name, professionalIds: s.professional_ids })),
    professionals: data.allProfessionals.map((p) => ({ id: p.id, name: p.name })), patients: data.patients, defaultDate: day < today ? today : day,
  };
  const minutesFromStart = (d: Date) => { const p = localParts(d, ctx.tz); return (p.hour - DAY_START) * 60 + p.minute; };

  const ApptCard = ({ a, compact }: { a: Appt; compact?: boolean }) => {
    const S = STATUS[a.status];
    const Icon = S.icon;
    return (
      <Modal title={a.patient} description={`${a.service} · ${formatFull(a.starts_at, ctx.tz)} às ${localTime(a.ends_at, ctx.tz)}`} wide triggerTitle="Clique para ver e alterar a consulta"
        triggerClass={cn("group block w-full cursor-pointer overflow-hidden rounded-sm border-l-2 px-2 py-1 text-left text-xs transition-[box-shadow,filter] hover:shadow-[0_0_0_1px_rgb(var(--acento-rgb)/0.7)] hover:brightness-110 focus-visible:shadow-[0_0_0_2px_rgb(var(--acento-rgb))]", S.cls, compact ? "" : "h-full")}
        trigger={<>
          <span className="flex items-center gap-1 font-semibold"><Icon size={11} aria-hidden className="shrink-0" /><span className="truncate">{localTime(a.starts_at, ctx.tz)} {a.patient}</span><ChevronRight size={11} aria-hidden className="ml-auto shrink-0 opacity-0 transition-opacity group-hover:opacity-80" /></span>
          <span className="block truncate opacity-80">{a.service} · {APPOINTMENT_STATUS_LABELS[a.status]}</span>
        </>}>
        <div className="space-y-6">
          <div className={cn("flex items-center justify-between gap-3 rounded-md border-l-2 px-4 py-3", S.cls)}>
            <span className="flex items-center gap-2 text-[14px] font-medium"><Icon size={15} aria-hidden /> {APPOINTMENT_STATUS_LABELS[a.status]}</span>
            <span className="t-small">Marcada por {a.created_by_type === "ai" ? "assistente virtual" : a.created_by_type === "user" ? "equipe" : "sistema"}</span>
          </div>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line">
            {[
              ["Paciente", <Link key="p" className="underline-offset-2 hover:underline" href={`/pacientes/${a.patient_id}`}>{a.patient}</Link>],
              ["Serviço", a.service],
              ["Dentista", data.allProfessionals.find((p) => p.id === a.professional_id)?.name ?? "—"],
              ["Cadeira", a.chair ?? "—"],
            ].map(([k, v]) => (
              <div key={String(k)} className="bg-surface px-4 py-3"><dt className="eyebrow text-bone-mute">{k}</dt><dd className="mt-1 text-[14px] font-medium">{v}</dd></div>
            ))}
            {a.notes && <div className="col-span-2 bg-surface px-4 py-3"><dt className="eyebrow text-bone-mute">Observação</dt><dd className="mt-1 text-[14px]">{a.notes}</dd></div>}
          </dl>
          {canWrite && NEXT[a.status].length > 0 && (
            <section>
              <h3 className="t-h3 mb-3">Próximo passo</h3>
              <div className="flex flex-wrap gap-2">
                {NEXT[a.status].map((s, i) => (
                  <ActionForm key={s} action={appointmentStatusAction}>
                    <input type="hidden" name="appointmentId" value={a.id} /><input type="hidden" name="status" value={s} />
                    <Button variant={s === "no_show" ? "outline" : i === 0 ? "primary" : "outline"}>{{ confirmed: "Confirmar presença", arrived: "Registrar chegada", in_service: "Iniciar atendimento", completed: "Concluir consulta", no_show: "Registrar falta" }[s as string] ?? s}</Button>
                  </ActionForm>
                ))}
              </div>
            </section>
          )}
          {canWrite && (a.status === "scheduled" || a.status === "confirmed") && (
            <section className="divide-y divide-line rounded-md border border-line">
              <details className="group/d">
                <summary className="flex h-12 cursor-pointer list-none items-center justify-between px-4 text-[14px] font-medium">Reagendar para outro horário<ChevronRight size={15} aria-hidden className="text-bone-mute transition-transform group-open/d:rotate-90" /></summary>
                <div className="border-t border-line p-4"><BookingForm {...bookingProps} reschedule={{ appointmentId: a.id, serviceId: a.service_id, patientName: a.patient }} /></div>
              </details>
              <details className="group/d">
                <summary className="flex h-12 cursor-pointer list-none items-center justify-between px-4 text-[14px] font-medium text-danger">Cancelar consulta<ChevronRight size={15} aria-hidden className="transition-transform group-open/d:rotate-90" /></summary>
                <ActionForm action={appointmentStatusAction} className="space-y-4 border-t border-line p-4">
                  <input type="hidden" name="appointmentId" value={a.id} /><input type="hidden" name="status" value="cancelled" />
                  <Field label="Motivo"><Input name="reason" placeholder="Ex.: paciente pediu" /></Field>
                  <div className="flex justify-end"><Button variant="danger">Cancelar e remover lembretes</Button></div>
                </ActionForm>
              </details>
            </section>
          )}
        </div>
      </Modal>
    );
  };

  return (
    <>
      <PageHeader title="Agenda" subtitle={view === "dia" ? `${formatDay(day)}${day === today ? " · hoje" : ""}` : view === "semana" ? `Semana de ${formatDay(weekStart)}` : new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${monthStart}T00:00:00Z`))}>
        {canWrite && (
          <>
            <Modal trigger={<><Lock size={14} aria-hidden /> Bloquear horário</>} title="Bloqueio, folga ou feriado" description="Horários bloqueados não aparecem para a assistente nem para a recepção." triggerClass={buttonClass("outline")}>
              <ActionForm action={createBlockAction} className="space-y-4">
                <Field label="Quem"><Select name="professionalId" defaultValue=""><option value="">Clínica toda (feriado)</option>{data.allProfessionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
                <Field label="Dia"><Input type="date" name="date" defaultValue={day} required /></Field>
                <Checkbox name="allDay" label="Dia inteiro" />
                <div className="grid grid-cols-2 gap-3"><Field label="Início"><Input type="time" name="start" defaultValue="12:00" /></Field><Field label="Fim"><Input type="time" name="end" defaultValue="13:00" /></Field></div>
                <Field label="Motivo"><Input name="reason" placeholder="Ex.: almoço, congresso, feriado" /></Field>
                <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Bloquear</Button></div>
              </ActionForm>
            </Modal>
            <Modal trigger={<><Plus aria-hidden /> Agendar consulta</>} title="Agendar consulta" description="Três passos: paciente, serviço e horário. Só aparecem horários realmente livres." wide defaultOpen={sp.nova === "1"} triggerClass={buttonClass("primary")}><BookingForm {...bookingProps} /></Modal>
          </>
        )}
      </PageHeader>

      <div className="vidro mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg p-3">
        <div className="flex items-center gap-2">
          <Link href={href({ d: shift(-1) })} aria-label="Anterior" className={cn(buttonClass("outline"), "w-10 px-0!")}><ChevronLeft size={16} /></Link>
          <Link href={href({ d: null })} className={buttonClass("outline")}>Hoje</Link>
          <Link href={href({ d: shift(1) })} aria-label="Próximo" className={cn(buttonClass("outline"), "w-10 px-0!")}><ChevronRight size={16} /></Link>
          <Segmented label="Visualização" className="ml-2" items={(["dia", "semana", "mes"] as const).map((v) => ({ href: href({ v: v === "dia" ? null : v }), label: v === "mes" ? "Mês" : v === "dia" ? "Dia" : "Semana", active: view === v }))} />
        </div>
        <SubmitOnChange className="flex flex-wrap items-center gap-2">
          {day !== today && <input type="hidden" name="d" value={day} />}
          {view !== "dia" && <input type="hidden" name="v" value={view} />}
          {ctx.role !== "dentista" && (
            <Select name="prof" defaultValue={sp.prof ?? ""} aria-label="Dentista" className="w-auto"><option value="">Todos os dentistas</option>{data.allProfessionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          )}
          <Select name="esp" defaultValue={sp.esp ?? ""} aria-label="Especialidade" className="w-auto"><option value="">Todas as especialidades</option>{specialties.map((s) => <option key={s}>{s}</option>)}</Select>
          <Select name="st" defaultValue={sp.st ?? ""} aria-label="Status" className="w-auto"><option value="">Consultas ativas</option>{APPOINTMENT_STATUSES.map((s) => <option key={s} value={s}>{APPOINTMENT_STATUS_LABELS[s]}</option>)}</Select>
        </SubmitOnChange>
      </div>

      {data.professionals.length === 0 ? <Empty title="Nenhum dentista para exibir">Cadastre dentistas em Configurações → Agenda.</Empty> : view === "dia" ? (
        <Card className="p-0">
          <div className="scroll-thin overflow-x-auto">
            <div className="grid min-w-[640px]" style={{ gridTemplateColumns: `52px repeat(${data.professionals.length}, minmax(170px, 1fr))` }}>
              <div className="sticky left-0 z-10 border-b border-line bg-surface" />
              {data.professionals.map((p) => (
                <div key={p.id} className="border-b border-l border-line px-4 py-4">
                  <p className="t-h3 flex items-center gap-2"><span className="size-2.5 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />{p.name}</p>
                  <p className="t-small mt-0.5 pl-[18px]">{p.specialty ?? "—"} · {(() => { const n = data.appts.filter((a) => a.professional_id === p.id).length; return `${n} consulta${n === 1 ? "" : "s"}`; })()}</p>
                </div>
              ))}
              <div className="sticky left-0 z-10 bg-surface" style={{ height: (DAY_END - DAY_START) * 60 * PPM }}>
                {Array.from({ length: DAY_END - DAY_START }, (_, i) => <div key={i} className="pr-2 text-right text-[10px] text-bone-mute" style={{ height: 60 * PPM }}>{String(DAY_START + i).padStart(2, "0")}:00</div>)}
              </div>
              {data.professionals.map((p) => (
                <div key={p.id} className="relative border-l border-line" style={{ height: (DAY_END - DAY_START) * 60 * PPM, backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${60 * PPM - 1}px, var(--color-line) ${60 * PPM - 1}px, var(--color-line) ${60 * PPM}px)` }}>
                  {data.blocks.filter((b) => !b.professional_id || b.professional_id === p.id).map((b) => {
                    const top = Math.max(0, localDate(b.s, ctx.tz) < day ? 0 : minutesFromStart(b.s)) * PPM;
                    const bottom = Math.min((DAY_END - DAY_START) * 60, localDate(b.e, ctx.tz) > day ? 9999 : minutesFromStart(b.e)) * PPM;
                    return (
                      <div key={b.id} className="absolute inset-x-1 flex items-start justify-between gap-1 overflow-hidden rounded-sm border border-dashed border-line px-2 py-1 text-[11px] text-bone-dim"
                        style={{ top, height: Math.max(22, bottom - top), backgroundImage: "repeating-linear-gradient(45deg, var(--color-surface-2) 0 8px, var(--color-line) 8px 16px)" }}>
                        <span className="flex items-center gap-1 font-medium"><Lock size={10} aria-hidden /> {b.reason ?? "Bloqueado"}</span>
                        {canWrite && <ActionForm action={deleteBlockAction}><input type="hidden" name="blockId" value={b.id} /><button className={buttonClass("ghost", "sm")} aria-label="Remover bloqueio">Remover</button></ActionForm>}
                      </div>
                    );
                  })}
                  {data.appts.filter((a) => a.professional_id === p.id).map((a) => (
                    <div key={a.id} className="absolute inset-x-1.5 z-[1]" style={{ top: Math.max(0, minutesFromStart(a.starts_at)) * PPM, height: Math.max(34, ((a.ends_at.getTime() - a.starts_at.getTime()) / 60000) * PPM - 2) }}>
                      <ApptCard a={a} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </Card>
      ) : view === "semana" ? (
        <div className="grid gap-2 md:grid-cols-7">
          {Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).map((d) => {
            const list = data.appts.filter((a) => localDate(a.starts_at, ctx.tz) === d);
            return (
              <Card key={d} className={cn("min-w-0 p-3", d === today && "border-acento shadow-[0_0_0_1px_rgb(var(--acento-rgb))]")}>
                <Link href={href({ d, v: null })} className="mb-2 flex items-baseline justify-between gap-2 whitespace-nowrap hover:underline">
                  <span className="text-[13px] font-semibold">{WEEKDAY_LABELS[weekdayOf(d)]!.slice(0, 3)} <span className="font-mono text-[12px] font-normal text-bone-dim">{d.slice(8)}/{d.slice(5, 7)}</span></span>
                  <span className="font-mono text-[11px] text-bone-mute">{list.length}</span>
                </Link>
                <div className="space-y-1.5">{list.length === 0 ? <p className="text-[11px] text-bone-mute">Livre</p> : list.map((a) => <ApptCard key={a.id} a={a} compact />)}</div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="p-3">
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-bone-mute">{["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((w) => <div key={w} className="py-1">{w}</div>)}</div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)).map((d) => {
              const n = data.appts.filter((a) => localDate(a.starts_at, ctx.tz) === d).length;
              return (
                <Link key={d} href={href({ d, v: null })} className={cn("min-h-16 rounded-sm border border-line p-2 text-left hover:bg-surface-2", d.slice(0, 7) !== day.slice(0, 7) && "opacity-40", d === today && "border-gold bg-gold/10")}>
                  <span className="text-xs font-semibold">{Number(d.slice(8))}</span>
                  {n > 0 && <span className="mt-1 block rounded-full bg-surface-2 px-1.5 text-center text-[10px] font-semibold text-bone">{n} consulta{n > 1 ? "s" : ""}</span>}
                </Link>
              );
            })}
          </div>
        </Card>
      )}

      {/* Legenda clicável: cada situação abre a lista de quem está nela no período que está na tela. */}
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs" aria-label="Situações das consultas">
        <span className="t-small mr-1">No período:</span>
        {APPOINTMENT_STATUSES.map((st) => {
          const Icon = STATUS[st].icon;
          const list = data.byStatus.filter((a) => a.status === st);
          return (
            <Modal key={st} title={APPOINTMENT_STATUS_LABELS[st]} description={`${list.length} consulta${list.length === 1 ? "" : "s"} ${view === "dia" ? "neste dia" : view === "semana" ? "nesta semana" : "neste mês"}.`}
              triggerTitle={`Ver consultas: ${APPOINTMENT_STATUS_LABELS[st]}`}
              triggerClass={cn("inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-sm border-l-2 px-2.5 transition-[filter,box-shadow] hover:brightness-110 hover:shadow-[0_0_0_1px_rgb(var(--acento-rgb)/0.6)]", STATUS[st].cls)}
              trigger={<><Icon size={12} aria-hidden /> {APPOINTMENT_STATUS_LABELS[st]} <span className="font-mono opacity-70">{list.length}</span></>}>
              {list.length === 0 ? <p className="t-small">Nenhuma consulta nesta situação no período.</p> : (
                <ul className="divide-y divide-line">
                  {list.map((a) => (
                    <li key={a.id} className="flex min-h-14 items-center justify-between gap-4 py-2.5">
                      <div className="min-w-0">
                        <Link href={`/pacientes/${a.patient_id}`} className="t-h3 block truncate hover:underline">{a.patient}</Link>
                        <p className="t-small truncate">{a.service} · {a.professional}</p>
                      </div>
                      <Link href={href({ d: localDate(a.starts_at, ctx.tz), v: null })} className={cn(buttonClass("ghost", "sm"), "shrink-0 font-mono normal-case tracking-normal")}>{formatShort(a.starts_at, ctx.tz)}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </Modal>
          );
        })}
      </div>
    </>
  );
}
