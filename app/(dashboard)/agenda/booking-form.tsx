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
    <ActionForm action={createAppointmentAction} className="space-y-7">
      {reschedule && <input type="hidden" name="appointmentId" value={reschedule.appointmentId} />}
      <input type="hidden" name="serviceId" value={serviceId} />
      <input type="hidden" name="slot" value={picked} />
      {reschedule ? (
        <p className="rounded-sm border-l-2 border-acento bg-surface-2/60 px-4 py-3 text-[14px]">Remarcando <strong>{reschedule.patientName}</strong>. O horário de agora só é liberado depois que o novo for salvo.</p>
      ) : (
        <Step n={1} title="Quem é o paciente?">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Paciente já cadastrado">
              <Select name="patientId" defaultValue=""><option value="">Escolha na lista…</option>{patients.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
            </Field>
            <Field label="Ou digite o nome de um novo"><Input name="newPatientName" placeholder="Nome completo" /></Field>
          </div>
        </Step>
      )}
      <Step n={reschedule ? 1 : 2} title="Qual atendimento e quando?">
        <div className="grid gap-4 sm:grid-cols-3">
          {!reschedule && (
            <Field label="Serviço">
              <Select value={serviceId} onChange={(e) => { setServiceId(e.target.value); setProfessionalId(""); }}>{services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
            </Field>
          )}
          <Field label="Dentista">
            <Select value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}><option value="">Qualquer um disponível</option>{enabled.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          </Field>
          <Field label="Dia"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        </div>
      </Step>
      <Step n={reschedule ? 2 : 3} title="Escolha um horário livre" aside={loading ? "Procurando…" : slots ? `${slots.length} horário${slots.length === 1 ? "" : "s"}` : undefined}>
        {slots && slots.length === 0 && !loading ? (
          <p className="rounded-sm bg-surface-2/60 px-4 py-4 text-center text-[14px] text-bone-dim">Nenhum horário livre neste dia. Tente outro dia ou outro dentista.</p>
        ) : (
          <div role="radiogroup" aria-label="Horários livres" className="scroll-thin grid max-h-52 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
            {(slots ?? []).map((s) => {
              const value = `${s.startsAt}|${s.professionalId}`;
              const on = picked === value;
              return (
                <button key={value} type="button" role="radio" aria-checked={on} onClick={() => setPicked(value)}
                  className={cn("btn flex h-12 flex-col items-center justify-center rounded-sm border text-center", on ? "border-acento bg-acento text-ink" : "border-line bg-surface-2/50 hover:border-bone-mute/60")}>
                  <span className="font-mono text-[14px] font-medium leading-none">{s.time}</span>
                  {!professionalId && <span className={cn("mt-1 max-w-full truncate px-1 text-[10.5px] leading-none", on ? "text-ink/75" : "text-bone-mute")}>{s.professional.split(" ").slice(0, 2).join(" ")}</span>}
                </button>
              );
            })}
          </div>
        )}
      </Step>
      {!reschedule && <Field label="Observação (opcional)" hint="Apenas informação administrativa. Nada clínico."><Textarea name="notes" className="min-h-20" /></Field>}
      <div className="flex items-center justify-end gap-3 border-t border-line pt-5">
        {!picked && <span className="t-small">Escolha um horário para continuar.</span>}
        <Button type="submit" disabled={!picked}>{reschedule ? "Confirmar remarcação" : "Confirmar agendamento"}</Button>
      </div>
    </ActionForm>
  );
}

function Step({ n, title, aside, children }: { n: number; title: string; aside?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-acento/60 font-mono text-[11px] text-acento">{n}</span>
        <h3 className="t-h3 flex-1">{title}</h3>
        {aside && <span className="t-small">{aside}</span>}
      </div>
      {children}
    </section>
  );
}
