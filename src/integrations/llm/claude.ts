import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { LlmUnavailableError, type LlmBlock, type LlmProvider, type LlmRequest, type LlmResponse } from "./types";

/** Preço por milhão de tokens (USD) para estimar custo em ai_runs. Modelo desconhecido = custo não estimado. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5], "claude-fable-5-2": [8, 40],
};

/** Lista os modelos Claude da chave informada. */
export async function listClaudeModels(apiKey: string): Promise<string[]> {
  const client = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 });
  const ids: string[] = [];
  for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
  return ids;
}

export function estimateCostCents(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICES[model];
  if (!p) return 0;
  const usd = (tokensIn * p[0] + tokensOut * p[1]) / 1_000_000;
  return Math.round(usd * 100 * 10_000) / 10_000;
}

const MODERN = /^claude-(opus|sonnet|haiku|fable|mythos)-5/;

export class ClaudeProvider implements LlmProvider {
  readonly name = "claude";
  private client: Anthropic;
  constructor(apiKey: string, private readonly model: string = env.anthropicModel) {
    this.client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    try {
      const res = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 4000,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools: req.tools,
        messages: req.messages,
        // Pensamento adaptativo, esforço e fallback só nos modelos da geração 5 (o admin pode escolher modelos antigos).
        ...(MODERN.test(this.model)
          ? {
              thinking: { type: "adaptive" as const },
              // Atendimento por chat: respostas curtas e rápidas (meta p95 ≤ 15 s com debounce).
              output_config: { effort: "low" as const },
              // Se o modelo recusar por política, a própria API tenta o modelo substituto padrão.
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default" as const,
            }
          : {}),
      });
      if (res.stop_reason === "refusal") throw new LlmUnavailableError("O modelo recusou a solicitação", false);
      const blocks: LlmBlock[] = [];
      for (const b of res.content) {
        if (b.type === "text") blocks.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      }
      return {
        blocks,
        assistantContent: res.content as Anthropic.Beta.BetaContentBlockParam[],
        stopReason: res.stop_reason,
        usage: {
          input: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
          output: res.usage.output_tokens,
        },
        model: res.model,
      };
    } catch (e) {
      if (e instanceof LlmUnavailableError) throw e;
      if (e instanceof Anthropic.AuthenticationError) throw new LlmUnavailableError("Chave da IA inválida", false);
      if (e instanceof Anthropic.BadRequestError) throw new LlmUnavailableError("Requisição rejeitada pela IA", false);
      if (e instanceof Anthropic.RateLimitError) throw new LlmUnavailableError("Limite de uso da IA atingido", true);
      if (e instanceof Anthropic.APIError) throw new LlmUnavailableError(`IA indisponível (${e.status ?? "rede"})`, true);
      throw new LlmUnavailableError("IA indisponível", true);
    }
  }
}
