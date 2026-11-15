import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db/client";
import { encryptField } from "@/lib/crypto";
import { fromOpenAiResponse, toOpenAiMessages, OpenAiCompatibleProvider, pickFreeToolModels, resetFreeModelCache, resetModelCooldown, RoutingProvider } from "@/integrations/llm/openai-compatible";
import { buildProvider, LlmUnavailableError } from "@/integrations/llm";
import { EvolutionProvider, parseEvolutionWebhook } from "@/integrations/whatsapp/evolution";
import { handleEvolutionWebhook } from "@/services/evolution-webhook";
import { parseWacliWebhook, verifyWacliSignature, WacliProvider } from "@/integrations/whatsapp/wacli";
import { handleWacliWebhook } from "@/services/wacli-webhook";
import { createHmac } from "node:crypto";
import { sendOutbound } from "@/services/conversations";
import { setProviderOverride } from "@/integrations/whatsapp";
import { addMinutes } from "@/lib/datetime";
import { makeClinic } from "./helpers";
import { assertPublicUrl, isPrivateAddress, setResolverForTests } from "@/lib/safe-url";

const sql = db();
// A rede de teste não resolve domínios externos: simulamos um IP público para os endereços dos testes.
setResolverForTests(async () => [{ address: "93.184.216.34" }]);
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

describe("WhatsApp por QR Code (gateway wacli)", () => {
  const msg = (over: Record<string, unknown> = {}) => ({ Chat: "5511988887777@s.whatsapp.net", ID: "3EB0A1", SenderJID: "5511988887777@s.whatsapp.net", Timestamp: "2026-11-14T10:00:00Z", FromMe: false, Text: "Oi, quero marcar", PushName: "Lia", Media: null, ...over });

  it("normaliza mensagens e confirmações; ignora grupos, envios próprios, reações e apagadas", () => {
    const ev = parseWacliWebhook(msg());
    expect(ev).toMatchObject({ kind: "message", message: { waMessageId: "3EB0A1", from: "+5511988887777", profileName: "Lia", type: "text", text: "Oi, quero marcar" } });
    const audio = parseWacliWebhook(msg({ Text: "", Media: { Type: "audio", MimeType: "audio/ogg" } }));
    expect(audio).toMatchObject({ kind: "message", message: { type: "audio", mediaId: "5511988887777@s.whatsapp.net|3EB0A1" } });
    for (const p of [msg({ Chat: "1203630000@g.us" }), msg({ FromMe: true }), msg({ ReactionToID: "X" }), msg({ Revoked: true }), { EventType: "chat_presence", Chat: "x" }]) {
      expect(parseWacliWebhook(p).kind).toBe("ignored");
    }
    expect(parseWacliWebhook({ EventType: "receipt", Chat: "5511988887777@s.whatsapp.net", MessageIDs: ["A", "B"], Type: "read", Timestamp: "2026-11-14T10:00:00Z" }))
      .toEqual({ kind: "statuses", statuses: [{ waMessageId: "A", status: "read", error: null }, { waMessageId: "B", status: "read", error: null }] });
  });

  it("assinatura HMAC confere o corpo exato", () => {
    const body = JSON.stringify(msg());
    const sig = `sha256=${createHmac("sha256", "segredo").update(body).digest("hex")}`;
    expect(verifyWacliSignature("segredo", body, sig)).toBe(true);
    expect(verifyWacliSignature("segredo", body + " ", sig)).toBe(false);
    expect(verifyWacliSignature("outro", body, sig)).toBe(false);
    expect(verifyWacliSignature("segredo", body, null)).toBe(false);
  });

  it("envia pelo gateway com a conta da clínica e o token no cabeçalho", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "3EB0OUT" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await new WacliProvider({ url: "https://gw.exemplo/", token: "tok", account: "clinica-1" }).sendText("+55 11 98888-7777", "Olá");
    expect(r.waMessageId).toBe("3EB0OUT");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.exemplo/v1/accounts/clinica-1/send");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toEqual({ to: "5511988887777", text: "Olá" });
  });

  it("webhook exige token e assinatura; entra no pipeline sem duplicar e sem janela de 24 h", async () => {
    const c = await makeClinic();
    const secret = "s".repeat(64);
    await sql`update clinic_integrations set wa_provider = 'wacli', wacli_webhook_secret_enc = ${encryptField(secret)} where clinic_id = ${c.clinicId}`;
    const [row] = await sql<{ wacli_webhook_token: string }[]>`select wacli_webhook_token from clinic_integrations where clinic_id = ${c.clinicId}`;
    const token = row!.wacli_webhook_token;
    const body = JSON.stringify(msg({ ID: "W1", Chat: "5511977776666@s.whatsapp.net" }));
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect((await handleWacliWebhook("0".repeat(64), body, sig)).status).toBe(404);
    expect((await handleWacliWebhook(token, body, "sha256=errada")).status).toBe(401);
    const first = await handleWacliWebhook(token, body, sig);
    const again = await handleWacliWebhook(token, body, sig);
    expect([first.status, first.accepted, again.accepted]).toEqual([200, 1, 0]);
    expect(await sql`select 1 from messages where clinic_id = ${c.clinicId} and direction = 'inbound'`).toHaveLength(1);

    const [conv] = await sql<{ id: string }[]>`select id from conversations where clinic_id = ${c.clinicId}`;
    setProviderOverride({ name: "fake", sendText: async () => ({ waMessageId: "w-out" }), sendTemplate: async () => ({ waMessageId: "t" }), downloadMedia: async () => ({ data: Buffer.from(""), mime: "x" }) });
    const r = await sendOutbound(sql, { clinicId: c.clinicId, conversationId: conv!.id, senderType: "human", body: "Bom dia!", now: addMinutes(new Date(), 26 * 60) });
    expect(r.status).toBe("sent");
  });
});

