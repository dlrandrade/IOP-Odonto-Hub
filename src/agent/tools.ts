import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Sql } from "@/db/client";
import { pickOffers } from "@/domain/slots";
import { addDays, formatFull, localDate, WEEKDAY_KEYS, WEEKDAY_LABELS, type BusinessHours } from "@/lib/datetime";
import { brl, normalizeText } from "@/lib/format";
import { bookAppointment, cancelAppointment, findSlots, rescheduleAppointment } from "@/services/booking";
import { requestHuman } from "@/services/conversations";
import { registerInterest, syncOpportunityOnBooking } from "@/services/crm";
import { cancelJobs } from "@/services/jobs-queue";
import type { ConversationState } from "@/domain/states";

/**
 * Tools tipadas (PRD 7.2). A IA nunca escreve no banco: ela pede, o servidor valida e executa.
 * clinic_id e contact_id vêm da conversa — o modelo não os informa nem consegue trocá-los.
 */
export type ToolCtx = {
  sql: Sql;
  clinicId: string;
  conversationId: string;
  contactId: string;
  tz: string;
  now: Date;
  /** Estado esperado da conversa; atualizado quando a própria IA encaminha. */
  expect: { state: ConversationState; rowVersion: number };
  flags: { handedOff: boolean; booked: boolean };
};

type ToolDef<S extends z.ZodTypeAny> = {
  name: string;
  description: string;
  schema: S;
  jsonSchema: Anthropic.Beta.BetaTool["input_schema"];
  run: (input: z.infer<S>, ctx: ToolCtx) => Promise<unknown>;
};

const def = <S extends z.ZodTypeAny>(t: ToolDef<S>) => t;
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use AAAA-MM-DD");

function priceText(mode: string, min: number | null, max: number | null): string {
  if (mode === "fixed" && min != null) return brl(min);
  if (mode === "range" && min != null && max != null) return `de ${brl(min)} a ${brl(max)}`;
  return "sob avaliação (depende de avaliação com o dentista)";
}

async function linkedPatient(ctx: ToolCtx, patientId: string): Promise<{ id: string; full_name: string } | null> {
  const [p] = await ctx.sql<{ id: string; full_name: string }[]>`
    select p.id, p.full_name from patients p
    join contact_patient_links l on l.patient_id = p.id and l.contact_id = ${ctx.contactId}
    where p.id = ${patientId} and p.clinic_id = ${ctx.clinicId} and p.merged_into_patient_id is null`;
  return p ?? null;
}

async function isVerified(ctx: ToolCtx, patientId: string): Promise<boolean> {
  const [c] = await ctx.sql<{ verified_patient_ids: string[] }[]>`select verified_patient_ids from conversations where id = ${ctx.conversationId}`;
  return !!c?.verified_patient_ids.includes(patientId);
}

async function offerSlots(ctx: ToolCtx, serviceId: string, professionalId: string | null, from: string, to: string, turno: "manha" | "tarde" | "noite" | null) {
  const { slots } = await findSlots(ctx.sql, { clinicId: ctx.clinicId, serviceId, professionalId, fromDate: from, toDate: to, turno, now: ctx.now });
  const offers = [];
  for (const s of pickOffers(slots, 5)) {
    const [offer] = await ctx.sql<{ token: string }[]>`
      insert into slot_offers (clinic_id, conversation_id, service_id, professional_id, starts_at, expires_at)
      values (${ctx.clinicId}, ${ctx.conversationId}, ${serviceId}, ${s.professionalId}, ${s.startsAt}, ${new Date(ctx.now.getTime() + 10 * 60_000)})
      returning token`;
    const [prof] = await ctx.sql<{ name: string }[]>`select name from professionals where id = ${s.professionalId}`;
    if (offer) offers.push({ slot_token: offer.token, data_completa: formatFull(s.startsAt, ctx.tz), profissional: prof?.name ?? "" });
  }
  return offers;
}

