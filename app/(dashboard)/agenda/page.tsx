import Link from "next/link";
import { Ban, CalendarCheck, Check, ChevronLeft, ChevronRight, CircleDashed, DoorOpen, Lock, Plus, Stethoscope, UserX, type LucideIcon } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, Modal, SubmitOnChange } from "@/components/client";
import { Badge, Button, buttonClass, Card, Checkbox, Empty, Field, Input, PageHeader, Select } from "@/components/ui";
import { can } from "@/domain/permissions";
import { APPOINTMENT_STATUSES, APPOINTMENT_STATUS_LABELS, type AppointmentStatus } from "@/domain/states";
import { addDays, formatDay, formatFull, localDate, localParts, localTime, weekdayOf, zonedToUtc } from "@/lib/datetime";
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
  scheduled: { icon: CircleDashed, cls: "bg-white border-navy-300 text-navy-900" },
  confirmed: { icon: CalendarCheck, cls: "bg-sun-100 border-sun-500 text-navy-900" },
  arrived: { icon: DoorOpen, cls: "bg-sky-50 border-sky-400 text-navy-900" },
  in_service: { icon: Stethoscope, cls: "bg-navy-900 border-navy-900 text-white" },
  completed: { icon: Check, cls: "bg-ok-soft border-ok text-ok" },
  no_show: { icon: UserX, cls: "bg-danger-soft border-danger text-danger" },
  cancelled: { icon: Ban, cls: "bg-cream-100 border-cream-300 text-navy-500 line-through" },
};
const NEXT: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled: ["confirmed", "arrived", "no_show"], confirmed: ["arrived", "no_show"], arrived: ["in_service", "completed"],
  in_service: ["completed"], completed: [], no_show: [], cancelled: [],
};
const DAY_START = 7;
const DAY_END = 20;
const PPM = 1.15; // pixels por minuto

