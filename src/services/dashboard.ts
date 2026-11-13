import type { Sql } from "@/db/client";
import { addDays, isWithinBusinessHours, zonedToUtc, type BusinessHours } from "@/lib/datetime";

export type DashboardFilter = { clinicId: string; tz: string; from: string; to: string; professionalId: string | null };

export type Dashboard = {
  newContacts: number;
  conversations: number;
  appointmentsBooked: number;
  conversion: { eligible: number; converted: number; rate: number | null; partial: boolean };
  byProfessional: { professional: string; total: number; attended: number; noShow: number }[];
  byWeekday: { weekday: number; total: number }[];
  byHour: { hour: number; total: number }[];
  firstResponse: { ai: number | null; human: number | null; afterHours: number | null; samples: number };
  queue: { awaiting: number; urgent: number; humanActive: number; aiActive: number; openTasks: number };
  attendance: { attended: number; noShow: number; cancelled: number; pending: number };
  aiCostCents: number;
  updatedAt: Date;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Indicadores P0 (PRD seção 10). Tudo calculado por SQL sobre as views v_*; cada número
 * pode ser conferido com um select simples nas tabelas (memória de cálculo na tela).
 * Período em datas locais da clínica, inclusivo.
 */
export async function loadDashboard(sql: Sql, f: DashboardFilter): Promise<Dashboard> {
  const start = zonedToUtc(f.from, "00:00", f.tz);
  const end = zonedToUtc(addDays(f.to, 1), "00:00", f.tz);
  const prof = f.professionalId ? sql`and professional_id = ${f.professionalId}` : sql``;

  const [cohort] = await sql<{ eligible: number; converted: number; partial: boolean }[]>`
    select count(*)::int as eligible, count(*) filter (where converted)::int as converted, coalesce(bool_or(cohort_partial), false) as partial
    from v_contact_cohort where clinic_id = ${f.clinicId} and first_seen_at >= ${start} and first_seen_at < ${end}`;
  const responses = await sql<{ first_inbound_at: Date; first_response_by: string | null; seconds: string | null }[]>`
    select first_inbound_at, first_response_by, seconds::text from v_first_response
    where clinic_id = ${f.clinicId} and first_inbound_at >= ${start} and first_inbound_at < ${end}`;
  const [booked] = await sql<{ n: number }[]>`
    select count(*)::int as n from v_appointment_facts
    where clinic_id = ${f.clinicId} and created_at >= ${start} and created_at < ${end} and rescheduled_from_id is null ${prof}`;
  const byProfessional = await sql<{ professional: string; total: number; attended: number; no_show: number }[]>`
    select professional, count(*) filter (where status <> 'cancelled')::int as total,
           count(*) filter (where status in ('arrived','in_service','completed'))::int as attended,
           count(*) filter (where status = 'no_show')::int as no_show
    from v_appointment_facts where clinic_id = ${f.clinicId} and starts_at >= ${start} and starts_at < ${end} ${prof}
    group by professional order by professional`;
  const [att] = await sql<{ attended: number; no_show: number; cancelled: number; pending: number }[]>`
    select count(*) filter (where status in ('arrived','in_service','completed'))::int as attended,
           count(*) filter (where status = 'no_show')::int as no_show,
           count(*) filter (where status = 'cancelled')::int as cancelled,
           count(*) filter (where status in ('scheduled','confirmed') and starts_at < now())::int as pending
    from v_appointment_facts where clinic_id = ${f.clinicId} and starts_at >= ${start} and starts_at < ${end} ${prof}`;
  const movement = await sql<{ dow: number; hour: number; n: number }[]>`
    select extract(dow from m.created_at at time zone ${f.tz})::int as dow, extract(hour from m.created_at at time zone ${f.tz})::int as hour, count(*)::int as n
    from messages m join conversations c on c.id = m.conversation_id join contacts ct on ct.id = c.contact_id
    where m.clinic_id = ${f.clinicId} and m.direction = 'inbound' and not ct.is_test and not ct.excluded_from_metrics
      and m.created_at >= ${start} and m.created_at < ${end}
    group by 1, 2`;
  const [queue] = await sql<{ awaiting: number; urgent: number; human_active: number; ai_active: number }[]>`
    select count(*) filter (where state = 'awaiting_human')::int as awaiting,
           count(*) filter (where state = 'awaiting_human' and handoff_priority = 'urgente')::int as urgent,
           count(*) filter (where state = 'human_active')::int as human_active,
           count(*) filter (where state = 'ai_active')::int as ai_active
    from conversations where clinic_id = ${f.clinicId}`;
  const [tasks] = await sql<{ n: number }[]>`select count(*)::int as n from tasks where clinic_id = ${f.clinicId} and status = 'open'`;
  const [cost] = await sql<{ total: string }[]>`
    select coalesce(sum(cost_cents), 0)::text as total from ai_runs where clinic_id = ${f.clinicId} and created_at >= ${start} and created_at < ${end}`;
  const [clinic] = await sql<{ business_hours: BusinessHours }[]>`select business_hours from clinics where id = ${f.clinicId}`;

  const answered = responses.filter((r) => r.seconds != null);
  const inHours = (r: { first_inbound_at: Date }) => isWithinBusinessHours(r.first_inbound_at, f.tz, clinic?.business_hours ?? {});
  const byWeekday = Array.from({ length: 7 }, (_, weekday) => ({ weekday, total: movement.filter((m) => m.dow === weekday).reduce((a, m) => a + m.n, 0) }));
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, total: movement.filter((m) => m.hour === hour).reduce((a, m) => a + m.n, 0) }));
  const eligible = cohort?.eligible ?? 0;
  return {
    newContacts: eligible,
    conversations: responses.length,
    appointmentsBooked: booked?.n ?? 0,
    conversion: { eligible, converted: cohort?.converted ?? 0, rate: eligible ? (cohort?.converted ?? 0) / eligible : null, partial: cohort?.partial ?? false },
    byProfessional: byProfessional.map((p) => ({ professional: p.professional, total: p.total, attended: p.attended, noShow: p.no_show })),
    byWeekday, byHour,
    firstResponse: {
      ai: median(answered.filter((r) => r.first_response_by === "ai" && inHours(r)).map((r) => Number(r.seconds))),
      human: median(answered.filter((r) => r.first_response_by === "human" && inHours(r)).map((r) => Number(r.seconds))),
      afterHours: median(answered.filter((r) => !inHours(r)).map((r) => Number(r.seconds))),
      samples: answered.length,
    },
    queue: { awaiting: queue?.awaiting ?? 0, urgent: queue?.urgent ?? 0, humanActive: queue?.human_active ?? 0, aiActive: queue?.ai_active ?? 0, openTasks: tasks?.n ?? 0 },
    attendance: { attended: att?.attended ?? 0, noShow: att?.no_show ?? 0, cancelled: att?.cancelled ?? 0, pending: att?.pending ?? 0 },
    aiCostCents: Number(cost?.total ?? 0),
    updatedAt: new Date(),
  };
}
