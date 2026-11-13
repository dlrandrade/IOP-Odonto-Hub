import { inTx, pgErrorCode, PG_EXCLUSION_VIOLATION, type Sql } from "@/db/client";
import { computeSlots, type Slot, type SlotQuery } from "@/domain/slots";
import { canTransitionAppointment, type AppointmentStatus } from "@/domain/states";
import { parseSettings } from "@/domain/settings";
import { addDays, addMinutes, clampToQuietHours, localDate } from "@/lib/datetime";
import { cancelJobs, enqueueJob } from "./jobs-queue";

export type AvailabilityRequest = {
  clinicId: string;
  serviceId: string;
  professionalId?: string | null;
  fromDate: string;
  toDate: string;
  turno?: SlotQuery["turno"];
  now?: Date;
  /** Recepção pode marcar sem antecedência mínima; a IA respeita a regra da clínica. */
  ignoreLeadTime?: boolean;
  /** Ao reagendar, ignora a ocupação da própria consulta. */
  ignoreAppointmentId?: string | null;
};

type ServiceRow = { id: string; name: string; kind: string; duration_min: number; buffer_min: number; required_resource_kinds: string[]; status: string };

export async function findSlots(sql: Sql, r: AvailabilityRequest): Promise<{ slots: Slot[]; service: ServiceRow | null; tz: string }> {
  const [clinic] = await sql<{ timezone: string; settings: unknown }[]>`select timezone, settings from clinics where id = ${r.clinicId}`;
  const tz = clinic?.timezone ?? "America/Sao_Paulo";
  const settings = parseSettings(clinic?.settings);
  const [service] = await sql<ServiceRow[]>`
    select id, name, kind, duration_min, buffer_min, required_resource_kinds, status
    from services where id = ${r.serviceId} and clinic_id = ${r.clinicId}`;
  if (!service) return { slots: [], service: null, tz };

  const professionals = await sql<{ id: string; resource_id: string }[]>`
    select p.id, r.id as resource_id
    from professionals p
    join service_professionals sp on sp.professional_id = p.id and sp.service_id = ${r.serviceId}
    join resources r on r.professional_id = p.id
    where p.clinic_id = ${r.clinicId} and p.active
      ${r.professionalId ? sql`and p.id = ${r.professionalId}` : sql``}`;
  if (professionals.length === 0) return { slots: [], service, tz };

  const rangeStart = new Date(`${addDays(r.fromDate, -1)}T00:00:00Z`);
  const rangeEnd = new Date(`${addDays(r.toDate, 2)}T00:00:00Z`);
  const rules = await sql<{ professional_id: string; weekday: number; start_time: string; end_time: string }[]>`
    select professional_id, weekday, start_time::text, end_time::text from availability_rules where clinic_id = ${r.clinicId}`;
  const blocks = await sql<{ professional_id: string | null; resource_id: string | null; s: Date; e: Date }[]>`
    select professional_id, resource_id, lower(during) as s, upper(during) as e from time_blocks
    where clinic_id = ${r.clinicId} and during && tstzrange(${rangeStart}, ${rangeEnd})`;
  const busy = await sql<{ resource_id: string; s: Date; e: Date }[]>`
    select resource_id, lower(during) as s, upper(during) as e from appointment_resources
    where clinic_id = ${r.clinicId} and active and during && tstzrange(${rangeStart}, ${rangeEnd})
      ${r.ignoreAppointmentId ? sql`and appointment_id <> ${r.ignoreAppointmentId}` : sql``}`;
  const resources = await sql<{ id: string; kind: string }[]>`
    select id, kind from resources where clinic_id = ${r.clinicId} and active and kind <> 'professional' order by name`;

  const slots = computeSlots({
    tz, now: r.now ?? new Date(), fromDate: r.fromDate, toDate: r.toDate, turno: r.turno ?? null,
    service: { durationMin: service.duration_min, bufferMin: service.buffer_min, requiredResourceKinds: service.required_resource_kinds },
    professionals: professionals.map((p) => ({ id: p.id, resourceId: p.resource_id })),
    rules: rules.map((x) => ({ professionalId: x.professional_id, weekday: x.weekday, start: x.start_time.slice(0, 5), end: x.end_time.slice(0, 5) })),
    blocks: blocks.map((b) => ({ professionalId: b.professional_id, resourceId: b.resource_id, start: b.s, end: b.e })),
    busy: busy.map((b) => ({ resourceId: b.resource_id, start: b.s, end: b.e })),
    resources: [...resources],
    minLeadMinutes: r.ignoreLeadTime ? -60 * 24 * 365 : settings.minLeadMinutes,
    maxAdvanceDays: settings.maxAdvanceDays,
  });
  return { slots, service, tz };
}