async function resolveOffer(ctx: ToolCtx, token: string) {
  const [offer] = await ctx.sql<{ service_id: string; professional_id: string; starts_at: Date; expires_at: Date }[]>`
    select service_id, professional_id, starts_at, expires_at from slot_offers
    where token = ${token} and clinic_id = ${ctx.clinicId} and conversation_id = ${ctx.conversationId}`;
  if (!offer) return { error: "slot_token inválido. Consulte a disponibilidade novamente." } as const;
  if (offer.expires_at < ctx.now) return { error: "Esta oferta expirou (validade de 10 minutos). Consulte a disponibilidade novamente." } as const;
  return { offer } as const;
}

/** Reduz a palavra ao radical simples (horários → horario, convênios → convenio) para a busca não falhar por plural. */
function stem(word: string): string {
  return word.length > 4 && word.endsWith("es") ? word.slice(0, -2) : word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}
const STOP = new Set(["que", "qual", "quais", "como", "para", "com", "uma", "das", "dos", "voce", "voces", "vcs", "tem", "sobre", "clinica"]);
function terms(text: string): string[] {
  return normalizeText(text).replace(/[^a-z0-9 ]/g, " ").split(" ").filter((t) => t.length > 2 && !STOP.has(t)).map(stem);
}
function relevance(query: string[], title: string, body: string): number {
  const t = terms(title);
  const b = new Set(terms(body));
  return query.reduce((n, q) => n + (t.some((w) => w.startsWith(q) || q.startsWith(w)) ? 3 : 0) + ([...b].some((w) => w.startsWith(q) || q.startsWith(w)) ? 1 : 0), 0);
}

/** Base pequena (o caso normal): a IA recebe tudo, sem depender de acertar a palavra da busca. */
const SMALL_BASE_CHARS = 8000;

function formatRanges(ranges: [string, string][] | undefined): string {
  return ranges?.length ? ranges.map(([a, b]) => `${a.slice(0, 5)}–${b.slice(0, 5)}`).join(", ") : "fechado";
}

