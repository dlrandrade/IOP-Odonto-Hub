"use server";

import { z } from "zod";
import { q } from "@/auth/session";
import type { ActionState } from "@/components/client";
import { act, actorOf, optStr, str, UserError } from "@/lib/action";
import { encryptField } from "@/lib/crypto";
import { normalizePhone } from "@/lib/format";
import { audit } from "@/services/audit";
import { ContactError, normalizeEmail, PATIENT_SOURCES } from "@/domain/contact";

const id = z.string().uuid();
const optDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

export async function savePatientAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("patients.write", "/pacientes", async (ctx) => {
    const fullName = str(form, "fullName");
    if (fullName.length < 3) throw new UserError("Informe o nome completo.");
    const birth = optDate.parse(optStr(form, "birthDate"));
    const patientId = optStr(form, "patientId");
    const cpf = optStr(form, "cpf");
    let email: string | null;
    try { email = normalizeEmail(optStr(form, "email")); } catch (e) { if (e instanceof ContactError) throw new UserError(e.message); throw e; }
    const source = z.enum(PATIENT_SOURCES).nullable().catch(null).parse(optStr(form, "source"));
    await q(ctx, async (tx) => {
      if (patientId) {
        await tx`update patients set full_name = ${fullName}, birth_date = ${birth}, notes = ${optStr(form, "notes")}, email = ${email}, source = ${source} where id = ${id.parse(patientId)}`;
        // CPF é opcional e só gravado criptografado; campo vazio mantém o valor atual.
        if (cpf) await tx`update patients set cpf_encrypted = ${encryptField(cpf.replace(/\D/g, ""))} where id = ${patientId}`;
        await audit(tx, actorOf(ctx), "patient.update", "patients", patientId, null, { full_name: fullName, cpf_changed: !!cpf });
        return;
      }
      const [p] = await tx<{ id: string }[]>`
        insert into patients (clinic_id, full_name, birth_date, notes, cpf_encrypted, email, source)
        values (${ctx.clinicId}, ${fullName}, ${birth}, ${optStr(form, "notes")}, ${cpf ? encryptField(cpf.replace(/\D/g, "")) : null}, ${email}, ${source}) returning id`;
      const phone = optStr(form, "phone");
      if (p && phone) {
        const [c] = await tx<{ id: string }[]>`
          insert into contacts (clinic_id, phone_e164, source) values (${ctx.clinicId}, ${normalizePhone(phone)}, 'manual')
          on conflict (clinic_id, phone_e164) do update set updated_at = now() returning id`;
        if (c) await tx`insert into contact_patient_links (clinic_id, contact_id, patient_id, relationship) values (${ctx.clinicId}, ${c.id}, ${p.id}, 'self') on conflict do nothing`;
      }
    });
  });
}

/** Mesclagem manual de duplicados: tudo do duplicado passa para o principal, com auditoria. */
export async function mergePatientsAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("patients.merge", "/pacientes", async (ctx) => {
    const keepId = id.parse(form.get("keepId"));
    const dupId = id.parse(form.get("duplicateId"));
    if (keepId === dupId) throw new UserError("Escolha dois cadastros diferentes.");
    await q(ctx, async (tx) => {
      const rows = await tx<{ id: string; full_name: string; birth_date: string | null }[]>`select id, full_name, birth_date::text from patients where id in ${tx([keepId, dupId])} and merged_into_patient_id is null`;
      if (rows.length !== 2) throw new UserError("Cadastro não encontrado ou já mesclado.");
      await tx`update appointments set patient_id = ${keepId} where patient_id = ${dupId}`;
      await tx`update opportunities set patient_id = ${keepId} where patient_id = ${dupId}`;
      await tx`delete from contact_patient_links d where d.patient_id = ${dupId} and exists (select 1 from contact_patient_links k where k.patient_id = ${keepId} and k.contact_id = d.contact_id)`;
      await tx`update contact_patient_links set patient_id = ${keepId} where patient_id = ${dupId}`;
      await tx`update patients set merged_into_patient_id = ${keepId} where id = ${dupId}`;
      await audit(tx, actorOf(ctx), "patient.merge", "patients", keepId, { duplicate: rows.find((r) => r.id === dupId) }, { kept: rows.find((r) => r.id === keepId) });
    });
    return { ok: true, message: "Cadastros mesclados." };
  });
}

export async function unlinkContactAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("patients.write", "/pacientes", async (ctx) => {
    await q(ctx, (tx) => tx`delete from contact_patient_links where id = ${id.parse(form.get("linkId"))}`);
  });
}
