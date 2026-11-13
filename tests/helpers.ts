import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { addDays, localDate, weekdayOf, zonedToUtc } from "@/lib/datetime";
import { createClinic } from "@/services/clinic-setup";
import type { InboundMessage } from "@/integrations/whatsapp";

export const TZ = "America/Sao_Paulo";

/** Próxima segunda-feira às 10h (horário da clínica): relógio fixo e previsível para os testes. */
export function nextMonday10(): Date {
  let day = addDays(localDate(new Date(), TZ), 1);
  while (weekdayOf(day) !== 1) day = addDays(day, 1);
  return zonedToUtc(day, "10:00", TZ);
}

export async function makeUser(email = `${randomUUID()}@teste.dev`): Promise<string> {
  const [u] = await db()<{ id: string }[]>`insert into auth.users (email, encrypted_password) values (${email}, crypt('senha-teste', gen_salt('bf', 4))) returning id`;
  return u!.id;
}

export type TestClinic = {
  clinicId: string; ownerAuthId: string; evaluationId: string; cleaningId: string; implantId: string;
  professionalIds: string[];
};

/** Clínica completa com IA ligada, catálogo publicado e protocolo de alerta aprovado. */
export async function makeClinic(opts: { chairs?: number; professionals?: number } = {}): Promise<TestClinic> {
  const sql = db();
  const ownerAuthId = await makeUser();
  const pros = Array.from({ length: opts.professionals ?? 1 }, (_, i) => ({ name: `Dr. Teste ${i + 1}`, specialty: "Clínica geral" }));
  const clinicId = await createClinic(sql, { clinicName: `Clínica ${randomUUID().slice(0, 6)}`, owner: { authUserId: ownerAuthId, email: "dono@teste.dev", name: "Dono" }, chairs: opts.chairs ?? 1, professionals: pros });
  await sql`update services set status = 'published' where clinic_id = ${clinicId}`;
  await sql`update services set price_mode = 'fixed', price_min_cents = 15000 where clinic_id = ${clinicId} and kind = 'evaluation'`;
  await sql`update clinics set ai_enabled = true, alert_message = 'Vou chamar nossa equipe agora.', alert_approved_at = now(),
              settings = '{"minLeadMinutes": 0}' where id = ${clinicId}`;
  const services = await sql<{ id: string; name: string; kind: string }[]>`select id, name, kind from services where clinic_id = ${clinicId}`;
  const professionals = await sql<{ id: string }[]>`select id from professionals where clinic_id = ${clinicId} order by created_at`;
  return {
    clinicId, ownerAuthId,
    evaluationId: services.find((s) => s.kind === "evaluation")!.id,
    cleaningId: services.find((s) => s.name.startsWith("Limpeza"))!.id,
    implantId: services.find((s) => s.name === "Implante")!.id,
    professionalIds: professionals.map((p) => p.id),
  };
}

export async function makePatient(clinicId: string, fullName: string, birth: string | null = null): Promise<string> {
  const [p] = await db()<{ id: string }[]>`insert into patients (clinic_id, full_name, birth_date) values (${clinicId}, ${fullName}, ${birth}) returning id`;
  return p!.id;
}

export function inbound(text: string, from = "+5511988887777", extra: Partial<InboundMessage> = {}): InboundMessage {
  return { waMessageId: `wamid.${randomUUID()}`, from, profileName: "Paciente Teste", timestamp: new Date(), type: "text", text, mediaId: null, mediaMime: null, rawType: "text", ...extra };
}

export async function outboundMessages(conversationId: string): Promise<{ body: string; sender_type: string }[]> {
  return db()<{ body: string; sender_type: string }[]>`
    select body, sender_type from messages where conversation_id = ${conversationId} and direction = 'outbound' order by created_at, id`;
}
