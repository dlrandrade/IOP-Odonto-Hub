import { after, NextResponse, type NextRequest } from "next/server";
import { handleWhatsAppWebhook, verifyWebhookToken } from "@/services/webhook";
import { runAfterDebounce } from "@/services/kick";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Verificação do webhook pela Meta. */
export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  if (p.get("hub.mode") === "subscribe" && (await verifyWebhookToken(p.get("hub.verify_token")))) {
    // Devolve só o desafio numérico da Meta, como texto puro (nunca HTML refletido).
    const challenge = (p.get("hub.challenge") ?? "").replace(/[^0-9A-Za-z_-]/g, "").slice(0, 200);
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
  }
  return new NextResponse("forbidden", { status: 403 });
}

/** Recebe eventos: valida assinatura, grava (idempotente) e responde 200 na hora. A IA roda depois, com debounce. */
export async function POST(request: NextRequest) {
  const raw = await request.text();
  const outcome = await handleWhatsAppWebhook(raw, request.headers.get("x-hub-signature-256"));
  if (outcome.status === 401) return new NextResponse("invalid signature", { status: 401 });
  if (outcome.accepted > 0) after(() => runAfterDebounce(outcome.clinicIds));
  return NextResponse.json({ ok: true });
}
