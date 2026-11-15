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
export const PATIENT_SOURCES = ["google", "instagram", "facebook", "tiktok", "youtube", "email", "indicacao", "whatsapp", "site", "passou_na_frente", "convenio", "outro"] as const;
export type PatientSource = (typeof PATIENT_SOURCES)[number];
export const PATIENT_SOURCE_LABELS: Record<PatientSource, string> = {
  google: "Google (Meu Negócio / Maps)", instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube", email: "E-mail",
  indicacao: "Indicação", whatsapp: "WhatsApp", site: "Site", passou_na_frente: "Passou na frente", convenio: "Convênio", outro: "Outro",
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

const ORIGIN_RULES: { source: PatientSource; re: RegExp }[] = [
  // Verbos de descoberta perto do canal: evita confundir "me manda o link do Google" com origem.
  { source: "google", re: /\b(vi|achei|encontrei|conheci|pesquisei|busquei|procurei|vim|cheguei|olhei)\b[^.?!\n]{0,30}\b(google|maps)\b|\bpelo (google|maps)\b|\bno google (maps)?\b(?! ?(meu negocio)?.*(link|avaliac))/ },
  { source: "instagram", re: /\b(vi|achei|encontrei|conheci|vim|cheguei|sigo|segui|anuncio)\b[^.?!\n]{0,30}\b(insta|instagram|ig|reels|stories)\b|\bpelo (insta|instagram)\b/ },
  { source: "facebook", re: /\b(vi|achei|encontrei|conheci|vim|cheguei|anuncio)\b[^.?!\n]{0,30}\b(face|facebook)\b|\bpelo (face|facebook)\b/ },
  { source: "tiktok", re: /\b(vi|achei|conheci|vim)\b[^.?!\n]{0,30}\btik ?tok\b|\bpelo tik ?tok\b/ },
  { source: "youtube", re: /\b(vi|achei|conheci|vim)\b[^.?!\n]{0,30}\byou ?tube\b|\bpelo you ?tube\b/ },
  { source: "email", re: /\b(recebi|vi|li)\b[^.?!\n]{0,30}\be-?mail\b|\bpelo e-?mail\b/ },
  { source: "indicacao", re: /\b(indicacao|indicou|indicaram|me indicou|recomendou|recomendaram|recomendacao)\b|\b(amig[oa]|vizinh[oa]|parente|minha (mae|irma|tia|prima)|meu (pai|irmao|tio|primo)) (me )?(falou|falaram|indicou|recomendou)\b/ },
  { source: "site", re: /\b(vi|achei|encontrei|vim)\b[^.?!\n]{0,30}\b(site|pagina de voces|sua pagina)\b|\bpelo site\b/ },
];

/**
 * Origem do paciente a partir do que ele escreveu ("vi vocês no Instagram", "minha amiga indicou").
 * Devolve a origem e o trecho que justificou, para mostrar na ficha.
 */
export function detectOrigin(text: string): { source: PatientSource; detail: string } | null {
  const plain = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  for (const r of ORIGIN_RULES) {
    const m = plain.match(r.re);
    if (m) {
      const at = m.index ?? 0;
      const snippet = text.slice(Math.max(0, at - 10), Math.min(text.length, at + m[0].length + 10)).trim().replace(/\s+/g, " ");
      return { source: r.source, detail: snippet.slice(0, 120) };
    }
  }
  return null;
}

/** Link que abre o WhatsApp (app ou WhatsApp Web) com o número e o texto já preenchidos. */
export function whatsappLink(phone: string, text?: string | null): string {
  const digits = phone.replace(/\D/g, "");
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

/** Origem por anúncio "clique para conversar": o link do anúncio diz se foi Instagram ou Facebook. */
export function originFromReferral(r: { sourceUrl: string | null; sourceType: string | null; headline: string | null } | null | undefined): { source: PatientSource; detail: string } | null {
  if (!r) return null;
  const url = (r.sourceUrl ?? "").toLowerCase();
  const kind = r.sourceType === "ad" ? "Anúncio" : "Publicação";
  const what = r.headline ? ` “${r.headline.slice(0, 60)}”` : "";
  if (url.includes("instagram")) return { source: "instagram", detail: `${kind} no Instagram${what}` };
  if (url.includes("facebook") || url.includes("fb.")) return { source: "facebook", detail: `${kind} no Facebook${what}` };
  return null;
}

/** Resposta direta a "como conheceu a clínica?" ("Instagram", "foi indicação", "pelo Google"). */
export function originFromAnswer(answer: string | null | undefined): PatientSource | null {
  if (!answer) return null;
  const t = answer.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/google|maps|pesquis/.test(t)) return "google";
  if (/insta|\big\b|reels|stories/.test(t)) return "instagram";
  if (/face(book)?\b/.test(t)) return "facebook";
  if (/tik ?tok/.test(t)) return "tiktok";
  if (/you ?tube/.test(t)) return "youtube";
  if (/e-?mail/.test(t)) return "email";
  if (/indic|recomend|amig|vizinh|parente|famil/.test(t)) return "indicacao";
  if (/site|pagina/.test(t)) return "site";
  if (/conveni|plano/.test(t)) return "convenio";
  if (/passei|passando|frente|fachada|placa/.test(t)) return "passou_na_frente";
  if (/whats|zap/.test(t)) return "whatsapp";
  return null;
}
