"use server";

import { z } from "zod";
import { adminCreateUser, adminSetPassword } from "@/auth/provider";
import { q } from "@/auth/session";
import type { ActionState } from "@/components/client";
import { ROLES } from "@/domain/permissions";
import { parseSettings, settingsSchema } from "@/domain/settings";
import { act, actorOf, bool, optStr, str, UserError } from "@/lib/action";
import { encryptField } from "@/lib/crypto";
import { WEEKDAY_KEYS, type BusinessHours } from "@/lib/datetime";
import { audit, diff } from "@/services/audit";

const id = z.string().uuid();
const PATH = "/configuracoes";

/** "08:00-12:00, 13:00-18:00" → [["08:00","12:00"],["13:00","18:00"]]; vazio = fechado. */
function parseRanges(raw: string): [string, string][] {
  if (!raw.trim()) return [];
  return raw.split(",").map((part) => {
    const m = part.trim().match(/^(\d{1,2}):?(\d{2})?\s*[-–a]\s*(\d{1,2}):?(\d{2})?$/);
    if (!m) throw new UserError(`Horário inválido: "${part.trim()}". Use o formato 08:00-18:00.`);
    const start = `${m[1]!.padStart(2, "0")}:${m[2] ?? "00"}`;
    const end = `${m[3]!.padStart(2, "0")}:${m[4] ?? "00"}`;
    if (end <= start) throw new UserError(`O fim precisa ser depois do início em "${part.trim()}".`);
    return [start, end] as [string, string];
  });
}

export async function saveClinicAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("settings.manage", [PATH, "/"], async (ctx) => {
    const timezone = str(form, "timezone");
    try { new Intl.DateTimeFormat("pt-BR", { timeZone: timezone }); } catch { throw new UserError("Fuso horário inválido."); }
    const hours: BusinessHours = {};
    for (const key of WEEKDAY_KEYS) hours[key] = parseRanges(str(form, `hours_${key}`));
    const next = {
      name: z.string().min(2, "Informe o nome da clínica.").parse(str(form, "name")), timezone,
      assistant_name: z.string().min(2).parse(str(form, "assistantName")), after_hours_message: z.string().min(5).parse(str(form, "afterHours")),
    };
    const current = parseSettings(ctx.clinic.settings);
    const settings = settingsSchema.parse({ ...current, minLeadMinutes: form.get("minLeadMinutes"), maxAdvanceDays: form.get("maxAdvanceDays") });
    await q(ctx, async (tx) => {
      await tx`update clinics set ${tx(next)}, business_hours = ${tx.json(hours as never)}, settings = ${tx.json(settings as never)} where id = ${ctx.clinicId}`;
      await tx`update units set address = ${optStr(form, "address")}, accessibility_info = ${optStr(form, "accessibility")}
               where id = (select id from units where clinic_id = ${ctx.clinicId} order by created_at limit 1)`;
      const changes = diff({ ...ctx.clinic, business_hours: ctx.clinic.business_hours } as Record<string, unknown>, { ...next, business_hours: hours });
      if (changes) await audit(tx, actorOf(ctx), "clinic.update", "clinics", ctx.clinicId, changes.before, changes.after);
    });
    return { ok: true, message: "Dados da clínica salvos." };
  });
}

// ───────────── Equipe ─────────────

export async function inviteUserAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("users.manage", PATH, async (ctx) => {
    const p = z.object({
      name: z.string().trim().min(2, "Informe o nome."), email: z.string().trim().toLowerCase().email("E-mail inválido."),
      role: z.enum(ROLES), password: z.string().min(8, "Senha provisória com ao menos 8 caracteres."),
    }).parse({ name: form.get("name"), email: form.get("email"), role: form.get("role"), password: form.get("password") });
    const created = await adminCreateUser(p.email, p.password);
    if (!created.ok) throw new UserError(created.error);
    await q(ctx, async (tx) => {
      const [u] = await tx<{ id: string }[]>`
        insert into app_users (clinic_id, auth_user_id, email, name, role) values (${ctx.clinicId}, ${created.userId}, ${p.email}, ${p.name}, ${p.role}) returning id`;
      await audit(tx, actorOf(ctx), "user.create", "app_users", u?.id ?? null, null, { email: p.email, role: p.role });
    });
    return { ok: true, message: "Usuário criado. Entregue a senha provisória por um canal seguro." };
  });
}

