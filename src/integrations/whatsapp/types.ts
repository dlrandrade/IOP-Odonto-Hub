/** Contrato do canal: Cloud API oficial (padrão) ou os alternativos não oficiais Evolution e wacli, escolhidos pela clínica. */
export type SendResult = { waMessageId: string };

export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code?: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface WhatsAppProvider {
  readonly name: string;
  sendText(to: string, body: string): Promise<SendResult>;
  /** fallbackBody: texto pronto, usado por canais sem templates (Evolution). */
  sendTemplate(to: string, templateName: string, language: string, params: string[], fallbackBody?: string): Promise<SendResult>;
  downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }>;
}

export type InboundMessage = {
  waMessageId: string;
  from: string; // E.164 com "+"
  profileName: string | null;
  timestamp: Date;
  type: "text" | "audio" | "image" | "unsupported";
  text: string | null;
  mediaId: string | null;
  mediaMime: string | null;
  rawType: string;
};

export type StatusUpdate = {
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  error: string | null;
};

export type ParsedWebhook = { phoneNumberId: string | null; messages: InboundMessage[]; statuses: StatusUpdate[] };
