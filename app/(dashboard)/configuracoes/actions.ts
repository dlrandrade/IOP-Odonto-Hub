"use server";

import { z, ZodError } from "zod";
import { adminCreateUser, adminSetPassword } from "@/auth/provider";
import { actionCtx, q } from "@/auth/session";
import { db } from "@/db/client";
import type { ActionState } from "@/components/client";
import { ROLES } from "@/domain/permissions";
import { parseSettings, settingsSchema } from "@/domain/settings";
import { act, actorOf, bool, optStr, str, UserError } from "@/lib/action";
import { decryptField, encryptField } from "@/lib/crypto";
import { assertPublicUrl } from "@/lib/safe-url";
import { env } from "@/lib/env";
import { buildProvider, listClaudeModels, listOpenAiModels, listOpenRouterFreeModels, LlmUnavailableError, OPENROUTER_URL, type LlmSettings } from "@/integrations/llm";
import { evolutionConfig, wacliGateway } from "@/integrations/whatsapp";
import { wacliConnect, wacliLogout, wacliStatus } from "@/integrations/whatsapp/wacli";
import QRCode from "qrcode";
import { randomBytes } from "node:crypto";
import { ensureEvolutionInstance, evolutionLogout, evolutionQr, evolutionState, setEvolutionWebhook, type EvolutionConfig } from "@/integrations/whatsapp/evolution";
import { WEEKDAY_KEYS, type BusinessHours } from "@/lib/datetime";
import { audit, diff } from "@/services/audit";
import { ContactError, extractPlaceId, normalizeEmail, normalizeGoogleUrl, normalizeInstagram, normalizePhone, normalizeUrl } from "@/domain/contact";
import { searchPlaces } from "@/integrations/google/places";
import { reviewLink } from "@/services/google-reviews";
import { syncCalendarImport } from "@/services/calendar-sync";

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
    let contact;
    try {
      contact = {
        contact_phone: normalizePhone(optStr(form, "contactPhone")), contact_email: normalizeEmail(optStr(form, "contactEmail")),
        website_url: normalizeUrl(optStr(form, "website"), "Site"), instagram_handle: normalizeInstagram(optStr(form, "instagram")),
      };
    } catch (e) { if (e instanceof ContactError) throw new UserError(e.message); throw e; }
    const next = {
      name: z.string().min(2, "Informe o nome da clínica.").parse(str(form, "name")), timezone,
      assistant_name: z.string().min(2).parse(str(form, "assistantName")), after_hours_message: z.string().min(5).parse(str(form, "afterHours")),
      ...contact,
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
      // A RLS esconde as outras clínicas; a unicidade é garantida pelo índice único (migração 0010).
      const [taken] = await db()`select 1 from clinic_integrations where wa_phone_number_id = ${phoneId} and clinic_id <> ${ctx.clinicId}`;
      if (taken) throw new UserError("Este número já está conectado a outra clínica.");
      const [current] = await tx<{ wa_access_token_enc: string | null; wa_app_secret_enc: string | null }[]>`select wa_access_token_enc, wa_app_secret_enc from clinic_integrations where clinic_id = ${ctx.clinicId}`;
      if (!token && !current?.wa_access_token_enc) throw new UserError("Informe o token de acesso.");
      if (!secret && !current?.wa_app_secret_enc) throw new UserError("Informe a chave secreta do app (App Secret).");
      // Segredos ficam criptografados no banco e nunca voltam para a tela.
      await tx`update clinic_integrations set wa_provider = 'cloud', wa_phone_number_id = ${phoneId}, wa_business_account_id = ${optStr(form, "wabaId")}, wa_display_phone = ${optStr(form, "displayPhone")},
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

// ───────────── WhatsApp alternativo (Evolution API) ─────────────

async function evoConfig(ctx: { authUserId: string }): Promise<{ cfg: EvolutionConfig; token: string } | null> {
  const [row] = await q(ctx, (tx) => tx<{ evo_base_url: string | null; evo_instance: string | null; evo_api_key_enc: string | null; evo_webhook_token: string }[]>`
    select evo_base_url, evo_instance, evo_api_key_enc, evo_webhook_token from clinic_integrations`);
  if (!row) return null;
  const cfg = evolutionConfig(row);
  return cfg ? { cfg, token: row.evo_webhook_token } : null;
}

export async function saveEvolutionAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("integrations.manage", [PATH, "/"], async (ctx) => {
    const baseUrl = z.string().url("Informe o endereço completo, começando com https://").parse(str(form, "baseUrl")).replace(/\/+$/, "");
    if (!baseUrl.startsWith("https://") && !baseUrl.startsWith("http://localhost")) throw new UserError("Use um endereço https:// para proteger a chave.");
    await assertPublicUrl(baseUrl).catch((e: unknown) => { throw new UserError(e instanceof Error ? e.message : "Endereço não permitido."); });
    const instance = z.string().regex(/^[A-Za-z0-9_-]{2,40}$/, "Nome da instância: só letras, números, hífen e sublinhado.").parse(str(form, "instance"));
    const apiKey = optStr(form, "apiKey");
    await q(ctx, async (tx) => {
      const [cur] = await tx<{ evo_api_key_enc: string | null }[]>`select evo_api_key_enc from clinic_integrations`;
      if (!apiKey && !cur?.evo_api_key_enc) throw new UserError("Informe a chave (API key) da Evolution.");
      await tx`update clinic_integrations set wa_provider = 'evolution', evo_base_url = ${baseUrl}, evo_instance = ${instance},
                 evo_api_key_enc = ${apiKey ? encryptField(apiKey) : cur?.evo_api_key_enc ?? null}, wa_last_error = null
               where clinic_id = ${ctx.clinicId}`;
      await audit(tx, actorOf(ctx), "whatsapp.evolution", "clinic_integrations", ctx.clinicId, null, { base_url: baseUrl, instance, key_changed: !!apiKey });
    });
    const conf = await evoConfig(ctx);
    if (!conf) throw new UserError("Configuração incompleta.");
    try {
      await ensureEvolutionInstance(conf.cfg);
      await setEvolutionWebhook(conf.cfg, `${env.appUrl}/api/webhooks/evolution/${conf.token}`);
    } catch (e) {
      throw new UserError(`Dados salvos, mas a Evolution não respondeu como esperado: ${e instanceof Error ? e.message : "erro"}`);
    }
    return { ok: true, message: "Pronto. Agora clique em “Mostrar QR Code” e leia com o celular da clínica." };
  });
}

export async function evolutionQrAction(): Promise<{ image: string | null; pairingCode: string | null; state: string; error?: string }> {
  const ctx = await actionCtx("integrations.manage");
  const conf = await evoConfig(ctx);
  if (!conf) return { image: null, pairingCode: null, state: "close", error: "Salve os dados da Evolution primeiro." };
  try {
    const state = await evolutionState(conf.cfg);
    if (state === "open") return { image: null, pairingCode: null, state };
    const qr = await evolutionQr(conf.cfg);
    return { ...qr, state };
  } catch (e) {
    return { image: null, pairingCode: null, state: "close", error: e instanceof Error ? e.message : "Erro ao falar com a Evolution." };
  }
}

export async function evolutionStatusAction(): Promise<{ state: string }> {
  const ctx = await actionCtx("integrations.manage");
  const conf = await evoConfig(ctx);
  if (!conf) return { state: "close" };
  const state = await evolutionState(conf.cfg).catch(() => "close" as const);
  if (state === "open") await q(ctx, (tx) => tx`update clinic_integrations set evo_connected_at = coalesce(evo_connected_at, now()) where clinic_id = ${ctx.clinicId}`);
  return { state };
}

export async function evolutionLogoutAction(): Promise<ActionState> {
  return act("integrations.manage", PATH, async (ctx) => {
    const conf = await evoConfig(ctx);
    if (conf) await evolutionLogout(conf.cfg).catch(() => undefined);
    await q(ctx, (tx) => tx`update clinic_integrations set evo_connected_at = null where clinic_id = ${ctx.clinicId}`);
    return { ok: true, message: "Celular desconectado." };
  });
}

export async function useOfficialWhatsAppAction(): Promise<ActionState> {
  return act("integrations.manage", [PATH, "/"], async (ctx) => {
    await q(ctx, async (tx) => {
      await tx`update clinic_integrations set wa_provider = 'cloud' where clinic_id = ${ctx.clinicId}`;
      await audit(tx, actorOf(ctx), "whatsapp.provider", "clinic_integrations", ctx.clinicId, null, { wa_provider: "cloud" });
    });
  });
}

// ───────────── WhatsApp por QR Code no gateway wacli ─────────────

async function wacliSetup(ctx: { authUserId: string; clinicId: string }) {
  const [row] = await q(ctx, (tx) => tx<{ wacli_gateway_url: string | null; wacli_gateway_token_enc: string | null; wacli_webhook_token: string; wacli_webhook_secret_enc: string | null }[]>`
    select wacli_gateway_url, wacli_gateway_token_enc, wacli_webhook_token, wacli_webhook_secret_enc from clinic_integrations`);
  if (!row) return null;
  const gateway = wacliGateway(ctx.clinicId, row);
  return gateway ? { gateway, row } : null;
}

/** Usa o gateway da plataforma ou o informado pela clínica, cria o segredo do webhook e começa o pareamento. */
export async function connectWacliAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("integrations.manage", [PATH, "/"], async (ctx) => {
    const url = optStr(form, "gatewayUrl")?.replace(/\/+$/, "") ?? null;
    const token = optStr(form, "gatewayToken");
    if (url && !/^https:\/\//.test(url) && !url.startsWith("http://localhost")) throw new UserError("Use um endereço https:// para o gateway.");
    if (url) await assertPublicUrl(url).catch((e: unknown) => { throw new UserError(e instanceof Error ? e.message : "Endereço não permitido."); });
    const phone = optStr(form, "phone")?.replace(/\D/g, "") ?? null;
    if (phone && (phone.length < 12 || phone.length > 13)) throw new UserError("Informe o número com DDI e DDD, ex.: 55 11 98765-4321.");
    await q(ctx, async (tx) => {
      const [cur] = await tx<{ wacli_gateway_token_enc: string | null; wacli_webhook_secret_enc: string | null }[]>`select wacli_gateway_token_enc, wacli_webhook_secret_enc from clinic_integrations`;
      const secret = cur?.wacli_webhook_secret_enc ?? encryptField(randomBytes(32).toString("hex"));
      await tx`update clinic_integrations set wa_provider = 'wacli', wacli_webhook_secret_enc = ${secret}, wa_last_error = null,
                 wacli_gateway_url = ${url}, wacli_gateway_token_enc = ${url ? (token ? encryptField(token) : cur?.wacli_gateway_token_enc ?? null) : null}
               where clinic_id = ${ctx.clinicId}`;
      await audit(tx, actorOf(ctx), "whatsapp.wacli", "clinic_integrations", ctx.clinicId, null, { own_gateway: !!url, by_phone_code: !!phone });
    });
    const setup = await wacliSetup(ctx);
    if (!setup) throw new UserError("Não há gateway wacli configurado. Peça ao suporte da plataforma ou informe o endereço e a chave do seu.");
    const secret = decryptField(setup.row.wacli_webhook_secret_enc);
    if (!secret) throw new UserError("Não foi possível preparar o segredo do webhook.");
    try {
      const r = await wacliConnect(setup.gateway, `${env.appUrl}/api/webhooks/wacli/${setup.row.wacli_webhook_token}`, secret, phone);
      return { ok: true, message: r.state === "connected" ? "WhatsApp já estava pareado e foi religado." : phone ? "Pronto. Veja o código ao lado e digite no celular." : "Pronto. Leia o QR Code ao lado com o celular da clínica." };
    } catch (e) {
      throw new UserError(`O gateway não respondeu como esperado: ${e instanceof Error ? e.message : "erro"}`);
    }
  });
}

/** Estado do pareamento, com o QR Code já desenhado como imagem. */
export async function wacliStatusAction(): Promise<{ state: string; image: string | null; pairCode: string | null; error: string | null }> {
  const ctx = await actionCtx("integrations.manage");
  const setup = await wacliSetup(ctx);
  if (!setup) return { state: "idle", image: null, pairCode: null, error: "Gateway wacli não configurado." };
  try {
    const s = await wacliStatus(setup.gateway);
    const image = s.qr ? await QRCode.toDataURL(s.qr, { margin: 1, width: 280 }) : null;
    if (s.state === "connected") await q(ctx, (tx) => tx`update clinic_integrations set wacli_connected_at = coalesce(wacli_connected_at, now()) where clinic_id = ${ctx.clinicId}`);
    return { state: s.state, image, pairCode: s.pairCode, error: s.error };
  } catch (e) {
    return { state: "error", image: null, pairCode: null, error: e instanceof Error ? e.message : "Gateway inacessível." };
  }
}

export async function wacliLogoutAction(): Promise<ActionState> {
  return act("integrations.manage", PATH, async (ctx) => {
    const setup = await wacliSetup(ctx);
    if (setup) await wacliLogout(setup.gateway).catch(() => undefined);
    await q(ctx, async (tx) => {
      await tx`update clinic_integrations set wacli_connected_at = null where clinic_id = ${ctx.clinicId}`;
      await audit(tx, actorOf(ctx), "whatsapp.wacli_logout", "clinic_integrations", ctx.clinicId, null, null);
    });
    return { ok: true, message: "WhatsApp desconectado e sessão apagada do gateway." };
  });
}

// ───────────── Provedor de IA ─────────────

const llmSchema = z.object({
  provider: z.enum(["platform", "anthropic", "openrouter", "openai_compatible"]),
  model: z.string().trim().max(120).optional(),
  baseUrl: z.string().trim().url("Endereço inválido").optional(),
});

async function llmFromForm(ctx: { authUserId: string }, form: FormData): Promise<LlmSettings> {
  const p = llmSchema.parse({ provider: form.get("provider"), model: optStr(form, "model") ?? undefined, baseUrl: optStr(form, "baseUrl") ?? undefined });
  const typed = optStr(form, "apiKey");
  const [row] = await q(ctx, (tx) => tx<{ llm_provider: string; llm_api_key_enc: string | null }[]>`select llm_provider, llm_api_key_enc from clinic_integrations`);
  // Chave em branco = mantém a salva, desde que seja do mesmo provedor.
  const stored = row?.llm_provider === p.provider ? decryptField(row.llm_api_key_enc) : null;
  const freeAuto = p.provider === "openrouter" && bool(form, "freeAuto");
  const fallbackModels = [...new Set(form.getAll("fallback").map((v) => String(v).trim()).filter((v) => v && v.length <= 120))].slice(0, 5);
  return { provider: p.provider, apiKey: typed ?? stored, model: freeAuto ? null : p.model ?? null, baseUrl: p.provider === "openai_compatible" ? p.baseUrl ?? null : null, freeAuto, fallbackModels: p.provider === "anthropic" ? [] : fallbackModels };
}

export async function saveLlmAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("ai.configure", [PATH, "/"], async (ctx) => {
    const s = await llmFromForm(ctx, form);
    if (s.baseUrl) await assertPublicUrl(s.baseUrl).catch((e: unknown) => { throw new UserError(e instanceof Error ? e.message : "Endereço não permitido."); });
    if (s.provider !== "platform") {
      if (!s.apiKey) throw new UserError("Informe a chave de API do provedor.");
      if (!s.model && !s.freeAuto) throw new UserError("Escolha o modelo (use “Carregar modelos”).");
      if (s.provider === "openai_compatible" && !s.baseUrl) throw new UserError("Informe o endereço da API.");
    }
    const typed = optStr(form, "apiKey");
    await q(ctx, async (tx) => {
      await tx`update clinic_integrations set llm_provider = ${s.provider}, llm_model = ${s.model}, llm_base_url = ${s.baseUrl},
                 llm_free_auto = ${!!s.freeAuto}, llm_fallback_models = ${s.fallbackModels ?? []},
                 llm_api_key_enc = ${s.provider === "platform" ? null : typed ? encryptField(typed) : tx`llm_api_key_enc`}, llm_last_error = null
               where clinic_id = ${ctx.clinicId}`;
      await audit(tx, actorOf(ctx), "ai.provider", "clinic_integrations", ctx.clinicId, null, { provider: s.provider, model: s.model, free_auto: !!s.freeAuto, fallback_models: s.fallbackModels ?? [], key_changed: !!typed });
    });
    return { ok: true, message: "Provedor de IA salvo. Vale a partir da próxima resposta." };
  });
}

export async function listModelsAction(form: FormData): Promise<{ models: string[]; error?: string }> {
  const ctx = await actionCtx("ai.configure");
  try {
    const s = await llmFromForm(ctx, form);
    if (s.provider === "platform") return { models: [] };
    if (s.provider === "anthropic") {
      if (!s.apiKey) return { models: [], error: "Informe a chave primeiro." };
      return { models: await listClaudeModels(s.apiKey) };
    }
    const base = s.provider === "openrouter" ? OPENROUTER_URL : s.baseUrl;
    if (!base) return { models: [], error: "Informe o endereço da API." };
    return { models: await listOpenAiModels(base, s.apiKey) };
  } catch (e) {
    return { models: [], error: e instanceof ZodError ? e.issues[0]?.message ?? "Dados inválidos." : "Não foi possível carregar os modelos. Confira a chave e o endereço." };
  }
}

/** Modelos gratuitos do OpenRouter com suporte a ferramentas, do maior contexto para o menor. */
export async function listFreeModelsAction(form: FormData): Promise<{ models: { id: string; context: number }[]; error?: string }> {
  const ctx = await actionCtx("ai.configure");
  try {
    const s = await llmFromForm(ctx, form);
    if (!s.apiKey) return { models: [], error: "Informe a chave do OpenRouter primeiro." };
    return { models: await listOpenRouterFreeModels(OPENROUTER_URL, s.apiKey) };
  } catch {
    return { models: [], error: "Não foi possível consultar o OpenRouter. Confira a chave." };
  }
}

export async function testLlmAction(form: FormData): Promise<{ ok: boolean; message: string }> {
  const ctx = await actionCtx("ai.configure");
  try {
    const s = await llmFromForm(ctx, form);
    const provider = buildProvider(s);
    if (!provider) return { ok: false, message: s.provider === "platform" ? "A plataforma ainda não tem uma chave de IA configurada." : "Preencha chave e modelo." };
    const started = Date.now();
    const r = await provider.complete({ system: "Responda apenas: ok", messages: [{ role: "user", content: "Teste de conexão." }], tools: [] });
    const text = r.blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    await q(ctx, (tx) => tx`update clinic_integrations set llm_checked_at = now(), llm_last_error = null where clinic_id = ${ctx.clinicId}`);
    return { ok: true, message: `Funcionou em ${((Date.now() - started) / 1000).toFixed(1)} s. Modelo: ${r.model}. Resposta: “${text.slice(0, 60) || "(vazia)"}”.` };
  } catch (e) {
    const msg = e instanceof LlmUnavailableError ? e.message : e instanceof ZodError ? e.issues[0]?.message ?? "Dados inválidos." : "Falhou. Confira a chave, o modelo e o endereço.";
    await q(ctx, (tx) => tx`update clinic_integrations set llm_last_error = ${msg} where clinic_id = ${ctx.clinicId}`).catch(() => undefined);
    return { ok: false, message: msg };
  }
}

// ───────────── Google Meu Negócio ─────────────

export async function saveGoogleAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("settings.manage", [PATH, "/indicadores", "/automacoes"], async (ctx) => {
    let next: { google_business_url: string | null; google_review_url: string | null; google_place_id: string | null };
    try {
      next = {
        google_business_url: normalizeGoogleUrl(optStr(form, "businessUrl"), "Link do perfil"),
        google_review_url: normalizeGoogleUrl(optStr(form, "reviewUrl"), "Link de avaliação"),
        google_place_id: extractPlaceId(optStr(form, "placeId")),
      };
    } catch (e) { if (e instanceof ContactError) throw new UserError(e.message); throw e; }
    await q(ctx, async (tx) => {
      await tx`update clinics set ${tx(next)} where id = ${ctx.clinicId}`;
      await audit(tx, actorOf(ctx), "clinic.google", "clinics", ctx.clinicId, null, next);
    });
    return { ok: true, message: reviewLink(next) ? "Google salvo. O link e o QR code já estão prontos." : "Google salvo." };
  });
}

/** Procura a clínica no Google pelo nome/endereço (precisa de GOOGLE_PLACES_API_KEY). */
export async function searchGooglePlaceAction(query: string): Promise<{ error?: string; places: { id: string; name: string; address: string; rating: number | null; reviewCount: number }[] }> {
  await actionCtx("settings.manage");
  if (!env.googlePlacesKey) return { error: "A busca automática não está ativa na plataforma. Cole o link de avaliação.", places: [] };
  const term = query.trim().slice(0, 200);
  if (term.length < 3) return { error: "Digite o nome da clínica e a cidade.", places: [] };
  try { return { places: await searchPlaces(term) }; } catch (e) { return { error: e instanceof Error ? e.message : "Falha ao buscar no Google.", places: [] }; }
}

/** Registro manual da nota e do total de avaliações (quando não há busca automática ou para corrigir o dia). */
export async function saveReviewSnapshotAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("settings.manage", ["/indicadores", PATH], async (ctx) => {
    const count = z.coerce.number({ message: "Informe o total de avaliações." }).int("Use um número inteiro.").min(0).max(1_000_000).parse(form.get("count"));
    const ratingRaw = optStr(form, "rating");
    const rating = ratingRaw == null ? null : z.coerce.number({ message: "Nota inválida." }).min(1, "A nota vai de 1 a 5.").max(5, "A nota vai de 1 a 5.").parse(ratingRaw.replace(",", "."));
    const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida.").parse(str(form, "day"));
    await q(ctx, async (tx) => {
      await tx`insert into google_review_snapshots (clinic_id, taken_on, rating, review_count, source, created_by)
               values (${ctx.clinicId}, ${day}, ${rating == null ? null : Math.round(rating * 10) / 10}, ${count}, 'manual', ${ctx.userId})
               on conflict (clinic_id, taken_on) do update set rating = excluded.rating, review_count = excluded.review_count, source = 'manual', created_by = excluded.created_by`;
    });
    return { ok: true, message: "Avaliações registradas." };
  });
}


// ───────────── Paciente irritado ─────────────

export async function saveIrritationAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("ai.configure", [PATH], async (ctx) => {
    const current = parseSettings(ctx.clinic.settings);
    const extra = str(form, "extra").split("\n").map((k) => k.trim()).filter((k) => k.length >= 2).slice(0, 100);
    const message = str(form, "message").slice(0, 500);
    const settings = settingsSchema.parse({
      ...current,
      irritation: { enabled: bool(form, "enabled"), profanity: bool(form, "profanity"), harsh: bool(form, "harsh"), caps: bool(form, "caps"), exclamations: bool(form, "exclamations"), urgent: bool(form, "urgent"), extra, message },
    });
    await q(ctx, async (tx) => {
      await tx`update clinics set settings = ${tx.json(settings as never)} where id = ${ctx.clinicId}`;
      await audit(tx, actorOf(ctx), "ai.irritation", "clinics", ctx.clinicId, current.irritation, settings.irritation);
    });
    return { ok: true, message: "Detecção de paciente irritado salva." };
  });
}

// ───────────── Google Agenda (iCal) ─────────────

const CAL_PATHS = [PATH, "/agenda"];

/** Puxar: a clínica cola o "Endereço secreto no formato iCal" do Google Agenda; testamos na hora. */
export async function addCalendarImportAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("settings.manage", CAL_PATHS, async (ctx) => {
    const raw = str(form, "url").replace(/^webcal:/i, "https:");
    let url: URL;
    try { url = await assertPublicUrl(raw); } catch (e) { throw new UserError(e instanceof Error ? e.message : "Endereço inválido."); }
    const professionalId = optStr(form, "professionalId");
    const label = (optStr(form, "label") ?? (url.hostname.includes("google") ? "Google Agenda" : "Agenda externa")).slice(0, 60);
    const result = await q(ctx, async (tx) => {
      if (professionalId) z.string().uuid().parse(professionalId);
      const [imp] = await tx<{ id: string; clinic_id: string; professional_id: string | null; url_enc: string }[]>`
        insert into calendar_imports (clinic_id, professional_id, label, url_enc) values (${ctx.clinicId}, ${professionalId}, ${label}, ${encryptField(url.toString())})
        returning id, clinic_id, professional_id, url_enc`;
      await audit(tx, actorOf(ctx), "calendar.import.add", "calendar_imports", imp!.id, null, { label, professional_id: professionalId });
      return syncCalendarImport(tx, imp!);
    });
    if (!result.ok) return { ok: true, message: `Agenda salva, mas a leitura falhou: ${result.error}` };
    return { ok: true, message: `Agenda conectada: ${result.count} compromisso(s) nos próximos 90 dias viraram bloqueios.` };
  });
}

export async function syncCalendarNowAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("settings.manage", CAL_PATHS, async (ctx) => {
    const id = z.string().uuid().parse(form.get("importId"));
    const result = await q(ctx, async (tx) => {
      const [imp] = await tx<{ id: string; clinic_id: string; professional_id: string | null; url_enc: string }[]>`select id, clinic_id, professional_id, url_enc from calendar_imports where id = ${id}`;
      if (!imp) throw new UserError("Agenda não encontrada.");
      return syncCalendarImport(tx, imp);
    });
    return result.ok ? { ok: true, message: `Sincronizado: ${result.count} compromisso(s).` } : { error: result.error ?? "Falha ao sincronizar." };
  });
}

export async function removeCalendarImportAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("settings.manage", CAL_PATHS, async (ctx) => {
    const id = z.string().uuid().parse(form.get("importId"));
    await q(ctx, async (tx) => {
      await tx`delete from calendar_imports where id = ${id}`; // os bloqueios importados saem junto (cascade)
      await audit(tx, actorOf(ctx), "calendar.import.remove", "calendar_imports", id, null, null);
    });
    return { ok: true, message: "Agenda desconectada e bloqueios removidos." };
  });
}

/** Espelhar: o que aparece no Google Agenda da clínica e troca do link secreto. */
export async function saveCalendarFeedAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("settings.manage", CAL_PATHS, async (ctx) => {
    const privacy = z.enum(["busy", "service", "name_service"]).parse(form.get("privacy"));
    const rotate = form.get("rotate") === "1";
    await q(ctx, async (tx) => {
      await tx`update clinic_integrations set calendar_feed_privacy = ${privacy}
               ${rotate ? tx`, calendar_feed_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')` : tx``}`;
      await audit(tx, actorOf(ctx), "calendar.feed", "clinic_integrations", ctx.clinicId, null, { privacy, rotated: rotate });
    });
    return { ok: true, message: rotate ? "Novo link gerado. O link antigo parou de funcionar: assine o novo no Google Agenda." : "Preferência salva. O Google atualiza a agenda em algumas horas." };
  });
}
