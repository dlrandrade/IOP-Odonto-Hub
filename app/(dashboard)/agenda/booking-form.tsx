"use client";

import { useEffect, useState, useTransition } from "react";
import { ActionForm } from "@/components/client";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { cn } from "@/lib/format";
import { createAppointmentAction, listSlotsAction, type SlotOption } from "./actions";

type Option = { id: string; name: string };
export type BookingFormProps = {
  services: (Option & { professionalIds: string[] })[];
  professionals: Option[];
  patients: Option[];
  defaultDate: string;
  /** Reagendamento: serviço e paciente fixos. */
  reschedule?: { appointmentId: string; serviceId: string; patientName: string };
};

/** Criação rápida / reagendamento: escolhe serviço e dia, vê só horários realmente livres. */
export function BookingForm({ services, professionals, patients, defaultDate, reschedule }: BookingFormProps) {
  const [serviceId, setServiceId] = useState(reschedule?.serviceId ?? services[0]?.id ?? "");
  const [professionalId, setProfessionalId] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const [picked, setPicked] = useState("");
  const [loading, start] = useTransition();
  const enabled = professionals.filter((p) => services.find((s) => s.id === serviceId)?.professionalIds.includes(p.id));

  useEffect(() => {
    if (!serviceId || !date) return;
    setPicked("");
    start(async () => {
      setSlots(await listSlotsAction({ serviceId, professionalId: professionalId || null, date, ignoreAppointmentId: reschedule?.appointmentId ?? null }).catch(() => []));
    });
  }, [serviceId, professionalId, date, reschedule?.appointmentId]);

  return (
    <ActionForm action={createAppointmentAction} className="space-y-4">
      {reschedule && <input type="hidden" name="appointmentId" value={reschedule.appointmentId} />}
      <input type="hidden" name="serviceId" value={serviceId} />
      <input type="hidden" name="slot" value={picked} />
      {reschedule ? (
        <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm">Reagendando <strong>{reschedule.patientName}</strong>. O horário atual só é liberado quando o novo for gravado.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Paciente">
            <Select name="patientId" defaultValue=""><option value="">— novo paciente —</option>{patients.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          </Field>
          <Field label="Ou nome do novo paciente"><Input name="newPatientName" placeholder="Nome completo" /></Field>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        {!reschedule && (
          <Field label="Serviço">
            <Select value={serviceId} onChange={(e) => { setServiceId(e.target.value); setProfessionalId(""); }}>{services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          </Field>
        )}
        <Field label="Dentista">
          <Select value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}><option value="">Qualquer habilitado</option>{enabled.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        </Field>
        <Field label="Dia"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
      </div>
      <div>
        <p className="mb-1.5 text-xs font-semibold text-bone-dim">Horários livres {loading && <span className="font-normal text-bone-mute">· carregando…</span>}</p>
        {slots && slots.length === 0 && !loading && <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-sm text-bone-mute">Sem horários livres neste dia para esse serviço. Confira o expediente do dentista, bloqueios e cadeiras.</p>}
        <div role="radiogroup" aria-label="Horários livres" className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
          {(slots ?? []).map((s) => {
            const value = `${s.startsAt}|${s.professionalId}`;
            return (
              <button key={value} type="button" role="radio" aria-checked={picked === value} onClick={() => setPicked(value)}
                className={cn("rounded-full border px-3 py-1.5 text-xs font-medium", picked === value ? "border-bone bg-gold text-ink" : "border-line bg-surface hover:bg-surface-2")}>
                {s.time}{!professionalId && <span className="opacity-70"> · {s.professional.split(" ").slice(0, 2).join(" ")}</span>}
              </button>
            );
          })}
        </div>
      </div>
      {!reschedule && <Field label="Observação administrativa (opcional)"><Textarea name="notes" className="min-h-16" /></Field>}
      <Button type="submit" disabled={!picked}>{reschedule ? "Reagendar" : "Agendar"}</Button>
    </ActionForm>
  );
}
