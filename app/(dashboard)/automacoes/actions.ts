"use server";

import { z } from "zod";
import { q } from "@/auth/session";
import type { ActionState } from "@/components/client";
import { parseSettings, settingsSchema } from "@/domain/settings";
import { act, actorOf, bool, optStr, str, UserError } from "@/lib/action";
import { audit, diff } from "@/services/audit";
import { RULE_ACTIONS, RULE_TRIGGERS } from "@/services/automation-rules";
import type { Ctx } from "@/auth/session";
import type { ClinicSettings } from "@/domain/settings";
import { BUILTIN_KEYS, type BuiltinKey } from "@/domain/automation";

const id = z.string().uuid();
const PATH = "/automacoes";

export async function saveAutomationSettingsAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("automations.manage", PATH, async (ctx) => {
    const current = parseSettings(ctx.clinic.settings);
    const next = settingsSchema.parse({
      ...current,
      followupsEnabled: bool(form, "followupsEnabled"), remindersEnabled: bool(form, "remindersEnabled"),
      followup1Hours: form.get("followup1Hours"), followup2Hours: form.get("followup2Hours"),
      quietStartHour: form.get("quietStartHour"), quietEndHour: form.get("quietEndHour"), maxAutomatedPerDay: form.get("maxAutomatedPerDay"),
      followup1Text: str(form, "followup1Text") || current.followup1Text, followup2Text: str(form, "followup2Text") || current.followup2Text,
    });
    await q(ctx, async (tx) => {
      await tx`update clinics set settings = ${tx.json(next as never)} where id = ${ctx.clinicId}`;
      const changes = diff(current as Record<string, unknown>, next as Record<string, unknown>);
      if (changes) await audit(tx, actorOf(ctx), "automation.settings", "clinics", ctx.clinicId, changes.before, changes.after);
    });
    return { ok: true, message: "Regras salvas." };
  });
}

export async function saveTemplateAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("automations.manage", PATH, async (ctx) => {
    const status = z.enum(["not_submitted", "pending", "approved", "rejected"]).parse(form.get("status"));
    const body = z.string().min(5, "Escreva o texto do template.").parse(str(form, "body"));
    await q(ctx, async (tx) => {
      const templateId = id.parse(form.get("templateId"));
      const [before] = await tx<{ wa_template_status: string }[]>`select wa_template_status from message_templates where id = ${templateId}`;
      await tx`update message_templates set body = ${body}, wa_template_status = ${status} where id = ${templateId}`;
      if (before && before.wa_template_status !== status) await audit(tx, actorOf(ctx), "template.status", "message_templates", templateId, before, { wa_template_status: status });
    });
  });
}

export async function completeTaskAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("conversations.reply", [PATH, "/"], async (ctx) => {
    await q(ctx, (tx) => tx`update tasks set status = 'done' where id = ${id.parse(form.get("taskId"))}`);
  });
}

/* ───────────── Construtor visual ───────────── */

const ENABLED_FLAG: Record<BuiltinKey, keyof ClinicSettings> = {
  followup_1: "followupsEnabled", followup_2: "followup2Enabled", reminder: "remindersEnabled", confirmation: "confirmationEnabled",
};

async function writeSettings(ctx: Ctx, change: (s: ClinicSettings) => ClinicSettings, auditAction: string) {
  const current = parseSettings(ctx.clinic.settings);
  const next = settingsSchema.parse(change(structuredClone(current)));
  await q(ctx, async (tx) => {
    await tx`update clinics set settings = ${tx.json(next as never)} where id = ${ctx.clinicId}`;
    const changes = diff(current as Record<string, unknown>, next as Record<string, unknown>);
    if (changes) await audit(tx, actorOf(ctx), auditAction, "clinics", ctx.clinicId, changes.before, changes.after);
  });
}

/** Liga/desliga uma automação (nativa ou da clínica). */
export async function toggleAutomationAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("automations.manage", PATH, async (ctx) => {
    const key = str(form, "key");
    const on = bool(form, "on");
    if ((BUILTIN_KEYS as readonly string[]).includes(key)) {
      const flag = ENABLED_FLAG[key as BuiltinKey];
      await writeSettings(ctx, (s) => ({ ...s, [flag]: on }), "automation.toggle");
      return { ok: true, message: on ? "Automação ativada." : "Automação pausada." };
    }
    await q(ctx, async (tx) => {
      const ruleId = id.parse(key);
      await tx`update automation_rules set enabled = ${on} where id = ${ruleId}`;
      await audit(tx, actorOf(ctx), "automation.toggle", "automation_rules", ruleId, null, { enabled: on });
    });
    return { ok: true, message: on ? "Automação ativada." : "Automação pausada." };
  });
}

/** Nova ordem dos cartões (arrastar e soltar). */
export async function reorderAutomationsAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("automations.manage", PATH, async (ctx) => {
    const order = z.array(z.string().max(64)).max(200).parse(JSON.parse(str(form, "order") || "[]"));
    const current = parseSettings(ctx.clinic.settings);
    const next = settingsSchema.parse({ ...current, automationOrder: order });
    await q(ctx, (tx) => tx`update clinics set settings = ${tx.json(next as never)} where id = ${ctx.clinicId}`);
  });
}