export default async function AgendaPage({ searchParams }: { searchParams: Promise<{ d?: string; v?: string; prof?: string; esp?: string; st?: string }> }) {
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
    const blocks = await tx<{ id: string; professional_id: string | null; s: Date; e: Date; reason: string | null }[]>`
      select id, professional_id, lower(during) as s, upper(during) as e, reason from time_blocks
      where during && tstzrange(${start}, ${end}) and resource_id is null order by lower(during)`;
    const services = canWrite ? await tx<{ id: string; name: string; professional_ids: string[] }[]>`
      select s.id, s.name, coalesce(array_agg(sp.professional_id) filter (where sp.professional_id is not null), '{}') as professional_ids
      from services s left join service_professionals sp on sp.service_id = s.id group by s.id order by s.name` : [];
    const patients = canWrite ? await tx<{ id: string; name: string }[]>`select id, full_name as name from patients where merged_into_patient_id is null order by full_name limit 1000` : [];
    return { professionals, allProfessionals, appts, blocks, services, patients, onlyProf };
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
      <Modal title={`${a.service} · ${a.patient}`} wide
        triggerClass={cn("block w-full overflow-hidden rounded-xl border-l-4 px-2 py-1 text-left text-xs shadow-sm hover:brightness-95", S.cls, compact ? "" : "h-full")}
        trigger={<>
          <span className="flex items-center gap-1 font-semibold"><Icon size={11} aria-hidden className="shrink-0" /><span className="truncate">{localTime(a.starts_at, ctx.tz)} {a.patient}</span></span>
          <span className="block truncate opacity-80">{a.service} · {APPOINTMENT_STATUS_LABELS[a.status]}</span>
        </>}>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-xs text-navy-500">Quando</dt><dd className="font-medium">{formatFull(a.starts_at, ctx.tz)} – {localTime(a.ends_at, ctx.tz)}</dd></div>
          <div><dt className="text-xs text-navy-500">Status</dt><dd><Badge tone={a.status === "no_show" ? "danger" : a.status === "completed" ? "ok" : "neutral"}><Icon size={11} aria-hidden /> {APPOINTMENT_STATUS_LABELS[a.status]}</Badge></dd></div>
          <div><dt className="text-xs text-navy-500">Paciente</dt><dd><Link className="font-medium underline" href={`/pacientes/${a.patient_id}`}>{a.patient}</Link></dd></div>
          <div><dt className="text-xs text-navy-500">Dentista / cadeira</dt><dd className="font-medium">{data.allProfessionals.find((p) => p.id === a.professional_id)?.name} · {a.chair ?? "—"}</dd></div>
          <div><dt className="text-xs text-navy-500">Marcada por</dt><dd>{a.created_by_type === "ai" ? "Assistente virtual" : a.created_by_type === "user" ? "Equipe" : "Sistema"}</dd></div>
          {a.notes && <div className="col-span-2"><dt className="text-xs text-navy-500">Observação</dt><dd>{a.notes}</dd></div>}
        </dl>
        {canWrite && NEXT[a.status].length > 0 && (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-cream-200 pt-4">
            {NEXT[a.status].map((s) => (
              <ActionForm key={s} action={appointmentStatusAction}>
                <input type="hidden" name="appointmentId" value={a.id} /><input type="hidden" name="status" value={s} />
                <Button size="sm" variant={s === "no_show" ? "outline" : "primary"}>{{ confirmed: "Confirmar", arrived: "Registrar chegada", in_service: "Iniciar atendimento", completed: "Concluir", no_show: "Registrar falta" }[s as string] ?? s}</Button>
              </ActionForm>
            ))}
          </div>
        )}
        {canWrite && (a.status === "scheduled" || a.status === "confirmed") && (
          <div className="mt-4 grid gap-4 border-t border-cream-200 pt-4 sm:grid-cols-2">
            <details><summary className="cursor-pointer text-sm font-semibold">Reagendar</summary>
              <div className="mt-3"><BookingForm {...bookingProps} reschedule={{ appointmentId: a.id, serviceId: a.service_id, patientName: a.patient }} /></div>
            </details>
            <details><summary className="cursor-pointer text-sm font-semibold text-danger">Cancelar consulta</summary>
              <ActionForm action={appointmentStatusAction} className="mt-3 space-y-3">
                <input type="hidden" name="appointmentId" value={a.id} /><input type="hidden" name="status" value="cancelled" />
                <Field label="Motivo"><Input name="reason" placeholder="Ex.: paciente pediu" /></Field>
                <Button size="sm" variant="danger">Cancelar e remover lembretes</Button>
              </ActionForm>
            </details>
          </div>
        )}
      </Modal>
    );
  };

  return (
    <>
      <PageHeader title="Agenda" subtitle={view === "dia" ? `${formatDay(day)}${day === today ? " · hoje" : ""}` : view === "semana" ? `Semana de ${formatDay(weekStart)}` : new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${monthStart}T00:00:00Z`))}>
        {canWrite && (
          <>
            <Modal trigger={<><Lock size={14} aria-hidden /> Bloquear horário</>} title="Bloqueio, folga ou feriado" triggerClass={buttonClass("outline")}>
              <ActionForm action={createBlockAction} className="space-y-4">
                <Field label="Quem"><Select name="professionalId" defaultValue=""><option value="">Clínica toda (feriado)</option>{data.allProfessionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
                <Field label="Dia"><Input type="date" name="date" defaultValue={day} required /></Field>
                <Checkbox name="allDay" label="Dia inteiro" />
                <div className="grid grid-cols-2 gap-3"><Field label="Início"><Input type="time" name="start" defaultValue="12:00" /></Field><Field label="Fim"><Input type="time" name="end" defaultValue="13:00" /></Field></div>
                <Field label="Motivo"><Input name="reason" placeholder="Ex.: almoço, congresso, feriado" /></Field>
                <Button type="submit">Bloquear</Button>
              </ActionForm>
            </Modal>
            <Modal trigger={<><Plus size={15} aria-hidden /> Nova consulta</>} title="Nova consulta" wide triggerClass={buttonClass("accent")}><BookingForm {...bookingProps} /></Modal>
          </>
        )}
      </PageHeader>

      <Card className="mb-3 flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="flex items-center gap-1">
          <Link href={href({ d: shift(-1) })} aria-label="Anterior" className="rounded-full p-2 hover:bg-cream-100"><ChevronLeft size={16} /></Link>
          <Link href={href({ d: null })} className={buttonClass("outline", "sm")}>Hoje</Link>
          <Link href={href({ d: shift(1) })} aria-label="Próximo" className="rounded-full p-2 hover:bg-cream-100"><ChevronRight size={16} /></Link>
          <div className="ml-2 flex rounded-full bg-cream-100 p-0.5">
            {(["dia", "semana", "mes"] as const).map((v) => (
              <Link key={v} href={href({ v: v === "dia" ? null : v })} className={cn("rounded-full px-3 py-1 text-xs font-medium", view === v ? "bg-navy-900 text-white" : "text-navy-700")}>{v === "mes" ? "Mês" : v === "dia" ? "Dia" : "Semana"}</Link>
            ))}
          </div>
        </div>
        <SubmitOnChange className="flex flex-wrap items-center gap-2">
          {day !== today && <input type="hidden" name="d" value={day} />}
          {view !== "dia" && <input type="hidden" name="v" value={view} />}
          {ctx.role !== "dentista" && (
            <Select name="prof" defaultValue={sp.prof ?? ""} aria-label="Dentista" className="h-8 w-auto text-xs"><option value="">Todos os dentistas</option>{data.allProfessionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          )}
          <Select name="esp" defaultValue={sp.esp ?? ""} aria-label="Especialidade" className="h-8 w-auto text-xs"><option value="">Todas as especialidades</option>{specialties.map((s) => <option key={s}>{s}</option>)}</Select>
          <Select name="st" defaultValue={sp.st ?? ""} aria-label="Status" className="h-8 w-auto text-xs"><option value="">Ativas</option>{APPOINTMENT_STATUSES.map((s) => <option key={s} value={s}>{APPOINTMENT_STATUS_LABELS[s]}</option>)}</Select>
        </SubmitOnChange>
      </Card>

      {data.professionals.length === 0 ? <Empty title="Nenhum dentista para exibir">Cadastre dentistas em Configurações → Agenda.</Empty> : view === "dia" ? (
        <Card className="p-0">
          <div className="scroll-thin overflow-x-auto">
            <div className="grid min-w-[640px]" style={{ gridTemplateColumns: `52px repeat(${data.professionals.length}, minmax(170px, 1fr))` }}>
              <div className="sticky left-0 z-10 border-b border-cream-200 bg-white" />
              {data.professionals.map((p) => (
                <div key={p.id} className="border-b border-l border-cream-200 px-3 py-3">
                  <p className="flex items-center gap-2 text-sm font-semibold"><span className="size-2.5 rounded-full" style={{ background: p.color }} aria-hidden />{p.name}</p>
                  <p className="text-[11px] text-navy-500">{p.specialty ?? "—"} · {data.appts.filter((a) => a.professional_id === p.id).length} consulta(s)</p>
                </div>
              ))}
              <div className="sticky left-0 z-10 bg-white" style={{ height: (DAY_END - DAY_START) * 60 * PPM }}>
                {Array.from({ length: DAY_END - DAY_START }, (_, i) => <div key={i} className="pr-2 text-right text-[10px] text-navy-500" style={{ height: 60 * PPM }}>{String(DAY_START + i).padStart(2, "0")}:00</div>)}
              </div>
              {data.professionals.map((p) => (
                <div key={p.id} className="relative border-l border-cream-200" style={{ height: (DAY_END - DAY_START) * 60 * PPM, backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${60 * PPM - 1}px, var(--color-cream-200) ${60 * PPM - 1}px, var(--color-cream-200) ${60 * PPM}px)` }}>
                  {data.blocks.filter((b) => !b.professional_id || b.professional_id === p.id).map((b) => {
                    const top = Math.max(0, localDate(b.s, ctx.tz) < day ? 0 : minutesFromStart(b.s)) * PPM;
                    const bottom = Math.min((DAY_END - DAY_START) * 60, localDate(b.e, ctx.tz) > day ? 9999 : minutesFromStart(b.e)) * PPM;
                    return (
                      <div key={b.id} className="absolute inset-x-1 flex items-start justify-between gap-1 overflow-hidden rounded-xl border border-dashed border-navy-300 px-2 py-1 text-[11px] text-navy-700"
                        style={{ top, height: Math.max(22, bottom - top), backgroundImage: "repeating-linear-gradient(45deg, var(--color-cream-100) 0 8px, var(--color-cream-200) 8px 16px)" }}>
                        <span className="flex items-center gap-1 font-medium"><Lock size={10} aria-hidden /> {b.reason ?? "Bloqueado"}</span>
                        {canWrite && <ActionForm action={deleteBlockAction}><input type="hidden" name="blockId" value={b.id} /><button className="underline" aria-label="Remover bloqueio">remover</button></ActionForm>}
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
              <Card key={d} className={cn("p-3", d === today && "ring-2 ring-sun-500")}>
                <Link href={href({ d, v: null })} className="mb-2 block text-xs font-semibold capitalize hover:underline">{formatDay(d)} <span className="font-normal text-navy-500">· {list.length}</span></Link>
                <div className="space-y-1.5">{list.length === 0 ? <p className="text-[11px] text-navy-300">Livre</p> : list.map((a) => <ApptCard key={a.id} a={a} compact />)}</div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="p-3">
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-navy-500">{["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((w) => <div key={w} className="py-1">{w}</div>)}</div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)).map((d) => {
              const n = data.appts.filter((a) => localDate(a.starts_at, ctx.tz) === d).length;
              return (
                <Link key={d} href={href({ d, v: null })} className={cn("min-h-16 rounded-xl border border-cream-200 p-2 text-left hover:bg-cream-50", d.slice(0, 7) !== day.slice(0, 7) && "opacity-40", d === today && "border-sun-500 bg-sun-100")}>
                  <span className="text-xs font-semibold">{Number(d.slice(8))}</span>
                  {n > 0 && <span className="mt-1 block rounded-full bg-navy-900 px-1.5 text-center text-[10px] font-semibold text-white">{n} consulta{n > 1 ? "s" : ""}</span>}
                </Link>
              );
            })}
          </div>
        </Card>
      )}

      <div className="mt-3 flex flex-wrap gap-2 text-xs" aria-label="Legenda de status">
        {APPOINTMENT_STATUSES.map((s) => { const Icon = STATUS[s].icon; return <span key={s} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", STATUS[s].cls, "no-underline")}><Icon size={11} aria-hidden /> {APPOINTMENT_STATUS_LABELS[s]}</span>; })}
      </div>
    </>
  );
}
