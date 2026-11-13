"use server";

import { z } from "zod";
import { q } from "@/auth/session";
import type { ActionState } from "@/components/client";
import { OPPORTUNITY_STAGES } from "@/domain/states";
import { act, optStr, str, UserError } from "@/lib/action";
import { normalizePhone } from "@/lib/format";
import { moveOpportunity, registerInterest } from "@/services/crm";

const id = z.string().uuid();

export async function moveOpportunityAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("crm.write", "/crm", async (ctx) => {
    const r = await q(ctx, (tx) => moveOpportunity(tx, {
      clinicId: ctx.clinicId, opportunityId: id.parse(form.get("opportunityId")), to: z.enum(OPPORTUNITY_STAGES).parse(form.get("to")),
      actor: "user", actorUserId: ctx.userId, lostReason: optStr(form, "lostReason"), evidence: optStr(form, "evidence"),
    }));
    if (!r.ok) throw new UserError(r.message ?? "Movimento não permitido.");
  });
}

export async function updateOpportunityAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("crm.write", "/crm", async (ctx) => {
    const due = optStr(form, "nextStepDue");
    await q(ctx, (tx) => tx`
      update opportunities set next_step = ${optStr(form, "nextStep")}, next_step_due = ${due ? new Date(`${due}T12:00:00Z`) : null}, owner_id = ${optStr(form, "ownerId")}
      where id = ${id.parse(form.get("opportunityId"))}`);
  });
}

export async function createOpportunityAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("crm.write", "/crm", async (ctx) => {
    const interest = str(form, "interest");
    if (interest.length < 2) throw new UserError("Descreva o interesse.");
    await q(ctx, async (tx) => {
      let contactId = optStr(form, "contactId");
      const phone = optStr(form, "phone");
      if (!contactId && phone) {
        const [c] = await tx<{ id: string }[]>`
          insert into contacts (clinic_id, phone_e164, wa_profile_name, source) values (${ctx.clinicId}, ${normalizePhone(phone)}, ${optStr(form, "name")}, 'manual')
          on conflict (clinic_id, phone_e164) do update set updated_at = now() returning id`;
        contactId = c?.id ?? null;
      }
      if (!contactId) throw new UserError("Escolha um contato ou informe um telefone.");
      await registerInterest(tx, { clinicId: ctx.clinicId, contactId, serviceId: optStr(form, "serviceId"), text: interest, intent: "considerando", actor: "user", source: "manual" });
    });
  });
}