export type BookInput = {
  clinicId: string;
  patientId: string;
  contactId?: string | null;
  serviceId: string;
  professionalId: string;
  startsAt: Date;
  createdByType: "ai" | "user" | "system";
  createdByUserId?: string | null;
  notes?: string | null;
  ignoreLeadTime?: boolean;
  now?: Date;
};

export type BookResult =
  | { ok: true; appointmentId: string; startsAt: Date; endsAt: Date }
  | { ok: false; reason: "unavailable" | "conflict" | "invalid"; message: string };

async function insertAppointment(tx: Sql, i: BookInput, rescheduledFromId: string | null): Promise<BookResult> {
  const [patient] = await tx`select 1 from patients where id = ${i.patientId} and clinic_id = ${i.clinicId}`;
  if (!patient) return { ok: false, reason: "invalid", message: "Paciente não encontrado." };
  const [clinic] = await tx<{ timezone: string }[]>`select timezone from clinics where id = ${i.clinicId}`;
  const tz = clinic?.timezone ?? "America/Sao_Paulo";
  const day = localDate(i.startsAt, tz);
  // Revalida no momento da reserva: disponibilidade, habilitação do dentista e recursos.
  const { slots, service } = await findSlots(tx, {
    clinicId: i.clinicId, serviceId: i.serviceId, professionalId: i.professionalId, fromDate: day, toDate: day,
    now: i.now, ignoreLeadTime: i.ignoreLeadTime, ignoreAppointmentId: rescheduledFromId,
  });
  if (!service) return { ok: false, reason: "invalid", message: "Serviço não encontrado." };
  const slot = slots.find((s) => s.startsAt.getTime() === i.startsAt.getTime());
  if (!slot) return { ok: false, reason: "unavailable", message: "Horário indisponível." };

  const [unit] = await tx<{ id: string }[]>`select id from units where clinic_id = ${i.clinicId} order by created_at limit 1`;
  const [appt] = await tx<{ id: string }[]>`
    insert into appointments (clinic_id, patient_id, contact_id, service_id, professional_id, unit_id, starts_at, ends_at,
                              created_by_type, created_by_user_id, notes, rescheduled_from_id)
    values (${i.clinicId}, ${i.patientId}, ${i.contactId ?? null}, ${i.serviceId}, ${i.professionalId}, ${unit?.id ?? null},
            ${slot.startsAt}, ${slot.endsAt}, ${i.createdByType}, ${i.createdByUserId ?? null}, ${i.notes ?? null}, ${rescheduledFromId})
    returning id`;
  if (!appt) return { ok: false, reason: "invalid", message: "Falha ao gravar a consulta." };
  for (const resourceId of slot.resourceIds) {
    await tx`
      insert into appointment_resources (clinic_id, appointment_id, resource_id, during)
      values (${i.clinicId}, ${appt.id}, ${resourceId}, tstzrange(${slot.startsAt}, ${slot.occupiedUntil}))`;
  }
  await scheduleReminders(tx, i.clinicId, appt.id, slot.startsAt, i.now ?? new Date());
  return { ok: true, appointmentId: appt.id, startsAt: slot.startsAt, endsAt: slot.endsAt };
}

async function guarded(sql: Sql, fn: (tx: Sql) => Promise<BookResult>): Promise<BookResult> {
  // A constraint EXCLUDE é quem decide a corrida. Quem perde tenta de novo (pode haver outra cadeira livre);
  // se o horário realmente acabou, a revalidação devolve "unavailable".
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let result: BookResult = { ok: false, reason: "invalid", message: "Falha ao gravar." };
      await inTx(sql, async (tx) => {
        result = await fn(tx);
        if (!result.ok) throw new RollbackSignal();
      }).catch((e) => { if (!(e instanceof RollbackSignal)) throw e; });
      return result;
    } catch (e) {
      if (pgErrorCode(e) !== PG_EXCLUSION_VIOLATION) throw e;
    }
  }
  return { ok: false, reason: "conflict", message: "Esse horário acabou de ser ocupado." };
}
class RollbackSignal extends Error {}

export function bookAppointment(sql: Sql, i: BookInput): Promise<BookResult> {
  return guarded(sql, (tx) => insertAppointment(tx, i, null));
}