describe("OpenRouter: modelos gratuitos em rodízio", () => {
  const catalog = { data: [
    { id: "a/grande:free", context_length: 128000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools", "tool_choice"] },
    { id: "b/medio:free", context_length: 32000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
    { id: "c/sem-ferramentas:free", context_length: 200000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["temperature"] },
    { id: "d/pago", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools"] },
    { id: "e/zero-sem-sufixo", context_length: 8000, pricing: { prompt: 0, completion: 0 }, supported_parameters: ["tools"] },
  ] };
  const ok = (model: string) => new Response(JSON.stringify({ model, choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200 });
  const req = { system: "s", messages: [{ role: "user" as const, content: "oi" }], tools: [] };
  afterEach(() => { resetFreeModelCache(); resetModelCooldown(); });

  it("seleciona só gratuitos que aceitam ferramentas, maior contexto primeiro", () => {
    expect(pickFreeToolModels(catalog).map((m) => m.id)).toEqual(["a/grande:free", "b/medio:free", "e/zero-sem-sufixo"]);
    expect(pickFreeToolModels({ nada: 1 })).toEqual([]);
  });

  it("troca de modelo em limite (429) e indisponível (404); para em chave recusada", async () => {
    const calls: string[] = [];
    const fake = (behaviour: Record<string, number>) => (model: string) => ({
      name: "fake",
      complete: async () => {
        calls.push(model);
        const st = behaviour[model];
        if (st) throw new LlmUnavailableError(`erro ${st}`, st === 429 || st >= 500, st);
        return { blocks: [{ type: "text" as const, text: model }], assistantContent: [], stopReason: "end_turn" as const, usage: { input: 1, output: 1 }, model };
      },
    });
    const r = await new RoutingProvider(async () => ["m1", "m2", "m3"], fake({ m1: 429, m2: 404 })).complete(req);
    expect(r.model).toBe("m3");
    expect(calls).toEqual(["m1", "m2", "m3"]);

    // Os que falharam ficam em espera: a próxima resposta já começa pelo que funcionou.
    calls.length = 0;
    await new RoutingProvider(async () => ["m1", "m2", "m3"], fake({})).complete(req);
    expect(calls).toEqual(["m3"]);

    resetModelCooldown();
    await expect(new RoutingProvider(async () => ["x1", "x2"], fake({ x1: 401 })).complete(req)).rejects.toMatchObject({ status: 401 });
    await expect(new RoutingProvider(async () => [], fake({})).complete(req)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("modo gratuito consulta a lista do OpenRouter e respeita os modelos priorizados pela clínica", async () => {
    const used: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify(catalog), { status: 200 });
      const model = JSON.parse(String(init?.body)).model as string;
      used.push(model);
      return model === "b/medio:free" ? new Response("{}", { status: 429 }) : ok(model);
    }));
    const p = buildProvider({ provider: "openrouter", apiKey: "k", model: null, baseUrl: null, freeAuto: true, fallbackModels: ["b/medio:free", "z/nao-existe-mais:free"] });
    const r = await p!.complete(req);
    expect(used).toEqual(["b/medio:free", "a/grande:free"]);
    expect(r.model).toBe("a/grande:free");
  });

  it("modo escolhido usa o principal e cai para a reserva", async () => {
    const used: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string;
      used.push(model);
      return model === "principal" ? new Response("{}", { status: 503 }) : ok(model);
    }));
    const r = await buildProvider({ provider: "openrouter", apiKey: "k", model: "principal", baseUrl: null, fallbackModels: ["reserva"] })!.complete(req);
    expect(used).toEqual(["principal", "reserva"]);
    expect(r.model).toBe("reserva");
  });
});

describe("Segurança: endereços informados pelas clínicas (SSRF)", () => {
  it("bloqueia rede interna, metadados de nuvem, http e credenciais na URL", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    await expect(assertPublicUrl("http://api.exemplo.com")).rejects.toThrow(/https/);
    await expect(assertPublicUrl("https://user:senha@api.exemplo.com")).rejects.toThrow(/usuário ou senha/);
    await expect(assertPublicUrl("https://169.254.169.254/latest")).rejects.toThrow(/privada/);
    await expect(assertPublicUrl("https://servico.internal")).rejects.toThrow(/internos/);
    setResolverForTests(async () => [{ address: "10.0.0.5" }]);
    await expect(assertPublicUrl("https://parece-publico.com")).rejects.toThrow(/privada/); // DNS aponta para rede interna
    setResolverForTests(async () => [{ address: "93.184.216.34" }]);
    await expect(assertPublicUrl("https://api.exemplo.com/v1")).resolves.toBeInstanceOf(URL);
  });
});
