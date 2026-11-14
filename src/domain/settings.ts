import { z } from "zod";

/** Regras configuráveis por clínica (clinics.settings). Defaults do PRD (RF-07, seção 6). */
export const settingsSchema = z.object({
  debounceSeconds: z.coerce.number().int().min(0).max(60).default(6),
  followup1Hours: z.coerce.number().min(0.01).max(23).default(3),
  followup2Hours: z.coerce.number().min(0.02).max(23.5).default(20),
  /** Follow-up 1 (o 2 tem chave própria). */
  followupsEnabled: z.coerce.boolean().default(true),
  followup2Enabled: z.coerce.boolean().default(true),
  /** Lembrete (reminderHours[0]); a confirmação (reminderHours[1]) tem chave própria. */
  remindersEnabled: z.coerce.boolean().default(true),
  confirmationEnabled: z.coerce.boolean().default(true),
  /** Ordem dos cartões no construtor de automações (chaves nativas e ids das regras da clínica). */
  automationOrder: z.array(z.string()).default([]),
  reminderHours: z.array(z.number()).default([48, 24]),
  quietStartHour: z.coerce.number().int().min(0).max(23).default(8),
  quietEndHour: z.coerce.number().int().min(1).max(24).default(20),
  minLeadMinutes: z.coerce.number().int().min(0).default(120),
  maxAdvanceDays: z.coerce.number().int().min(1).max(365).default(60),
  maxAutomatedPerDay: z.coerce.number().int().min(1).max(10).default(3),
  aiMonthlyBudgetCents: z.coerce.number().int().min(0).nullable().default(null),
  followup1Text: z.string().default("Oi! Ficou alguma dúvida? Se quiser, posso ver um horário para você."),
  followup2Text: z.string().default("Passando para saber se ainda posso ajudar com o agendamento. Se preferir, é só responder quando puder."),
});

export type ClinicSettings = z.infer<typeof settingsSchema>;

export function parseSettings(raw: unknown): ClinicSettings {
  const parsed = settingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : settingsSchema.parse({});
}
