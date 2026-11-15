import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asUser, db } from "@/db/client";
import { addDays, addMinutes, localDate, zonedToUtc } from "@/lib/datetime";
import { hmacHex, encryptField } from "@/lib/crypto";
import { bookAppointment, cancelAppointment, findSlots, rescheduleAppointment, setAppointmentStatus } from "@/services/booking";
import { handBack, ingestInbound, sendOutbound, takeOver } from "@/services/conversations";
import { moveOpportunity, registerInterest, syncOpportunityOnBooking } from "@/services/crm";
import { runDueJobs } from "@/services/jobs";
import { renderRuleText, sweepBirthdays } from "@/services/automation-rules";
import { createClinic, REVIEW_REQUEST_TEXT } from "@/services/clinic-setup";
import { loadReviewHistory, sweepGoogleReviews } from "@/services/google-reviews";
import { syncCalendarImport } from "@/services/calendar-sync";
import { setResolverForTests } from "@/lib/safe-url";
import { encryptField as enc } from "@/lib/crypto";
import { buildSystemPrompt } from "@/agent/prompt";
import { handleWhatsAppWebhook } from "@/services/webhook";
import { loadDashboard } from "@/services/dashboard";
import { ScriptedProvider, setLlmOverride, type LlmBlock, type LlmRequest } from "@/integrations/llm";
import { ProviderError, setProviderOverride, SimulatorProvider } from "@/integrations/whatsapp";
import { setTranscriptionOverride } from "@/integrations/transcription";
import { runTool, type ToolCtx } from "@/agent/tools";
import { inbound, makeClinic, makePatient, makeUser, nextMonday10, outboundMessages, TZ, type TestClinic } from "./helpers";

const sql = db();
const NOW = nextMonday10();
const DAY = localDate(NOW, TZ);
const at = (time: string, plusDays = 0) => zonedToUtc(addDays(DAY, plusDays), time, TZ);
const tool = (name: string, input: unknown, id = `tu_${Math.random().toString(36).slice(2)}`): LlmBlock => ({ type: "tool_use", id, name, input });
const say = (text: string): LlmBlock[] => [{ type: "text", text }];
const lastToolResult = (req: LlmRequest): Record<string, unknown> => {
  const last = req.messages[req.messages.length - 1];
  const block = Array.isArray(last?.content) ? last.content.find((b) => b.type === "tool_result") : undefined;
  return block && "content" in block && typeof block.content === "string" ? JSON.parse(block.content) as Record<string, unknown> : {};
};

async function conversationOf(clinicId: string, phone: string) {
  const [c] = await sql<{ id: string; state: string; contact_id: string; handoff_priority: string | null; row_version: number }[]>`
    select c.id, c.state, c.contact_id, c.handoff_priority, c.row_version from conversations c join contacts ct on ct.id = c.contact_id
    where c.clinic_id = ${clinicId} and ct.phone_e164 = ${phone} order by c.created_at desc limit 1`;
  return c!;
}
const runJobs = (clinicId: string, minutesAhead = 1) => runDueJobs({ now: addMinutes(NOW, minutesAhead), clinicId });

beforeEach(() => { setProviderOverride(new SimulatorProvider()); setLlmOverride(null); setTranscriptionOverride(null); });
afterAll(async () => { await sql.end(); });

describe("S0 — isolamento e permissões (RLS)", () => {
  it("usuário de outra clínica não lê nem altera dados", async () => {
    const a = await makeClinic();
    const b = await makeClinic();
    await makePatient(a.clinicId, "Paciente da Clínica A");
    const seenByB = await asUser(b.ownerAuthId, (tx) => tx`select id from patients`);
    expect(seenByB).toHaveLength(0);
    const seenByA = await asUser(a.ownerAuthId, (tx) => tx`select id from patients`);
    expect(seenByA).toHaveLength(1);
    const clinics = await asUser(b.ownerAuthId, (tx) => tx<{ id: string }[]>`select id from clinics`);
    expect(clinics.map((c) => c.id)).toEqual([b.clinicId]);
    await expect(asUser(b.ownerAuthId, (tx) => tx`insert into patients (clinic_id, full_name) values (${a.clinicId}, 'Invasor')`)).rejects.toThrow(/row-level security/);
    const updated = await asUser(b.ownerAuthId, (tx) => tx`update services set name = 'x' where clinic_id = ${a.clinicId} returning id`);
    expect(updated).toHaveLength(0);
    const views = await asUser(b.ownerAuthId, (tx) => tx`select * from v_contact_cohort where clinic_id = ${a.clinicId}`);
    expect(views).toHaveLength(0);
  });

  it("papel restringe escrita; usuário desativado e anônimo não veem nada", async () => {
    const c = await makeClinic();
    const reception = await makeUser();
    await sql`insert into app_users (clinic_id, auth_user_id, email, name, role) values (${c.clinicId}, ${reception}, 'r@t.dev', 'Recepção', 'recepcao')`;
    await expect(asUser(reception, (tx) => tx`update services set price_min_cents = 1 where id = ${c.evaluationId}`)).resolves.toHaveLength(0);
    await expect(asUser(reception, (tx) => tx`insert into app_users (clinic_id, auth_user_id, email, name, role) values (${c.clinicId}, gen_random_uuid(), 'x@t.dev', 'X', 'admin')`)).rejects.toThrow(/row-level security/);
    expect(await asUser(reception, (tx) => tx`select 1 from audit_events`)).toHaveLength(0);
    expect(await asUser(reception, (tx) => tx`select 1 from clinic_integrations`)).toHaveLength(0);
    expect(await asUser(reception, (tx) => tx`insert into patients (clinic_id, full_name) values (${c.clinicId}, 'Novo') returning id`)).toHaveLength(1);

    const finance = await makeUser();
    await sql`insert into app_users (clinic_id, auth_user_id, email, name, role) values (${c.clinicId}, ${finance}, 'f@t.dev', 'Fin', 'financeiro')`;
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("oi"), NOW);
    expect(await asUser(finance, (tx) => tx`select 1 from messages`)).toHaveLength(0);
    expect((await asUser(reception, (tx) => tx`select 1 from messages`)).length).toBeGreaterThan(0);

    await sql`update app_users set active = false where auth_user_id = ${reception}`;
    expect(await asUser(reception, (tx) => tx`select 1 from patients`)).toHaveLength(0);
    expect(await asUser("00000000-0000-0000-0000-000000000000", (tx) => tx`select 1 from patients`)).toHaveLength(0);
  });
});

describe("Perfil do próprio usuário", () => {
  it("cada pessoa altera só o próprio nome e foto; papel e colegas ficam intactos", async () => {
    const c = await makeClinic();
    const a = await makeUser();
    const b = await makeUser();
    await sql`insert into app_users (clinic_id, auth_user_id, email, name, role) values (${c.clinicId}, ${a}, 'a@t.dev', 'Ana', 'recepcao'), (${c.clinicId}, ${b}, 'b@t.dev', 'Beto', 'recepcao')`;
    // Pela RLS, recepção não escreve em app_users diretamente...
    expect(await asUser(a, (tx) => tx`update app_users set name = 'Hack' where auth_user_id = ${b} returning id`)).toHaveLength(0);
    // ...mas a função de perfil altera o próprio cadastro.
    await asUser(a, (tx) => tx`select app.update_my_profile('Ana Paula', 'data:image/jpeg;base64,AAAA', false)`);
    const rows = await sql<{ name: string; role: string; avatar_data: string | null }[]>`select name, role, avatar_data from app_users where clinic_id = ${c.clinicId} and auth_user_id in (${a}, ${b}) order by email`;
    expect(rows).toEqual([{ name: "Ana Paula", role: "recepcao", avatar_data: "data:image/jpeg;base64,AAAA" }, { name: "Beto", role: "recepcao", avatar_data: null }]);
    await asUser(a, (tx) => tx`select app.update_my_profile('Ana Paula', null, true)`);
    expect((await sql<{ avatar_data: string | null }[]>`select avatar_data from app_users where auth_user_id = ${a}`)[0]?.avatar_data).toBe("data:image/jpeg;base64,AAAA");
    await expect(asUser(a, (tx) => tx`select app.update_my_profile(' ', null, true)`)).rejects.toThrow(/nome inválido/);
  });
});

