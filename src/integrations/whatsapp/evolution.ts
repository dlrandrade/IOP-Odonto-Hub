import { assertPublicUrl } from "@/lib/safe-url";
import { z } from "zod";
import { ProviderError, type InboundMessage, type SendResult, type StatusUpdate, type WhatsAppProvider } from "./types";

/**
 * Evolution API (v2): alternativa NÃO OFICIAL ao WhatsApp, conectada por QR Code a um número comum.
 * Risco: viola os termos do WhatsApp e o número pode ser bloqueado. Fica como opção da clínica, nunca o padrão.
 * Rotas conferidas no código-fonte da Evolution API (routerPath = "/<rota>/:instanceName").
 */
export type EvolutionConfig = { baseUrl: string; instance: string; apiKey: string };

function url(c: EvolutionConfig, path: string): string {
  return `${c.baseUrl.replace(/\/+$/, "")}/${path}/${encodeURIComponent(c.instance)}`;
}

async function call(c: EvolutionConfig, method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs = 15_000): Promise<unknown> {
  try { await assertPublicUrl(c.baseUrl); } catch (e) { throw new ProviderError(e instanceof Error ? e.message : "Endereço não permitido.", false); }
  let res: Response;
  try {
    res = await fetch(path === "instance/create" ? `${c.baseUrl.replace(/\/+$/, "")}/instance/create` : url(c, path), {
      method,
      headers: { apikey: c.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    throw new ProviderError("Não foi possível falar com o servidor da Evolution API. Confira o endereço.", true);
  }
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 429;
    const msg = res.status === 401 || res.status === 403 ? "Chave da Evolution API recusada." : res.status === 404 ? "Instância não encontrada na Evolution API." : `Evolution API respondeu ${res.status}.`;
    throw new ProviderError(msg, retryable, String(res.status));
  }
  return json;
}

const toJid = (phoneE164: string) => phoneE164.replace(/\D/g, "");

export class EvolutionProvider implements WhatsAppProvider {
  readonly name = "evolution";
  constructor(private readonly c: EvolutionConfig) {}

  async sendText(to: string, body: string): Promise<SendResult> {
    const json = await call(this.c, "POST", "message/sendText", { number: toJid(to), text: body });
    const parsed = z.object({ key: z.object({ id: z.string() }) }).passthrough().safeParse(json);
    if (!parsed.success) throw new ProviderError("Resposta inesperada da Evolution API", false);
    return { waMessageId: parsed.data.key.id };
  }

  /** Sem janela de 24 h nem templates neste canal: o "template" vira texto comum. */
  sendTemplate(to: string, _name: string, _language: string, params: string[], fallbackBody?: string): Promise<SendResult> {
    return this.sendText(to, fallbackBody ?? params.join(" "));
  }

  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }> {
    const json = await call(this.c, "POST", "chat/getBase64FromMediaMessage", { message: { key: { id: mediaId } }, convertToMp4: false }, 30_000);
    const parsed = z.object({ base64: z.string(), mimetype: z.string().optional() }).passthrough().safeParse(json);
    if (!parsed.success) throw new ProviderError("Mídia indisponível na Evolution API", false);
    return { data: Buffer.from(parsed.data.base64, "base64"), mime: (parsed.data.mimetype ?? "application/octet-stream").split(";")[0]!.trim() };
  }
}

export type EvolutionState = "open" | "connecting" | "close" | "missing";

export async function evolutionState(c: EvolutionConfig): Promise<EvolutionState> {
  try {
    const json = await call(c, "GET", "instance/connectionState");
    const s = z.object({ instance: z.object({ state: z.string() }).passthrough() }).passthrough().safeParse(json);
    const state = s.success ? s.data.instance.state : "close";
    return state === "open" ? "open" : state === "connecting" ? "connecting" : "close";
  } catch (e) {
    if (e instanceof ProviderError && e.code === "404") return "missing";
    throw e;
  }
}

/** Cria a instância se ainda não existir (exige a chave global da Evolution). */
export async function ensureEvolutionInstance(c: EvolutionConfig): Promise<void> {
  if ((await evolutionState(c)) !== "missing") return;
  await call(c, "POST", "instance/create", { instanceName: c.instance, integration: "WHATSAPP-BAILEYS", qrcode: true });
}

/** Aponta os eventos da instância para o nosso webhook. */
export async function setEvolutionWebhook(c: EvolutionConfig, webhookUrl: string): Promise<void> {
  await call(c, "POST", "webhook/set", {
    webhook: { enabled: true, url: webhookUrl, byEvents: false, base64: false, events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"] },
  });
}

/** QR Code para parear o celular da clínica (imagem em data URL) ou código de pareamento. */
export async function evolutionQr(c: EvolutionConfig): Promise<{ image: string | null; pairingCode: string | null }> {
  const json = await call(c, "GET", "instance/connect");
  const p = z.object({ base64: z.string().nullish(), pairingCode: z.string().nullish() }).passthrough().safeParse(json);
  if (!p.success) return { image: null, pairingCode: null };
  const img = p.data.base64 ?? null;
  return { image: img && !img.startsWith("data:") ? `data:image/png;base64,${img}` : img, pairingCode: p.data.pairingCode ?? null };
}

export async function evolutionLogout(c: EvolutionConfig): Promise<void> {
  await call(c, "DELETE", "instance/logout");
}

// ───────────── Webhook de entrada ─────────────

const keySchema = z.object({ id: z.string(), remoteJid: z.string().optional(), remoteJidAlt: z.string().optional(), fromMe: z.boolean().optional() }).passthrough();
const upsertData = z.object({
  key: keySchema,
  pushName: z.string().nullish(),
  messageType: z.string().optional(),
  messageTimestamp: z.union([z.number(), z.string()]).optional(),
  message: z.object({
    conversation: z.string().optional(),
    extendedTextMessage: z.object({ text: z.string().optional() }).passthrough().optional(),
    imageMessage: z.object({ caption: z.string().optional(), mimetype: z.string().optional() }).passthrough().optional(),
    audioMessage: z.object({ mimetype: z.string().optional() }).passthrough().optional(),
    buttonsResponseMessage: z.object({ selectedDisplayText: z.string().optional() }).passthrough().optional(),
    listResponseMessage: z.object({ title: z.string().optional() }).passthrough().optional(),
  }).passthrough().nullish(),
}).passthrough();

const updateData = z.object({
  keyId: z.string().optional(),
  messageId: z.string().optional(),
  key: keySchema.optional(),
  fromMe: z.boolean().optional(),
  status: z.string().optional(),
}).passthrough();

const envelope = z.object({ event: z.string(), instance: z.string().optional(), data: z.unknown() }).passthrough();

/** Só conversas individuais. Grupos e status ficam de fora. JIDs "@lid" usam o número alternativo, quando vier. */
function phoneFromJid(key: z.infer<typeof keySchema>): string | null {
  const jid = key.remoteJid ?? "";
  const pick = jid.endsWith("@s.whatsapp.net") ? jid : key.remoteJidAlt?.endsWith("@s.whatsapp.net") ? key.remoteJidAlt : null;
  if (!pick) return null;
  const digits = pick.split("@")[0]!.split(":")[0]!.replace(/\D/g, "");
  return digits.length >= 10 ? `+${digits}` : null;
}

const STATUS: Record<string, StatusUpdate["status"]> = { SERVER_ACK: "sent", DELIVERY_ACK: "delivered", READ: "read", PLAYED: "read", ERROR: "failed" };

export type EvolutionEvent = { kind: "messages"; messages: InboundMessage[] } | { kind: "statuses"; statuses: StatusUpdate[] } | { kind: "connection"; state: string } | { kind: "ignored" };

export function parseEvolutionWebhook(payload: unknown): EvolutionEvent {
  const env = envelope.safeParse(payload);
  if (!env.success) return { kind: "ignored" };
  const event = env.data.event.toLowerCase().replace(/_/g, ".");
  const items = Array.isArray(env.data.data) ? env.data.data : [env.data.data];

  if (event === "messages.upsert") {
    const messages: InboundMessage[] = [];
    for (const raw of items) {
      const d = upsertData.safeParse(raw);
      if (!d.success || d.data.key.fromMe) continue; // mensagens enviadas pelo próprio celular da clínica não entram como do paciente
      const from = phoneFromJid(d.data.key);
      if (!from) continue;
      const m = d.data.message ?? {};
      const text = m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? m.buttonsResponseMessage?.selectedDisplayText ?? m.listResponseMessage?.title ?? null;
      const type: InboundMessage["type"] = m.audioMessage ? "audio" : m.imageMessage ? "image" : text !== null ? "text" : "unsupported";
      const ts = Number(d.data.messageTimestamp);
      messages.push({
        waMessageId: d.data.key.id, from, profileName: d.data.pushName ?? null,
        timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
        type, text, mediaId: type === "audio" || type === "image" ? d.data.key.id : null,
        mediaMime: m.audioMessage?.mimetype ?? m.imageMessage?.mimetype ?? null, rawType: d.data.messageType ?? type,
      });
    }
    return { kind: "messages", messages };
  }
  if (event === "messages.update") {
    const statuses: StatusUpdate[] = [];
    for (const raw of items) {
      const d = updateData.safeParse(raw);
      if (!d.success) continue;
      const id = d.data.keyId ?? d.data.key?.id ?? d.data.messageId;
      const status = STATUS[(d.data.status ?? "").toUpperCase()];
      if (id && status) statuses.push({ waMessageId: id, status, error: null });
    }
    return { kind: "statuses", statuses };
  }
  if (event === "connection.update") {
    const s = z.object({ state: z.string() }).passthrough().safeParse(items[0]);
    return { kind: "connection", state: s.success ? s.data.state : "unknown" };
  }
  return { kind: "ignored" };
}