/** Edita uma automação nativa: tempo de espera e, nos follow-ups, o texto. */
export async function saveBuiltinAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("automations.manage", PATH, async (ctx) => {
    const key = z.enum(BUILTIN_KEYS).parse(form.get("key"));
    const hours = z.coerce.number({ message: "Informe as horas." }).positive("As horas precisam ser maiores que zero.").parse(form.get("hours"));
    const text = str(form, "text");
    await writeSettings(ctx, (s) => {
      if (key === "followup_1") return { ...s, followup1Hours: hours, followup1Text: text || s.followup1Text };
      if (key === "followup_2") return { ...s, followup2Hours: hours, followup2Text: text || s.followup2Text };
      if (hours > 24 * 14) throw new UserError("Use no máximo 14 dias de antecedência.");
      const r = [...s.reminderHours];
      r[key === "reminder" ? 0 : 1] = hours;
      return { ...s, reminderHours: [r[0] ?? 48, r[1] ?? 24] };
    }, "automation.builtin");
    return { ok: true, message: "Automação salva. Vale para os próximos agendamentos e conversas." };
  });
}

/** Cria ou edita uma automação da clínica. */
export async function saveRuleAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("automations.manage", PATH, async (ctx) => {
    const trigger = z.enum(RULE_TRIGGERS, { message: "Escolha quando a automação acontece." }).parse(form.get("trigger"));
    const action = z.enum(RULE_ACTIONS, { message: "Escolha o que a automação faz." }).parse(form.get("action"));
    const name = z.string().min(3, "Dê um nome à automação.").max(80).parse(str(form, "name"));
    let offset: number;
    if (trigger === "birthday") {
      const m = str(form, "time").match(/^(\d{1,2}):(\d{2})$/);
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new UserError("Informe o horário do envio (ex.: 09:00).");
      offset = Number(m[1]) * 60 + Number(m[2]);
    } else {
      const amount = z.coerce.number({ message: "Informe o tempo de espera." }).min(0, "O tempo não pode ser negativo.").parse(form.get("amount"));
      const unit = z.enum(["minutes", "hours", "days"]).parse(form.get("unit"));
      offset = Math.round(amount * (unit === "days" ? 1440 : unit === "hours" ? 60 : 1));
      if (offset > 60 * 24 * 60) throw new UserError("Use no máximo 60 dias.");
    }
    const body = optStr(form, "body");
    const taskTitle = optStr(form, "taskTitle");
    if (action === "message" && (!body || body.length < 5)) throw new UserError("Escreva a mensagem que será enviada.");
    if (action === "task" && !taskTitle) throw new UserError("Escreva o título da tarefa.");
    const template = optStr(form, "templateName");
    const ruleId = optStr(form, "ruleId");
    await q(ctx, async (tx) => {
      if (ruleId) {
        const rid = id.parse(ruleId);
        await tx`update automation_rules set name = ${name}, trigger = ${trigger}, offset_minutes = ${offset}, action = ${action},
                   body = ${action === "message" ? body : null}, template_name = ${action === "message" ? template : null}, task_title = ${action === "task" ? taskTitle : null}
                 where id = ${rid}`;
        await audit(tx, actorOf(ctx), "automation.update", "automation_rules", rid, null, { name, trigger, offset, action });
      } else {
        const [r] = await tx<{ id: string }[]>`
          insert into automation_rules (clinic_id, name, trigger, offset_minutes, action, body, template_name, task_title, position)
          values (${ctx.clinicId}, ${name}, ${trigger}, ${offset}, ${action}, ${action === "message" ? body : null}, ${action === "message" ? template : null}, ${action === "task" ? taskTitle : null},
                  (select coalesce(max(position), 0) + 1 from automation_rules where clinic_id = ${ctx.clinicId}))
          returning id`;
        await audit(tx, actorOf(ctx), "automation.create", "automation_rules", r!.id, null, { name, trigger, offset, action });
      }
    });
    return { ok: true, message: ruleId ? "Automação salva." : "Automação criada e ativada." };
  });
}

export async function deleteRuleAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("automations.manage", PATH, async (ctx) => {
    const rid = id.parse(form.get("ruleId"));
    await q(ctx, async (tx) => {
      await tx`update scheduled_jobs set status = 'cancelled' where status = 'pending' and type = 'automation' and payload->>'ruleId' = ${rid}`;
      await tx`delete from automation_rules where id = ${rid}`;
      await audit(tx, actorOf(ctx), "automation.delete", "automation_rules", rid, null, null);
    });
    return { ok: true, message: "Automação excluída." };
  });
}

/** Limites que valem para todas as automações. */
export async function saveLimitsAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("automations.manage", PATH, async (ctx) => {
    await writeSettings(ctx, (s) => ({ ...s, quietStartHour: Number(form.get("quietStartHour")), quietEndHour: Number(form.get("quietEndHour")), maxAutomatedPerDay: Number(form.get("maxAutomatedPerDay")) }), "automation.limits");
    return { ok: true, message: "Limites salvos." };
  });
}
