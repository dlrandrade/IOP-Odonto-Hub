import { after, NextResponse, type NextRequest } from "next/server";
import { handleWacliWebhook } from "@/services/wacli-webhook";
import { runAfterDebounce } from "@/services/kick";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Mensagens e confirmações de leitura vindas do gateway wacli (canal não oficial). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const raw = await request.text();
  if (raw.length > 256 * 1024) return new NextResponse("payload too large", { status: 413 });
  const outcome = await handleWacliWebhook(token, raw, request.headers.get("x-wacli-signature"));
  if (outcome.status === 404) return new NextResponse("not found", { status: 404 });
  if (outcome.status === 401) return new NextResponse("invalid signature", { status: 401 });
  if (outcome.accepted > 0 && outcome.clinicId) {
    const clinicId = outcome.clinicId;
    after(() => runAfterDebounce([clinicId]));
  }
  return NextResponse.json({ ok: true });
}
