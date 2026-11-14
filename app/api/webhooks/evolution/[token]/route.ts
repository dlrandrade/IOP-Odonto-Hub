import { after, NextResponse, type NextRequest } from "next/server";
import { handleEvolutionWebhook } from "@/services/evolution-webhook";
import { runAfterDebounce } from "@/services/kick";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Eventos da Evolution API (canal alternativo, não oficial). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const payload: unknown = await request.json().catch(() => null);
  const outcome = await handleEvolutionWebhook(token, payload);
  if (outcome.status === 404) return new NextResponse("not found", { status: 404 });
  if (outcome.accepted > 0 && outcome.clinicId) {
    const clinicId = outcome.clinicId;
    after(() => runAfterDebounce([clinicId]));
  }
  return NextResponse.json({ ok: true });
}
