import type Anthropic from "@anthropic-ai/sdk";
import type { Sql } from "@/db/client";
import { detectAlert } from "@/domain/alerts";
import { parseSettings } from "@/domain/settings";
import { formatFull, isWithinBusinessHours, type BusinessHours } from "@/lib/datetime";
import { estimateCostCents, llmProvider, LlmUnavailableError } from "@/integrations/llm";
import { requestHuman, scheduleFollowups, sendOutbound, type ConversationRow } from "@/services/conversations";
import { buildSystemPrompt, buildTurnContext } from "./prompt";
import { runTool, TOOL_SPECS, type ToolCtx } from "./tools";

export type RunOutcome =
  | "replied" | "discarded_handoff" | "handoff" | "alert" | "skipped" | "no_provider" | "budget_exceeded" | "error";

const MAX_STEPS = 8;
const HISTORY = 30;

type Msg = { id: string; direction: string; sender_type: string; type: string; body: string | null; transcript: string | null; transcript_status: string | null; created_at: Date };

/**
 * Passos 6–8 do pipeline: reconferir estado → montar contexto → chamar o agente → executar tools → reconferir antes de enviar.
 * Lança LlmUnavailableError(retryable) para o worker repetir; nos demais casos resolve com o desfecho.
 */
export async function processConversation(sql: Sql, clinicId: string, conversationId: string, now: Date = new Date()): Promise<RunOutcome> {
  const started = Date.now();
  const [conv] = await sql<ConversationRow[]>`select * from conversations where id = ${conversationId} and clinic_id = ${clinicId}`;
  const [clinic] = await sql<{ name: string; assistant_name: string; timezone: string; business_hours: BusinessHours; ai_enabled: boolean; ai_kill_switch: boolean; alert_keywords: string[]; alert_message: string | null; alert_after_hours_message: string | null; settings: unknown }[]>`
    select name, assistant_name, timezone, business_hours, ai_enabled, ai_kill_switch, alert_keywords, alert_message, alert_after_hours_message, settings
    from clinics where id = ${clinicId}`;
  if (!conv || !clinic) return "skipped";
  if (conv.state !== "ai_active" || !clinic.ai_enabled || clinic.ai_kill_switch) return "skipped";

  const history = (await sql<Msg[]>`
    select id, direction, sender_type, type, body, transcript, transcript_status, created_at from messages
    where conversation_id = ${conversationId} and direction <> 'internal'
    order by created_at desc, id desc limit ${HISTORY}`).reverse();
  // Lote novo = mensagens do paciente depois da última saída.
  let lastOut = -1;
  history.forEach((m, i) => { if (m.direction === "outbound") lastOut = i; });
  const batch = history.slice(lastOut + 1).filter((m) => m.direction === "inbound");
  if (batch.length === 0) return "skipped";

  const expect = { state: conv.state, rowVersion: conv.row_version };
  const withinHours = isWithinBusinessHours(now, clinic.timezone, clinic.business_hours);
  const settings = parseSettings(clinic.settings);
  const record = (outcome: RunOutcome, extra: { model?: string; tokensIn?: number; tokensOut?: number; tools?: unknown[] } = {}) => sql<{ id: string }[]>`
    insert into ai_runs (clinic_id, conversation_id, model, tokens_in, tokens_out, cost_cents, tools_called, latency_ms, outcome)
    values (${clinicId}, ${conversationId}, ${extra.model ?? null}, ${extra.tokensIn ?? 0}, ${extra.tokensOut ?? 0},
            ${estimateCostCents(extra.model ?? "", extra.tokensIn ?? 0, extra.tokensOut ?? 0)}, ${sql.json((extra.tools ?? []) as never)}, ${Date.now() - started}, ${outcome})
    returning id`;

  // Sinal de alerta clínico: fluxo prioritário e determinístico, antes de qualquer chamada ao modelo.
  const batchText = batch.map((m) => m.transcript ?? m.body ?? "").join("\n");
  const alert = detectAlert(batchText, clinic.alert_keywords);
  if (alert) {
    const version = await requestHuman(sql, clinicId, conversationId, `Sinal de alerta relatado pelo paciente ("${alert}")`, "urgente");
    if (version !== null) {
      const text = (!withinHours && clinic.alert_after_hours_message) || clinic.alert_message
        || "Entendi. Vou chamar nossa equipe agora para dar continuidade ao seu atendimento.";
      await sendOutbound(sql, { clinicId, conversationId, senderType: "ai", body: text, expect: { state: "awaiting_human", rowVersion: version }, now });
    }
    await record("alert");
    return "alert";
  }

  const provider = llmProvider();
  if (!provider) {
    await requestHuman(sql, clinicId, conversationId, "Assistente de IA não configurado (sem chave de API)", "normal");
    await record("no_provider");
    return "no_provider";
  }
  // Limite de custo nunca para a fila humana: ao estourar, a conversa vai para a equipe.
  if (settings.aiMonthlyBudgetCents != null) {
    const [spent] = await sql<{ total: string }[]>`
      select coalesce(sum(cost_cents), 0)::text as total from ai_runs where clinic_id = ${clinicId} and created_at >= date_trunc('month', now())`;
    if (Number(spent?.total ?? 0) >= settings.aiMonthlyBudgetCents) {
      await requestHuman(sql, clinicId, conversationId, "Limite mensal de custo da IA atingido", "normal");
      await record("budget_exceeded");
      return "budget_exceeded";
    }
  }

  const [links] = await sql<{ n: number }[]>`select count(*)::int as n from contact_patient_links where contact_id = ${conv.contact_id}`;
  const offers = await sql<{ token: string; starts_at: Date; service: string; professional: string }[]>`
    select o.token, o.starts_at, s.name as service, p.name as professional from slot_offers o
    join services s on s.id = o.service_id join professionals p on p.id = o.professional_id
    where o.conversation_id = ${conversationId} and o.expires_at > ${now} order by o.starts_at limit 8`;
  const hasImage = batch.some((m) => m.type === "image");
  const turnContext = buildTurnContext({
    now, tz: clinic.timezone, withinBusinessHours: withinHours, summary: conv.summary, pendingNotes: conv.pending_notes,
    linkedPatients: links?.n ?? 0, verifiedPatients: conv.verified_patient_ids.length,
    activeOffers: offers.map((o) => ({ token: o.token, label: formatFull(o.starts_at, clinic.timezone), service: o.service, professional: o.professional })),
    hasImage, hasFailedAudio: batch.some((m) => m.type === "audio" && m.transcript_status === "failed"),
  });

  const messages = toLlmMessages(history, turnContext);
  const ctx: ToolCtx = { sql, clinicId, conversationId, contactId: conv.contact_id, tz: clinic.timezone, now, expect, flags: { handedOff: false, booked: false } };
  const toolsCalled: { name: string; ok: boolean }[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let model = provider.name;
  let finalText = "";

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await provider.complete({ system: buildSystemPrompt({ name: clinic.name, assistantName: clinic.assistant_name, alertMessage: clinic.alert_message }), messages, tools: TOOL_SPECS });
      tokensIn += res.usage.input;
      tokensOut += res.usage.output;
      model = res.model;
      const toolUses = res.blocks.filter((b) => b.type === "tool_use");
      if (res.stopReason === "pause_turn") { messages.push({ role: "assistant", content: res.assistantContent }); continue; }
      if (toolUses.length === 0) {
        finalText = res.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        break;
      }
      messages.push({ role: "assistant", content: res.assistantContent });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of toolUses) {
        const out = await runTool(call.name, call.input, ctx);
        toolsCalled.push({ name: call.name, ok: !out.isError });
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(out.result), is_error: out.isError });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    await record("error", { model, tokensIn, tokensOut, tools: toolsCalled });
    if (e instanceof LlmUnavailableError && e.retryable) throw e;
    await requestHuman(sql, clinicId, conversationId, "IA indisponível — atendimento humano necessário", "normal");
    return "error";
  }

  // Imagem sempre vai para um humano, mesmo que o modelo esqueça de encaminhar.
  if (hasImage && !ctx.flags.handedOff) {
    const version = await requestHuman(sql, clinicId, conversationId, "Paciente enviou imagem (sem interpretação pela IA)", "normal");
    if (version !== null) { ctx.expect = { state: "awaiting_human", rowVersion: version }; ctx.flags.handedOff = true; }
  }
  if (!finalText) {
    if (!ctx.flags.handedOff) await requestHuman(sql, clinicId, conversationId, "IA não conseguiu formular resposta", "normal");
    await record("handoff", { model, tokensIn, tokensOut, tools: toolsCalled });
    return "handoff";
  }

  const [run] = await record(ctx.flags.handedOff ? "handoff" : "replied", { model, tokensIn, tokensOut, tools: toolsCalled });
  // Passo 7: se um humano assumiu enquanto a IA pensava, a resposta é descartada.
  const sent = await sendOutbound(sql, { clinicId, conversationId, senderType: "ai", body: finalText, aiRunId: run?.id ?? null, expect: ctx.expect, now });
  if (sent.status === "discarded") {
    if (run) await sql`update ai_runs set outcome = 'discarded_handoff' where id = ${run.id}`;
    return "discarded_handoff";
  }
  const last = batch[batch.length - 1];
  if (!ctx.flags.handedOff && !ctx.flags.booked && last) await scheduleFollowups(sql, clinicId, conversationId, last.created_at, now);
  await sql`update conversations set pending_notes = null where id = ${conversationId} and pending_notes is not null`;
  return ctx.flags.handedOff ? "handoff" : "replied";
}

