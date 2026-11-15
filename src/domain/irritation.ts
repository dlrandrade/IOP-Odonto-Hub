import { normalizeText } from "@/lib/format";

/**
 * Detecção de paciente irritado: palavrão, expressões duras, ameaça de reclamação, mensagem em CAIXA ALTA
 * ("gritando") e excesso de exclamações. Ao detectar, a assistente para, responde com acolhimento e chama a equipe.
 * Tudo é configurável por clínica (Configurações → Assistente). Detecção serve só para encaminhar.
 */
export type IrritationConfig = {
  enabled: boolean;
  profanity: boolean;
  harsh: boolean;
  caps: boolean;
  exclamations: boolean;
  /** palavras ou frases extras da clínica (uma por item) */
  extra: string[];
};

export const DEFAULT_IRRITATION: IrritationConfig = { enabled: true, profanity: true, harsh: true, caps: true, exclamations: false, extra: [] };

const PROFANITY = [
  "porra", "caralho", "krl", "merda", "bosta", "puta", "puto", "pqp", "fdp", "filho da puta", "vtnc", "vai tomar no cu", "tomar no cu",
  "vsf", "vai se foder", "foda se", "fodase", "foder", "fodido", "cacete", "desgraca", "desgracado", "desgracada", "arrombado",
  "otario", "otaria", "babaca", "imbecil", "idiota", "idiotas", "cretino", "vagabundo", "vagabunda", "safado", "safada", "lixo", "porcaria",
];
const HARSH = [
  "absurdo", "ridiculo", "ridicula", "vergonha", "que vergonha", "descaso", "falta de respeito", "desrespeito", "pessimo", "pessima",
  "horrivel", "palhacada", "incompetente", "incompetentes", "incompetencia", "enganacao", "golpe", "golpistas", "roubo", "ladrao", "ladroes",
  "vou processar", "processar voces", "advogado", "procon", "reclame aqui", "reclameaqui", "denunciar", "vou denunciar",
  "nunca mais", "estou irritado", "estou irritada", "to irritado", "to irritada", "revoltado", "revoltada", "cansei",
  "nao aguento mais", "quero meu dinheiro", "dinheiro de volta", "ninguem responde", "ninguem me responde", "pessimo atendimento",
];

const hasTerm = (haystack: string, term: string) => {
  const t = normalizeText(term).trim();
  if (!t) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(haystack);
};

/** Texto "gritado": ao menos 10 letras e 80% delas maiúsculas. */
export function isShouting(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 10) return false;
  const upper = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
  return upper / letters.length >= 0.8;
}

/** Devolve o motivo (para a equipe) ou null. */
export function detectIrritation(text: string, cfg: IrritationConfig): string | null {
  if (!cfg.enabled || !text.trim()) return null;
  const h = normalizeText(text);
  if (cfg.profanity) { const w = PROFANITY.find((t) => hasTerm(h, t)); if (w) return "palavrão ou ofensa"; }
  const extra = cfg.extra.find((t) => hasTerm(h, t));
  if (extra) return `expressão configurada pela clínica (“${extra}”)`;
  if (cfg.harsh) { const w = HARSH.find((t) => hasTerm(h, t)); if (w) return `expressão de insatisfação (“${w}”)`; }
  if (cfg.caps && isShouting(text)) return "mensagem em caixa alta (gritando)";
  if (cfg.exclamations && /[!?]{4,}/.test(text)) return "excesso de exclamações";
  return null;
}
