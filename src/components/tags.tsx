import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui";
import { CONVERSATION_STATE_LABELS, type ConversationState } from "@/domain/states";

/** Cada situação da conversa tem sua cor, sempre a mesma em toda a plataforma. */
export const STATE_TONE: Record<ConversationState, "info" | "warn" | "violet" | "neutral"> = {
  ai_active: "info", awaiting_human: "warn", human_active: "violet", closed: "neutral",
};

export function StateTag({ state, urgent, assignee }: { state: ConversationState; urgent?: boolean; assignee?: string | null }) {
  if (urgent) return <Badge tone="danger"><AlertTriangle aria-hidden /> Urgente</Badge>;
  return (
    <Badge tone={STATE_TONE[state]}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {CONVERSATION_STATE_LABELS[state]}{assignee ? ` · ${assignee.split(" ")[0]}` : ""}
    </Badge>
  );
}
