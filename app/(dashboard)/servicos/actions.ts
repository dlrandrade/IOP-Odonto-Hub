"use server";

import { z } from "zod";
import { q } from "@/auth/session";
import type { ActionState } from "@/components/client";
import { act, actorOf, bool, optStr, str, UserError } from "@/lib/action";
import { parseBrlToCents } from "@/lib/format";
import { audit, diff } from "@/services/audit";

const id = z.string().uuid();
const PATHS = ["/servicos", "/"];

export async function saveServiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("catalog.publish", PATHS, async (ctx) => {
    const priceMode = z.enum(["fixed", "range", "on_evaluation"]).parse(form.get("priceMode"));
    const min = parseBrlToCents(str(form, "priceMin"));
    const max = parseBrlToCents(str(form, "priceMax"));
    if (priceMode === "fixed" && min == null) throw new UserError("Informe o valor do serviço.");
    if (priceMode === "range" && (min == null || max == null || max < min)) throw new UserError("Informe a faixa de preço (mínimo e máximo).");
    const bookable = bool(form, "bookable");
    const leadsTo = optStr(form, "leadsTo");
    const status = z.enum(["draft", "published"]).parse(form.get("status"));
    const next = {
      name: z.string().min(2, "Informe o nome.").parse(str(form, "name")),
      specialty: optStr(form, "specialty"),
      kind: z.enum(["evaluation", "procedure", "return"]).parse(form.get("kind")),
      duration_min: z.coerce.number().int().min(5).max(600).parse(form.get("duration")),
      buffer_min: z.coerce.number().int().min(0).max(120).parse(form.get("buffer") || 0),
      price_mode: priceMode,
      price_min_cents: priceMode === "on_evaluation" ? null : min,
      price_max_cents: priceMode === "range" ? max : null,
      bookable_directly: bookable,
      leads_to_evaluation_service_id: bookable ? null : leadsTo,
      patient_description: optStr(form, "description"),
      preparation: optStr(form, "preparation"),
      status,
    };
    const professionalIds = form.getAll("professionals").map((v) => id.parse(v));
    const serviceId = optStr(form, "serviceId");
    await q(ctx, async (tx) => {
      let sid = serviceId;
      if (sid) {
        const [before] = await tx<Record<string, unknown>[]>`select * from services where id = ${id.parse(sid)}`;
        if (!before) throw new UserError("Serviço não encontrado.");
        const publishing = status === "published" && before.status !== "published";
        await tx`update services set ${tx(next)}, version = version + 1,
                   approved_by = ${publishing ? ctx.userId : (before.approved_by as string | null)}, approved_at = ${publishing ? tx`now()` : tx`approved_at`}
                 where id = ${sid}`;
        const changes = diff(before, next);
        // Alteração de preço e publicação ficam auditadas com antes/depois e autor.
        if (changes) await audit(tx, actorOf(ctx), "service.update", "services", sid, changes.before, changes.after);
      } else {
        const [row] = await tx<{ id: string }[]>`
          insert into services ${tx({ ...next, clinic_id: ctx.clinicId, approved_by: status === "published" ? ctx.userId : null, approved_at: status === "published" ? new Date() : null })} returning id`;
        sid = row?.id ?? null;
        if (sid) await audit(tx, actorOf(ctx), "service.create", "services", sid, null, next);
      }
      if (!sid) throw new UserError("Não foi possível salvar.");
      await tx`delete from service_professionals where service_id = ${sid}`;
      for (const pid of professionalIds) await tx`insert into service_professionals (clinic_id, service_id, professional_id) values (${ctx.clinicId}, ${sid}, ${pid})`;
    });
  });
}

export async function saveDocAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act("catalog.publish", PATHS, async (ctx) => {
    const title = z.string().min(2, "Informe o título.").parse(str(form, "title"));
    const body = str(form, "body");
    const status = z.enum(["draft", "published"]).parse(form.get("status"));
    if (status === "published" && body.length < 5) throw new UserError("Escreva o conteúdo antes de publicar.");
    const docId = optStr(form, "docId");
    await q(ctx, async (tx) => {
      let did = docId;
      let version = 1;
      if (did) {
        const [before] = await tx<{ title: string; body: string; status: string; version: number }[]>`select title, body, status, version from knowledge_docs where id = ${id.parse(did)}`;
        if (!before) throw new UserError("Documento não encontrado.");
        version = before.version + 1;
        const publishing = status === "published";
        await tx`update knowledge_docs set title = ${title}, body = ${body}, status = ${status}, version = ${version}, author_id = ${ctx.userId},
                   approved_by = ${publishing ? ctx.userId : null}, approved_at = ${publishing ? new Date() : null} where id = ${did}`;
        await audit(tx, actorOf(ctx), "knowledge.update", "knowledge_docs", did, { title: before.title, status: before.status, version: before.version }, { title, status, version });
      } else {
        const [row] = await tx<{ id: string }[]>`
          insert into knowledge_docs (clinic_id, title, body, status, author_id, approved_by, approved_at)
          values (${ctx.clinicId}, ${title}, ${body}, ${status}, ${ctx.userId}, ${status === "published" ? ctx.userId : null}, ${status === "published" ? new Date() : null}) returning id`;
        did = row?.id ?? null;
      }
      if (!did) throw new UserError("Não foi possível salvar.");
      await tx`insert into knowledge_doc_versions (clinic_id, doc_id, version, title, body, status, author_id, approved_by)
               values (${ctx.clinicId}, ${did}, ${version}, ${title}, ${body}, ${status}, ${ctx.userId}, ${status === "published" ? ctx.userId : null})`;
    });
  });
}
