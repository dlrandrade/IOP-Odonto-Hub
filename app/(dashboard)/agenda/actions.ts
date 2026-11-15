"use server";

import { z } from "zod";
import { q } from "@/auth/session";
import type { ActionState } from "@/components/client";
import { APPOINTMENT_STATUSES } from "@/domain/states";
import { act, actorOf, optStr, str, UserError } from "@/lib/action";
import { actionCtx } from "@/auth/session";
import { addDays, localTime, zonedToUtc } from "@/lib/datetime";
import { audit } from "@/services/audit";
import { bookAppointment, cancelAppointment, findSlots, rescheduleAppointment, setAppointmentStatus } from "@/services/booking";
import { syncOpportunityOnBooking } from "@/services/crm";
import { formatFull } from "@/lib/datetime";

const PATH = "/agenda";
const id = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export type SlotOption = { startsAt: string; time: string; professionalId: string; professional: string };

/** Horários livres de um dia para a criação rápida (recepção não tem antecedência mínima). */
export async function listSlotsAction(input: { serviceId: string; professionalId: string | null; date: string; ignoreAppointmentId?: string | null }): Promise<SlotOption[]> {
  const ctx = await actionCtx("agenda.write");
  const p = z.object({ serviceId: id, professionalId: id.nullable(), date, ignoreAppointmentId: id.nullish() }).parse(input);
  return q(ctx, async (tx) => {
    const { slots } = await findSlots(tx, { clinicId: ctx.clinicId, serviceId: p.serviceId, professionalId: p.professionalId, fromDate: p.date, toDate: p.date, ignoreLeadTime: true, ignoreAppointmentId: p.ignoreAppointmentId });
    const names = new Map((await tx<{ id: string; name: string }[]>`select id, name from professionals`).map((r) => [r.id, r.name]));
    const now = Date.now();
    return slots.filter((s) => s.startsAt.getTime() > now - 12 * 3600_000).map((s) => ({
      startsAt: s.startsAt.toISOString(), time: localTime(s.startsAt, ctx.tz), professionalId: s.professionalId, professional: names.get(s.professionalId) ?? "",
    }));
  });
}

export async function createAppointmentAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("agenda.write", [PATH, "/pacientes", "/"], async (ctx) => {
    const serviceId = id.parse(form.get("serviceId"));
    const slot = z.string().min(10, "Escolha um horário.").parse(str(form, "slot"));
    const [startsAtIso, professionalId] = slot.split("|");
    const rescheduleId = optStr(form, "appointmentId");
    await q(ctx, async (tx) => {
      if (rescheduleId) {
        const r = await rescheduleAppointment(tx, { clinicId: ctx.clinicId, appointmentId: id.parse(rescheduleId), professionalId: id.parse(professionalId), startsAt: new Date(startsAtIso!), createdByType: "user", createdByUserId: ctx.userId, ignoreLeadTime: true });
        if (!r.ok) throw new UserError(r.message);
        return;
      }
      let patientId = optStr(form, "patientId");
      const newName = optStr(form, "newPatientName");
      if (!patientId && newName) {
        const [p] = await tx<{ id: string }[]>`insert into patients (clinic_id, full_name) values (${ctx.clinicId}, ${newName}) returning id`;
        patientId = p?.id ?? null;
      }
      if (!patientId) throw new UserError("Escolha o paciente ou informe o nome de um novo.");
      const [link] = await tx<{ contact_id: string }[]>`select contact_id from contact_patient_links where patient_id = ${patientId} order by is_guardian desc, created_at limit 1`;
      const r = await bookAppointment(tx, {
        clinicId: ctx.clinicId, patientId, contactId: link?.contact_id ?? null, serviceId, professionalId: id.parse(professionalId), startsAt: new Date(startsAtIso!),
        createdByType: "user", createdByUserId: ctx.userId, notes: optStr(form, "notes"), ignoreLeadTime: true,
      });
      if (!r.ok) throw new UserError(r.reason === "conflict" || r.reason === "unavailable" ? "Esse horário acabou de ser ocupado. Escolha outro." : r.message);
      await syncOpportunityOnBooking(tx, { clinicId: ctx.clinicId, patientId, contactId: link?.contact_id ?? null, serviceId, actor: "user", actorUserId: ctx.userId, when: formatFull(r.startsAt, ctx.tz) });
    });
  });
}

export async function appointmentStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("agenda.write", [PATH, "/"], async (ctx) => {
    const appointmentId = id.parse(form.get("appointmentId"));
    const to = z.enum(APPOINTMENT_STATUSES).parse(form.get("status"));
    await q(ctx, async (tx) => {
      const r = to === "cancelled"
        ? await cancelAppointment(tx, ctx.clinicId, appointmentId, optStr(form, "reason") ?? "Cancelada pela recepção")
        : await setAppointmentStatus(tx, ctx.clinicId, appointmentId, to, "user");
      if (!r.ok) throw new UserError(r.message ?? "Mudança não permitida.");
      await audit(tx, actorOf(ctx), `appointment.${to}`, "appointments", appointmentId, null, { status: to });
    });
  });
}

export async function createBlockAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("agenda.write", PATH, async (ctx) => {
    const day = date.parse(form.get("date"));
    const allDay = form.get("allDay") === "on";
    const start = allDay ? "00:00" : z.string().regex(/^\d{2}:\d{2}$/).parse(form.get("start"));
    const end = allDay ? "00:00" : z.string().regex(/^\d{2}:\d{2}$/).parse(form.get("end"));
    const from = zonedToUtc(day, start, ctx.tz);
    const to = zonedToUtc(allDay ? addDays(day, 1) : day, end, ctx.tz);
    if (to <= from) throw new UserError("O fim precisa ser depois do início.");
    const professionalId = optStr(form, "professionalId");
    await q(ctx, (tx) => tx`
      insert into time_blocks (clinic_id, professional_id, during, reason)
      values (${ctx.clinicId}, ${professionalId}, tstzrange(${from}, ${to}), ${optStr(form, "reason")})`);
  });
}

export async function deleteBlockAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("agenda.write", PATH, async (ctx) => {
    await q(ctx, (tx) => tx`delete from time_blocks where id = ${id.parse(form.get("blockId"))}`);
  });
}
