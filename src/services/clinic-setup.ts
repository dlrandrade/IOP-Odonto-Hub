import { inTx, type Sql } from "@/db/client";
import { SUGGESTED_ALERT_KEYWORDS } from "@/domain/alerts";
import { WEEKDAY_KEYS, type BusinessHours } from "@/lib/datetime";

export type NewClinicInput = {
  clinicName: string;
  timezone?: string;
  owner: { authUserId: string; email: string; name: string } | null;
  chairs: number;
  professionals: { name: string; specialty: string | null }[];
  businessHours?: BusinessHours;
  isDemo?: boolean;
  /** Dados informados na contratação: já configuram a conta (contato, endereço, Google, automação de avaliação). */
  profile?: ClinicProfile;
};

export type ClinicProfile = {
  phone?: string | null; email?: string | null; website?: string | null; instagram?: string | null; address?: string | null;
  googleReviewUrl?: string | null; googleBusinessUrl?: string | null;
};

/** Texto da automação de avaliação criada quando a clínica informa o Google na contratação. */
export const REVIEW_REQUEST_TEXT = "Olá, {primeiro_nome}! Obrigado por escolher a {clinica}. Se puder, conte como foi sua experiência no Google — leva menos de um minuto e ajuda muito: {link_avaliacao}";

const DEFAULT_HOURS: BusinessHours = {
  mon: [["08:00", "18:00"]], tue: [["08:00", "18:00"]], wed: [["08:00", "18:00"]], thu: [["08:00", "18:00"]],
  fri: [["08:00", "18:00"]], sat: [["08:00", "12:00"]], sun: [],
};

const COLORS = ["#0F2A3D", "#B8860B", "#2F6F8F", "#7A4E9A", "#2E7D5B", "#B5533C"];

/** Modelos de serviço para a clínica começar: rascunhos, SEM preço e SEM texto clínico. A clínica revisa e publica. */
const SERVICE_TEMPLATES = [
  { name: "Avaliação inicial", kind: "evaluation", specialty: "Clínica geral", duration: 30, bookable: true, leads: false },
  { name: "Limpeza (profilaxia)", kind: "procedure", specialty: "Clínica geral", duration: 40, bookable: true, leads: false },
  { name: "Retorno", kind: "return", specialty: "Clínica geral", duration: 20, bookable: true, leads: false },
  { name: "Clareamento", kind: "procedure", specialty: "Estética", duration: 60, bookable: false, leads: true },
  { name: "Ortodontia (aparelho)", kind: "procedure", specialty: "Ortodontia", duration: 45, bookable: false, leads: true },
  { name: "Implante", kind: "procedure", specialty: "Implantodontia", duration: 90, bookable: false, leads: true },
] as const;

const KNOWLEDGE_TEMPLATES = ["Endereço e como chegar", "Formas de pagamento", "Convênios", "Acessibilidade e estacionamento"];

const MESSAGE_TEMPLATES = [
  { name: "lembrete_consulta", body: "Olá! Lembrete: {{1}} tem {{2}} com {{3}} em {{4}}." },
  { name: "confirmacao_consulta", body: "Olá! {{1}} tem {{2}} com {{3}} em {{4}}. Responda 1 para confirmar ou 2 para remarcar." },
  { name: "retomada_contato", body: "Olá! Ficamos à disposição para continuar seu atendimento. Posso ajudar?" },
];

/**
 * Cria uma clínica pronta para uso em um passo: unidade, cadeiras, dentistas com expediente,
 * catálogo em rascunho, base de conhecimento, templates e protocolo de alerta sugerido.
 */
