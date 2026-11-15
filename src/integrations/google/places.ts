import { env } from "@/lib/env";

/**
 * Google Meu Negócio (Perfil da Empresa) pela Places API (New): nota média e total de avaliações.
 * Só leitura pública; não exige acesso à conta do Google da clínica.
 */
export type PlaceStats = { rating: number | null; reviewCount: number };

/** Place IDs do Google: letras, números, "-" e "_" (ex.: ChIJN1t_tDeuEmsRUsoyG83frY4). */
export const isPlaceId = (v: string) => /^[A-Za-z0-9_-]{10,300}$/.test(v);

/** Link direto para o paciente escrever uma avaliação, montado a partir do Place ID. */
export const reviewUrlFor = (placeId: string) => `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
export const mapsUrlFor = (placeId: string) => `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;

export async function fetchPlaceStats(placeId: string, fetcher: typeof fetch = fetch): Promise<PlaceStats> {
  const key = env.googlePlacesKey;
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY não configurada.");
  if (!isPlaceId(placeId)) throw new Error("Place ID inválido.");
  const res = await fetcher(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "rating,userRatingCount" },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  const json = (await res.json().catch(() => ({}))) as { rating?: number; userRatingCount?: number; error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `Google respondeu ${res.status}`);
  return { rating: typeof json.rating === "number" ? Math.round(json.rating * 10) / 10 : null, reviewCount: json.userRatingCount ?? 0 };
}

/** Busca o lugar pelo nome e endereço (para a clínica não precisar descobrir o Place ID). */
export async function searchPlaces(query: string, fetcher: typeof fetch = fetch): Promise<{ id: string; name: string; address: string; rating: number | null; reviewCount: number }[]> {
  const key = env.googlePlacesKey;
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY não configurada.");
  const res = await fetcher("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount", "content-type": "application/json" },
    body: JSON.stringify({ textQuery: query.slice(0, 200), languageCode: "pt-BR", regionCode: "BR", pageSize: 5 }),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  const json = (await res.json().catch(() => ({}))) as { places?: { id: string; displayName?: { text?: string }; formattedAddress?: string; rating?: number; userRatingCount?: number }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `Google respondeu ${res.status}`);
  return (json.places ?? []).map((p) => ({ id: p.id, name: p.displayName?.text ?? "", address: p.formattedAddress ?? "", rating: p.rating ?? null, reviewCount: p.userRatingCount ?? 0 }));
}