function describe(m: Msg): string {
  if (m.type === "audio") return m.transcript ? `[áudio transcrito] ${m.transcript}` : "[áudio sem transcrição disponível]";
  if (m.type === "image") return `[imagem enviada — não interpretada]${m.body ? ` legenda: ${m.body}` : ""}`;
  return m.body ?? "";
}

/** Histórico → mensagens do modelo. Conteúdo do paciente vai marcado como dado, nunca como instrução. */
export function toLlmMessages(history: Msg[], turnContext: string): Anthropic.Beta.BetaMessageParam[] {
  const out: { role: "user" | "assistant"; text: string }[] = [];
  for (const m of history) {
    const role = m.direction === "inbound" ? "user" : "assistant";
    const text = role === "user"
      ? `<mensagem_paciente>${describe(m).replaceAll("</mensagem_paciente>", "")}</mensagem_paciente>`
      : m.sender_type === "human" ? `[Atendente da clínica] ${m.body ?? ""}` : m.body ?? "";
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.text += `\n${text}`;
    else out.push({ role, text });
  }
  while (out.length && out[0]?.role !== "user") out.shift();
  const messages: Anthropic.Beta.BetaMessageParam[] = out.map((m) => ({ role: m.role, content: m.text }));
  const last = messages[messages.length - 1];
  if (last && last.role === "user" && typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content }, { type: "text", text: turnContext }];
  }
  return messages;
}