export async function createClinic(sql: Sql, input: NewClinicInput): Promise<string> {
  return inTx(sql, async (tx) => {
    const hours = input.businessHours ?? DEFAULT_HOURS;
    const [clinic] = await tx<{ id: string }[]>`
      insert into clinics (name, timezone, business_hours, is_demo, alert_keywords, onboarding_completed_at,
                           contact_phone, contact_email, website_url, instagram_handle, google_review_url, google_business_url)
      values (${input.clinicName}, ${input.timezone ?? "America/Sao_Paulo"}, ${tx.json(hours as never)}, ${input.isDemo ?? false},
              ${SUGGESTED_ALERT_KEYWORDS}, now(), ${input.profile?.phone ?? null}, ${input.profile?.email ?? null}, ${input.profile?.website ?? null},
              ${input.profile?.instagram ?? null}, ${input.profile?.googleReviewUrl ?? null}, ${input.profile?.googleBusinessUrl ?? null})
      returning id`;
    if (!clinic) throw new Error("Falha ao criar clínica");
    const clinicId = clinic.id;
    await tx`insert into clinic_integrations (clinic_id) values (${clinicId})`;
    const [unit] = await tx<{ id: string }[]>`insert into units (clinic_id, name, address) values (${clinicId}, 'Unidade principal', ${input.profile?.address ?? null}) returning id`;
    if (input.owner) {
      await tx`
        insert into app_users (clinic_id, auth_user_id, email, name, role)
        values (${clinicId}, ${input.owner.authUserId}, ${input.owner.email}, ${input.owner.name}, 'admin')`;
    }
    for (let i = 1; i <= Math.max(1, input.chairs); i++) {
      await tx`insert into resources (clinic_id, unit_id, name, kind) values (${clinicId}, ${unit?.id ?? null}, ${`Cadeira ${i}`}, 'chair')`;
    }
    const professionalIds: string[] = [];
    for (const [i, p] of input.professionals.entries()) {
      const [row] = await tx<{ id: string }[]>`
        insert into professionals (clinic_id, name, specialty, color) values (${clinicId}, ${p.name}, ${p.specialty}, ${COLORS[i % COLORS.length] ?? "#0F2A3D"})
        returning id`;
      if (!row) continue;
      professionalIds.push(row.id);
      for (const [weekday, key] of WEEKDAY_KEYS.entries()) {
        for (const [start, end] of hours[key] ?? []) {
          await tx`insert into availability_rules (clinic_id, professional_id, unit_id, weekday, start_time, end_time)
                   values (${clinicId}, ${row.id}, ${unit?.id ?? null}, ${weekday}, ${start}, ${end})`;
        }
      }
    }
    let evaluationId: string | null = null;
    for (const s of SERVICE_TEMPLATES) {
      const inserted: { id: string }[] = await tx<{ id: string }[]>`
        insert into services (clinic_id, name, kind, specialty, duration_min, bookable_directly, leads_to_evaluation_service_id, price_mode)
        values (${clinicId}, ${s.name}, ${s.kind}, ${s.specialty}, ${s.duration}, ${s.bookable}, ${s.leads ? evaluationId : null}, 'on_evaluation')
        returning id`;
      const row = inserted[0];
      if (!row) continue;
      if (s.kind === "evaluation") evaluationId = row.id;
      for (const pid of professionalIds) {
        await tx`insert into service_professionals (clinic_id, service_id, professional_id) values (${clinicId}, ${row.id}, ${pid})`;
      }
    }
    for (const title of KNOWLEDGE_TEMPLATES) await tx`insert into knowledge_docs (clinic_id, title) values (${clinicId}, ${title})`;
    for (const t of MESSAGE_TEMPLATES) await tx`insert into message_templates (clinic_id, name, body) values (${clinicId}, ${t.name}, ${t.body})`;
    // Google informado na contratação: a automação de pedir avaliação já nasce pronta (3 h depois da consulta concluída).
    if (input.profile?.googleReviewUrl) {
      await tx`insert into automation_rules (clinic_id, name, trigger, offset_minutes, action, channel, body, position)
               values (${clinicId}, 'Pedir avaliação no Google', 'after_appointment', 180, 'message', 'whatsapp', ${REVIEW_REQUEST_TEXT}, 1)`;
    }
    return clinicId;
  });
}