export async function updateUserAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("users.manage", PATH, async (ctx) => {
    const userId = id.parse(form.get("userId"));
    const role = z.enum(ROLES).parse(form.get("role"));
    const active = bool(form, "active");
    const password = optStr(form, "password");
    if (password && password.length < 8) throw new UserError("A nova senha precisa ter ao menos 8 caracteres.");
    await q(ctx, async (tx) => {
      const [before] = await tx<{ role: string; active: boolean; auth_user_id: string }[]>`select role, active, auth_user_id from app_users where id = ${userId}`;
      if (!before) throw new UserError("Usuário não encontrado.");
      if (userId === ctx.userId && (!active || role !== "admin")) throw new UserError("Você não pode rebaixar ou desativar o próprio acesso.");
      const [admins] = await tx<{ n: number }[]>`select count(*)::int as n from app_users where role = 'admin' and active and id <> ${userId}`;
      if ((admins?.n ?? 0) === 0 && (role !== "admin" || !active)) throw new UserError("A clínica precisa de ao menos um administrador ativo.");
      // Desativar corta o acesso na próxima requisição (a sessão é conferida a cada chamada).
      await tx`update app_users set role = ${role}, active = ${active} where id = ${userId}`;
      if (password) await adminSetPassword(before.auth_user_id, password);
      await audit(tx, actorOf(ctx), "user.update", "app_users", userId, { role: before.role, active: before.active }, { role, active, password_reset: !!password });
    });
  });
}

// ───────────── Agenda: dentistas, cadeiras e expediente ─────────────

export async function saveProfessionalAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("agenda.structure", [PATH, "/agenda"], async (ctx) => {
    const data = {
      name: z.string().min(2, "Informe o nome.").parse(str(form, "name")), specialty: optStr(form, "specialty"), council_number: optStr(form, "council"),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).parse(str(form, "color") || "#0F2A3D"), app_user_id: optStr(form, "appUserId"), active: bool(form, "active"),
    };
    const rules: { weekday: number; start: string; end: string }[] = [];
    for (const [weekday, key] of WEEKDAY_KEYS.entries()) for (const [start, end] of parseRanges(str(form, `rule_${key}`))) rules.push({ weekday, start, end });
    await q(ctx, async (tx) => {
      let pid = optStr(form, "professionalId");
      if (pid) await tx`update professionals set ${tx(data)} where id = ${id.parse(pid)}`;
      else {
        const [row] = await tx<{ id: string }[]>`insert into professionals ${tx({ ...data, clinic_id: ctx.clinicId })} returning id`;
        pid = row?.id ?? null;
        // Novo dentista começa habilitado em todos os serviços; ajuste em Serviços.
        if (pid) await tx`insert into service_professionals (clinic_id, service_id, professional_id) select ${ctx.clinicId}, id, ${pid} from services where clinic_id = ${ctx.clinicId}`;
      }
      if (!pid) throw new UserError("Não foi possível salvar.");
      const [unit] = await tx<{ id: string }[]>`select id from units order by created_at limit 1`;
      await tx`delete from availability_rules where professional_id = ${pid}`;
      for (const r of rules) await tx`insert into availability_rules (clinic_id, professional_id, unit_id, weekday, start_time, end_time) values (${ctx.clinicId}, ${pid}, ${unit?.id ?? null}, ${r.weekday}, ${r.start}, ${r.end})`;
      await audit(tx, actorOf(ctx), "professional.save", "professionals", pid, null, { name: data.name, active: data.active, rules: rules.length });
    });
  });
}

export async function saveResourceAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("agenda.structure", [PATH, "/agenda"], async (ctx) => {
    const name = z.string().min(1, "Informe o nome.").parse(str(form, "name"));
    const kind = z.enum(["chair", "equipment", "assistant"]).parse(form.get("kind"));
    const resourceId = optStr(form, "resourceId");
    await q(ctx, async (tx) => {
      if (resourceId) await tx`update resources set name = ${name}, active = ${bool(form, "active")} where id = ${id.parse(resourceId)} and kind <> 'professional'`;
      else {
        const [unit] = await tx<{ id: string }[]>`select id from units order by created_at limit 1`;
        await tx`insert into resources (clinic_id, unit_id, name, kind) values (${ctx.clinicId}, ${unit?.id ?? null}, ${name}, ${kind})`;
      }
    });
  });
}

// ───────────── WhatsApp ─────────────

