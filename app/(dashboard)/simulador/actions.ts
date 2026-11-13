"use server";

import { after } from "next/server";
import { z } from "zod";
import type { ActionState } from "@/components/client";
import { db } from "@/db/client";
import { act, str, UserError } from "@/lib/action";
import { normalizePhone } from "@/lib/format";
import { ingestInbound } from "@/services/conversations";
import { runAfterDebounce } from "@/services/kick";
import { simulatorMessageId } from "@/services/webhook";

/** Mensagem do "paciente" entra pelo mesmo pipeline do WhatsApp (canal simulator), sem chamada externa. */
export async function simulateAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("simulator.use", ["/simulador", "/conversas"], async (ctx) => {
    const phone = normalizePhone(z.string().min(8).parse(str(form, "phone")));
    const kind = str(form, "kind") === "image" ? "image" : "text";
    const text = str(form, "text");
    if (kind === "text" && !text) throw new UserError("Escreva a mensagem do paciente.");
    await ingestInbound(db(), ctx.clinicId, "simulator", {
      waMessageId: simulatorMessageId(), from: phone, profileName: str(form, "name") || "Paciente (simulação)", timestamp: new Date(),
      type: kind, text: text || null, mediaId: null, mediaMime: null, rawType: kind,
    });
    after(() => runAfterDebounce([ctx.clinicId]));
  });
}

export async function resetSimulationAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("simulator.use", ["/simulador", "/conversas"], async (ctx) => {
    const phone = normalizePhone(str(form, "phone"));
    // Remove apenas contatos de teste desta clínica (conversas, consultas e vínculos criados na simulação).
    const sql = db();
    const [contact] = await sql<{ id: string }[]>`select id from contacts where clinic_id = ${ctx.clinicId} and phone_e164 = ${phone} and is_test`;
    if (!contact) return;
    await sql.begin(async (tx) => {
      await tx`delete from appointments where clinic_id = ${ctx.clinicId} and contact_id = ${contact.id}`;
      await tx`delete from patients where clinic_id = ${ctx.clinicId} and id in (select patient_id from contact_patient_links where contact_id = ${contact.id})
               and not exists (select 1 from contact_patient_links l2 where l2.patient_id = patients.id and l2.contact_id <> ${contact.id})`;
      await tx`delete from contacts where id = ${contact.id}`;
    });
  });
}
