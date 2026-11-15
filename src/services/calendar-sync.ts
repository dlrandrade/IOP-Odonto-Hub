import { inTx, type Sql } from "@/db/client";
import { busyIntervals, parseIcs } from "@/domain/ical";
import { decryptField } from "@/lib/crypto";
import { assertPublicUrl } from "@/lib/safe-url";

/**
 * Puxar compromissos de uma agenda externa (Google Agenda pelo "endereço secreto no formato iCal").
 * Cada sincronização substitui os bloqueios daquela importação nos próximos 90 dias.
 */
const MAX_BYTES = 5 * 1024 * 1024;
const WINDOW_DAYS = 90;

/** Baixa o iCal seguindo no máximo 3 redirecionamentos, todos conferidos contra endereços internos. */
export async function fetchIcs(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  let current = url;
  for (let i = 0; i < 4; i++) {
    await assertPublicUrl(current);
    const res = await fetcher(current, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { accept: "text/calendar, */*" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { current = new URL(res.headers.get("location")!, current).toString(); continue; }
    if (res.status === 404) throw new Error("Agenda não encontrada. Confira se copiou o endereço secreto completo.");
    if (!res.ok) throw new Error(`A agenda respondeu ${res.status}.`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("Agenda grande demais para importar.");
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error("O endereço não é de uma agenda iCal. Use o “Endereço secreto no formato iCal”.");
    return text;
  }
  throw new Error("Redirecionamentos demais.");
}

type ImportRow = { id: string; clinic_id: string; professional_id: string | null; url_enc: string };

export async function syncCalendarImport(sql: Sql, imp: ImportRow, now: Date = new Date(), fetcher?: typeof fetch): Promise<{ ok: boolean; count: number; error?: string }> {
  const [clinic] = await sql<{ timezone: string }[]>`select timezone from clinics where id = ${imp.clinic_id}`;
  const tz = clinic?.timezone ?? "America/Sao_Paulo";
  try {
    const url = decryptField(imp.url_enc);
    if (!url) throw new Error("Endereço da agenda indisponível. Cadastre de novo.");
    const text = await fetchIcs(url, fetcher);
    const from = new Date(now.getTime() - 86_400_000);
    const to = new Date(now.getTime() + WINDOW_DAYS * 86_400_000);
    const busy = busyIntervals(parseIcs(text), from, to, tz).slice(0, 3000);
    await inTx(sql, async (tx) => {
      await tx`delete from time_blocks where import_id = ${imp.id} and clinic_id = ${imp.clinic_id}`;
      for (const b of busy) {
        await tx`insert into time_blocks (clinic_id, professional_id, during, reason, import_id, external_uid)
                 values (${imp.clinic_id}, ${imp.professional_id}, tstzrange(${b.start}, ${b.end}, '[)'), ${`Google Agenda${b.summary ? `: ${b.summary.slice(0, 60)}` : ""}`}, ${imp.id}, ${b.uid.slice(0, 300)})`;
      }
      await tx`update calendar_imports set last_synced_at = ${now}, last_error = null, events_count = ${busy.length} where id = ${imp.id}`;
    });
    return { ok: true, count: busy.length };
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 300) : "Falha ao ler a agenda.";
    await sql`update calendar_imports set last_synced_at = ${now}, last_error = ${error} where id = ${imp.id}`;
    return { ok: false, count: 0, error };
  }
}

/** Worker: sincroniza cada agenda importada a cada 15 minutos. */
export async function sweepCalendarImports(sql: Sql, now: Date = new Date()): Promise<number> {
  const rows = await sql<ImportRow[]>`
    select i.id, i.clinic_id, i.professional_id, i.url_enc from calendar_imports i join clinics c on c.id = i.clinic_id
    where i.active and c.status <> 'suspended' and (i.last_synced_at is null or i.last_synced_at < ${new Date(now.getTime() - 15 * 60_000)})
    order by i.last_synced_at nulls first limit 20`;
  for (const r of rows) await syncCalendarImport(sql, r, now);
  return rows.length;
}