export async function saveWhatsAppAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("integrations.manage", [PATH, "/"], async (ctx) => {
    const phoneId = z.string().regex(/^\d{5,25}$/, "O ID do número tem apenas dígitos (copie do painel da Meta).").parse(str(form, "phoneNumberId"));
    const token = optStr(form, "accessToken");
    const secret = optStr(form, "appSecret");
    await q(ctx, async (tx) => {
      const [taken] = await tx`select 1 from clinic_integrations where wa_phone_number_id = ${phoneId} and clinic_id <> ${ctx.clinicId}`;
      if (taken) throw new UserError("Este número já está conectado a outra clínica.");
      const [current] = await tx<{ wa_access_token_enc: string | null; wa_app_secret_enc: string | null }[]>`select wa_access_token_enc, wa_app_secret_enc from clinic_integrations where clinic_id = ${ctx.clinicId}`;
      if (!token && !current?.wa_access_token_enc) throw new UserError("Informe o token de acesso.");
      if (!secret && !current?.wa_app_secret_enc) throw new UserError("Informe a chave secreta do app (App Secret).");
      // Segredos ficam criptografados no banco e nunca voltam para a tela.
      await tx`update clinic_integrations set wa_phone_number_id = ${phoneId}, wa_business_account_id = ${optStr(form, "wabaId")}, wa_display_phone = ${optStr(form, "displayPhone")},
                 wa_access_token_enc = ${token ? encryptField(token) : current?.wa_access_token_enc ?? null},
                 wa_app_secret_enc = ${secret ? encryptField(secret) : current?.wa_app_secret_enc ?? null}, wa_connected_at = now(), wa_last_error = null
               where clinic_id = ${ctx.clinicId}`;
      await audit(tx, actorOf(ctx), "whatsapp.connect", "clinic_integrations", ctx.clinicId, null, { phone_number_id: phoneId, token_changed: !!token, secret_changed: !!secret });
    });
    return { ok: true, message: "Credenciais salvas. Agora cadastre a URL do webhook no painel da Meta." };
  });
}

// ───────────── IA e protocolo de alerta ─────────────

export async function saveAiAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("ai.configure", [PATH, "/", "/conversas"], async (ctx) => {
    const keywords = str(form, "alertKeywords").split("\n").map((k) => k.trim()).filter(Boolean).slice(0, 100);
    const alertMessage = optStr(form, "alertMessage");
    const afterHoursAlert = optStr(form, "alertAfterHours");
    const approve = bool(form, "approve");
    const enable = bool(form, "aiEnabled");
    const protocolChanged = alertMessage !== ctx.clinic.alert_message || afterHoursAlert !== ctx.clinic.alert_after_hours_message || JSON.stringify(keywords) !== JSON.stringify(ctx.clinic.alert_keywords);
    // Mudou o protocolo → precisa de nova aprovação do responsável técnico.
    const approved = approve ? true : protocolChanged ? false : !!ctx.clinic.alert_approved_at;
    if (approve && (!alertMessage || keywords.length === 0)) throw new UserError("Para aprovar, preencha os sinais de alerta e a mensagem de encaminhamento.");
    if (enable && !approved) throw new UserError("A assistente só pode ser ativada depois que o protocolo de sinais de alerta for aprovado pelo responsável técnico.");
    const current = parseSettings(ctx.clinic.settings);
    const budget = optStr(form, "budget");
    const settings = settingsSchema.parse({ ...current, debounceSeconds: form.get("debounceSeconds"), aiMonthlyBudgetCents: budget ? Math.round(Number(budget.replace(",", ".")) * 100) : null });
    await q(ctx, async (tx) => {
      await tx`update clinics set alert_keywords = ${keywords}, alert_message = ${alertMessage}, alert_after_hours_message = ${afterHoursAlert},
                 alert_approved_at = ${approve ? new Date() : approved ? ctx.clinic.alert_approved_at : null}, alert_approved_by = ${approve ? ctx.userId : approved ? ctx.clinic.alert_approved_by : null},
                 ai_enabled = ${enable}, ai_kill_switch = ${bool(form, "killSwitch")}, settings = ${tx.json(settings as never)}
               where id = ${ctx.clinicId}`;
      await audit(tx, actorOf(ctx), "ai.configure", "clinics", ctx.clinicId,
        { ai_enabled: ctx.clinic.ai_enabled, ai_kill_switch: ctx.clinic.ai_kill_switch, alert_approved: !!ctx.clinic.alert_approved_at },
        { ai_enabled: enable, ai_kill_switch: bool(form, "killSwitch"), alert_approved: approved, protocol_changed: protocolChanged });
    });
    return { ok: true, message: "Configuração da assistente salva." };
  });
}
