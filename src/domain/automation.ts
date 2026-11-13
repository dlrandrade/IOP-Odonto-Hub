import type { ConversationState } from "./states";

/** Elegibilidade de envios automáticos (RF-07). Avaliada no momento da execução, não do agendamento. */
export type AutomationCheck = {
  now: Date;
  kind: "followup_1" | "followup_2" | "reminder" | "confirmation";
  conversationState: ConversationState | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  windowExpiresAt: Date | null;
  optedOut: boolean;
  serviceMessagesAllowed: boolean;
  automatedSentLast24h: number;
  maxAutomatedPerDay: number;
  /** Momento de referência com que o job foi agendado (última mensagem na época). */
  scheduledAfter: Date | null;
  hasFutureAppointment: boolean;
  hasApprovedTemplate: boolean;
};

export type AutomationDecision =
  | { action: "send_free_text" }
  | { action: "send_template" }
  | { action: "create_human_task"; reason: string }
  | { action: "skip"; reason: string };

export function decideAutomation(c: AutomationCheck): AutomationDecision {
  if (c.optedOut) return { action: "skip", reason: "opt_out" };
  if (!c.serviceMessagesAllowed) return { action: "skip", reason: "sem_permissao_de_servico" };
  const isFollowup = c.kind === "followup_1" || c.kind === "followup_2";

  if (isFollowup) {
    if (c.conversationState !== "ai_active") return { action: "skip", reason: "conversa_com_humano_ou_encerrada" };
    if (c.hasFutureAppointment) return { action: "skip", reason: "ja_agendou" };
    // Paciente respondeu depois que o follow-up foi programado → sequência interrompida.
    if (c.scheduledAfter && c.lastInboundAt && c.lastInboundAt > c.scheduledAfter) return { action: "skip", reason: "paciente_respondeu" };
    if (c.kind === "followup_1" && c.scheduledAfter && c.lastOutboundAt && c.lastOutboundAt > c.scheduledAfter) {
      return { action: "skip", reason: "ja_houve_nova_mensagem" };
    }
  }
  if (c.automatedSentLast24h >= c.maxAutomatedPerDay) return { action: "skip", reason: "limite_de_frequencia" };

  const inWindow = !!c.windowExpiresAt && c.now < c.windowExpiresAt;
  if (inWindow) return { action: "send_free_text" };
  // Fora da janela de 24 h: só template aprovado; sem ele, tarefa humana. Nunca contornar.
  if (c.hasApprovedTemplate && !isFollowup) return { action: "send_template" };
  if (c.hasApprovedTemplate && isFollowup) return { action: "send_template" };
  return { action: "create_human_task", reason: "fora_da_janela_sem_template" };
}

export function backoffMinutes(attempt: number): number {
  return Math.min(60, 2 ** attempt);
}
