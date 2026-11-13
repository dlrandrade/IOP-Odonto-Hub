/** Contrato do canal. Produção usa somente a Cloud API oficial; APIs não oficiais são proibidas. */
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
  sendTemplate(to: string, templateName: string, language: string, params: string[]): Promise<SendResult>;
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
