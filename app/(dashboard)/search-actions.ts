"use server";

import { getCtx, q } from "@/auth/session";
import { can } from "@/domain/permissions";
import { formatPhone } from "@/lib/format";

export type SearchResult = { kind: "paciente" | "conversa"; id: string; title: string; detail: string; href: string };

/** Busca global (⌘K): pacientes e conversas, respeitando o papel e a RLS do usuário. */
export async function searchAction(raw: string): Promise<SearchResult[]> {
  const ctx = await getCtx();
  const term = raw.trim().slice(0, 60);
  if (!ctx || term.length < 2) return [];
  const like = `%${term}%`;
  const digits = term.replace(/\D/g, "");
  const phoneLike = digits.length >= 4 ? `%${digits}%` : null;
  return q(ctx, async (tx) => {
    const out: SearchResult[] = [];
    if (can(ctx.role, "patients.view")) {
      const rows = await tx<{ id: string; full_name: string; phone: string | null }[]>`
        select p.id, p.full_name,
               (select ct.phone_e164 from contact_patient_links l join contacts ct on ct.id = l.contact_id where l.patient_id = p.id limit 1) as phone
        from patients p
        where p.merged_into_patient_id is null
          and (p.full_name ilike ${like} or (${phoneLike}::text is not null and exists (
                select 1 from contact_patient_links l join contacts ct on ct.id = l.contact_id where l.patient_id = p.id and ct.phone_e164 like ${phoneLike})))
        order by p.full_name limit 6`;
      for (const r of rows) out.push({ kind: "paciente", id: r.id, title: r.full_name, detail: r.phone ? formatPhone(r.phone) : "Sem telefone", href: `/pacientes/${r.id}` });
    }
    if (can(ctx.role, "conversations.view")) {
      const rows = await tx<{ id: string; name: string | null; phone: string; preview: string | null }[]>`
        select c.id, ct.wa_profile_name as name, ct.phone_e164 as phone, c.last_message_preview as preview
        from conversations c join contacts ct on ct.id = c.contact_id
        where c.state <> 'closed' and (ct.wa_profile_name ilike ${like} or (${phoneLike}::text is not null and ct.phone_e164 like ${phoneLike}))
        order by c.last_message_at desc nulls last limit 5`;
      for (const r of rows) out.push({ kind: "conversa", id: r.id, title: r.name ?? formatPhone(r.phone), detail: r.preview ?? "Conversa aberta", href: `/conversas?c=${r.id}` });
    }
    return out;
  });
}
