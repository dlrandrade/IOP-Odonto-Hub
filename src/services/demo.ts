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
    await seedDemoActivity(tx, clinicId);
    return clinicId;
  });
}

/**
 * Movimento do dia para a demonstração: conversas em cada situação, consultas de hoje e tarefas.
 * Só roda se a clínica é demo e ainda não tem conversas de WhatsApp. Tudo fictício.
 */
export async function seedDemoActivity(sql: Sql, clinicId: string): Promise<boolean> {
  return inTx(sql, async (tx) => {
    const [clinic] = await tx<{ is_demo: boolean; timezone: string }[]>`select is_demo, timezone from clinics where id = ${clinicId}`;
    if (!clinic?.is_demo) return false;
    const [{ n } = { n: 0 }] = await tx<{ n: number }[]>`select count(*)::int as n from conversations where clinic_id = ${clinicId} and channel = 'whatsapp'`;
    if (n > 0) return false;
    const tz = clinic.timezone;
    const now = new Date();
    const today = localDate(now, tz);
    const people = await tx<{ contact_id: string; patient_id: string; name: string }[]>`
      select l.contact_id, p.id as patient_id, p.full_name as name from contact_patient_links l join patients p on p.id = l.patient_id
      where l.clinic_id = ${clinicId} and l.relationship = 'self' order by p.full_name limit 12`;
    const pros = await tx<{ id: string; resource_id: string }[]>`
      select p.id, r.id as resource_id from professionals p join resources r on r.professional_id = p.id where p.clinic_id = ${clinicId} and p.active order by p.created_at`;
    const services = await tx<{ id: string; kind: string; name: string; duration_min: number }[]>`select id, kind, name, duration_min from services where clinic_id = ${clinicId} and status = 'published'`;
    if (people.length < 8 || pros.length === 0 || services.length === 0) return false;
    const min = (m: number) => addMinutes(now, -m);

    // Consultas de hoje: o status acompanha o relógio (passadas concluídas, a atual em atendimento).
    const slots = ["08:00", "09:30", "11:00", "13:30", "15:00", "16:30", "17:30"];
    for (const [i, time] of slots.entries()) {
      const who = people[(i + 4) % people.length]!;
      const pro = pros[i % pros.length]!;
      const service = services[i % services.length]!;
      const startsAt = zonedToUtc(today, time, tz);
      const endsAt = addMinutes(startsAt, service.duration_min);
      const status = endsAt <= now ? (i === 1 ? "no_show" : "completed") : startsAt <= now ? "in_service" : i % 2 ? "confirmed" : "scheduled";
      await tx.savepoint(async (sp) => {
        const [a] = await sp<{ id: string }[]>`
          insert into appointments (clinic_id, patient_id, contact_id, service_id, professional_id, starts_at, ends_at, status, created_by_type, created_at, confirmed_at)
          values (${clinicId}, ${who.patient_id}, ${who.contact_id}, ${service.id}, ${pro.id}, ${startsAt}, ${endsAt}, ${status}, ${i % 2 ? "ai" : "user"}, ${min(3 * 1440)}, ${status === "confirmed" ? now : null})
          returning id`;
        await sp`insert into appointment_resources (clinic_id, appointment_id, resource_id, during, active)
                 values (${clinicId}, ${a!.id}, ${pro.resource_id}, tstzrange(${startsAt}, ${endsAt}), true)`;
      }).catch(() => undefined);
    }

    // Conversas em cada situação da fila.
    type Msg = [direction: "inbound" | "outbound" | "internal", sender: "patient" | "ai" | "human" | "system", body: string, minutesAgo: number];
    const convs: { who: number; state: string; priority?: "normal" | "urgente"; reason?: string; unread: number; msgs: Msg[] }[] = [
      { who: 0, state: "awaiting_human", priority: "urgente", reason: "Sinal de alerta relatado: dor forte e inchaço", unread: 2, msgs: [
        ["inbound", "patient", "Oi, estou com muita dor no dente desde ontem", 14],
        ["inbound", "patient", "e o rosto está ficando inchado", 13],
        ["outbound", "ai", "[DEMO] Sinto muito que esteja passando por isso. Vou chamar nossa equipe agora para falar com você.", 13],
        ["internal", "system", "Encaminhada com urgência para a equipe: sinal de alerta.", 13],
      ] },
      { who: 1, state: "awaiting_human", priority: "normal", reason: "Pergunta sobre convênio, que não está na base de conhecimento", unread: 1, msgs: [
        ["inbound", "patient", "Boa tarde! Vocês atendem pelo meu convênio?", 42],
        ["outbound", "ai", "Boa tarde! Sou a Sol, assistente virtual da clínica. Sobre convênios, vou confirmar com a equipe e já te retornamos, tudo bem?", 41],
        ["internal", "system", "Encaminhada para a equipe: assunto fora da base de conhecimento.", 41],
      ] },
      { who: 2, state: "human_active", unread: 0, msgs: [
        ["inbound", "patient", "Preciso remarcar minha consulta de quinta", 95],
        ["outbound", "human", "Claro! Tenho sexta às 10h30 ou segunda às 14h. Qual fica melhor?", 80],
        ["inbound", "patient", "Sexta às 10h30, por favor", 22],
      ] },
      { who: 3, state: "ai_active", unread: 0, msgs: [
        ["inbound", "patient", "Oi! Quero marcar uma avaliação", 180],
        ["outbound", "ai", "Olá! Sou a Sol, assistente virtual da clínica. Posso ver os horários livres para avaliação. Prefere manhã ou tarde?", 179],
        ["inbound", "patient", "De manhã", 170],
        ["outbound", "ai", "Tenho amanhã às 9h ou às 10h30. Qual prefere?", 169],
      ] },
      { who: 5, state: "ai_active", unread: 0, msgs: [
        ["inbound", "patient", "Quanto custa a limpeza?", 260],
        ["outbound", "ai", "A limpeza (profilaxia) custa R$ 250,00 (valor de demonstração). Quer que eu veja um horário?", 259],
      ] },
      { who: 6, state: "closed", unread: 0, msgs: [
        ["inbound", "patient", "Confirmo minha consulta de amanhã", 1500],
        ["outbound", "ai", "Consulta confirmada! Até amanhã.", 1499],
      ] },
    ];
    const convIds: string[] = [];
    for (const c of convs) {
      const who = people[c.who]!;
      const last = c.msgs[c.msgs.length - 1]!;
      const lastVisible = [...c.msgs].reverse().find((m) => m[0] !== "internal")!;
      const firstIn = c.msgs.find((m) => m[0] === "inbound")!;
      const firstOut = c.msgs.find((m) => m[0] === "outbound");
      const lastIn = [...c.msgs].reverse().find((m) => m[0] === "inbound")!;
      const [conv] = await tx<{ id: string }[]>`
        insert into conversations (clinic_id, contact_id, channel, state, last_inbound_at, window_expires_at, last_message_at, last_message_preview, last_message_direction,
                                   first_inbound_at, first_response_at, first_response_by, unread_count, handoff_reason, handoff_priority, closed_at, created_at)
        values (${clinicId}, ${who.contact_id}, 'whatsapp', ${c.state}, ${min(lastIn[3])}, ${addMinutes(min(lastIn[3]), 1440)}, ${min(last[3])}, ${lastVisible[2].slice(0, 120)}, ${lastVisible[0]},
                ${min(firstIn[3])}, ${firstOut ? min(firstOut[3]) : null}, ${firstOut ? (firstOut[1] === "ai" ? "ai" : "human") : null}, ${c.unread},
                ${c.reason ?? null}, ${c.priority ?? null}, ${c.state === "closed" ? min(last[3]) : null}, ${min(firstIn[3])})
        returning id`;
      convIds.push(conv!.id);
      for (const [direction, sender, body, ago] of c.msgs) {
        await tx`insert into messages (clinic_id, conversation_id, direction, sender_type, type, body, delivery_status, created_at)
                 values (${clinicId}, ${conv!.id}, ${direction}, ${sender}, ${direction === "internal" ? "note" : "text"}, ${body},
                         ${direction === "inbound" ? "received" : direction === "outbound" ? "read" : "received"}, ${min(ago)})`;
      }
    }

    // Tarefas que a automação deixou para a equipe.
    await tx`insert into tasks (clinic_id, title, detail, kind, conversation_id, contact_id, created_at) values
      (${clinicId}, 'Retornar sobre convênio', ${`${people[1]!.name}: a assistente não tem essa informação.`}, 'handoff', ${convIds[1]!}, ${people[1]!.contact_id}, ${min(41)}),
      (${clinicId}, 'Ligar para confirmar presença', ${`${people[7]!.name}: lembrete fora da janela de 24 h sem template aprovado.`}, 'automation', null, ${people[7]!.contact_id}, ${min(120)}),
      (${clinicId}, 'Registrar falta da manhã', 'Consulta das 9h30 passou sem registro de presença.', 'manual', null, null, ${min(60)})`;
    return true;
  });
}
