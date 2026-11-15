import { z } from "zod";
import { ProviderError, type InboundMessage, type ParsedWebhook, type SendResult, type StatusUpdate, type WhatsAppProvider } from "./types";

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0"}`;

export class CloudApiProvider implements WhatsAppProvider {
  readonly name = "whatsapp_cloud";
  constructor(private readonly phoneNumberId: string, private readonly accessToken: string) {}

  private async post(body: Record<string, unknown>): Promise<SendResult> {
    let res: Response;
    try {
      res = await fetch(`${GRAPH}/${this.phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ProviderError("Falha de rede ao falar com o WhatsApp", true);
    }
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = z.object({ error: z.object({ message: z.string().optional(), code: z.number().optional() }) }).safeParse(json);
      const retryable = res.status >= 500 || res.status === 429;
      throw new ProviderError(err.success ? err.data.error.message ?? "Erro do WhatsApp" : `HTTP ${res.status}`, retryable, err.success ? String(err.data.error.code ?? "") : undefined);
    }
    const ok = z.object({ messages: z.array(z.object({ id: z.string() })).min(1) }).safeParse(json);
    if (!ok.success) throw new ProviderError("Resposta inesperada do WhatsApp", false);
    return { waMessageId: ok.data.messages[0]!.id };
  }

  sendText(to: string, body: string): Promise<SendResult> {
    return this.post({ to: to.replace(/^\+/, ""), type: "text", text: { body, preview_url: false } });
  }

  sendTemplate(to: string, templateName: string, language: string, params: string[]): Promise<SendResult> {
    return this.post({
      to: to.replace(/^\+/, ""), type: "template",
      template: {
        name: templateName, language: { code: language },
        components: params.length ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] : [],
      },
    });
  }

  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }> {
    const headers = { Authorization: `Bearer ${this.accessToken}` };
    const meta = await fetch(`${GRAPH}/${mediaId}`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!meta.ok) throw new ProviderError(`Mídia indisponível (HTTP ${meta.status})`, meta.status >= 500);
    const info = z.object({ url: z.string().url(), mime_type: z.string() }).parse(await meta.json());
    const file = await fetch(info.url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!file.ok) throw new ProviderError(`Download de mídia falhou (HTTP ${file.status})`, file.status >= 500);
    return { data: Buffer.from(await file.arrayBuffer()), mime: info.mime_type };
  }
}

const inboundSchema = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string().optional(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  audio: z.object({ id: z.string(), mime_type: z.string().optional() }).optional(),
  image: z.object({ id: z.string(), mime_type: z.string().optional(), caption: z.string().optional() }).optional(),
  button: z.object({ text: z.string() }).optional(),
  referral: z.object({ source_url: z.string().optional(), source_type: z.string().optional(), headline: z.string().optional() }).optional(),
  interactive: z.object({
    button_reply: z.object({ title: z.string() }).optional(),
    list_reply: z.object({ title: z.string() }).optional(),
  }).optional(),
});

const valueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string() }).optional(),
  contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string().optional() }).optional() })).optional(),
  messages: z.array(inboundSchema).optional(),
  statuses: z.array(z.object({
    id: z.string(), status: z.string(),
    errors: z.array(z.object({ title: z.string().optional(), message: z.string().optional() })).optional(),
  })).optional(),
});

const webhookSchema = z.object({
  entry: z.array(z.object({ changes: z.array(z.object({ value: valueSchema })).optional() })).optional(),
});

/** Normaliza o payload da Cloud API. Um POST pode trazer várias mensagens e status de números diferentes. */
export function parseCloudWebhook(payload: unknown): ParsedWebhook[] {
  const parsed = webhookSchema.safeParse(payload);
  if (!parsed.success) return [];
  const out: ParsedWebhook[] = [];
  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      const names = new Map((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));
      const messages: InboundMessage[] = (v.messages ?? []).map((m) => {
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.image?.caption ?? null;
        const type: InboundMessage["type"] =
          m.type === "audio" ? "audio" : m.type === "image" ? "image" : text !== null && ["text", "button", "interactive"].includes(m.type) ? "text" : "unsupported";
        return {
          waMessageId: m.id, from: `+${m.from.replace(/\D/g, "")}`, profileName: names.get(m.from) ?? null,
          timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
          type, text, mediaId: m.audio?.id ?? m.image?.id ?? null, mediaMime: m.audio?.mime_type ?? m.image?.mime_type ?? null, rawType: m.type,
          referral: m.referral ? { sourceUrl: m.referral.source_url ?? null, sourceType: m.referral.source_type ?? null, headline: m.referral.headline ?? null } : null,
        };
      });
      const statuses: StatusUpdate[] = (v.statuses ?? []).flatMap((s) =>
        ["sent", "delivered", "read", "failed"].includes(s.status)
          ? [{ waMessageId: s.id, status: s.status as StatusUpdate["status"], error: s.errors?.[0]?.message ?? s.errors?.[0]?.title ?? null }]
          : []);
      out.push({ phoneNumberId: v.metadata?.phone_number_id ?? null, messages, statuses });
    }
  }
  return out;
}
