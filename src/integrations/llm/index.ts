import { env } from "@/lib/env";
import type { Sql } from "@/db/client";
import { decryptField } from "@/lib/crypto";
import { ClaudeProvider } from "./claude";
import { listOpenRouterFreeModels, OpenAiCompatibleProvider, RoutingProvider } from "./openai-compatible";
import type { LlmBlock, LlmProvider, LlmRequest, LlmResponse } from "./types";

/** Provedor roteirizado para testes: cada passo decide a resposta a partir da requisição recebida. */
export class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  readonly requests: LlmRequest[] = [];
  private i = 0;
  constructor(private readonly steps: Array<LlmBlock[] | ((req: LlmRequest) => LlmBlock[])>) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps[this.i++];
    const blocks = typeof step === "function" ? step(req) : step ?? [{ type: "text" as const, text: "" }];
    const hasTool = blocks.some((b) => b.type === "tool_use");
    return {
      blocks,
      assistantContent: blocks.map((b) => (b.type === "text" ? { type: "text" as const, text: b.text } : { type: "tool_use" as const, id: b.id, name: b.name, input: b.input })),
      stopReason: hasTool ? "tool_use" : "end_turn",
      usage: { input: 100, output: 20 },
      model: "scripted",
    };
  }
}

let override: LlmProvider | null = null;
export function setLlmOverride(p: LlmProvider | null): void { override = p; }

/** Provedor padrão da plataforma (variáveis de ambiente). Sem chave, devolve null e a conversa vai para a equipe. */
export function llmProvider(): LlmProvider | null {
  if (override) return override;
  return env.anthropicKey ? new ClaudeProvider(env.anthropicKey) : null;
}

export type LlmSettings = {
  provider: string; apiKey: string | null; model: string | null; baseUrl: string | null;
  /** OpenRouter: usa os modelos gratuitos do momento, trocando sozinho quando um falha. */
  freeAuto?: boolean;
  /** OpenRouter/compatível: modelos reserva, tentados em ordem se o principal falhar. */
  fallbackModels?: string[];
};

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

/** Monta o provedor a partir da configuração (da clínica ou do formulário de teste). */
export function buildProvider(s: LlmSettings): LlmProvider | null {
  if (s.provider === "platform") return llmProvider();
  if (!s.apiKey) return null;
  const key = s.apiKey;
  if (s.provider === "openrouter") {
    const make = (model: string) => new OpenAiCompatibleProvider(OPENROUTER_URL, key, model, { "HTTP-Referer": env.appUrl, "X-Title": "IOP Odonto Hub" }, "openrouter");
    if (s.freeAuto) {
      const pinned = s.fallbackModels ?? [];
      return new RoutingProvider(async () => {
        const free = (await listOpenRouterFreeModels(OPENROUTER_URL, key)).map((m) => m.id);
        // Os escolhidos pela clínica vêm primeiro (se ainda forem gratuitos); depois o resto da lista do momento.
        return [...pinned.filter((m) => free.includes(m)), ...free.filter((m) => !pinned.includes(m))];
      }, make);
    }
    if (!s.model) return null;
    const chain = [s.model, ...(s.fallbackModels ?? []).filter((m) => m !== s.model)];
    return chain.length > 1 ? new RoutingProvider(async () => chain, make) : make(s.model);
  }
  if (!s.model) return null;
  if (s.provider === "anthropic") return new ClaudeProvider(key, s.model);
  if (s.provider === "openai_compatible" && s.baseUrl) {
    const base = s.baseUrl;
    const chain = [s.model, ...(s.fallbackModels ?? []).filter((m) => m !== s.model)];
    return chain.length > 1 ? new RoutingProvider(async () => chain, (m) => new OpenAiCompatibleProvider(base, key, m)) : new OpenAiCompatibleProvider(base, key, s.model);
  }
  return null;
}

/** Provedor da clínica: o que o admin configurou em Configurações → Assistente, ou o padrão da plataforma. */
export async function llmProviderFor(sql: Sql, clinicId: string): Promise<LlmProvider | null> {
  if (override) return override;
  const [row] = await sql<{ llm_provider: string; llm_api_key_enc: string | null; llm_model: string | null; llm_base_url: string | null; llm_free_auto: boolean; llm_fallback_models: string[] }[]>`
    select llm_provider, llm_api_key_enc, llm_model, llm_base_url, llm_free_auto, llm_fallback_models from clinic_integrations where clinic_id = ${clinicId}`;
  if (!row) return llmProvider();
  return buildProvider({ provider: row.llm_provider, apiKey: decryptField(row.llm_api_key_enc), model: row.llm_model, baseUrl: row.llm_base_url, freeAuto: row.llm_free_auto, fallbackModels: row.llm_fallback_models });
}

export * from "./types";
export { estimateCostCents, listClaudeModels } from "./claude";
export { listOpenAiModels, listOpenRouterFreeModels, OpenAiCompatibleProvider, RoutingProvider } from "./openai-compatible";
