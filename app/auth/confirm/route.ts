import { NextResponse, type NextRequest } from "next/server";
import { confirmEmail } from "@/auth/provider";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Destino do link de confirmação de e-mail. Só redireciona para caminhos internos fixos. */
export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const ok = await confirmEmail({ code: p.get("code"), tokenHash: p.get("token_hash"), type: p.get("type") });
  return NextResponse.redirect(new URL(ok ? "/onboarding" : "/login?erro=link", env.appUrl));
}
