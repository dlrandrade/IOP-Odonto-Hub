/** Máquinas de estado (PRD seção 5). Regras puras, sem banco. */

export const CONVERSATION_STATES = ["ai_active", "awaiting_human", "human_active", "closed"] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const CONVERSATION_STATE_LABELS: Record<ConversationState, string> = {
  ai_active: "IA ativa", awaiting_human: "Aguardando humano", human_active: "Humano ativo", closed: "Encerrada",
};

/** Estado ao reabrir conversa encerrada: volta para a IA, salvo pendência humana. */
export function reopenState(hadPending: boolean): ConversationState {
  return hadPending ? "awaiting_human" : "ai_active";
}

export const APPOINTMENT_STATUSES = ["scheduled", "confirmed", "arrived", "in_service", "completed", "no_show", "cancelled"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: "Agendada", confirmed: "Confirmada", arrived: "Chegou", in_service: "Em atendimento",
  completed: "Concluída", no_show: "Faltou", cancelled: "Cancelada",
};

const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled: ["confirmed", "arrived", "no_show", "cancelled"],
  confirmed: ["arrived", "no_show", "cancelled", "scheduled"],
  arrived: ["in_service", "completed"],
  in_service: ["completed"],
  completed: [],
  no_show: [],
  cancelled: [],
};

/** Status que só um humano registra — nunca inferidos do texto da conversa. */
export const HUMAN_ONLY_STATUSES: AppointmentStatus[] = ["arrived", "in_service", "completed", "no_show"];

export function canTransitionAppointment(from: AppointmentStatus, to: AppointmentStatus, actor: "ai" | "user" | "system"): boolean {
  if (!APPOINTMENT_TRANSITIONS[from].includes(to)) return false;
  if (actor !== "user" && HUMAN_ONLY_STATUSES.includes(to)) return false;
  return true;
}

export const OPPORTUNITY_STAGES = ["new", "in_conversation", "evaluation_scheduled", "evaluation_done", "proposal_presented", "following_up", "accepted", "lost"] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export const OPPORTUNITY_STAGE_LABELS: Record<OpportunityStage, string> = {
  new: "Novo", in_conversation: "Em conversa", evaluation_scheduled: "Avaliação agendada",
  evaluation_done: "Avaliação realizada", proposal_presented: "Proposta apresentada",
  following_up: "Em acompanhamento", accepted: "Aceito", lost: "Perdido",
};

export type StageMoveInput = {
  from: OpportunityStage;
  to: OpportunityStage;
  actor: "ai" | "user" | "system";
  hasScheduledEvaluation?: boolean;
  lostReason?: string | null;
  evidence?: string | null;
};

/** Devolve null se o movimento é permitido, ou o motivo da recusa. */
export function validateStageMove(i: StageMoveInput): string | null {
  if (i.from === i.to) return "A oportunidade já está nesse estágio.";
  if (i.from === "accepted" || i.from === "lost") {
    if (i.actor !== "user") return "Oportunidade finalizada só pode ser reaberta por uma pessoa.";
  }
  if (i.actor !== "user") {
    const allowed: OpportunityStage[] = ["new", "in_conversation", "evaluation_scheduled"];
    if (!allowed.includes(i.to)) return "Automação só move a oportunidade até 'Avaliação agendada'.";
  }
  if (i.to === "evaluation_scheduled" && i.actor !== "user" && !i.hasScheduledEvaluation) {
    return "Só é possível mover para 'Avaliação agendada' depois que a consulta existir.";
  }
  if (i.to === "lost" && !i.lostReason?.trim()) return "Informe o motivo da perda.";
  if (i.to === "accepted" && !i.evidence?.trim()) return "O aceite exige evidência explícita (ex.: mensagem ou registro do aceite).";
  return null;
}
