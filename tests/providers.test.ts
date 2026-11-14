import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db/client";
import { encryptField } from "@/lib/crypto";
import { fromOpenAiResponse, toOpenAiMessages, OpenAiCompatibleProvider } from "@/integrations/llm/openai-compatible";
import { EvolutionProvider, parseEvolutionWebhook } from "@/integrations/whatsapp/evolution";
import { handleEvolutionWebhook } from "@/services/evolution-webhook";
import { sendOutbound } from "@/services/conversations";
import { setProviderOverride } from "@/integrations/whatsapp";
import { addMinutes } from "@/lib/datetime";
import { makeClinic } from "./helpers";

const sql = db();
afterEach(() => { vi.unstubAllGlobals(); setProviderOverride(null); });
afterAll(async () => { await sql.end(); });

describe("IA compatível com OpenAI (OpenRouter e similares)", () => {
  it("traduz histórico, chamadas de ferramenta e resultados para o formato OpenAI", () => {
    const msgs = toOpenAiMessages({
      system: "regras",
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "oi" }, { type: "text", text: "<contexto/>" }] },
        { role: "assistant", content: [{ type: "text", text: "vou ver" }, { type: "tool_use", id: "t1", name: "buscar_servicos", input: { consulta: "limpeza" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{\"ok\":true}", is_error: false }] },
      ],
    });
    expect(msgs[0]).toEqual({ role: "system", content: "regras" });
    expect(msgs[1]).toEqual({ role: "user", content: "oi\n<contexto/>" });
    expect(msgs[2]).toMatchObject({ role: "assistant", content: "vou ver", tool_calls: [{ id: "t1", function: { name: "buscar_servicos", arguments: "{\"consulta\":\"limpeza\"}" } }] });
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "{\"ok\":true}" });
  });

  it("lê resposta com chamada de ferramenta, uso e custo", () => {
    const r = fromOpenAiResponse({
      model: "x/y", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", function: { name: "consultar_conhecimento", arguments: "{\"topico\":\"endereço\"}" } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.0012 },
    }, "fallback");
    expect(r.stopReason).toBe("tool_use");
    expect(r.blocks[0]).toEqual({ type: "tool_use", id: "c1", name: "consultar_conhecimento", input: { topico: "endereço" } });
    expect(r.usage).toEqual({ input: 10, output: 3, costUsd: 0.0012 });
    expect(() => fromOpenAiResponse({ nada: 1 }, "m")).toThrow();
  });

  it("chave recusada não é repetida; queda do provedor é", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(new OpenAiCompatibleProvider("https://x.test/v1", "k", "m").complete({ system: "", messages: [], tools: [] })).rejects.toMatchObject({ retryable: false });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    await expect(new OpenAiCompatibleProvider("https://x.test/v1", "k", "m").complete({ system: "", messages: [], tools: [] })).rejects.toMatchObject({ retryable: true });
  });
});

describe("WhatsApp alternativo (Evolution API)", () => {
  const upsert = (id: string, extra: Record<string, unknown> = {}) => ({
    event: "messages.upsert", instance: "clinica",
    data: { key: { id, remoteJid: "5511977770000@s.whatsapp.net", fromMe: false }, pushName: "Bia", messageType: "conversation", message: { conversation: "Oi, quero marcar" }, messageTimestamp: 1700000000, ...extra },
  });

  it("normaliza texto, ignora grupos e mensagens enviadas pela própria clínica", () => {
    const ev = parseEvolutionWebhook(upsert("A1"));
    expect(ev).toMatchObject({ kind: "messages", messages: [{ waMessageId: "A1", from: "+5511977770000", text: "Oi, quero marcar", type: "text", profileName: "Bia" }] });
    expect(parseEvolutionWebhook({ ...upsert("A2"), data: { key: { id: "A2", remoteJid: "123@g.us", fromMe: false }, message: { conversation: "grupo" } } })).toEqual({ kind: "messages", messages: [] });
    expect(parseEvolutionWebhook({ ...upsert("A3"), data: { key: { id: "A3", remoteJid: "5511977770000@s.whatsapp.net", fromMe: true }, message: { conversation: "eu" } } })).toEqual({ kind: "messages", messages: [] });
    const audio = parseEvolutionWebhook({ event: "MESSAGES_UPSERT", data: { key: { id: "A4", remoteJid: "5511977770000@s.whatsapp.net" }, message: { audioMessage: { mimetype: "audio/ogg; codecs=opus" } } } });
    expect(audio).toMatchObject({ kind: "messages", messages: [{ type: "audio", mediaId: "A4" }] });
    expect(parseEvolutionWebhook({ event: "messages.update", data: { keyId: "Z9", status: "READ" } })).toEqual({ kind: "statuses", statuses: [{ waMessageId: "Z9", status: "read", error: null }] });
  });

  it("envia texto pela rota da instância com a chave no cabeçalho", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ key: { id: "OUT1" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await new EvolutionProvider({ baseUrl: "https://evo.test/", instance: "minha clinica", apiKey: "K" }).sendText("+5511977770000", "Olá");
    expect(r.waMessageId).toBe("OUT1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://evo.test/message/sendText/minha%20clinica");
    expect(init?.headers).toMatchObject({ apikey: "K" });
    expect(JSON.parse(String(init?.body))).toEqual({ number: "5511977770000", text: "Olá" });
  });

  it("webhook com token correto entra no mesmo pipeline, sem duplicar; token errado é recusado", async () => {
    const c = await makeClinic();
    await sql`update clinic_integrations set wa_provider = 'evolution', evo_base_url = 'https://evo.test', evo_instance = 'x', evo_api_key_enc = ${encryptField("K")} where clinic_id = ${c.clinicId}`;
    const [row] = await sql<{ evo_webhook_token: string }[]>`select evo_webhook_token from clinic_integrations where clinic_id = ${c.clinicId}`;
    const token = row!.evo_webhook_token;
    await sql`update clinics set ai_enabled = false where id = ${c.clinicId}`;
    expect((await handleEvolutionWebhook("0".repeat(64), upsert("B1"))).status).toBe(404);
    const first = await handleEvolutionWebhook(token, upsert("B1"));
    const again = await handleEvolutionWebhook(token, upsert("B1"));
    expect([first.accepted, again.accepted]).toEqual([1, 0]);
    expect(await sql`select 1 from messages where clinic_id = ${c.clinicId} and direction = 'inbound'`).toHaveLength(1);

    // Sem janela de 24 h neste canal: a equipe consegue responder depois de um dia.
    const [conv] = await sql<{ id: string }[]>`select id from conversations where clinic_id = ${c.clinicId}`;
    setProviderOverride({ name: "fake", sendText: async () => ({ waMessageId: "evo-out" }), sendTemplate: async () => ({ waMessageId: "t" }), downloadMedia: async () => ({ data: Buffer.from(""), mime: "x" }) });
    const r = await sendOutbound(sql, { clinicId: c.clinicId, conversationId: conv!.id, senderType: "human", body: "Bom dia!", now: addMinutes(new Date(), 26 * 60) });
    expect(r.status).toBe("sent");
  });
});
