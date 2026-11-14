import { env } from "@/lib/env";
import type { Sql } from "@/db/client";
import { decryptField } from "@/lib/crypto";
import { ClaudeProvider } from "./claude";
import { OpenAiCompatibleProvider } from "./openai-compatible";
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

export type LlmSettings = { provider: string; apiKey: string | null; model: string | null; baseUrl: string | null };

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

/** Monta o provedor a partir da configuração (da clínica ou do formulário de teste). */
export function buildProvider(s: LlmSettings): LlmProvider | null {
  if (s.provider === "platform") return llmProvider();
  if (!s.apiKey || !s.model) return null;
  if (s.provider === "anthropic") return new ClaudeProvider(s.apiKey, s.model);
  if (s.provider === "openrouter") {
    return new OpenAiCompatibleProvider(OPENROUTER_URL, s.apiKey, s.model, { "HTTP-Referer": env.appUrl, "X-Title": "IOP Odonto Hub" }, "openrouter");
  }
  if (s.provider === "openai_compatible" && s.baseUrl) return new OpenAiCompatibleProvider(s.baseUrl, s.apiKey, s.model);
  return null;
}

/** Provedor da clínica: o que o admin configurou em Configurações → Assistente, ou o padrão da plataforma. */
export async function llmProviderFor(sql: Sql, clinicId: string): Promise<LlmProvider | null> {
  if (override) return override;
  const [row] = await sql<{ llm_provider: string; llm_api_key_enc: string | null; llm_model: string | null; llm_base_url: string | null }[]>`
    select llm_provider, llm_api_key_enc, llm_model, llm_base_url from clinic_integrations where clinic_id = ${clinicId}`;
  if (!row) return llmProvider();
  return buildProvider({ provider: row.llm_provider, apiKey: decryptField(row.llm_api_key_enc), model: row.llm_model, baseUrl: row.llm_base_url });
}

export * from "./types";
export { estimateCostCents, listClaudeModels } from "./claude";
export { listOpenAiModels, OpenAiCompatibleProvider } from "./openai-compatible";
