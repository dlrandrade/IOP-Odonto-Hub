import { db } from "@/db/client";
import { buildIcs } from "@/domain/ical";

export const dynamic = "force-dynamic";

/**
 * Agenda da clínica em iCal, para assinar no Google Agenda ("Adicionar agenda → Do URL").
 * O token secreto na URL é a única credencial: pode ser trocado em Configurações → Agenda.
 * ?dentista=<id> restringe a um profissional. O título segue a privacidade escolhida pela clínica.
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token.replace(/\.ics$/i, "");
  if (!/^[a-f0-9]{64}$/.test(token)) return new Response("Não encontrado", { status: 404 });
  const sql = db();
  const [integ] = await sql<{ clinic_id: string; privacy: "busy" | "service" | "name_service"; name: string; status: string }[]>`
    select i.clinic_id, i.calendar_feed_privacy as privacy, c.name, c.status from clinic_integrations i join clinics c on c.id = i.clinic_id
    where i.calendar_feed_token = ${token}`;
  if (!integ || integ.status === "suspended") return new Response("Não encontrado", { status: 404 });
  const dentist = new URL(req.url).searchParams.get("dentista");
  const professionalId = dentist && /^[0-9a-f-]{36}$/.test(dentist) ? dentist : null;
  const rows = await sql<{ id: string; starts_at: Date; ends_at: Date; status: string; service: string; professional: string; patient: string }[]>`
    select a.id, a.starts_at, a.ends_at, a.status, s.name as service, pr.name as professional, p.full_name as patient
    from appointments a join services s on s.id = a.service_id join professionals pr on pr.id = a.professional_id join patients p on p.id = a.patient_id
    where a.clinic_id = ${integ.clinic_id} and a.status not in ('cancelled') and a.starts_at > now() - interval '30 days' and a.starts_at < now() + interval '180 days'
      ${professionalId ? sql`and a.professional_id = ${professionalId}` : sql``}
    order by a.starts_at limit 5000`;
  const first = (n: string) => n.split(/\s+/)[0] ?? n;
  const ics = buildIcs(`${integ.name} · Odonto Hub`, rows.map((r) => ({
    id: r.id, start: r.starts_at, end: r.ends_at, tentative: r.status === "scheduled",
    summary: integ.privacy === "busy" ? "Ocupado" : integ.privacy === "service" ? `${r.service} · ${r.professional}` : `${first(r.patient)} · ${r.service}`,
    description: integ.privacy === "busy" ? null : `${r.service} com ${r.professional}${r.status === "confirmed" ? " (confirmada)" : ""}`,
  })));
  return new Response(ics, {
    headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=300", "x-robots-tag": "noindex", "content-disposition": "inline; filename=agenda.ics" },
  });
}
