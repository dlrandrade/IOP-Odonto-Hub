import { randomUUID } from "node:crypto";
import type { Sql } from "@/db/client";
import { decryptField } from "@/lib/crypto";
import { env } from "@/lib/env";
import { CloudApiProvider } from "./cloud";
import { ProviderError, type SendResult, type WhatsAppProvider } from "./types";

/** Canal do simulador: mesmo pipeline, nenhuma chamada externa. */
export class SimulatorProvider implements WhatsAppProvider {
  readonly name = "simulator";
  async sendText(): Promise<SendResult> { return { waMessageId: `sim.${randomUUID()}` }; }
  async sendTemplate(): Promise<SendResult> { return { waMessageId: `sim.${randomUUID()}` }; }
  async downloadMedia(): Promise<{ data: Buffer; mime: string }> { throw new ProviderError("Simulador não baixa mídia", false); }
}

let override: WhatsAppProvider | null = null;
/** Somente testes: injeta um provedor falso. */
export function setProviderOverride(p: WhatsAppProvider | null): void { override = p; }

export async function providerFor(sql: Sql, clinicId: string, channel: string): Promise<WhatsAppProvider | null> {
  if (override) return override;
  if (channel === "simulator") return new SimulatorProvider();
  const [row] = await sql<{ wa_phone_number_id: string | null; wa_access_token_enc: string | null }[]>`
    select wa_phone_number_id, wa_access_token_enc from clinic_integrations where clinic_id = ${clinicId}`;
  const token = decryptField(row?.wa_access_token_enc);
  if (row?.wa_phone_number_id && token) return new CloudApiProvider(row.wa_phone_number_id, token);
  if (env.wa.phoneNumberId && env.wa.accessToken) return new CloudApiProvider(env.wa.phoneNumberId, env.wa.accessToken);
  return null;
}

export * from "./types";
