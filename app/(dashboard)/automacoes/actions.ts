"use server";

import { z } from "zod";
import { q } from "@/auth/session";
import type { ActionState } from "@/components/client";
import { parseSettings, settingsSchema } from "@/domain/settings";
import { act, actorOf, bool, str } from "@/lib/action";
import { audit, diff } from "@/services/audit";

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
