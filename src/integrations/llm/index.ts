import { env } from "@/lib/env";
import { ClaudeProvider } from "./claude";
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

/** Sem chave configurada devolve null: o pipeline encaminha a conversa para a equipe. */
export function llmProvider(): LlmProvider | null {
  if (override) return override;
  return env.anthropicKey ? new ClaudeProvider(env.anthropicKey) : null;
}

export * from "./types";
export { estimateCostCents } from "./claude";
