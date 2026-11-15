import { env } from "@/lib/env";

/** Envio de e-mail das automações. Hoje via Resend (API HTTP); trocar de provedor é trocar só este arquivo. */
export type EmailMessage = { to: string; subject: string; text: string; replyTo?: string | null; fromName?: string | null };
export type EmailResult = { ok: true; id: string | null } | { ok: false; error: string; retryable: boolean };

export function emailConfigured(): boolean {
  return !!(env.email.resendKey && env.email.from);
}

/** Troca o nome de exibição do remetente pelo da clínica, mantendo o endereço verificado. */
export function fromWithName(from: string, name?: string | null): string {
  if (!name) return from;
  const address = from.match(/<([^>]+)>/)?.[1] ?? from;
  return `${name.replace(/["<>\r\n]/g, "").slice(0, 80)} <${address}>`;
}

export async function sendEmail(m: EmailMessage): Promise<EmailResult> {
  const key = env.email.resendKey;
  const from = env.email.from;
  if (!key || !from) return { ok: false, error: "E-mail não configurado na plataforma.", retryable: false };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: fromWithName(from, m.fromName), to: [m.to], subject: m.subject, text: m.text, reply_to: m.replyTo ?? undefined }),
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  }).catch(() => null);
  if (!res) return { ok: false, error: "Serviço de e-mail inacessível.", retryable: true };
  const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok) return { ok: false, error: json.message ?? `E-mail recusado (${res.status}).`, retryable: res.status >= 500 || res.status === 429 };
  return { ok: true, id: json.id ?? null };
}

export const isEmail = (v: string | null | undefined): v is string => !!v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
