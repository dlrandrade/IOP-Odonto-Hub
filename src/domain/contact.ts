/**
 * Normalização dos dados de contato e presença digital da clínica (contratação, onboarding e Configurações).
 * Regras puras: testáveis sem banco. Retornam null para vazio e lançam ContactError com mensagem em pt-BR.
 */
export class ContactError extends Error {}

const blank = (v: string | null | undefined) => !v || v.trim() === "";

/** "@clinica", "clinica" ou "https://instagram.com/clinica/" → "clinica". */
export function normalizeInstagram(raw: string | null | undefined): string | null {
  if (blank(raw)) return null;
  let v = raw!.trim();
  const m = v.match(/instagram\.com\/([^/?#]+)/i);
  if (m) v = m[1]!;
  v = v.replace(/^@/, "").replace(/\/+$/, "");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(v)) throw new ContactError("Instagram inválido. Use só o @ (ex.: @clinicasorriso).");
  return v.toLowerCase();
}

/** Aceita "www.site.com.br" e devolve com https://. Só http(s). */
export function normalizeUrl(raw: string | null | undefined, label = "Endereço"): string | null {
  if (blank(raw)) return null;
  let v = raw!.trim();
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  let u: URL;
  try { u = new URL(v); } catch { throw new ContactError(`${label} inválido.`); }
  if (!["http:", "https:"].includes(u.protocol) || !u.hostname.includes(".") || u.username || u.password) throw new ContactError(`${label} inválido.`);
  return u.toString();
}

const GOOGLE_HOSTS = /(^|\.)(google\.[a-z.]+|g\.page|goo\.gl|g\.co|maps\.app\.goo\.gl)$/i;

/** Link do Google Meu Negócio (perfil ou "pedir avaliações"): precisa ser do Google. */
export function normalizeGoogleUrl(raw: string | null | undefined, label = "Link do Google"): string | null {
  const url = normalizeUrl(raw, label);
  if (!url) return null;
  if (!GOOGLE_HOSTS.test(new URL(url).hostname)) throw new ContactError(`${label}: use o link copiado do Google (ex.: g.page/r/… ou maps.app.goo.gl/…).`);
  return url.replace(/^http:/, "https:");
}

/** Place ID colado direto ou extraído de um link que o contenha (placeid=… ou place_id:…). */
export function extractPlaceId(raw: string | null | undefined): string | null {
  if (blank(raw)) return null;
  const v = raw!.trim();
  const m = v.match(/place_?id[=:]([A-Za-z0-9_-]{10,300})/i);
  const id = m ? m[1]! : v;
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) throw new ContactError("Place ID inválido (ex.: ChIJN1t_tDeuEmsRUsoyG83frY4).");
  return id;
}

/** Telefone da clínica para exibir: mantém dígitos, +, espaços, parênteses e hífen. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (blank(raw)) return null;
  const v = raw!.trim();
  const digits = v.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15 || /[^\d+\s()-]/.test(v)) throw new ContactError("Telefone inválido. Inclua o DDD (ex.: 11 3333-4444).");
  return v;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (blank(raw)) return null;
  const v = raw!.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || v.length > 200) throw new ContactError("E-mail inválido.");
  return v;
}

/** Origem do paciente ("como conheceu a clínica"). Mesma lista do check da tabela patients. */
export const PATIENT_SOURCES = ["google", "instagram", "indicacao", "whatsapp", "site", "facebook", "passou_na_frente", "convenio", "outro"] as const;
export type PatientSource = (typeof PATIENT_SOURCES)[number];
export const PATIENT_SOURCE_LABELS: Record<PatientSource, string> = {
  google: "Google (Meu Negócio / Maps)", instagram: "Instagram", indicacao: "Indicação", whatsapp: "WhatsApp", site: "Site",
  facebook: "Facebook", passou_na_frente: "Passou na frente", convenio: "Convênio", outro: "Outro",
};

export type ClinicProfileInput = { phone?: unknown; email?: unknown; website?: unknown; instagram?: unknown; address?: unknown; googleReviewUrl?: unknown };

/** Dados da contratação (onboarding ou painel da plataforma) → perfil normalizado. Lança ContactError. */
export function parseClinicProfile(i: ClinicProfileInput) {
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const address = s(i.address)?.trim().slice(0, 300) || null;
  return {
    phone: normalizePhone(s(i.phone)), email: normalizeEmail(s(i.email)), website: normalizeUrl(s(i.website), "Site"),
    instagram: normalizeInstagram(s(i.instagram)), address, googleReviewUrl: normalizeGoogleUrl(s(i.googleReviewUrl), "Link de avaliação do Google"),
  };
}
