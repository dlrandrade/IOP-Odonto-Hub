import QRCode from "qrcode";
import type { Sql } from "@/db/client";
import { env } from "@/lib/env";
import { localDate } from "@/lib/datetime";
import { fetchPlaceStats, reviewUrlFor } from "@/integrations/google/places";

/** Link que o paciente usa para avaliar: o informado pela clínica ou o montado pelo Place ID. */
export function reviewLink(c: { google_review_url: string | null; google_place_id: string | null }): string | null {
  return c.google_review_url ?? (c.google_place_id ? reviewUrlFor(c.google_place_id) : null);
}

/** QR code (SVG em data URL) para imprimir no balcão ou compartilhar. Cores fixas: precisa ler em qualquer celular. */
export async function qrDataUrl(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0a0e13", light: "#ffffff" } });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * Uma foto por dia da nota e do total de avaliações, para cada clínica com Place ID.
 * Roda junto com o worker; a chave única (clínica, dia) garante uma consulta ao Google por dia.
 */
export async function sweepGoogleReviews(sql: Sql, now: Date, fetcher?: typeof fetch): Promise<number> {
  if (!env.googlePlacesKey) return 0;
  const clinics = await sql<{ id: string; timezone: string; google_place_id: string }[]>`
    select c.id, c.timezone, c.google_place_id from clinics c
    where c.google_place_id is not null and c.status <> 'suspended'
      and not exists (select 1 from google_review_snapshots s where s.clinic_id = c.id and s.taken_on = (now() at time zone c.timezone)::date)`;
  let n = 0;
  for (const c of clinics.slice(0, 50)) {
    try {
      const stats = await fetchPlaceStats(c.google_place_id, fetcher);
      await sql`insert into google_review_snapshots (clinic_id, taken_on, rating, review_count, source)
                values (${c.id}, ${localDate(now, c.timezone)}, ${stats.rating}, ${stats.reviewCount}, 'google')
                on conflict (clinic_id, taken_on) do update set rating = excluded.rating, review_count = excluded.review_count, source = 'google'`;
      n++;
    } catch {
      // Falha pontual do Google não pode travar o worker; tenta de novo na próxima rodada.
    }
  }
  return n;
}

export type ReviewPoint = { day: string; rating: number | null; count: number };

/** Histórico para o gráfico: últimas fotos (uma por dia) e a variação no período. */
export async function loadReviewHistory(tx: Sql, days = 180): Promise<{ points: ReviewPoint[]; latest: ReviewPoint | null; growth30: number | null }> {
  const rows = await tx<{ day: string; rating: string | null; count: number }[]>`
    select taken_on::text as day, rating::text, review_count as count from google_review_snapshots
    where taken_on >= current_date - ${days}::int order by taken_on`;
  const points = rows.map((r) => ({ day: r.day, rating: r.rating == null ? null : Number(r.rating), count: r.count }));
  const latest = points.at(-1) ?? null;
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const base = [...points].reverse().find((p) => p.day <= cutoff) ?? points[0];
  return { points, latest, growth30: latest && base && base !== latest ? latest.count - base.count : null };
}