export const TOOLS = [
  def({
    name: "buscar_servicos",
    description: "Busca serviços publicados da clínica (nome, tipo, preço vigente, descrição aprovada, se agenda direto). Use antes de falar de qualquer serviço ou preço. Consulta vazia lista todos.",
    schema: z.object({ consulta: z.coerce.string().max(200).default("") }),
    jsonSchema: { type: "object", properties: { consulta: { type: "string", description: "Termo livre, ex.: 'limpeza', 'implante'. Vazio lista tudo." } }, required: ["consulta"] },
    run: async ({ consulta }, ctx) => {
      const rows = await ctx.sql<{ id: string; name: string; specialty: string | null; kind: string; price_mode: string; price_min_cents: number | null; price_max_cents: number | null; bookable_directly: boolean; leads_to_evaluation_service_id: string | null; patient_description: string | null; preparation: string | null; duration_min: number }[]>`
        select id, name, specialty, kind, price_mode, price_min_cents, price_max_cents, bookable_directly, leads_to_evaluation_service_id, patient_description, preparation, duration_min
        from services where clinic_id = ${ctx.clinicId} and status = 'published' order by name`;
      const terms = normalizeText(consulta).split(" ").filter((t) => t.length > 2);
      const match = (r: (typeof rows)[number]) => {
        const hay = normalizeText(`${r.name} ${r.specialty ?? ""} ${r.patient_description ?? ""}`);
        return terms.length === 0 || terms.some((t) => hay.includes(t));
      };
      const found = rows.filter(match);
      const list = (found.length ? found : []).map((r) => ({
        service_id: r.id, nome: r.name, especialidade: r.specialty, tipo: r.kind,
        preco: priceText(r.price_mode, r.price_min_cents, r.price_max_cents),
        agenda_direto: r.bookable_directly,
        avaliacao_necessaria_service_id: r.bookable_directly ? null : r.leads_to_evaluation_service_id,
        descricao_aprovada: r.patient_description, preparo: r.preparation,
      }));
      return list.length ? { servicos: list } : { servicos: [], aviso: "Nenhum serviço publicado corresponde. Não ofereça serviço fora do cadastro; se necessário, encaminhe para a equipe." };
    },
  }),
  def({
    name: "consultar_conhecimento",
    description: "Busca textos aprovados da base de conhecimento da clínica: horário de funcionamento, endereço, formas de pagamento, convênios, acessibilidade, estacionamento, políticas. Se a base for pequena, devolve todos os textos.",
    schema: z.object({ topico: z.coerce.string().max(300).default("") }),
    jsonSchema: { type: "object", properties: { topico: { type: "string", description: "Assunto em poucas palavras, ex.: 'horário de funcionamento', 'convênios'." } }, required: ["topico"] },
    run: async ({ topico }, ctx) => {
      const docs = await ctx.sql<{ title: string; body: string }[]>`
        select title, body from knowledge_docs where clinic_id = ${ctx.clinicId} and status = 'published' and length(trim(body)) > 0 order by title`;
      if (docs.length === 0) return { trechos: [], aviso: "A clínica ainda não publicou textos na base de conhecimento. Diga que vai confirmar com a equipe e encaminhe." };
      const q = terms(topico);
      const ranked = docs.map((d) => ({ d, score: relevance(q, d.title, d.body) })).sort((a, b) => b.score - a.score);
      const total = docs.reduce((n, d) => n + d.title.length + d.body.length, 0);
      const chosen = total <= SMALL_BASE_CHARS ? ranked : ranked.filter((x) => x.score > 0).slice(0, 4);
      if (chosen.length === 0) return { trechos: [], aviso: "Nada aprovado sobre isso. Diga que vai confirmar com a equipe e encaminhe.", titulos_disponiveis: docs.map((d) => d.title) };
      return {
        orientacao: "Use somente o que estiver nestes textos. Textos marcados [DEMO] são fictícios: avise que é uma clínica de demonstração.",
        trechos: chosen.map((x) => ({ titulo: x.d.title, texto: x.d.body.slice(0, 2000), relevante: x.score > 0 })),
      };
    },
  }),
  def({
    name: "informacoes_da_clinica",
    description: "Dados cadastrados da clínica: nome, endereço, acessibilidade, horário de atendimento da recepção e a equipe de dentistas com especialidade, dias e horários de atendimento e serviços que cada um faz. Use para perguntas sobre dentistas, quem atende, dias e horários de funcionamento e endereço.",
    schema: z.object({}).passthrough(),
    jsonSchema: { type: "object", properties: {}, required: [] },
    run: async (_input, ctx) => {
      const [clinic] = await ctx.sql<{ name: string; business_hours: BusinessHours; contact_phone: string | null; contact_email: string | null; website_url: string | null; instagram_handle: string | null }[]>`
        select name, business_hours, contact_phone, contact_email, website_url, instagram_handle from clinics where id = ${ctx.clinicId}`;
      const units = await ctx.sql<{ name: string; address: string | null; accessibility_info: string | null }[]>`
        select name, address, accessibility_info from units where clinic_id = ${ctx.clinicId} order by created_at`;
      const pros = await ctx.sql<{ id: string; name: string; specialty: string | null }[]>`
        select id, name, specialty from professionals where clinic_id = ${ctx.clinicId} and active order by name`;
      const rules = await ctx.sql<{ professional_id: string; weekday: number; start_time: string; end_time: string }[]>`
        select professional_id, weekday, start_time::text, end_time::text from availability_rules where clinic_id = ${ctx.clinicId} order by weekday, start_time`;
      const svc = await ctx.sql<{ professional_id: string; name: string }[]>`
        select sp.professional_id, s.name from service_professionals sp join services s on s.id = sp.service_id
        where s.clinic_id = ${ctx.clinicId} and s.status = 'published' order by s.name`;
      const hours = clinic?.business_hours ?? {};
      return {
        clinica: clinic?.name,
        // Contatos oficiais da clínica; só os cadastrados (nunca inventar).
        contatos: {
          telefone: clinic?.contact_phone ?? "não cadastrado", email: clinic?.contact_email ?? "não cadastrado",
          instagram: clinic?.instagram_handle ? `@${clinic.instagram_handle}` : "não cadastrado", site: clinic?.website_url ?? "não cadastrado",
        },
        unidades: units.map((u) => ({ nome: u.name, endereco: u.address || "não cadastrado", acessibilidade: u.accessibility_info || "não cadastrada" })),
        horario_de_atendimento_da_recepcao: WEEKDAY_KEYS.map((k, i) => `${WEEKDAY_LABELS[i]}: ${formatRanges(hours[k])}`),
        dentistas: pros.map((p) => {
          const mine = rules.filter((r) => r.professional_id === p.id);
          const days = WEEKDAY_LABELS.map((label, wd) => {
            const r = mine.filter((x) => x.weekday === wd).map((x) => [x.start_time, x.end_time] as [string, string]);
            return r.length ? `${label}: ${formatRanges(r)}` : null;
          }).filter(Boolean);
          return { nome: p.name, especialidade: p.specialty ?? "não informada", atende: days.length ? days : ["sem expediente cadastrado"], servicos: svc.filter((x) => x.professional_id === p.id).map((x) => x.name) };
        }),
        orientacao: "Isto mostra quando cada dentista trabalha, não horários livres. Para marcar, use consultar_disponibilidade, que traz só os horários realmente vagos.",
      };
    },
  }),
  def({
    name: "identificar_paciente",
    description: "Procura, entre os pacientes vinculados a este telefone, quem tem o nome informado. Com a data de nascimento correta o paciente fica VERIFICADO nesta conversa, o que libera ver consultas existentes, remarcar e cancelar.",
    schema: z.object({ nome: z.string().min(2).max(120), data_nascimento: dateStr.nullish() }),
    jsonSchema: { type: "object", properties: { nome: { type: "string", description: "Nome completo informado" }, data_nascimento: { type: "string", description: "AAAA-MM-DD, se o paciente informou" } }, required: ["nome"] },
    run: async ({ nome, data_nascimento }, ctx) => {
      const rows = await ctx.sql<{ id: string; full_name: string; birth_date: string | null; relationship: string }[]>`
        select p.id, p.full_name, p.birth_date::text, l.relationship from patients p
        join contact_patient_links l on l.patient_id = p.id and l.contact_id = ${ctx.contactId}
        where p.clinic_id = ${ctx.clinicId} and p.merged_into_patient_id is null`;
      const wanted = normalizeText(nome);
      const matches = rows.filter((r) => {
        const full = normalizeText(r.full_name);
        return full === wanted || (wanted.split(" ").length >= 2 && (full.includes(wanted) || wanted.includes(full)));
      });
      if (matches.length === 0) return { encontrado: false, orientacao: "Nenhum paciente com esse nome vinculado a este telefone. Se for cadastro novo, use criar_paciente." };
      const out = [];
      for (const p of matches) {
        let verified = await isVerified(ctx, p.id);
        if (!verified && data_nascimento && p.birth_date === data_nascimento) {
          await ctx.sql`update conversations set verified_patient_ids = array_append(verified_patient_ids, ${p.id}::uuid) where id = ${ctx.conversationId}`;
          await ctx.sql`update contact_patient_links set verified_at = ${ctx.now} where contact_id = ${ctx.contactId} and patient_id = ${p.id}`;
          verified = true;
        }
        if (!verified) {
          out.push({ patient_id: p.id, nome: p.full_name, verificado: false, orientacao: p.birth_date ? "Para ver ou alterar consultas, confirme a data de nascimento." : "Cadastro sem data de nascimento: alterações em consultas existentes precisam da equipe." });
          continue;
        }
        const appts = await ctx.sql<{ id: string; starts_at: Date; status: string; service: string; professional: string }[]>`
          select a.id, a.starts_at, a.status, s.name as service, pr.name as professional
          from appointments a join services s on s.id = a.service_id join professionals pr on pr.id = a.professional_id
          where a.patient_id = ${p.id} and a.clinic_id = ${ctx.clinicId} and a.starts_at > ${ctx.now} and a.status in ('scheduled','confirmed')
          order by a.starts_at`;
        out.push({
          patient_id: p.id, nome: p.full_name, verificado: true,
          consultas_futuras: appts.map((a) => ({ appointment_id: a.id, data_completa: formatFull(a.starts_at, ctx.tz), servico: a.service, profissional: a.professional, status: a.status })),
        });
      }
      return { encontrado: true, pacientes: out };
    },
  }),
  def({
    name: "criar_paciente",
    description: "Cadastra um novo paciente vinculado a este telefone. relacao_com_contato diz quem o paciente é para a pessoa que está escrevendo: 'self' (ela mesma), 'filho', 'conjuge', 'dependente' ou 'outro'.",
    schema: z.object({ nome: z.string().min(3).max(120), relacao_com_contato: z.enum(["self", "filho", "conjuge", "dependente", "outro"]), data_nascimento: dateStr.nullish() }),
    jsonSchema: { type: "object", properties: { nome: { type: "string" }, relacao_com_contato: { type: "string", enum: ["self", "filho", "conjuge", "dependente", "outro"] }, data_nascimento: { type: "string", description: "AAAA-MM-DD, opcional" } }, required: ["nome", "relacao_com_contato"] },
    run: async ({ nome, relacao_com_contato, data_nascimento }, ctx) => {
      const existing = await ctx.sql<{ id: string; full_name: string }[]>`
        select p.id, p.full_name from patients p join contact_patient_links l on l.patient_id = p.id and l.contact_id = ${ctx.contactId}
        where p.clinic_id = ${ctx.clinicId} and p.merged_into_patient_id is null`;
      const same = existing.find((p) => normalizeText(p.full_name) === normalizeText(nome));
      if (same) return { patient_id: same.id, ja_existia: true };
      const [p] = await ctx.sql<{ id: string }[]>`
        insert into patients (clinic_id, full_name, birth_date) values (${ctx.clinicId}, ${nome.trim()}, ${data_nascimento ?? null}) returning id`;
      if (!p) return { erro: "Não foi possível cadastrar." };
      const guardian = relacao_com_contato === "filho" || relacao_com_contato === "dependente";
      await ctx.sql`
        insert into contact_patient_links (clinic_id, contact_id, patient_id, relationship, is_guardian, verified_at)
        values (${ctx.clinicId}, ${ctx.contactId}, ${p.id}, ${relacao_com_contato}, ${guardian}, ${ctx.now})`;
      // Quem acabou de fornecer os dados está verificado para este cadastro nesta conversa.
      await ctx.sql`update conversations set verified_patient_ids = array_append(verified_patient_ids, ${p.id}::uuid) where id = ${ctx.conversationId}`;
      return { patient_id: p.id, ja_existia: false };
    },
  }),
  def({
    name: "consultar_disponibilidade",
    description: "Consulta horários livres reais para um serviço que agenda direto. Devolve até 5 opções, cada uma com slot_token (válido por 10 minutos) e a data completa já no fuso da clínica.",
    schema: z.object({
      service_id: z.string().uuid(), profissional_id: z.string().uuid().nullish(),
      periodo: z.object({ de: dateStr, ate: dateStr }), turno: z.enum(["manha", "tarde", "noite"]).nullish(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        service_id: { type: "string" }, profissional_id: { type: "string" },
        periodo: { type: "object", properties: { de: { type: "string", description: "AAAA-MM-DD" }, ate: { type: "string", description: "AAAA-MM-DD" } }, required: ["de", "ate"] },
        turno: { type: "string", enum: ["manha", "tarde", "noite"] },
      },
      required: ["service_id", "periodo"],
    },
    run: async ({ service_id, profissional_id, periodo, turno }, ctx) => {
      const [svc] = await ctx.sql<{ name: string; bookable_directly: boolean; status: string; leads_to_evaluation_service_id: string | null }[]>`
        select name, bookable_directly, status, leads_to_evaluation_service_id from services where id = ${service_id} and clinic_id = ${ctx.clinicId}`;
      if (!svc || svc.status !== "published") return { erro: "Serviço não encontrado entre os publicados." };
      if (!svc.bookable_directly) {
        return { erro: "Este serviço não é agendado diretamente.", avaliacao_necessaria_service_id: svc.leads_to_evaluation_service_id, orientacao: svc.leads_to_evaluation_service_id ? "Ofereça a avaliação indicada." : "Encaminhe para a equipe." };
      }
      const today = localDate(ctx.now, ctx.tz);
      const from = periodo.de < today ? today : periodo.de;
      const to = periodo.ate < from ? from : periodo.ate > addDays(from, 31) ? addDays(from, 31) : periodo.ate;
      const offers = await offerSlots(ctx, service_id, profissional_id ?? null, from, to, turno ?? null);
      return offers.length ? { servico: svc.name, opcoes: offers } : { servico: svc.name, opcoes: [], aviso: "Sem horários livres nesse período. Tente outro período ou turno." };
    },
  }),
  def({
    name: "reservar_horario",
    description: "Cria a consulta para o slot_token escolhido. Chame somente depois de o paciente confirmar explicitamente a data completa e o nome do paciente. Só diga 'agendado' se o retorno for sucesso.",
    schema: z.object({ slot_token: z.string().min(8), patient_id: z.string().uuid(), confirmacao_explicita: z.literal(true) }),
    jsonSchema: { type: "object", properties: { slot_token: { type: "string" }, patient_id: { type: "string" }, confirmacao_explicita: { type: "boolean", description: "true somente se o paciente disse 'sim' à data completa" } }, required: ["slot_token", "patient_id", "confirmacao_explicita"] },
    run: async ({ slot_token, patient_id }, ctx) => {
      const r = await resolveOffer(ctx, slot_token);
      if ("error" in r) return { sucesso: false, erro: r.error };
      const patient = await linkedPatient(ctx, patient_id);
      if (!patient) return { sucesso: false, erro: "Paciente não vinculado a este telefone. Use identificar_paciente ou criar_paciente." };
      const [svc] = await ctx.sql<{ name: string; kind: string; bookable_directly: boolean }[]>`select name, kind, bookable_directly from services where id = ${r.offer.service_id}`;
      if (!svc?.bookable_directly) return { sucesso: false, erro: "Serviço não agendável diretamente." };
      const booked = await bookAppointment(ctx.sql, {
        clinicId: ctx.clinicId, patientId: patient.id, contactId: ctx.contactId, serviceId: r.offer.service_id,
        professionalId: r.offer.professional_id, startsAt: r.offer.starts_at, createdByType: "ai", now: ctx.now,
      });
      if (!booked.ok) {
        const day = localDate(r.offer.starts_at, ctx.tz);
        const novas = await offerSlots(ctx, r.offer.service_id, null, day, addDays(day, 7), null);
        return { sucesso: false, conflito: true, erro: "O horário não está mais disponível. NÃO confirme o agendamento.", novas_opcoes: novas };
      }
      ctx.flags.booked = true;
      await cancelJobs(ctx.sql, ctx.clinicId, { conversationId: ctx.conversationId, types: ["followup_1", "followup_2"] });
      await syncOpportunityOnBooking(ctx.sql, { clinicId: ctx.clinicId, patientId: patient.id, contactId: ctx.contactId, serviceId: r.offer.service_id, actor: "ai", when: formatFull(booked.startsAt, ctx.tz) });
      return { sucesso: true, appointment_id: booked.appointmentId, paciente: patient.full_name, servico: svc.name, data_completa: formatFull(booked.startsAt, ctx.tz) };
    },
  }),
  def({
    name: "reagendar_consulta",
    description: "Move uma consulta existente para o slot_token escolhido (a vaga antiga só é liberada se a nova for gravada). Exige paciente verificado.",
    schema: z.object({ appointment_id: z.string().uuid(), slot_token: z.string().min(8) }),
    jsonSchema: { type: "object", properties: { appointment_id: { type: "string" }, slot_token: { type: "string" } }, required: ["appointment_id", "slot_token"] },
    run: async ({ appointment_id, slot_token }, ctx) => {
      const [appt] = await ctx.sql<{ patient_id: string; service_id: string }[]>`select patient_id, service_id from appointments where id = ${appointment_id} and clinic_id = ${ctx.clinicId}`;
      if (!appt || !(await linkedPatient(ctx, appt.patient_id))) return { sucesso: false, erro: "Consulta não encontrada para este telefone." };
      if (!(await isVerified(ctx, appt.patient_id))) return { sucesso: false, erro: "Paciente não verificado. Confirme nome completo e data de nascimento com identificar_paciente." };
      const r = await resolveOffer(ctx, slot_token);
      if ("error" in r) return { sucesso: false, erro: r.error };
      if (r.offer.service_id !== appt.service_id) return { sucesso: false, erro: "O horário oferecido é de outro serviço. Consulte a disponibilidade do mesmo serviço da consulta." };
      const moved = await rescheduleAppointment(ctx.sql, { clinicId: ctx.clinicId, appointmentId: appointment_id, professionalId: r.offer.professional_id, startsAt: r.offer.starts_at, createdByType: "ai", now: ctx.now });
      if (!moved.ok) return { sucesso: false, erro: `${moved.message} A consulta original foi mantida. NÃO confirme a remarcação.` };
      ctx.flags.booked = true;
      return { sucesso: true, appointment_id: moved.appointmentId, data_completa: formatFull(moved.startsAt, ctx.tz) };
    },
  }),
  def({
    name: "cancelar_consulta",
    description: "Cancela uma consulta existente e os lembretes pendentes. Exige paciente verificado.",
    schema: z.object({ appointment_id: z.string().uuid(), motivo: z.string().max(300).nullish() }),
    jsonSchema: { type: "object", properties: { appointment_id: { type: "string" }, motivo: { type: "string" } }, required: ["appointment_id"] },
    run: async ({ appointment_id, motivo }, ctx) => {
      const [appt] = await ctx.sql<{ patient_id: string }[]>`select patient_id from appointments where id = ${appointment_id} and clinic_id = ${ctx.clinicId}`;
      if (!appt || !(await linkedPatient(ctx, appt.patient_id))) return { sucesso: false, erro: "Consulta não encontrada para este telefone." };
      if (!(await isVerified(ctx, appt.patient_id))) return { sucesso: false, erro: "Paciente não verificado. Confirme nome completo e data de nascimento com identificar_paciente." };
      const r = await cancelAppointment(ctx.sql, ctx.clinicId, appointment_id, motivo ?? "Cancelada pelo paciente via WhatsApp");
      return r.ok ? { sucesso: true } : { sucesso: false, erro: r.message };
    },
  }),
  def({
    name: "registrar_interesse",
    description: "Registra no CRM o interesse do contato em um serviço. intencao: 'curioso' (só perguntou), 'considerando' (pensa em fazer), 'quer_agendar'. Interesse não é tratamento contratado.",
    schema: z.object({ service_id: z.string().uuid().nullish(), texto: z.string().min(2).max(300), intencao: z.enum(["curioso", "considerando", "quer_agendar"]) }),
    jsonSchema: { type: "object", properties: { service_id: { type: "string" }, texto: { type: "string", description: "Resumo curto do interesse, ex.: 'Implante'" }, intencao: { type: "string", enum: ["curioso", "considerando", "quer_agendar"] } }, required: ["texto", "intencao"] },
    run: async ({ service_id, texto, intencao }, ctx) => {
      if (service_id) {
        const [s] = await ctx.sql`select 1 from services where id = ${service_id} and clinic_id = ${ctx.clinicId}`;
        if (!s) return { erro: "service_id desconhecido." };
      }
      const id = await registerInterest(ctx.sql, { clinicId: ctx.clinicId, contactId: ctx.contactId, serviceId: service_id ?? null, text: texto, intent: intencao, actor: "ai" });
      return { opportunity_id: id };
    },
  }),
  def({
    name: "encaminhar_humano",
    description: "Passa a conversa para a equipe humana. Use quando faltar informação aprovada, houver sinal de alerta (prioridade 'urgente'), imagem, reclamação, pedido fora do seu alcance ou falha em uma ferramenta.",
    schema: z.object({ motivo: z.string().min(3).max(300), prioridade: z.enum(["normal", "urgente"]) }),
    jsonSchema: { type: "object", properties: { motivo: { type: "string" }, prioridade: { type: "string", enum: ["normal", "urgente"] } }, required: ["motivo", "prioridade"] },
    run: async ({ motivo, prioridade }, ctx) => {
      const version = await requestHuman(ctx.sql, ctx.clinicId, ctx.conversationId, motivo, prioridade);
      if (version === null) return { encaminhado: false, aviso: "A conversa já está com a equipe." };
      ctx.expect = { state: "awaiting_human", rowVersion: version };
      ctx.flags.handedOff = true;
      return { encaminhado: true, orientacao: "Avise o paciente, em uma frase, que a equipe vai continuar o atendimento. Não prometa prazo." };
    },
  }),
  def({
    name: "atualizar_resumo",
    description: "Salva um resumo factual curto do atendimento para a equipe (fica marcado como gerado por IA). Não é evolução clínica.",
    schema: z.object({ texto: z.string().min(5).max(1200) }),
    jsonSchema: { type: "object", properties: { texto: { type: "string" } }, required: ["texto"] },
    run: async ({ texto }, ctx) => {
      await ctx.sql`update conversations set summary = ${texto}, summary_updated_at = ${ctx.now}, summary_by = 'ai' where id = ${ctx.conversationId}`;
      return { salvo: true };
    },
  }),
];

export const TOOL_SPECS: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.jsonSchema }));

