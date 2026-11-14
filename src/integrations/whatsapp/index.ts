import { randomUUID } from "node:crypto";
import type { Sql } from "@/db/client";
import { decryptField } from "@/lib/crypto";
import { env } from "@/lib/env";
import { CloudApiProvider } from "./cloud";
import { EvolutionProvider, type EvolutionConfig } from "./evolution";
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
  const [row] = await sql<{ wa_provider: string; wa_phone_number_id: string | null; wa_access_token_enc: string | null; evo_base_url: string | null; evo_instance: string | null; evo_api_key_enc: string | null }[]>`
    select wa_provider, wa_phone_number_id, wa_access_token_enc, evo_base_url, evo_instance, evo_api_key_enc from clinic_integrations where clinic_id = ${clinicId}`;
  if (row?.wa_provider === "evolution") {
    const cfg = evolutionConfig(row);
    return cfg ? new EvolutionProvider(cfg) : null;
  }
  const token = decryptField(row?.wa_access_token_enc);
  if (row?.wa_phone_number_id && token) return new CloudApiProvider(row.wa_phone_number_id, token);
  if (env.wa.phoneNumberId && env.wa.accessToken) return new CloudApiProvider(env.wa.phoneNumberId, env.wa.accessToken);
  return null;
}

export function evolutionConfig(row: { evo_base_url: string | null; evo_instance: string | null; evo_api_key_enc: string | null }): EvolutionConfig | null {
  const apiKey = decryptField(row.evo_api_key_enc);
  return row.evo_base_url && row.evo_instance && apiKey ? { baseUrl: row.evo_base_url, instance: row.evo_instance, apiKey } : null;
}

/**
 * A janela de 24 h e os templates são regras da API oficial. No canal Evolution (não oficial) não se aplicam,
 * mas opt-out, horário permitido e limite de frequência continuam valendo.
 */
export async function enforcesWindow(sql: Sql, clinicId: string): Promise<boolean> {
  const [row] = await sql<{ wa_provider: string }[]>`select wa_provider from clinic_integrations where clinic_id = ${clinicId}`;
  return row?.wa_provider !== "evolution";
}

export * from "./types";