describe("S2 — agenda", () => {
  it("duas reservas simultâneas do mesmo horário: uma vence, a outra recebe conflito (constraint EXCLUDE)", async () => {
    const c = await makeClinic();
    const p1 = await makePatient(c.clinicId, "Paciente Um");
    const p2 = await makePatient(c.clinicId, "Paciente Dois");
    const input = { clinicId: c.clinicId, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("14:00"), createdByType: "user" as const, now: NOW };
    const results = await Promise.all([bookAppointment(sql, { ...input, patientId: p1 }), bookAppointment(sql, { ...input, patientId: p2 })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser && !loser.ok && ["conflict", "unavailable"].includes(loser.reason)).toBe(true);
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from appointments where clinic_id = ${c.clinicId}`;
    expect(count?.n).toBe(1);
    // Quem perdeu ainda encontra alternativas, e o horário ocupado não é mais oferecido.
    const { slots } = await findSlots(sql, { clinicId: c.clinicId, serviceId: c.evaluationId, fromDate: DAY, toDate: DAY, now: NOW });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.some((s) => s.startsAt.getTime() === at("14:00").getTime())).toBe(false);
  });

  it("corrida com 10 tentativas e duas cadeiras nunca gera sobreposição de recurso", async () => {
    const c = await makeClinic({ chairs: 2, professionals: 2 });
    const patients = await Promise.all(Array.from({ length: 10 }, (_, i) => makePatient(c.clinicId, `P ${i}`)));
    const results = await Promise.all(patients.map((patientId, i) => bookAppointment(sql, {
      clinicId: c.clinicId, patientId, serviceId: c.evaluationId, professionalId: c.professionalIds[i % 2]!, startsAt: at("16:30"), createdByType: "user", now: NOW,
    })));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    const overlaps = await sql`
      select 1 from appointment_resources a join appointment_resources b on a.resource_id = b.resource_id and a.id < b.id and a.during && b.during
      where a.clinic_id = ${c.clinicId} and a.active and b.active`;
    expect(overlaps).toHaveLength(0);
  });

  it("cancelar libera a vaga e remove lembretes pendentes", async () => {
    const c = await makeClinic();
    const patientId = await makePatient(c.clinicId, "Paciente");
    const booked = await bookAppointment(sql, { clinicId: c.clinicId, patientId, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("10:00", 7), createdByType: "user", now: NOW });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;
    const pending = () => sql`select 1 from scheduled_jobs where appointment_id = ${booked.appointmentId} and status = 'pending'`;
    expect(await pending()).toHaveLength(2); // 48 h e 24 h
    await cancelAppointment(sql, c.clinicId, booked.appointmentId, "Paciente pediu");
    expect(await pending()).toHaveLength(0);
    const again = await bookAppointment(sql, { clinicId: c.clinicId, patientId, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("10:00", 7), createdByType: "user", now: NOW });
    expect(again.ok).toBe(true);
  });

  it("não agenda lembrete retroativo quando a consulta é marcada em cima da hora", async () => {
    const c = await makeClinic();
    const patientId = await makePatient(c.clinicId, "Paciente");
    const booked = await bookAppointment(sql, { clinicId: c.clinicId, patientId, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("16:00"), createdByType: "user", now: NOW });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;
    expect(await sql`select 1 from scheduled_jobs where appointment_id = ${booked.appointmentId}`).toHaveLength(0);
  });

  it("reagendar é atômico: a vaga antiga só é liberada se a nova for gravada", async () => {
    const c = await makeClinic();
    const p1 = await makePatient(c.clinicId, "Um");
    const p2 = await makePatient(c.clinicId, "Dois");
    const base = { clinicId: c.clinicId, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, createdByType: "user" as const, now: NOW };
    const a = await bookAppointment(sql, { ...base, patientId: p1, startsAt: at("11:00") });
    const b = await bookAppointment(sql, { ...base, patientId: p2, startsAt: at("15:00") });
    if (!a.ok || !b.ok) throw new Error("setup");
    const fail = await rescheduleAppointment(sql, { ...base, appointmentId: a.appointmentId, startsAt: at("15:00") });
    expect(fail.ok).toBe(false);
    const [still] = await sql<{ status: string }[]>`select status from appointments where id = ${a.appointmentId}`;
    expect(still?.status).toBe("scheduled");
    expect(await sql`select 1 from appointment_resources where appointment_id = ${a.appointmentId} and active`).not.toHaveLength(0);
    const ok = await rescheduleAppointment(sql, { ...base, appointmentId: a.appointmentId, startsAt: at("11:30") });
    expect(ok.ok).toBe(true);
    const [old] = await sql<{ status: string }[]>`select status from appointments where id = ${a.appointmentId}`;
    expect(old?.status).toBe("cancelled");
    if (ok.ok) {
      const [fresh] = await sql<{ rescheduled_from_id: string }[]>`select rescheduled_from_id from appointments where id = ${ok.appointmentId}`;
      expect(fresh?.rescheduled_from_id).toBe(a.appointmentId);
    }
  });

  it("recepção agenda, cancela e assume conversa com a própria sessão (RLS), sem conexão de sistema", async () => {
    const c = await makeClinic();
    const reception = await makeUser();
    await sql`insert into app_users (clinic_id, auth_user_id, email, name, role) values (${c.clinicId}, ${reception}, 'rec@t.dev', 'Recepção', 'recepcao')`;
    const patientId = await makePatient(c.clinicId, "Paciente");
    const booked = await asUser(reception, (tx) => bookAppointment(tx, { clinicId: c.clinicId, patientId, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("10:00", 7), createdByType: "user", now: NOW }));
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;
    expect(await sql`select 1 from scheduled_jobs where appointment_id = ${booked.appointmentId} and status = 'pending'`).toHaveLength(2);
    const moved = await asUser(reception, (tx) => rescheduleAppointment(tx, { clinicId: c.clinicId, appointmentId: booked.appointmentId, professionalId: c.professionalIds[0]!, startsAt: at("11:00", 7), createdByType: "user", now: NOW }));
    expect(moved.ok).toBe(true);
    if (moved.ok) expect((await asUser(reception, (tx) => cancelAppointment(tx, c.clinicId, moved.appointmentId, "teste"))).ok).toBe(true);
    expect(await sql`select 1 from scheduled_jobs where clinic_id = ${c.clinicId} and status = 'pending'`).toHaveLength(0);
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("oi", "+5511900001234"), NOW);
    const conv = await conversationOf(c.clinicId, "+5511900001234");
    await asUser(reception, async (tx) => {
      await takeOver(tx, c.clinicId, conv.id, { id: null, name: "Recepção" });
      const sent = await sendOutbound(tx, { clinicId: c.clinicId, conversationId: conv.id, senderType: "human", body: "Olá!", now: NOW });
      expect(sent.status).toBe("sent");
      await handBack(tx, c.clinicId, conv.id, { id: null, name: "Recepção" }, null);
    });
    // Dentista não altera a agenda nem pela API do banco.
    const dentist = await makeUser();
    await sql`insert into app_users (clinic_id, auth_user_id, email, name, role) values (${c.clinicId}, ${dentist}, 'den@t.dev', 'Dentista', 'dentista')`;
    await expect(asUser(dentist, (tx) => bookAppointment(tx, { clinicId: c.clinicId, patientId, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("14:00", 7), createdByType: "user", now: NOW }))).rejects.toThrow(/row-level security/);
  });

  it("status de presença só por registro humano", async () => {
    const c = await makeClinic();
    const patientId = await makePatient(c.clinicId, "Paciente");
    const booked = await bookAppointment(sql, { clinicId: c.clinicId, patientId, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("13:00"), createdByType: "user", now: NOW });
    if (!booked.ok) throw new Error("setup");
    expect((await setAppointmentStatus(sql, c.clinicId, booked.appointmentId, "arrived", "ai")).ok).toBe(false);
    expect((await setAppointmentStatus(sql, c.clinicId, booked.appointmentId, "arrived", "user")).ok).toBe(true);
  });
});

describe("S4 — webhook e inbox", () => {
  async function connect(c: TestClinic, phoneId: string) {
    await sql`update clinic_integrations set wa_phone_number_id = ${phoneId}, wa_app_secret_enc = ${encryptField("app-secret")}, wa_access_token_enc = ${encryptField("token")} where clinic_id = ${c.clinicId}`;
  }
  const payload = (phoneId: string, id: string, text: string) => JSON.stringify({ entry: [{ changes: [{ value: {
    metadata: { phone_number_id: phoneId }, contacts: [{ wa_id: "5511977776666", profile: { name: "Bia" } }],
    messages: [{ id, from: "5511977776666", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
  } }] }] });

  it("o mesmo webhook entregue 3 vezes gera 1 mensagem e 1 resposta", async () => {
    const c = await makeClinic();
    await connect(c, `PN-${c.clinicId}`);
    setLlmOverride(new ScriptedProvider([say("Olá! Sou a assistente virtual da clínica. Como posso ajudar?")]));
    const body = payload(`PN-${c.clinicId}`, "wamid.same", "Oi, boa tarde");
    const sig = `sha256=${hmacHex("app-secret", body)}`;
    const results = [await handleWhatsAppWebhook(body, sig), await handleWhatsAppWebhook(body, sig), await handleWhatsAppWebhook(body, sig)];
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.map((r) => r.accepted)).toEqual([1, 0, 0]);
    await runDueJobs({ now: addMinutes(new Date(), 1), clinicId: c.clinicId });
    await runDueJobs({ now: addMinutes(new Date(), 2), clinicId: c.clinicId });
    const conv = await conversationOf(c.clinicId, "+5511977776666");
    const msgs = await sql<{ direction: string }[]>`select direction from messages where conversation_id = ${conv.id} and direction <> 'internal'`;
    expect(msgs.filter((m) => m.direction === "inbound")).toHaveLength(1);
    expect(msgs.filter((m) => m.direction === "outbound")).toHaveLength(1);
  });

  it("assinatura inválida é rejeitada e nada é gravado", async () => {
    const c = await makeClinic();
    await connect(c, `PN-${c.clinicId}`);
    const body = payload(`PN-${c.clinicId}`, "wamid.forged", "oi");
    expect((await handleWhatsAppWebhook(body, "sha256=deadbeef")).status).toBe(401);
    expect(await sql`select 1 from messages where clinic_id = ${c.clinicId}`).toHaveLength(0);
  });

  it("mídia não suportada gera aviso com caminho alternativo", async () => {
    const c = await makeClinic();
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("", "+5511966665555", { type: "unsupported", text: null, rawType: "sticker" }), NOW);
    const conv = await conversationOf(c.clinicId, "+5511966665555");
    const out = await outboundMessages(conv.id);
    expect(out[0]?.body).toContain("texto, áudio ou foto");
  });

  it("fora da janela de 24 h mensagem livre não sai", async () => {
    const c = await makeClinic();
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("oi", "+5511955554444"), addMinutes(NOW, -25 * 60));
    const conv = await conversationOf(c.clinicId, "+5511955554444");
    const r = await sendOutbound(sql, { clinicId: c.clinicId, conversationId: conv.id, senderType: "human", body: "Olá!", now: NOW });
    expect(r).toEqual({ status: "blocked", reason: "window_closed" });
  });

  it("queda do provedor: fila preserva a saída e não duplica ao voltar", async () => {
    const c = await makeClinic();
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("oi", "+5511944443333"), NOW);
    const conv = await conversationOf(c.clinicId, "+5511944443333");
    let calls = 0;
    setProviderOverride({ name: "flaky", downloadMedia: async () => { throw new ProviderError("x", false); }, sendTemplate: async () => ({ waMessageId: "t" }),
      sendText: async () => { calls++; if (calls === 1) throw new ProviderError("indisponível", true); return { waMessageId: `ok-${calls}` }; } });
    const r = await sendOutbound(sql, { clinicId: c.clinicId, conversationId: conv.id, senderType: "human", body: "Já retorno", now: NOW });
    expect(r.status).toBe("queued");
    await runDueJobs({ now: addMinutes(new Date(), 10), clinicId: c.clinicId });
    await runDueJobs({ now: addMinutes(new Date(), 20), clinicId: c.clinicId });
    const out = await sql<{ delivery_status: string; wa_message_id: string }[]>`select delivery_status, wa_message_id from messages where conversation_id = ${conv.id} and direction = 'outbound'`;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ delivery_status: "sent", wa_message_id: "ok-2" });
    expect(calls).toBe(2);
  });
});

describe("S5 — agente (suíte roteirizada: entrada → tools → saída permitida)", () => {
  it("jornada: preço cadastrado → horários → confirmação → reserva persistida → CRM avança", async () => {
    const c = await makeClinic();
    const phone = "+5511911110001";
    const provider = new ScriptedProvider([
      [tool("buscar_servicos", { consulta: "avaliação" })],
      (req) => { expect(JSON.stringify(lastToolResult(req))).toContain("R$"); return [tool("registrar_interesse", { service_id: c.evaluationId, texto: "Avaliação inicial", intencao: "quer_agendar" })]; },
      [tool("consultar_disponibilidade", { service_id: c.evaluationId, periodo: { de: DAY, ate: addDays(DAY, 3) } })],
      (req) => { const r = lastToolResult(req) as { opcoes: { data_completa: string }[] }; return say(`Tenho ${r.opcoes[0]!.data_completa}. Pode ser? Qual o nome completo do paciente?`); },
      // 2º turno: paciente confirmou
      [tool("criar_paciente", { nome: "Marina Souza", relacao_com_contato: "self" })],
      (req) => {
        const patient = lastToolResult(req) as { patient_id: string };
        const ctxText = JSON.stringify(req.messages);
        const token = /slot_token ([0-9a-f]{32})/.exec(ctxText)?.[1];
        expect(token).toBeTruthy();
        return [tool("reservar_horario", { slot_token: token, patient_id: patient.patient_id, confirmacao_explicita: true })];
      },
      (req) => { const r = lastToolResult(req) as { sucesso: boolean; data_completa: string }; expect(r.sucesso).toBe(true); return say(`Agendado para ${r.data_completa}.`); },
    ]);
    setLlmOverride(provider);
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("Quanto custa a avaliação? Quero marcar", phone), NOW);
    await runJobs(c.clinicId);
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("Sim, pode ser. Marina Souza", phone), addMinutes(NOW, 2));
    await runJobs(c.clinicId, 3);
    const conv = await conversationOf(c.clinicId, phone);
    const out = await outboundMessages(conv.id);
    expect(out).toHaveLength(2);
    expect(out[1]?.body).toMatch(/^Agendado para .*\d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/);
    const appts = await sql<{ created_by_type: string }[]>`select created_by_type from appointments where clinic_id = ${c.clinicId}`;
    expect(appts).toEqual([{ created_by_type: "ai" }]);
    const [opp] = await sql<{ stage: string }[]>`select stage from opportunities where clinic_id = ${c.clinicId}`;
    expect(opp?.stage).toBe("evaluation_scheduled");
    const runs = await sql<{ outcome: string; tools_called: { name: string }[] }[]>`select outcome, tools_called from ai_runs where conversation_id = ${conv.id} order by created_at`;
    expect(runs.map((r) => r.outcome)).toEqual(["replied", "replied"]);
    // Agendou → sequência de follow-up interrompida.
    expect(await sql`select 1 from scheduled_jobs where conversation_id = ${conv.id} and type like 'followup%' and status = 'pending'`).toHaveLength(0);
  });

  it("sem resposta do banco a IA não recebe 'sucesso' — conflito devolve novas opções", async () => {
    const c = await makeClinic();
    const [conv] = await sql<{ id: string; contact_id: string }[]>`
      with ct as (insert into contacts (clinic_id, phone_e164) values (${c.clinicId}, '+5511911110002') returning id)
      insert into conversations (clinic_id, contact_id) select ${c.clinicId}, id from ct returning id, contact_id`;
    const ctx: ToolCtx = { sql, clinicId: c.clinicId, conversationId: conv!.id, contactId: conv!.contact_id, tz: TZ, now: NOW, expect: { state: "ai_active", rowVersion: 0 }, flags: { handedOff: false, booked: false } };
    const offers = (await runTool("consultar_disponibilidade", { service_id: c.evaluationId, periodo: { de: DAY, ate: DAY } }, ctx)).result as { opcoes: { slot_token: string }[] };
    const created = (await runTool("criar_paciente", { nome: "Carlos Lima", relacao_com_contato: "self" }, ctx)).result as { patient_id: string };
    const [offer] = await sql<{ starts_at: Date }[]>`select starts_at from slot_offers where token = ${offers.opcoes[0]!.slot_token}`;
    // Outra pessoa ocupa o horário entre a oferta e a confirmação.
    const other = await makePatient(c.clinicId, "Outro");
    await bookAppointment(sql, { clinicId: c.clinicId, patientId: other, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: offer!.starts_at, createdByType: "user", now: NOW });
    const r = (await runTool("reservar_horario", { slot_token: offers.opcoes[0]!.slot_token, patient_id: created.patient_id, confirmacao_explicita: true }, ctx)).result as { sucesso: boolean; novas_opcoes: unknown[] };
    expect(r.sucesso).toBe(false);
    expect(r.novas_opcoes.length).toBeGreaterThan(0);
    // Sem confirmação explícita a entrada é recusada; token expirado também.
    expect((await runTool("reservar_horario", { slot_token: offers.opcoes[1]!.slot_token, patient_id: created.patient_id, confirmacao_explicita: false }, ctx)).isError).toBe(true);
    const late = (await runTool("reservar_horario", { slot_token: offers.opcoes[1]!.slot_token, patient_id: created.patient_id, confirmacao_explicita: true }, { ...ctx, now: addMinutes(NOW, 11) })).result as { sucesso: boolean; erro: string };
    expect(late.sucesso).toBe(false);
    expect(late.erro).toContain("expirou");
  });

  it("preço não cadastrado nunca é inventado; serviço fora do catálogo não é oferecido; implante leva à avaliação", async () => {
    const c = await makeClinic();
    const [conv] = await sql<{ id: string; contact_id: string }[]>`
      with ct as (insert into contacts (clinic_id, phone_e164) values (${c.clinicId}, '+5511911110003') returning id)
      insert into conversations (clinic_id, contact_id) select ${c.clinicId}, id from ct returning id, contact_id`;
    const ctx: ToolCtx = { sql, clinicId: c.clinicId, conversationId: conv!.id, contactId: conv!.contact_id, tz: TZ, now: NOW, expect: { state: "ai_active", rowVersion: 0 }, flags: { handedOff: false, booked: false } };
    const implant = (await runTool("buscar_servicos", { consulta: "implante" }, ctx)).result as { servicos: { preco: string; agenda_direto: boolean; avaliacao_necessaria_service_id: string }[] };
    expect(implant.servicos[0]?.preco).toContain("sob avaliação");
    expect(implant.servicos[0]?.agenda_direto).toBe(false);
    expect(implant.servicos[0]?.avaliacao_necessaria_service_id).toBe(c.evaluationId);
    const direct = (await runTool("consultar_disponibilidade", { service_id: c.implantId, periodo: { de: DAY, ate: DAY } }, ctx)).result as { erro: string };
    expect(direct.erro).toContain("não é agendado diretamente");
    const missing = (await runTool("buscar_servicos", { consulta: "botox harmonização" }, ctx)).result as { servicos: unknown[]; aviso: string };
    expect(missing.servicos).toHaveLength(0);
    expect(missing.aviso).toContain("Não ofereça");
    const kb = (await runTool("consultar_conhecimento", { topico: "vocês aceitam criptomoeda?" }, ctx)).result as { trechos: unknown[] };
    expect(kb.trechos).toHaveLength(0); // base ainda em rascunho → nada aprovado
    // Publicar muda a resposta seguinte, sem retreinar.
    await sql`update knowledge_docs set status = 'published', body = 'Aceitamos Pix e cartão.' where clinic_id = ${c.clinicId} and title = 'Formas de pagamento'`;
    const kb2 = (await runTool("consultar_conhecimento", { topico: "formas de pagamento" }, ctx)).result as { trechos: { texto: string }[] };
    expect(kb2.trechos[0]?.texto).toContain("Pix");

    // Caso real: documento "Horário de funcionamento", pergunta no plural e sem acento.
    await sql`insert into knowledge_docs (clinic_id, title, body, status) values (${c.clinicId}, 'Horário de funcionamento', 'Segunda a sexta de 8h às 18h e sábado de 9h às 14h. Domingo fechado.', 'published')`;
    for (const topico of ["horarios de atendimento", "que horas vocês abrem?", "funcionam no sabado"]) {
      const r = (await runTool("consultar_conhecimento", { topico }, ctx)).result as { trechos: { titulo: string; texto: string; relevante: boolean }[] };
      expect(r.trechos.find((t) => t.titulo === "Horário de funcionamento")?.texto, topico).toContain("sábado de 9h");
    }
    // Modelos menores trocam o nome do campo ou mandam texto solto: o servidor aproveita em vez de falhar.
    expect((await runTool("consultar_conhecimento", { query: "horários" }, ctx)).isError).toBe(false);
    expect((await runTool("consultar_conhecimento", { __invalid_json: "{'topico': 'horários'}" }, ctx)).isError).toBe(false);
    expect((await runTool("consultar_conhecimento", {}, ctx)).isError).toBe(false);
    const bad = await runTool("buscar_servicos", { consulta: 123, extra: { a: 1 } }, ctx);
    expect(bad.isError).toBe(false); // número vira texto

    // Dentistas, especialidade, dias de atendimento, serviços e endereço vêm de informacoes_da_clinica.
    await sql`update units set address = 'Rua Teste, 100' where clinic_id = ${c.clinicId}`;
    const info = (await runTool("informacoes_da_clinica", {}, ctx)).result as { unidades: { endereco: string }[]; dentistas: { nome: string; atende: string[]; servicos: string[] }[]; horario_de_atendimento_da_recepcao: string[] };
    expect(info.unidades[0]?.endereco).toBe("Rua Teste, 100");
    expect(info.dentistas[0]?.nome).toBe("Dr. Teste 1");
    expect(info.dentistas[0]?.atende.some((d) => d.startsWith("Segunda: "))).toBe(true);
    expect(info.dentistas[0]?.servicos.length).toBeGreaterThan(0);
    expect(info.horario_de_atendimento_da_recepcao).toHaveLength(7);
  });

  it("sinal de alerta: sem venda, sem chamada ao modelo, encaminha com urgência", async () => {
    const c = await makeClinic();
    const provider = new ScriptedProvider([say("NÃO DEVERIA SER CHAMADO")]);
    setLlmOverride(provider);
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("estou com muita dor e o rosto inchado, quanto custa o clareamento?", "+5511911110004"), NOW);
    await runJobs(c.clinicId);
    const conv = await conversationOf(c.clinicId, "+5511911110004");
    expect(provider.requests).toHaveLength(0);
    expect(conv.state).toBe("awaiting_human");
    expect(conv.handoff_priority).toBe("urgente");
    const out = await outboundMessages(conv.id);
    expect(out).toHaveLength(1);
    expect(out[0]?.body).toBe("Vou chamar nossa equipe agora.");
  });

  it("imagem é encaminhada sem laudo e sem ser enviada ao modelo", async () => {
    const c = await makeClinic();
    const provider = new ScriptedProvider([say("Recebi sua imagem. Nossa equipe vai olhar e te responder por aqui.")]);
    setLlmOverride(provider);
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("olha meu dente", "+5511911110005", { type: "image", text: "olha meu dente", mediaId: null, rawType: "image" }), NOW);
    await runJobs(c.clinicId);
    const conv = await conversationOf(c.clinicId, "+5511911110005");
    expect(conv.state).toBe("awaiting_human");
    const sent = JSON.stringify(provider.requests[0]?.messages);
    expect(sent).toContain("não interpretada");
    expect(sent).not.toContain('"type":"image"');
    expect(await outboundMessages(conv.id)).toHaveLength(1);
  });

  it("injeção de prompt: tool com paciente de outro telefone é recusada; ferramenta inexistente não executa", async () => {
    const c = await makeClinic();
    const victim = await makePatient(c.clinicId, "Vítima Silva", "1990-01-01");
    const [victimContact] = await sql<{ id: string }[]>`insert into contacts (clinic_id, phone_e164) values (${c.clinicId}, '+5511900000001') returning id`;
    await sql`insert into contact_patient_links (clinic_id, contact_id, patient_id) values (${c.clinicId}, ${victimContact!.id}, ${victim})`;
    const booked = await bookAppointment(sql, { clinicId: c.clinicId, patientId: victim, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("09:00", 2), createdByType: "user", now: NOW });
    if (!booked.ok) throw new Error("setup");
    const [conv] = await sql<{ id: string; contact_id: string }[]>`
      with ct as (insert into contacts (clinic_id, phone_e164) values (${c.clinicId}, '+5511911110006') returning id)
      insert into conversations (clinic_id, contact_id) select ${c.clinicId}, id from ct returning id, contact_id`;
    const ctx: ToolCtx = { sql, clinicId: c.clinicId, conversationId: conv!.id, contactId: conv!.contact_id, tz: TZ, now: NOW, expect: { state: "ai_active", rowVersion: 0 }, flags: { handedOff: false, booked: false } };
    const cancel = (await runTool("cancelar_consulta", { appointment_id: booked.appointmentId }, ctx)).result as { sucesso: boolean };
    expect(cancel.sucesso).toBe(false);
    const ident = (await runTool("identificar_paciente", { nome: "Vítima Silva", data_nascimento: "1990-01-01" }, ctx)).result as { encontrado: boolean };
    expect(ident.encontrado).toBe(false);
    expect((await runTool("executar_sql", { q: "select * from patients" }, ctx)).isError).toBe(true);
    const [still] = await sql<{ status: string }[]>`select status from appointments where id = ${booked.appointmentId}`;
    expect(still?.status).toBe("scheduled");
  });

  it("dois pacientes no mesmo telefone: histórico só após verificação de nome + nascimento", async () => {
    const c = await makeClinic();
    const [contact] = await sql<{ id: string }[]>`insert into contacts (clinic_id, phone_e164) values (${c.clinicId}, '+5511911110007') returning id`;
    const renata = await makePatient(c.clinicId, "Renata Sales", "1979-11-05");
    const sergio = await makePatient(c.clinicId, "Sérgio Sales", "1976-02-17");
    for (const p of [renata, sergio]) await sql`insert into contact_patient_links (clinic_id, contact_id, patient_id) values (${c.clinicId}, ${contact!.id}, ${p})`;
    const booked = await bookAppointment(sql, { clinicId: c.clinicId, patientId: sergio, contactId: contact!.id, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("10:00", 3), createdByType: "user", now: NOW });
    if (!booked.ok) throw new Error("setup");
    const [conv] = await sql<{ id: string }[]>`insert into conversations (clinic_id, contact_id) values (${c.clinicId}, ${contact!.id}) returning id`;
    const ctx: ToolCtx = { sql, clinicId: c.clinicId, conversationId: conv!.id, contactId: contact!.id, tz: TZ, now: NOW, expect: { state: "ai_active", rowVersion: 0 }, flags: { handedOff: false, booked: false } };
    const unverified = JSON.stringify((await runTool("identificar_paciente", { nome: "Sérgio Sales" }, ctx)).result);
    expect(unverified).toContain('"verificado":false');
    expect(unverified).not.toContain("consultas_futuras");
    expect(JSON.stringify((await runTool("identificar_paciente", { nome: "Sergio Sales", data_nascimento: "1979-11-05" }, ctx)).result)).not.toContain("consultas_futuras");
    expect(((await runTool("cancelar_consulta", { appointment_id: booked.appointmentId }, ctx)).result as { sucesso: boolean }).sucesso).toBe(false);
    const verified = JSON.stringify((await runTool("identificar_paciente", { nome: "sergio sales", data_nascimento: "1976-02-17" }, ctx)).result);
    expect(verified).toContain("consultas_futuras");
    expect(verified).toContain(booked.appointmentId);
    // Verificar o Sérgio não libera a Renata.
    expect(JSON.stringify((await runTool("identificar_paciente", { nome: "Renata Sales" }, ctx)).result)).toContain('"verificado":false');
    expect(((await runTool("cancelar_consulta", { appointment_id: booked.appointmentId }, ctx)).result as { sucesso: boolean }).sucesso).toBe(true);
  });

  it("mãe agenda para o filho sem trocar o próprio cadastro", async () => {
    const c = await makeClinic();
    const [contact] = await sql<{ id: string }[]>`insert into contacts (clinic_id, phone_e164, wa_profile_name) values (${c.clinicId}, '+5511911110008', 'Carla') returning id`;
    const mother = await makePatient(c.clinicId, "Carla Mendes", "1988-04-04");
    await sql`insert into contact_patient_links (clinic_id, contact_id, patient_id, relationship) values (${c.clinicId}, ${contact!.id}, ${mother}, 'self')`;
    const [conv] = await sql<{ id: string }[]>`insert into conversations (clinic_id, contact_id) values (${c.clinicId}, ${contact!.id}) returning id`;
    const ctx: ToolCtx = { sql, clinicId: c.clinicId, conversationId: conv!.id, contactId: contact!.id, tz: TZ, now: NOW, expect: { state: "ai_active", rowVersion: 0 }, flags: { handedOff: false, booked: false } };
    const child = (await runTool("criar_paciente", { nome: "Pedro Mendes", relacao_com_contato: "filho", data_nascimento: "2016-08-08" }, ctx)).result as { patient_id: string };
    const offers = (await runTool("consultar_disponibilidade", { service_id: c.evaluationId, periodo: { de: DAY, ate: DAY } }, ctx)).result as { opcoes: { slot_token: string }[] };
    const r = (await runTool("reservar_horario", { slot_token: offers.opcoes[0]!.slot_token, patient_id: child.patient_id, confirmacao_explicita: true }, ctx)).result as { sucesso: boolean; paciente: string };
    expect(r).toMatchObject({ sucesso: true, paciente: "Pedro Mendes" });
    const links = await sql<{ relationship: string; is_guardian: boolean; full_name: string }[]>`
      select l.relationship, l.is_guardian, p.full_name from contact_patient_links l join patients p on p.id = l.patient_id where l.contact_id = ${contact!.id} order by p.full_name`;
    expect(links).toEqual([{ relationship: "self", is_guardian: false, full_name: "Carla Mendes" }, { relationship: "filho", is_guardian: true, full_name: "Pedro Mendes" }]);
  });

  it("áudio ininteligível: mantém o áudio e a IA é avisada para pedir texto", async () => {
    const c = await makeClinic();
    setTranscriptionOverride({ transcribe: async () => { throw new Error("ininteligível"); } });
    const provider = new ScriptedProvider([say("Não consegui ouvir seu áudio. Pode escrever, por favor?")]);
    setLlmOverride(provider);
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("", "+5511911110009", { type: "audio", text: null, mediaId: null, rawType: "audio" }), NOW);
    await runJobs(c.clinicId);
    await runJobs(c.clinicId, 2);
    const conv = await conversationOf(c.clinicId, "+5511911110009");
    const [msg] = await sql<{ transcript_status: string; type: string }[]>`select transcript_status, type from messages where conversation_id = ${conv.id} and direction = 'inbound'`;
    expect(msg).toEqual({ transcript_status: "failed", type: "audio" });
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain("não pôde ser transcrito");
  });

  it("IA fora do ar: conversa vai para a fila humana; sem chave configurada idem", async () => {
    const c = await makeClinic();
    setLlmOverride({ name: "down", complete: async () => { throw new Error("boom"); } });
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("oi", "+5511911110010"), NOW);
    await runJobs(c.clinicId);
    expect((await conversationOf(c.clinicId, "+5511911110010")).state).toBe("awaiting_human");
    setLlmOverride(null);
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("oi", "+5511911110011"), NOW);
    await runJobs(c.clinicId);
    expect((await conversationOf(c.clinicId, "+5511911110011")).state).toBe("awaiting_human");
  });
});

describe("RF-02 — assumir e devolver", () => {
  it("humano assume durante o processamento: a resposta da IA é descartada", async () => {
    const c = await makeClinic();
    const phone = "+5511922220001";
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("Quero agendar", phone), NOW);
    const conv = await conversationOf(c.clinicId, phone);
    setLlmOverride(new ScriptedProvider([() => say("Resposta que não pode sair")]));
    // O humano assume enquanto o modelo ainda está "pensando".
    const original = ScriptedProvider.prototype.complete;
    ScriptedProvider.prototype.complete = async function (req) { await takeOver(sql, c.clinicId, conv.id, { id: null, name: "Recepção" }); return original.call(this, req); };
    // O job foi cancelado ao assumir? Ainda não: assumiu DURANTE. Reexecuta o processamento diretamente.
    const { processConversation } = await import("@/agent/orchestrator");
    const outcome = await processConversation(sql, c.clinicId, conv.id, addMinutes(NOW, 1));
    ScriptedProvider.prototype.complete = original;
    expect(outcome).toBe("discarded_handoff");
    expect(await outboundMessages(conv.id)).toHaveLength(0);
    const [run] = await sql<{ outcome: string }[]>`select outcome from ai_runs where conversation_id = ${conv.id}`;
    expect(run?.outcome).toBe("discarded_handoff");
  });

  it("após assumir, nova mensagem não gera resposta da IA; job em fila é cancelado; devolução leva pendências", async () => {
    const c = await makeClinic();
    const phone = "+5511922220002";
    const provider = new ScriptedProvider([say("Claro! Continuando de onde a equipe parou.")]);
    setLlmOverride(provider);
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("Oi", phone), NOW);
    const conv = await conversationOf(c.clinicId, phone);
    await takeOver(sql, c.clinicId, conv.id, { id: null, name: "Bia" });
    expect(await sql`select 1 from scheduled_jobs where conversation_id = ${conv.id} and status = 'pending'`).toHaveLength(0);
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("Tem alguém aí?", phone), addMinutes(NOW, 1));
    await runJobs(c.clinicId, 5);
    expect(provider.requests).toHaveLength(0);
    expect(await outboundMessages(conv.id)).toHaveLength(0);
    const [seen] = await sql<{ state: string; body: string }[]>`
      select c.state, m.body from conversations c join messages m on m.conversation_id = c.id and m.type = 'note' where c.id = ${conv.id} limit 1`;
    expect(seen).toMatchObject({ state: "human_active", body: "Bia assumiu a conversa." });

    await handBack(sql, c.clinicId, conv.id, { id: null, name: "Bia" }, "Paciente já informou que prefere manhã.");
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("Pode ser amanhã?", phone), addMinutes(NOW, 6));
    await runJobs(c.clinicId, 8);
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain("prefere manhã");
    expect(await outboundMessages(conv.id)).toHaveLength(1);
  });

  it("kill switch global: nenhuma resposta automática", async () => {
    const c = await makeClinic();
    const provider = new ScriptedProvider([say("x")]);
    setLlmOverride(provider);
    await sql`update clinics set ai_kill_switch = true where id = ${c.clinicId}`;
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("Oi", "+5511922220003"), NOW);
    await runJobs(c.clinicId, 5);
    expect(provider.requests).toHaveLength(0);
  });
});

describe("S6 — CRM", () => {
  it("'talvez eu faça implante' vira interesse, não tratamento; dois interesses coexistem sem duplicar cadastro", async () => {
    const c = await makeClinic();
    const [contact] = await sql<{ id: string }[]>`insert into contacts (clinic_id, phone_e164) values (${c.clinicId}, '+5511933330001') returning id`;
    const a = await registerInterest(sql, { clinicId: c.clinicId, contactId: contact!.id, serviceId: c.implantId, text: "Implante", intent: "considerando", actor: "ai" });
    const again = await registerInterest(sql, { clinicId: c.clinicId, contactId: contact!.id, serviceId: c.implantId, text: "Implante", intent: "quer_agendar", actor: "ai" });
    const b = await registerInterest(sql, { clinicId: c.clinicId, contactId: contact!.id, serviceId: c.cleaningId, text: "Limpeza", intent: "curioso", actor: "ai" });
    expect(again).toBe(a);
    expect(b).not.toBe(a);
    expect(await sql`select 1 from appointments where clinic_id = ${c.clinicId}`).toHaveLength(0);
    expect(await sql`select 1 from contacts where clinic_id = ${c.clinicId}`).toHaveLength(1);
    // IA não move para avaliação agendada sem consulta, nem para avaliação realizada.
    expect((await moveOpportunity(sql, { clinicId: c.clinicId, opportunityId: a, to: "evaluation_scheduled", actor: "ai" })).ok).toBe(false);
    expect((await moveOpportunity(sql, { clinicId: c.clinicId, opportunityId: a, to: "evaluation_done", actor: "ai" })).ok).toBe(false);
    expect((await moveOpportunity(sql, { clinicId: c.clinicId, opportunityId: a, to: "lost", actor: "user" })).ok).toBe(false);
    expect((await moveOpportunity(sql, { clinicId: c.clinicId, opportunityId: a, to: "lost", actor: "user", lostReason: "Preço" })).ok).toBe(true);
    const events = await sql`select 1 from opportunity_events where opportunity_id = ${a}`;
    expect(events.length).toBe(2);
  });
});

describe("CRM ligado à agenda", () => {
  const stages = (clinicId: string, patientId: string) => sql<{ stage: string; service_interest: string; contact_id: string | null }[]>`
    select stage, service_interest, contact_id from opportunities where clinic_id = ${clinicId} and patient_id = ${patientId} order by created_at`;

  it("paciente sem telefone com procedimento agendado pela equipe entra no CRM como aceito", async () => {
    const c = await makeClinic();
    const patientId = await makePatient(c.clinicId, "Daniel Luz");
    await syncOpportunityOnBooking(sql, { clinicId: c.clinicId, patientId, contactId: null, serviceId: c.implantId, actor: "user", when: "seg, 10:00" });
    expect(await stages(c.clinicId, patientId)).toEqual([{ stage: "accepted", service_interest: "Implante", contact_id: null }]);
    const [ev] = await sql<{ note: string }[]>`select e.note from opportunity_events e join opportunities o on o.id = e.opportunity_id where o.patient_id = ${patientId}`;
    expect(ev?.note).toContain("Procedimento agendado pela equipe");
  });

  it("avaliação cria ou avança a oportunidade; retorno não mexe; IA não promove procedimento a aceito", async () => {
    const c = await makeClinic();
    const p1 = await makePatient(c.clinicId, "Ana Avaliação");
    await syncOpportunityOnBooking(sql, { clinicId: c.clinicId, patientId: p1, contactId: null, serviceId: c.evaluationId, actor: "ai", when: "x" });
    expect((await stages(c.clinicId, p1)).map((o) => o.stage)).toEqual(["evaluation_scheduled"]);
    // Segunda avaliação não duplica.
    await syncOpportunityOnBooking(sql, { clinicId: c.clinicId, patientId: p1, contactId: null, serviceId: c.evaluationId, actor: "user", when: "x" });
    expect(await stages(c.clinicId, p1)).toHaveLength(1);

    const p2 = await makePatient(c.clinicId, "Bia Interesse");
    const [contact] = await sql<{ id: string }[]>`insert into contacts (clinic_id, phone_e164) values (${c.clinicId}, '+5511966660001') returning id`;
    await sql`insert into contact_patient_links (clinic_id, contact_id, patient_id) values (${c.clinicId}, ${contact!.id}, ${p2})`;
    await registerInterest(sql, { clinicId: c.clinicId, contactId: contact!.id, serviceId: c.implantId, text: "implante", intent: "considerando", actor: "ai" });
    const booked = await bookAppointment(sql, { clinicId: c.clinicId, patientId: p2, contactId: contact!.id, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("10:00", 1), createdByType: "ai", now: NOW });
    expect(booked.ok).toBe(true);
    await syncOpportunityOnBooking(sql, { clinicId: c.clinicId, patientId: p2, contactId: contact!.id, serviceId: c.evaluationId, actor: "ai", when: "x" });
    expect((await sql<{ stage: string }[]>`select stage from opportunities where contact_id = ${contact!.id}`).map((o) => o.stage)).toEqual(["evaluation_scheduled"]);

    const p3 = await makePatient(c.clinicId, "Caio Limpeza");
    await syncOpportunityOnBooking(sql, { clinicId: c.clinicId, patientId: p3, contactId: null, serviceId: c.cleaningId, actor: "ai", when: "x" });
    expect((await stages(c.clinicId, p3)).map((o) => o.stage)).toEqual(["in_conversation"]);
    const [ret] = await sql<{ id: string }[]>`select id from services where clinic_id = ${c.clinicId} and kind = 'return' limit 1`;
    if (ret) {
      const p4 = await makePatient(c.clinicId, "Davi Retorno");
      await syncOpportunityOnBooking(sql, { clinicId: c.clinicId, patientId: p4, contactId: null, serviceId: ret.id, actor: "user", when: "x" });
      expect(await stages(c.clinicId, p4)).toHaveLength(0);
    }
  });
});

describe("S7 — automações", () => {
  async function talk(c: TestClinic, phone: string) {
    setLlmOverride(new ScriptedProvider([say("Posso ver um horário para você?")]));
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("Queria saber da limpeza", phone), NOW);
    await runJobs(c.clinicId);
    return conversationOf(c.clinicId, phone);
  }
  const jobs = (conversationId: string) => sql<{ type: string; status: string; result: string | null }[]>`
    select type, status, result from scheduled_jobs where conversation_id = ${conversationId} and type like 'followup%' order by run_at`;

  it("follow-ups são agendados após a resposta da IA (3 h e 20 h) e enviados dentro da janela", async () => {
    const c = await makeClinic();
    const conv = await talk(c, "+5511944440001");
    expect((await jobs(conv.id)).map((j) => `${j.type}:${j.status}`)).toEqual(["followup_1:pending", "followup_2:pending"]);
    await runDueJobs({ now: addMinutes(NOW, 3 * 60 + 5), clinicId: c.clinicId });
    const out = await outboundMessages(conv.id);
    expect(out).toHaveLength(2);
    expect(out[1]?.sender_type).toBe("system");
  });

  it("paciente respondeu no meio da espera: follow-up não é enviado", async () => {
    const c = await makeClinic();
    const conv = await talk(c, "+5511944440002");
    setLlmOverride(null);
    await sql`update clinics set ai_enabled = false where id = ${c.clinicId}`;
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("vou pensar", "+5511944440002"), addMinutes(NOW, 60));
    expect((await jobs(conv.id)).every((j) => j.status === "cancelled")).toBe(true);
    await runDueJobs({ now: addMinutes(NOW, 4 * 60), clinicId: c.clinicId });
    expect(await outboundMessages(conv.id)).toHaveLength(1);
  });

  it("'parar' bloqueia imediatamente as automações", async () => {
    const c = await makeClinic();
    const conv = await talk(c, "+5511944440003");
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("PARAR", "+5511944440003"), addMinutes(NOW, 10));
    const [contact] = await sql<{ opted_out_at: Date | null; service_messages_allowed: boolean }[]>`select opted_out_at, service_messages_allowed from contacts where id = ${conv.contact_id}`;
    expect(contact?.opted_out_at).toBeTruthy();
    expect(contact?.service_messages_allowed).toBe(false);
    expect(await sql`select 1 from scheduled_jobs where conversation_id = ${conv.id} and status = 'pending'`).toHaveLength(0);
  });

  it("lembrete fora da janela sem template aprovado vira tarefa humana; com template aprovado usa o template", async () => {
    const c = await makeClinic();
    const patientId = await makePatient(c.clinicId, "Lia Prado");
    const [contact] = await sql<{ id: string }[]>`insert into contacts (clinic_id, phone_e164) values (${c.clinicId}, '+5511944440004') returning id`;
    await sql`insert into contact_patient_links (clinic_id, contact_id, patient_id) values (${c.clinicId}, ${contact!.id}, ${patientId})`;
    const booked = await bookAppointment(sql, { clinicId: c.clinicId, patientId, contactId: contact!.id, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("10:00", 7), createdByType: "user", now: NOW });
    if (!booked.ok) throw new Error("setup");
    await runDueJobs({ now: addMinutes(at("10:00", 7), -47 * 60), clinicId: c.clinicId });
    const tasks = await sql<{ title: string }[]>`select title from tasks where clinic_id = ${c.clinicId}`;
    expect(tasks.map((t) => t.title)).toEqual(["Lembrar paciente da consulta"]);
    expect(await sql`select 1 from messages where clinic_id = ${c.clinicId}`).toHaveLength(0);

    await sql`update message_templates set wa_template_status = 'approved' where clinic_id = ${c.clinicId}`;
    await runDueJobs({ now: addMinutes(at("10:00", 7), -23 * 60), clinicId: c.clinicId });
    const sent = await sql<{ type: string; body: string }[]>`select type, body from messages where clinic_id = ${c.clinicId} and direction = 'outbound'`;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("template");
    // Paciente responde "1" → consulta confirmada, sem IA.
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("1", "+5511944440004"), addMinutes(at("10:00", 7), -22 * 60));
    const [appt] = await sql<{ status: string }[]>`select status from appointments where id = ${booked.appointmentId}`;
    expect(appt?.status).toBe("confirmed");
  });
});

describe("S8 — dashboard concilia com os registros (teste 1)", () => {
  it("totais batem com as tabelas; contatos de teste ficam de fora", async () => {
    const c = await makeClinic();
    for (const [i, phone] of ["+5511955550001", "+5511955550002", "+5511955550003"].entries()) {
      await ingestInbound(sql, c.clinicId, "whatsapp", inbound("oi", phone), addMinutes(NOW, i));
    }
    await ingestInbound(sql, c.clinicId, "simulator", inbound("teste", "+5500000000001"), NOW);
    const first = await conversationOf(c.clinicId, "+5511955550001");
    const patientId = await makePatient(c.clinicId, "Convertido");
    const booked = await bookAppointment(sql, { clinicId: c.clinicId, patientId, contactId: first.contact_id, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("15:00"), createdByType: "ai", now: NOW });
    if (!booked.ok) throw new Error("setup");
    await setAppointmentStatus(sql, c.clinicId, booked.appointmentId, "arrived", "user");
    await setAppointmentStatus(sql, c.clinicId, booked.appointmentId, "completed", "user");
    const d = await asUser(c.ownerAuthId, (tx) => loadDashboard(tx, { clinicId: c.clinicId, tz: TZ, from: localDate(new Date(), TZ), to: addDays(DAY, 1), professionalId: null }));
    expect(d.newContacts).toBe(3);
    expect(d.conversations).toBe(3);
    expect(d.appointmentsBooked).toBe(1);
    expect(d.conversion).toMatchObject({ eligible: 3, converted: 1 });
    expect(d.byProfessional[0]?.total).toBe(1);
    const [raw] = await sql<{ n: number }[]>`select count(*)::int as n from contacts where clinic_id = ${c.clinicId} and not is_test`;
    expect(raw?.n).toBe(d.newContacts);
  });
});

describe("Automações da clínica (construtor visual)", () => {
  async function patientWithOpenWindow(c: TestClinic, name: string, phone: string, birth: string | null = null) {
    await sql`update clinics set ai_enabled = false where id = ${c.clinicId}`;
    const patientId = await makePatient(c.clinicId, name, birth);
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("Oi", phone), NOW);
    const conv = await conversationOf(c.clinicId, phone);
    await sql`insert into contact_patient_links (clinic_id, contact_id, patient_id) values (${c.clinicId}, ${conv.contact_id}, ${patientId})`;
    return { patientId, conv };
  }
  const rule = (clinicId: string, r: { trigger: string; offset: number; action: "message" | "task"; body?: string; task?: string; enabled?: boolean }) => sql`
    insert into automation_rules (clinic_id, name, trigger, offset_minutes, action, body, task_title, enabled)
    values (${clinicId}, 'Regra de teste', ${r.trigger}, ${r.offset}, ${r.action}, ${r.body ?? null}, ${r.task ?? null}, ${r.enabled ?? true})`;

  it("texto aceita variáveis do paciente, da consulta e da clínica", () => {
    expect(renderRuleText("Oi, {primeiro_nome}! {servico} com {dentista} em {data} na {clinica}.", { patient: "Lia Prado", service: "Limpeza", professional: "Dra. Ana", when: "seg, 10:00", clinic: "Sorriso" }))
      .toBe("Oi, Lia! Limpeza com Dra. Ana em seg, 10:00 na Sorriso.");
  });

  it("depois da consulta concluída: envia a mensagem na hora programada; regra pausada não envia", async () => {
    const c = await makeClinic();
    await rule(c.clinicId, { trigger: "after_appointment", offset: 120, action: "message", body: "Obrigado pela visita, {primeiro_nome}!" });
    await rule(c.clinicId, { trigger: "after_appointment", offset: 120, action: "message", body: "Não deveria sair", enabled: false });
    const { patientId, conv } = await patientWithOpenWindow(c, "Lia Prado", "+5511955550001");
    const booked = await bookAppointment(sql, { clinicId: c.clinicId, patientId, contactId: conv.contact_id, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("08:00", 0), createdByType: "user", now: addMinutes(NOW, -3 * 60) });
    if (!booked.ok) throw new Error("setup");
    await sql`update appointments set status = 'in_service' where id = ${booked.appointmentId}`;
    expect((await setAppointmentStatus(sql, c.clinicId, booked.appointmentId, "completed", "user", NOW)).ok).toBe(true);
    await runDueJobs({ now: addMinutes(NOW, 60), clinicId: c.clinicId });
    expect((await outboundMessages(conv.id)).map((m) => m.body)).not.toContain("Obrigado pela visita, Lia!");
    await runDueJobs({ now: addMinutes(NOW, 125), clinicId: c.clinicId });
    const bodies = (await outboundMessages(conv.id)).map((m) => m.body);
    expect(bodies).toContain("Obrigado pela visita, Lia!");
    expect(bodies).not.toContain("Não deveria sair");
  });

  it("falta registrada com regra de tarefa cria a tarefa para a equipe", async () => {
    const c = await makeClinic();
    await rule(c.clinicId, { trigger: "no_show", offset: 0, action: "task", task: "Ligar para {paciente}" });
    const patientId = await makePatient(c.clinicId, "Rui Gomes");
    const booked = await bookAppointment(sql, { clinicId: c.clinicId, patientId, contactId: null, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("08:00", 0), createdByType: "user", now: addMinutes(NOW, -3 * 60) });
    if (!booked.ok) throw new Error("setup");
    expect((await setAppointmentStatus(sql, c.clinicId, booked.appointmentId, "no_show", "user", NOW)).ok).toBe(true);
    await runDueJobs({ now: addMinutes(NOW, 1), clinicId: c.clinicId });
    const tasks = await sql<{ title: string }[]>`select title from tasks where clinic_id = ${c.clinicId}`;
    expect(tasks.map((t) => t.title)).toContain("Ligar para Rui Gomes");
  });

  it("aniversário: um envio por paciente por ano, só depois do horário escolhido", async () => {
    const c = await makeClinic();
    await rule(c.clinicId, { trigger: "birthday", offset: 9 * 60, action: "message", body: "Feliz aniversário, {primeiro_nome}!" });
    const { conv } = await patientWithOpenWindow(c, "Bia Lima", "+5511955550003", `1990-${DAY.slice(5)}`);
    await sweepBirthdays(sql, at("08:00", 0));
    expect(await sql`select 1 from scheduled_jobs where clinic_id = ${c.clinicId} and type = 'automation'`).toHaveLength(0);
    await sweepBirthdays(sql, NOW);
    await sweepBirthdays(sql, addMinutes(NOW, 30));
    expect(await sql`select 1 from scheduled_jobs where clinic_id = ${c.clinicId} and type = 'automation'`).toHaveLength(1);
    await runDueJobs({ now: addMinutes(NOW, 1), clinicId: c.clinicId });
    expect((await outboundMessages(conv.id)).map((m) => m.body)).toContain("Feliz aniversário, Bia!");
  });
});

describe("Google Meu Negócio, canais da automação e setup pela contratação", () => {
  const completed = async (c: TestClinic, patientId: string, contactId: string | null) => {
    const booked = await bookAppointment(sql, { clinicId: c.clinicId, patientId, contactId, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("08:00", 0), createdByType: "user", now: addMinutes(NOW, -3 * 60) });
    if (!booked.ok) throw new Error("setup");
    await sql`update appointments set status = 'in_service' where id = ${booked.appointmentId}`;
    expect((await setAppointmentStatus(sql, c.clinicId, booked.appointmentId, "completed", "user", NOW)).ok).toBe(true);
  };

  it("dados da contratação já configuram a conta: contatos, endereço e automação de avaliação", async () => {
    const owner = await makeUser();
    const clinicId = await createClinic(sql, {
      clinicName: "Clínica Contratada", owner: { authUserId: owner, email: "x@teste.dev", name: "Dona" }, chairs: 1, professionals: [],
      profile: { phone: "(11) 3333-4444", email: "contato@clinica.dev", instagram: "clinica", address: "Rua A, 10", googleReviewUrl: "https://g.page/r/abc/review" },
    });
    const [c] = await sql<{ contact_phone: string; instagram_handle: string; google_review_url: string }[]>`select contact_phone, instagram_handle, google_review_url from clinics where id = ${clinicId}`;
    expect(c).toMatchObject({ contact_phone: "(11) 3333-4444", instagram_handle: "clinica", google_review_url: "https://g.page/r/abc/review" });
    expect((await sql<{ address: string }[]>`select address from units where clinic_id = ${clinicId}`)[0]?.address).toBe("Rua A, 10");
    const rules = await sql<{ name: string; body: string; enabled: boolean }[]>`select name, body, enabled from automation_rules where clinic_id = ${clinicId}`;
    expect(rules).toEqual([{ name: "Pedir avaliação no Google", body: REVIEW_REQUEST_TEXT, enabled: true }]);
  });

  it("pedido de avaliação leva o link do Google; sem Google cadastrado, não envia", async () => {
    const c = await makeClinic();
    await sql`update clinics set ai_enabled = false where id = ${c.clinicId}`;
    await sql`insert into automation_rules (clinic_id, name, trigger, offset_minutes, action, channel, body) values (${c.clinicId}, 'Avaliação', 'after_appointment', 0, 'message', 'whatsapp', 'Avalie: {link_avaliacao}')`;
    const patientId = await makePatient(c.clinicId, "Ana Reis");
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("Oi", "+5511955551001"), NOW);
    const conv = await conversationOf(c.clinicId, "+5511955551001");
    await sql`insert into contact_patient_links (clinic_id, contact_id, patient_id) values (${c.clinicId}, ${conv.contact_id}, ${patientId})`;
    await completed(c, patientId, conv.contact_id);
    await runDueJobs({ now: addMinutes(NOW, 2), clinicId: c.clinicId });
    expect((await outboundMessages(conv.id)).map((m) => m.body).join()).not.toContain("Avalie");
    const [job] = await sql<{ result: string }[]>`select result from scheduled_jobs where clinic_id = ${c.clinicId} and type = 'automation'`;
    expect(job?.result).toBe("skipped:sem_link_do_google");

    await sql`update clinics set google_place_id = 'ChIJ_teste_123456' where id = ${c.clinicId}`;
    await sql`update scheduled_jobs set status = 'pending', result = null where clinic_id = ${c.clinicId} and type = 'automation'`;
    await runDueJobs({ now: addMinutes(NOW, 3), clinicId: c.clinicId });
    expect((await outboundMessages(conv.id)).map((m) => m.body)).toContain("Avalie: https://search.google.com/local/writereview?placeid=ChIJ_teste_123456");
  });

  it("Instagram vira tarefa com o texto pronto; e-mail sem configuração ou sem e-mail na ficha também", async () => {
    const c = await makeClinic();
    await sql`update clinics set instagram_handle = 'sorriso' where id = ${c.clinicId}`;
    await sql`insert into automation_rules (clinic_id, name, trigger, offset_minutes, action, channel, body) values
      (${c.clinicId}, 'Insta', 'after_appointment', 0, 'message', 'instagram', 'Oi {primeiro_nome}, siga {instagram}'),
      (${c.clinicId}, 'Mail', 'after_appointment', 0, 'message', 'email', 'Obrigado, {primeiro_nome}')`;
    const patientId = await makePatient(c.clinicId, "Caio Lins");
    await completed(c, patientId, null);
    await runDueJobs({ now: addMinutes(NOW, 2), clinicId: c.clinicId });
    const tasks = await sql<{ title: string; detail: string }[]>`select title, detail from tasks where clinic_id = ${c.clinicId} order by title`;
    expect(tasks).toEqual(expect.arrayContaining([
      { title: "Insta: enviar pelo Instagram", detail: "Para Caio Lins: Oi Caio, siga @sorriso" },
      expect.objectContaining({ title: "Mail: enviar manualmente", detail: expect.stringContaining("não tem e-mail cadastrado") }),
    ]));
  });

  it("avaliações: uma foto por dia pela API do Google, histórico e crescimento; RLS isola as clínicas", async () => {
    const a = await makeClinic();
    const b = await makeClinic();
    await sql`update clinics set google_place_id = 'ChIJ_place_a_0001' where id = ${a.clinicId}`;
    await sql`insert into google_review_snapshots (clinic_id, taken_on, rating, review_count) values (${a.clinicId}, current_date - 40, 4.6, 80)`;
    const prev = process.env.GOOGLE_PLACES_API_KEY;
    process.env.GOOGLE_PLACES_API_KEY = "teste";
    let calls = 0;
    const fake = (async (url: string) => {
      calls++;
      return new Response(JSON.stringify(url.includes("ChIJ_place_a_0001") ? { rating: 4.84, userRatingCount: 97 } : {}), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await sweepGoogleReviews(sql, new Date(), fake);
      await sweepGoogleReviews(sql, new Date(), fake); // segunda rodada no mesmo dia não consulta de novo
    } finally { if (prev === undefined) delete process.env.GOOGLE_PLACES_API_KEY; else process.env.GOOGLE_PLACES_API_KEY = prev; }
    expect(calls).toBeGreaterThanOrEqual(1);
    const callsForA = calls;
    expect(callsForA).toBeLessThan(10);
    const h = await asUser(a.ownerAuthId, (tx) => loadReviewHistory(tx));
    expect(h.latest).toMatchObject({ rating: 4.8, count: 97 });
    expect(h.growth30).toBe(17);
    const other = await asUser(b.ownerAuthId, (tx) => loadReviewHistory(tx));
    expect(other.points).toHaveLength(0);
  });
});

describe("Envio por clique, paciente irritado, origem e Google Agenda", () => {
  it("sem WhatsApp conectado, a automação vira um botão 'Enviar no WhatsApp' com número e texto prontos", async () => {
    setProviderOverride(null);
    const c = await makeClinic();
    await sql`insert into automation_rules (clinic_id, name, trigger, offset_minutes, action, channel, body) values (${c.clinicId}, 'Obrigado', 'after_appointment', 0, 'message', 'whatsapp', 'Obrigado, {primeiro_nome}!')`;
    const patientId = await makePatient(c.clinicId, "Lia Prado");
    const [ct] = await sql<{ id: string }[]>`insert into contacts (clinic_id, phone_e164) values (${c.clinicId}, '+5511955559999') returning id`;
    await sql`insert into contact_patient_links (clinic_id, contact_id, patient_id) values (${c.clinicId}, ${ct!.id}, ${patientId})`;
    const booked = await bookAppointment(sql, { clinicId: c.clinicId, patientId, contactId: ct!.id, serviceId: c.evaluationId, professionalId: c.professionalIds[0]!, startsAt: at("08:00", 0), createdByType: "user", now: addMinutes(NOW, -3 * 60) });
    if (!booked.ok) throw new Error("setup");
    await sql`update appointments set status = 'in_service' where id = ${booked.appointmentId}`;
    await setAppointmentStatus(sql, c.clinicId, booked.appointmentId, "completed", "user", NOW);
    await runDueJobs({ now: addMinutes(NOW, 2), clinicId: c.clinicId });
    const [task] = await sql<{ wa_phone: string; message_text: string; kind: string }[]>`select wa_phone, message_text, kind from tasks where clinic_id = ${c.clinicId} and wa_phone is not null`;
    expect(task).toEqual({ wa_phone: "+5511955559999", message_text: "Obrigado, Lia!", kind: "whatsapp_click" });
  });

  it("paciente irritado: a assistente não chama o modelo, responde com acolhimento e passa para a equipe", async () => {
    const c = await makeClinic();
    let called = false;
    setLlmOverride({ name: "x", complete: async () => { called = true; throw new Error("não deveria"); } });
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("ISSO É UM DESCASO, NINGUÉM RESPONDE NADA", "+5511955558888"), NOW);
    await runJobs(c.clinicId, 1);
    const conv = await conversationOf(c.clinicId, "+5511955558888");
    const [row] = await sql<{ state: string; handoff_reason: string }[]>`select state, handoff_reason from conversations where id = ${conv.id}`;
    expect(called).toBe(false);
    expect(row?.state).toBe("awaiting_human");
    expect(row?.handoff_reason).toContain("Paciente irritado");
    expect((await outboundMessages(conv.id)).map((m) => m.body).join()).toContain("Sinto muito pelo transtorno");
  });

  it("origem: 'vi no Instagram' na primeira mensagem vai para o contato e para o paciente cadastrado pela IA", async () => {
    const c = await makeClinic();
    await sql`update clinics set ai_enabled = false where id = ${c.clinicId}`;
    await ingestInbound(sql, c.clinicId, "whatsapp", inbound("Oi! Vi vocês no Instagram, fazem clareamento?", "+5511955557777"), NOW);
    const conv = await conversationOf(c.clinicId, "+5511955557777");
    const [ct] = await sql<{ origin: string }[]>`select origin from contacts where id = ${conv.contact_id}`;
    expect(ct?.origin).toBe("instagram");
    const ctx: ToolCtx = { sql, clinicId: c.clinicId, conversationId: conv.id, contactId: conv.contact_id, tz: TZ, now: NOW, expect: { state: "ai_active", rowVersion: 0 }, flags: { handedOff: false, booked: false } };
    const r = (await runTool("criar_paciente", { nome: "Rita Souza", relacao_com_contato: "self" }, ctx)).result as { patient_id: string };
    const [p] = await sql<{ source: string; source_detail: string }[]>`select source, source_detail from patients where id = ${r.patient_id}`;
    expect(p?.source).toBe("instagram");
    expect(p?.source_detail).toContain("Instagram");
  });

  it("a assistente recebe o link de avaliação e os contatos públicos da clínica", () => {
    const prompt = buildSystemPrompt({ name: "Sorriso", assistantName: "Ana", alertMessage: null, publicInfo: { reviewUrl: "https://g.page/r/x/review", instagram: "sorriso" } });
    expect(prompt).toContain("Link para avaliar a clínica no Google: https://g.page/r/x/review");
    expect(prompt).toContain("@sorriso");
  });

  it("Google Agenda: compromissos do iCal viram bloqueios do dentista e somem dos horários livres", async () => {
    setResolverForTests(async () => [{ address: "142.250.0.1" }]);
    try {
      const c = await makeClinic();
      const start = at("10:00", 0).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const end = at("11:00", 0).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:g1\r\nSUMMARY:Particular\r\nDTSTART:${start}\r\nDTEND:${end}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
      const fake = (async () => new Response(ics, { status: 200 })) as unknown as typeof fetch;
      const [imp] = await sql<{ id: string; clinic_id: string; professional_id: string | null; url_enc: string }[]>`
        insert into calendar_imports (clinic_id, professional_id, label, url_enc) values (${c.clinicId}, ${c.professionalIds[0]!}, 'Google', ${enc("https://calendar.google.com/calendar/ical/x/basic.ics")})
        returning id, clinic_id, professional_id, url_enc`;
      expect(await syncCalendarImport(sql, imp!, NOW, fake)).toEqual({ ok: true, count: 1 });
      expect(await syncCalendarImport(sql, imp!, NOW, fake)).toEqual({ ok: true, count: 1 }); // substitui, não duplica
      const blocks = await sql<{ reason: string }[]>`select reason from time_blocks where import_id = ${imp!.id}`;
      expect(blocks).toEqual([{ reason: "Google Agenda: Particular" }]);
      const { slots } = await findSlots(sql, { clinicId: c.clinicId, serviceId: c.evaluationId, fromDate: DAY, toDate: DAY, now: addMinutes(NOW, -600) });
      expect(slots.length).toBeGreaterThan(0);
      expect(slots.some((s) => s.startsAt.getTime() >= at("10:00", 0).getTime() && s.startsAt.getTime() < at("11:00", 0).getTime())).toBe(false);
    } finally { setResolverForTests(null); }
  });
});

