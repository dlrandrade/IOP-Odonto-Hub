import type Anthropic from "@anthropic-ai/sdk";

/** O modelo interpreta e pede ações tipadas; quem executa é o servidor. */
export type LlmBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

export type LlmRequest = {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
};

export type LlmResponse = {
  blocks: LlmBlock[];
  /** Conteúdo bruto do turno do assistente, devolvido intacto na próxima chamada. */
  assistantContent: Anthropic.Beta.BetaMessageParam["content"];
  stopReason: string | null;
  usage: { input: number; output: number };
  model: string;
};

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmUnavailableError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}
