import { assertPublicUrl } from "@/lib/safe-url";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { LlmUnavailableError, type LlmBlock, type LlmProvider, type LlmRequest, type LlmResponse } from "./types";

/**
 * Provedor para APIs no formato OpenAI (/chat/completions com "tools"): OpenRouter, Groq, Together,
 * servidores locais etc. O orquestrador fala o formato de blocos da Anthropic; aqui fazemos a tradução.
 */
type OaMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

type Block = Anthropic.Beta.BetaContentBlockParam;
/** Visão solta de um bloco, só com os campos que usamos (evita brigar com a união de tipos do SDK). */
type Loose = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

function blocksOf(content: Anthropic.Beta.BetaMessageParam["content"] | undefined): Loose[] {
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content as unknown as Loose[];
}

export function toOpenAiMessages(req: LlmRequest): OaMessage[] {
  const out: OaMessage[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    const blocks = blocksOf(m.content);
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    if (m.role === "assistant") {
      const calls = blocks.filter((b) => b.type === "tool_use" && b.id && b.name)
        .map((b) => ({ id: b.id!, type: "function" as const, function: { name: b.name!, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const r of blocks.filter((b) => b.type === "tool_result" && b.tool_use_id)) {
      const content = typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? "");
      out.push({ role: "tool", tool_call_id: r.tool_use_id!, content: r.is_error ? `ERRO: ${content}` : content });
    }
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

const responseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    message: z.object({
      content: z.string().nullish(),
      tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string().nullish() }) })).nullish(),
    }),
  })).min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional(), cost: z.number().optional() }).nullish(),
});

export function fromOpenAiResponse(json: unknown, fallbackModel: string): LlmResponse {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new LlmUnavailableError("Resposta inesperada do provedor de IA", false);
  const choice = parsed.data.choices[0]!;
  const blocks: LlmBlock[] = [];
  if (choice.message.content?.trim()) blocks.push({ type: "text", text: choice.message.content });
  for (const c of choice.message.tool_calls ?? []) {
    let input: unknown = {};
    try { input = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = { __invalid_json: c.function.arguments }; }
    blocks.push({ type: "tool_use", id: c.id, name: c.function.name, input });
  }
  const assistantContent: Block[] = blocks.map((b) => (b.type === "text" ? { type: "text", text: b.text } : { type: "tool_use", id: b.id, name: b.name, input: b.input as Record<string, unknown> }));
  return {
    blocks, assistantContent,
    stopReason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input: parsed.data.usage?.prompt_tokens ?? 0, output: parsed.data.usage?.completion_tokens ?? 0, costUsd: parsed.data.usage?.cost },
    model: parsed.data.model ?? fallbackModel,
  };
}

/** Endereço da API informado pela clínica: só https público (proteção contra SSRF). */
async function safeBase(baseUrl: string): Promise<void> {
  try { await assertPublicUrl(baseUrl); } catch (e) { throw new LlmUnavailableError(e instanceof Error ? e.message : "Endereço da IA não permitido.", false); }
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly model: string, private readonly extraHeaders: Record<string, string> = {}, name = "openai_compatible") {
    this.name = name;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    await safeBase(this.baseUrl);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", ...this.extraHeaders },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 2000,
          messages: toOpenAiMessages(req),
          tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
          tool_choice: "auto",
          ...(this.name === "openrouter" ? { usage: { include: true } } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
        redirect: "error",
      });
    } catch {
      throw new LlmUnavailableError("Provedor de IA fora do ar", true);
    }
    const json: unknown = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new LlmUnavailableError("Chave da IA recusada pelo provedor", false, res.status);
    if (res.status === 429 || res.status >= 500) throw new LlmUnavailableError(`Provedor de IA indisponível (${res.status})`, true, res.status);
    if (!res.ok) throw new LlmUnavailableError(`Provedor de IA recusou a requisição (${res.status})`, false, res.status);
    return fromOpenAiResponse(json, this.model);
  }
}

/** Lista os modelos disponíveis (GET /models), para o admin escolher sem digitar nomes. */
export async function listOpenAiModels(baseUrl: string, apiKey: string | null): Promise<string[]> {
  await safeBase(baseUrl);
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  if (!res.ok) throw new LlmUnavailableError(`Não foi possível listar os modelos (${res.status})`, false);
  const parsed = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) }).safeParse(await res.json());
  return parsed.success ? parsed.data.data.map((m) => m.id).sort() : [];
}

/* ───────────── OpenRouter: modelos gratuitos e rotação ───────────── */

