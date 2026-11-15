import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ProviderError, type InboundMessage, type SendResult, type StatusUpdate, type WhatsAppProvider } from "./types";

/**
 * Canal wacli (WhatsApp Web, não oficial) através do gateway em gateway/wacli.
 * O gateway roda uma sessão por clínica (conta = id da clínica) e devolve as mensagens por webhook assinado.
 */
export type WacliGateway = { url: string; token: string; account: string };
export type WacliState = "idle" | "pairing" | "connected" | "disconnected" | "error";

async function call<T>(g: WacliGateway, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(`${g.url.replace(/\/+$/, "")}/v1/accounts/${encodeURIComponent(g.account)}${path}`, {
    method,
    headers: { authorization: `Bearer ${g.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e: unknown) => { throw new ProviderError(`Gateway wacli inacessível: ${e instanceof Error ? e.message : "erro de rede"}`, true); });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ProviderError(json.error ?? `Gateway wacli respondeu ${res.status}`, res.status >= 500 || res.status === 409, String(res.status));
  return json as T;
}

export const wacliConnect = (g: WacliGateway, webhookUrl: string, webhookSecret: string, phone?: string | null) =>
  call<{ state: WacliState }>(g, "POST", "/connect", { webhookUrl, webhookSecret, phone: phone ?? undefined });
export const wacliStatus = (g: WacliGateway) => call<{ state: WacliState; qr: string | null; pairCode: string | null; error: string | null }>(g, "GET", "");
export const wacliLogout = (g: WacliGateway) => call<{ state: WacliState }>(g, "POST", "/logout");

export class WacliProvider implements WhatsAppProvider {
  readonly name = "wacli";
  constructor(private readonly g: WacliGateway) {}

  async sendText(to: string, body: string): Promise<SendResult> {
    const r = await call<{ id: string }>(this.g, "POST", "/send", { to: to.replace(/\D/g, ""), text: body }, 70_000);
    return { waMessageId: r.id };
  }

  /** Sem templates no WhatsApp Web: envia o texto pronto. */
  async sendTemplate(to: string, _name: string, _language: string, _params: string[], fallbackBody?: string): Promise<SendResult> {
    if (!fallbackBody) throw new ProviderError("Canal wacli não usa templates e não há texto para enviar.", false);
    return this.sendText(to, fallbackBody);
  }

  /** mediaId = "<chat jid>|<id da mensagem>", montado no webhook. */
  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }> {
    const [chat, id] = mediaId.split("|");
    if (!chat || !id) throw new ProviderError("Referência de mídia inválida", false);
    const url = `${this.g.url.replace(/\/+$/, "")}/v1/accounts/${encodeURIComponent(this.g.account)}/media?chat=${encodeURIComponent(chat)}&id=${encodeURIComponent(id)}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.g.token}` }, signal: AbortSignal.timeout(100_000) })
      .catch(() => { throw new ProviderError("Gateway wacli inacessível", true); });
    if (!res.ok) throw new ProviderError(`Mídia indisponível (${res.status})`, res.status >= 500);
    return { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? "application/octet-stream" };
  }
}

/** Confere X-Wacli-Signature: "sha256=" + HMAC-SHA256(segredo, corpo bruto) em hexadecimal. */
export function verifyWacliSignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const got = Buffer.from(header);
  return got.length === want.length && timingSafeEqual(got, want);
}

const message = z.object({
  Chat: z.string(), ID: z.string(), SenderJID: z.string().optional(), Timestamp: z.string().optional(), FromMe: z.boolean().optional(),
  Text: z.string().nullish(), ChatName: z.string().nullish(), PushName: z.string().nullish(),
  ReactionToID: z.string().nullish(), Revoked: z.boolean().nullish(), Edited: z.boolean().nullish(),
  Media: z.object({ Type: z.string().nullish(), Caption: z.string().nullish(), MimeType: z.string().nullish() }).nullish(),
});
const receipt = z.object({ EventType: z.literal("receipt"), Chat: z.string(), MessageIDs: z.array(z.string()), Type: z.string() });

export type WacliEvent = { kind: "message"; message: InboundMessage } | { kind: "statuses"; statuses: StatusUpdate[] } | { kind: "ignored" };

/** Converte o payload do webhook do wacli. Grupos, status, canais e mensagens enviadas pela própria clínica são ignorados. */
export function parseWacliWebhook(payload: unknown): WacliEvent {
  const r = receipt.safeParse(payload);
  if (r.success) {
    const status = ({ delivered: "delivered", read: "read", played: "read" } as const)[r.data.Type as "delivered" | "read" | "played"];
    return status ? { kind: "statuses", statuses: r.data.MessageIDs.map((id) => ({ waMessageId: id, status, error: null })) } : { kind: "ignored" };
  }
  if (payload && typeof payload === "object" && "EventType" in payload) return { kind: "ignored" };
  const m = message.safeParse(payload);
  if (!m.success) return { kind: "ignored" };
  const d = m.data;
  // Mensagens da própria clínica, reações, apagadas e edições não abrem atendimento.
  if (d.FromMe || d.ReactionToID || d.Revoked || d.Edited) return { kind: "ignored" };
  const jid = d.Chat;
  if (!jid.endsWith("@s.whatsapp.net")) return { kind: "ignored" }; // grupos (@g.us), status, canais, LIDs não resolvidos
  const digits = jid.split("@")[0]!.split(":")[0]!.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return { kind: "ignored" };
  const mediaType = d.Media?.Type?.toLowerCase() ?? null;
  const type: InboundMessage["type"] = !mediaType ? (d.Text ? "text" : "unsupported")
    : mediaType.includes("audio") || mediaType.includes("ptt") ? "audio" : mediaType.includes("image") ? "image" : "unsupported";
  const ts = d.Timestamp ? new Date(d.Timestamp) : new Date();
  return {
    kind: "message",
    message: {
      waMessageId: d.ID, from: `+${digits}`, profileName: d.PushName ?? d.ChatName ?? null,
      timestamp: Number.isNaN(ts.getTime()) ? new Date() : ts, type,
      text: type === "text" ? d.Text ?? null : d.Media?.Caption ?? d.Text ?? null,
      mediaId: type === "audio" || type === "image" ? `${jid}|${d.ID}` : null, mediaMime: d.Media?.MimeType ?? null,
      rawType: mediaType ?? "text",
    },
  };
}