/** Executa uma tool pedida pelo modelo. Entrada inválida ou erro vira resultado de erro — nunca exceção para o modelo. */
/**
 * Modelos menores às vezes erram o nome do campo ("query" em vez de "topico") ou mandam texto solto.
 * Se a ferramenta espera um único campo de texto obrigatório e veio um único valor, aproveitamos esse valor.
 */
function coerceInput(tool: (typeof TOOLS)[number], input: unknown): unknown {
  const required = (tool.jsonSchema.required ?? []) as string[];
  const props = (tool.jsonSchema.properties ?? {}) as Record<string, { type?: string }>;
  if (typeof input === "string") input = required.length === 1 ? { [required[0]!]: input } : {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return input ?? {};
  const obj = { ...(input as Record<string, unknown>) };
  if (typeof obj.__invalid_json === "string") {
    const raw = obj.__invalid_json;
    delete obj.__invalid_json;
    try { return coerceInput(tool, JSON.parse(raw.replace(/'/g, '"').replace(/,\s*}/g, "}"))); } catch { if (required.length === 1) obj[required[0]!] = raw; }
  }
  if (required.length === 1 && props[required[0]!]?.type === "string" && !(required[0]! in obj)) {
    const extras = Object.entries(obj).filter(([k, v]) => !(k in props) && typeof v === "string");
    if (extras.length === 1) obj[required[0]!] = extras[0]![1];
  }
  return obj;
}

export async function runTool(name: string, input: unknown, ctx: ToolCtx): Promise<{ result: unknown; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { result: { erro: `Ferramenta desconhecida: ${name}` }, isError: true };
  const parsed = tool.schema.safeParse(coerceInput(tool, input));
  if (!parsed.success) {
    return {
      result: {
        erro: "Entrada inválida. Chame de novo usando exatamente estes campos.",
        detalhes: parsed.error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`),
        campos_esperados: tool.jsonSchema.properties ?? {}, obrigatorios: tool.jsonSchema.required ?? [],
      },
      isError: true,
    };
  }
  try {
    const run = tool.run as (i: unknown, c: ToolCtx) => Promise<unknown>;
    return { result: await run(parsed.data, ctx), isError: false };
  } catch {
    return { result: { erro: "Falha ao executar. Se for uma reserva, NÃO confirme: diga que a confirmação ficou pendente e encaminhe para a equipe." }, isError: true };
  }
}