export type FreeModel = { id: string; context: number };
const openRouterModel = z.object({
  id: z.string(),
  context_length: z.number().nullish(),
  pricing: z.object({ prompt: z.union([z.string(), z.number()]).nullish(), completion: z.union([z.string(), z.number()]).nullish() }).partial().nullish(),
  supported_parameters: z.array(z.string()).nullish(),
}).passthrough();

/**
 * Filtra os modelos gratuitos que aceitam ferramentas (a assistente precisa de tool calling para consultar
 * agenda e preços). Gratuito = sufixo ":free" ou preço zero de entrada e saída. Maior contexto primeiro.
 */
export function pickFreeToolModels(json: unknown): FreeModel[] {
  const parsed = z.object({ data: z.array(z.unknown()) }).safeParse(json);
  if (!parsed.success) return [];
  const out: FreeModel[] = [];
  for (const raw of parsed.data.data) {
    const m = openRouterModel.safeParse(raw);
    if (!m.success) continue;
    const zero = (v: unknown) => v !== null && v !== undefined && Number(v) === 0;
    const free = m.data.id.endsWith(":free") || (zero(m.data.pricing?.prompt) && zero(m.data.pricing?.completion));
    if (!free || !(m.data.supported_parameters ?? []).includes("tools")) continue;
    if (m.data.id === "openrouter/auto") continue;
    out.push({ id: m.data.id, context: m.data.context_length ?? 0 });
  }
  // Versões de prévia/experimentais costumam errar mais o formato das ferramentas: vão para o fim da fila.
  const unstable = (id: string) => (/(preview|[-:]exp|experimental|beta|alpha|test)/i.test(id) ? 1 : 0);
  return out.sort((a, b) => unstable(a.id) - unstable(b.id) || b.context - a.context || a.id.localeCompare(b.id));
}

let freeCache: { at: number; models: FreeModel[] } | null = null;
/** Lista atual de modelos gratuitos do OpenRouter (cache de 1 h: a lista muda com frequência). */
export async function listOpenRouterFreeModels(baseUrl: string, apiKey: string | null, now = Date.now()): Promise<FreeModel[]> {
  if (freeCache && now - freeCache.at < 60 * 60 * 1000 && freeCache.models.length) return freeCache.models;
  await safeBase(baseUrl);
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(20_000), redirect: "error" })
    .catch(() => { throw new LlmUnavailableError("Não foi possível consultar os modelos gratuitos", true); });
  if (!res.ok) throw new LlmUnavailableError(`Não foi possível consultar os modelos gratuitos (${res.status})`, res.status >= 500);
  const models = pickFreeToolModels(await res.json());
  freeCache = { at: now, models };
  return models;
}
export function resetFreeModelCache(): void { freeCache = null; }

/** Modelos que falharam há pouco ficam de fora por 10 min (cota esgotada, fora do ar, removido). */
const cooldown = new Map<string, number>();
const COOLDOWN_MS = 10 * 60 * 1000;
export function resetModelCooldown(): void { cooldown.clear(); }

/**
 * Tenta os modelos em ordem e passa para o próximo quando um falha por cota (429), instabilidade (5xx),
 * modelo indisponível (404) ou rede. Chave recusada (401/403) para tudo: trocar de modelo não resolve.
 */
export class RoutingProvider implements LlmProvider {
  readonly name = "openrouter_rotation";
  constructor(private readonly candidates: () => Promise<string[]>, private readonly make: (model: string) => LlmProvider, private readonly maxTries = 4) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const all = await this.candidates();
    if (all.length === 0) throw new LlmUnavailableError("Nenhum modelo gratuito com suporte a ferramentas disponível agora", true);
    const now = Date.now();
    const fresh = all.filter((m) => (cooldown.get(m) ?? 0) <= now);
    // Se todos estão em espera, tenta mesmo assim (melhor do que não responder).
    const order = (fresh.length ? fresh : all).slice(0, this.maxTries);
    let last: unknown = null;
    for (const model of order) {
      try {
        return await this.make(model).complete(req);
      } catch (e) {
        last = e;
        if (e instanceof LlmUnavailableError && (e.status === 401 || e.status === 403)) throw e;
        const switchable = !(e instanceof LlmUnavailableError) || e.retryable || e.status === 404 || e.status === 400;
        if (!switchable) throw e;
        cooldown.set(model, now + COOLDOWN_MS);
      }
    }
    throw last instanceof LlmUnavailableError ? new LlmUnavailableError(`Todos os modelos tentados falharam: ${last.message}`, true, last.status) : new LlmUnavailableError("Todos os modelos tentados falharam", true);
  }
}
