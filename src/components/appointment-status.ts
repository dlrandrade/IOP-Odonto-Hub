import { Ban, CalendarCheck, Check, CircleDashed, DoorOpen, Stethoscope, UserX, type LucideIcon } from "lucide-react";
import type { AppointmentStatus } from "@/domain/states";

/**
 * Uma cor por situação da consulta, igual na Agenda e em Hoje:
 * a confirmar = neutro, confirmada = verde, chegou = azul, em atendimento = violeta,
 * concluída = cinza (já passou), faltou = vermelho, cancelada = riscada.
 */
export const APPT_STYLE: Record<AppointmentStatus, { icon: LucideIcon; block: string; row: string; bar: string; pill: string; label: string }> = {
  scheduled: { icon: CircleDashed, label: "A confirmar", block: "bg-surface-2 border-bone-mute text-bone", row: "", bar: "bg-bone-mute/50", pill: "bg-bone/[0.07] text-bone-dim" },
  confirmed: { icon: CalendarCheck, label: "Confirmada", block: "bg-ok-soft border-ok text-bone", row: "bg-ok/[0.05]", bar: "bg-ok", pill: "bg-ok-soft text-ok" },
  arrived: { icon: DoorOpen, label: "Chegou", block: "bg-info-soft border-info text-bone", row: "bg-info/[0.06]", bar: "bg-info", pill: "bg-info-soft text-info" },
  in_service: { icon: Stethoscope, label: "Em atendimento", block: "bg-violet-soft border-violet text-bone", row: "bg-violet/[0.07]", bar: "bg-violet", pill: "bg-violet-soft text-violet" },
  completed: { icon: Check, label: "Concluída", block: "bg-surface-2/70 border-line text-bone-dim", row: "opacity-60", bar: "bg-line", pill: "bg-bone/[0.05] text-bone-mute" },
  no_show: { icon: UserX, label: "Faltou", block: "bg-danger-soft border-danger text-danger", row: "bg-danger/[0.05]", bar: "bg-danger", pill: "bg-danger-soft text-danger" },
  cancelled: { icon: Ban, label: "Cancelada", block: "bg-surface-2 border-line text-bone-mute line-through", row: "opacity-50", bar: "bg-line", pill: "bg-bone/[0.05] text-bone-mute" },
};