/** Reagendar: nova consulta + cancelamento da anterior em uma única transação (a vaga antiga só é liberada se a nova gravar). */
export function rescheduleAppointment(sql: Sql, i: Omit<BookInput, "patientId" | "serviceId" | "contactId"> & { appointmentId: string }): Promise<BookResult> {
  return guarded(sql, async (tx) => {
    const [old] = await tx<{ id: string; patient_id: string; contact_id: string | null; service_id: string; status: AppointmentStatus }[]>`
      select id, patient_id, contact_id, service_id, status from appointments
      where id = ${i.appointmentId} and clinic_id = ${i.clinicId} for update`;
    if (!old) return { ok: false, reason: "invalid", message: "Consulta não encontrada." };
    if (!["scheduled", "confirmed"].includes(old.status)) return { ok: false, reason: "invalid", message: "Só é possível reagendar consultas agendadas ou confirmadas." };
    await tx`update appointment_resources set active = false where appointment_id = ${old.id}`;
    const created = await insertAppointment(tx, { ...i, patientId: old.patient_id, contactId: old.contact_id, serviceId: old.service_id }, old.id);
    if (!created.ok) return created;
    await tx`update appointments set status = 'cancelled', cancel_reason = 'Reagendada' where id = ${old.id}`;
    await cancelJobs(tx, i.clinicId, { appointmentId: old.id });
    return created;
  });
}

export async function cancelAppointment(sql: Sql, clinicId: string, appointmentId: string, reason: string | null): Promise<{ ok: boolean; message?: string }> {
  return inTx(sql, async (tx) => {
    const [appt] = await tx<{ status: AppointmentStatus }[]>`select status from appointments where id = ${appointmentId} and clinic_id = ${clinicId} for update`;
    if (!appt) return { ok: false, message: "Consulta não encontrada." };
    if (!["scheduled", "confirmed"].includes(appt.status)) return { ok: false, message: "Esta consulta não pode mais ser cancelada." };
    await tx`update appointments set status = 'cancelled', cancel_reason = ${reason} where id = ${appointmentId}`;
    await tx`update appointment_resources set active = false where appointment_id = ${appointmentId}`;
    // Cancelar remove lembretes pendentes.
    await cancelJobs(tx, clinicId, { appointmentId });
    return { ok: true };
  });
}

export async function setAppointmentStatus(sql: Sql, clinicId: string, appointmentId: string, to: AppointmentStatus, actor: "ai" | "user" | "system"): Promise<{ ok: boolean; message?: string }> {
  if (to === "cancelled") return cancelAppointment(sql, clinicId, appointmentId, null);
  const [appt] = await sql<{ status: AppointmentStatus }[]>`select status from appointments where id = ${appointmentId} and clinic_id = ${clinicId}`;
  if (!appt) return { ok: false, message: "Consulta não encontrada." };
  if (!canTransitionAppointment(appt.status, to, actor)) return { ok: false, message: "Mudança de status não permitida." };
  await sql`
    update appointments set status = ${to}, confirmed_at = ${to === "confirmed" ? sql`now()` : sql`confirmed_at`}
    where id = ${appointmentId} and clinic_id = ${clinicId}`;
  if (to === "confirmed") await cancelJobs(sql, clinicId, { appointmentId, types: ["confirmation_request"] });
  if (to === "no_show") await cancelJobs(sql, clinicId, { appointmentId });
  return { ok: true };
}

/** Lembretes 48 h e 24 h antes; não agenda retroativo se a consulta foi marcada com menos antecedência. */
async function scheduleReminders(sql: Sql, clinicId: string, appointmentId: string, startsAt: Date, now: Date): Promise<void> {
  const [clinic] = await sql<{ timezone: string; settings: unknown }[]>`select timezone, settings from clinics where id = ${clinicId}`;
  const settings = parseSettings(clinic?.settings);
  if (!settings.remindersEnabled) return;
  const tz = clinic?.timezone ?? "America/Sao_Paulo";
  for (const hours of settings.reminderHours) {
    const ideal = addMinutes(startsAt, -hours * 60);
    if (ideal <= now) continue;
    const runAt = clampToQuietHours(ideal, tz, settings.quietStartHour, settings.quietEndHour);
    if (runAt >= startsAt) continue;
    await enqueueJob(sql, {
      clinicId, type: hours <= 24 ? "confirmation_request" : "reminder", runAt, appointmentId,
      idempotencyKey: `reminder:${appointmentId}:${hours}`, payload: { hours },
    });
  }
}
