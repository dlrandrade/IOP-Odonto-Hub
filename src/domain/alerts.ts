import { normalizeText } from "@/lib/format";

/**
 * Sinais de alerta clínico (PRD 7.4). A detecção serve apenas para ENCAMINHAR a um humano,
 * nunca para classificar a condição. A lista efetiva e o texto são configurados e aprovados
 * pelo responsável técnico de cada clínica; esta é só a sugestão inicial do cadastro.
 */
export const SUGGESTED_ALERT_KEYWORDS = [
  "dor forte", "dor intensa", "muita dor", "dor insuportavel", "inchaco", "inchado", "rosto inchado",
  "sangramento", "sangrando", "nao para de sangrar", "trauma", "acidente", "dente quebrado", "quebrei o dente",
  "dente quebrou", "febre", "pus", "abscesso", "cai e bati",
];

export function detectAlert(text: string, keywords: string[]): string | null {
  const haystack = normalizeText(text);
  for (const k of keywords) {
    const needle = normalizeText(k);
    if (needle && haystack.includes(needle)) return k;
  }
  return null;
}

const OPT_OUT = ["parar", "pare", "sair", "stop", "cancelar mensagens", "nao quero mais receber", "descadastrar"];

/** "Parar" bloqueia comunicações automáticas imediatamente (RF-07). */
export function isOptOut(text: string): boolean {
  const t = normalizeText(text).replace(/[.!]/g, "");
  return OPT_OUT.some((k) => t === k || (k.includes(" ") && t.includes(k)));
}
