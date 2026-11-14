import type postgres from "postgres";
import type { Ctx } from "@/auth/session";
import { can } from "@/domain/permissions";

export type SetupStep = { done: boolean; label: string; href: string };

/** Primeiros passos de uma clínica nova. Só aparecem para quem pode configurar. */
export async function setupSteps(tx: postgres.TransactionSql, ctx: Ctx): Promise<SetupStep[]> {
  if (!can(ctx.role, "settings.manage")) return [];
  const [c] = await tx<{ services: number; docs: number; rules: number; wa: boolean }[]>`
    select (select count(*)::int from services where status = 'published') as services,
           (select count(*)::int from knowledge_docs where status = 'published' and body <> '') as docs,
           (select count(*)::int from availability_rules) as rules,
           coalesce((select wa_phone_number_id is not null and wa_access_token_enc is not null from clinic_integrations limit 1), false) as wa`;
  return [
    { done: (c?.rules ?? 0) > 0, label: "Dentistas com expediente", href: "/configuracoes?aba=agenda" },
    { done: (c?.services ?? 0) > 0, label: "Publicar serviços e preços", href: "/servicos" },
    { done: (c?.docs ?? 0) > 0, label: "Publicar base de conhecimento", href: "/servicos?aba=conhecimento" },
    { done: !!c?.wa, label: "Conectar o WhatsApp", href: "/configuracoes?aba=whatsapp" },
    { done: !!ctx.clinic.alert_approved_at, label: "Aprovar protocolo de urgência", href: "/configuracoes?aba=ia" },
    { done: ctx.clinic.ai_enabled, label: "Ativar a assistente virtual", href: "/configuracoes?aba=ia" },
  ];
}
