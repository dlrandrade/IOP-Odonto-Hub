import { clsx, type ClassValue } from "clsx";

export const cn = (...v: ClassValue[]) => clsx(v);

export function brl(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

export function parseBrlToCents(input: string): number | null {
  const clean = input.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  if (clean === "") return null;
  const n = Number(clean);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function formatPhone(e164: string): string {
  const m = e164.match(/^\+?55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  return `+${digits}`;
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
