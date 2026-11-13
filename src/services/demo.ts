import { inTx, type Sql } from "@/db/client";
import { addDays, addMinutes, localDate, weekdayOf, zonedToUtc } from "@/lib/datetime";
import { createClinic } from "./clinic-setup";

/**
 * Seed de demonstração (PRD seção 15). TODOS os dados são FICTÍCIOS: nomes, telefones, preços e textos.
 * A clínica e os serviços ficam marcados como demo (is_demo) e a interface exibe o aviso.
 */
const FIRST = ["Ana", "Bruno", "Carla", "Diego", "Elisa", "Fábio", "Gabriela", "Heitor", "Isabela", "João", "Karina", "Lucas", "Marina", "Nelson", "Olívia", "Paulo", "Renata", "Sérgio"];
const LAST = ["Almeida", "Barros", "Cardoso", "Duarte", "Esteves", "Farias", "Gomes", "Henriques", "Lima", "Moura", "Nogueira", "Prado", "Queiroz", "Ramos", "Sales", "Teixeira", "Uchoa", "Vieira"];

export async function seedDemoClinic(sql: Sql, owner: { authUserId: string; email: string; name: string } | null, name = "Clínica Sorriso Demo"): Promise<string> {
  return inTx(sql, async (tx) => {
    const clinicId = await createClinic(tx, {
      clinicName: name, owner, chairs: 3, isDemo: true,
      professionals: [
        { name: "Dra. Helena Demo", specialty: "Clínica geral" },
        { name: "Dr. Rafael Demo", specialty: "Ortodontia" },
        { name: "Dra. Lívia Demo", specialty: "Implantodontia" },
      ],
    });
    const tz = "America/Sao_Paulo";
    // Preços fictícios, só para demonstração.
    await tx`update services set status = 'published', is_demo = true, approved_at = now(),
               patient_description = '[DEMO] Texto fictício de demonstração. Substitua pela descrição aprovada pela clínica.'
             where clinic_id = ${clinicId}`;
    await tx`update services set price_mode = 'fixed', price_min_cents = 12000 where clinic_id = ${clinicId} and kind = 'evaluation'`;
    await tx`update services set price_mode = 'fixed', price_min_cents = 25000 where clinic_id = ${clinicId} and name like 'Limpeza%'`;
    await tx`update services set price_mode = 'range', price_min_cents = 60000, price_max_cents = 140000 where clinic_id = ${clinicId} and name = 'Clareamento'`;
    await tx`update services set price_mode = 'fixed', price_min_cents = 0 where clinic_id = ${clinicId} and kind = 'return'`;
    await tx`update knowledge_docs set status = 'published', approved_at = now(),
               body = '[DEMO] Conteúdo fictício de demonstração para "' || title || '". Substitua pelo texto real da clínica.'
             where clinic_id = ${clinicId}`;
    await tx`update clinics set assistant_name = 'Sol', alert_message = '[DEMO] Sinto muito que esteja passando por isso. Vou chamar nossa equipe agora para falar com você.',
               alert_approved_at = now(), ai_enabled = true where id = ${clinicId}`;

    const services = await tx<{ id: string; kind: string; name: string; duration_min: number }[]>`select id, kind, name, duration_min from services where clinic_id = ${clinicId}`;
    const pros = await tx<{ id: string; resource_id: string }[]>`
      select p.id, r.id as resource_id from professionals p join resources r on r.professional_id = p.id where p.clinic_id = ${clinicId} order by p.created_at`;
    const chairs = await tx<{ id: string }[]>`select id from resources where clinic_id = ${clinicId} and kind = 'chair' order by name`;
    const evaluation = services.find((s) => s.kind === "evaluation");
    const cleaning = services.find((s) => s.name.startsWith("Limpeza"));
    const implant = services.find((s) => s.name === "Implante");
    if (!evaluation || !cleaning) throw new Error("Catálogo demo incompleto");

    const now = new Date();
    const today = localDate(now, tz);
    const patients: { patientId: string; contactId: string }[] = [];
    const mkContact = async (i: number, daysAgo: number) => {
      const [c] = await tx<{ id: string }[]>`
        insert into contacts (clinic_id, phone_e164, wa_profile_name, source, created_at)
        values (${clinicId}, ${`+55119900000${String(i).padStart(2, "0")}`}, ${`${FIRST[i % FIRST.length]} (demo)`}, 'whatsapp', ${addMinutes(now, -daysAgo * 1440)})
        returning id`;
      return c!.id;
    };
    const mkPatient = async (fullName: string, contactId: string, relationship: string, guardian: boolean, birth: string) => {
      const [p] = await tx<{ id: string }[]>`insert into patients (clinic_id, full_name, birth_date) values (${clinicId}, ${fullName}, ${birth}) returning id`;
      await tx`insert into contact_patient_links (clinic_id, contact_id, patient_id, relationship, is_guardian, is_payer)
               values (${clinicId}, ${contactId}, ${p!.id}, ${relationship}, ${guardian}, ${relationship === "self" || guardian})`;
      patients.push({ patientId: p!.id, contactId });
      return p!.id;
    };
    // 16 contatos simples, 1 responsável com 2 filhos, 1 telefone compartilhado por dois adultos = 20 pacientes.
    for (let i = 0; i < 15; i++) {
      const contactId = await mkContact(i, 2 + i * 3);
      await mkPatient(`${FIRST[i]} ${LAST[i]} Demo`, contactId, "self", false, `19${70 + i}-0${(i % 9) + 1}-1${i % 9}`);
    }
    const guardian = await mkContact(15, 20);
    await mkPatient("Paulo Prado Demo", guardian, "self", false, "1985-03-12");
    await mkPatient("Theo Prado Demo", guardian, "filho", true, "2015-06-01");
    await mkPatient("Luna Prado Demo", guardian, "filho", true, "2017-09-21");
    const shared = await mkContact(16, 12);
    await mkPatient("Renata Sales Demo", shared, "self", false, "1979-11-05");
    await mkPatient("Sérgio Sales Demo", shared, "conjuge", false, "1976-02-17");

    // Consultas passadas e futuras para popular agenda e dashboard.
    let n = 0;
    const book = async (day: string, time: string, status: string) => {
      const wd = weekdayOf(day);
      if (wd === 0 || (wd === 6 && time >= "12:00")) return;
      const who = patients[n % patients.length]!;
      const pro = pros[n % pros.length]!;
      const chair = chairs[n % chairs.length]!;
      const service = n % 3 === 0 ? cleaning : evaluation;
      n++;
      const startsAt = zonedToUtc(day, time, tz);
      const endsAt = addMinutes(startsAt, service.duration_min);
      await tx.savepoint(async (sp) => {
        const [a] = await sp<{ id: string }[]>`
          insert into appointments (clinic_id, patient_id, contact_id, service_id, professional_id, starts_at, ends_at, status, created_by_type, created_at, confirmed_at)
          values (${clinicId}, ${who.patientId}, ${who.contactId}, ${service.id}, ${pro.id}, ${startsAt}, ${endsAt}, ${status}, ${n % 2 ? "ai" : "user"},
                  ${addMinutes(startsAt, -3 * 1440)}, ${status === "confirmed" ? now : null})
          returning id`;
        for (const rid of [pro.resource_id, chair.id]) {
          await sp`insert into appointment_resources (clinic_id, appointment_id, resource_id, during, active)
                   values (${clinicId}, ${a!.id}, ${rid}, tstzrange(${startsAt}, ${endsAt}), ${status !== "cancelled"})`;
        }
      }).catch(() => undefined);
    };
    const times = ["09:00", "10:30", "14:00", "15:30"];
    for (let d = -21; d < 0; d++) {
      const status = d % 7 === -3 ? "no_show" : d % 5 === -2 ? "cancelled" : "completed";
      await book(addDays(today, d), times[Math.abs(d) % times.length]!, status);
      if (d % 2 === 0) await book(addDays(today, d), times[(Math.abs(d) + 2) % times.length]!, "completed");
    }
    for (let d = 0; d <= 10; d++) {
      await book(addDays(today, d), times[d % times.length]!, d % 2 ? "confirmed" : "scheduled");
      if (d % 3 === 0) await book(addDays(today, d), times[(d + 2) % times.length]!, "scheduled");
    }

    // Algumas oportunidades no funil.
    const stages = ["new", "in_conversation", "in_conversation", "evaluation_scheduled", "evaluation_done", "proposal_presented", "following_up"];
    for (const [i, stage] of stages.entries()) {
      const who = patients[i]!;
      const svc = i % 2 ? implant ?? evaluation : evaluation;
      const [o] = await tx<{ id: string }[]>`
        insert into opportunities (clinic_id, contact_id, patient_id, service_id, service_interest, intent, stage, source, next_step)
        values (${clinicId}, ${who.contactId}, ${who.patientId}, ${svc.id}, ${svc.name}, 'considerando', ${stage}, 'whatsapp', 'Retornar contato')
        returning id`;
      await tx`insert into opportunity_events (clinic_id, opportunity_id, from_stage, to_stage, actor) values (${clinicId}, ${o!.id}, null, ${stage}, 'system')`;
    }
    return clinicId;
  });
}
