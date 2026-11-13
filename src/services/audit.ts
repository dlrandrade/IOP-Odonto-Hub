import type { Sql } from "@/db/client";

export type Actor = { clinicId: string; userId: string | null; label: string };

/** Trilha de auditoria com antes/depois. Nunca registrar corpo de mensagem ou dado de saúde aqui. */
export async function audit(
  sql: Sql, actor: Actor, action: string, entity: string, entityId: string | null,
  before: Record<string, unknown> | null, after: Record<string, unknown> | null,
): Promise<void> {
  await sql`
    insert into audit_events (clinic_id, actor_id, actor_label, action, entity, entity_id, before, after)
    values (${actor.clinicId}, ${actor.userId}, ${actor.label}, ${action}, ${entity}, ${entityId},
            ${before ? sql.json(before as never) : null}, ${after ? sql.json(after as never) : null})`;
}

/** Só os campos que mudaram, para o antes/depois ficar legível. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    const x = before[k];
    const y = after[k];
    if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) { b[k] = x ?? null; a[k] = y ?? null; }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}
