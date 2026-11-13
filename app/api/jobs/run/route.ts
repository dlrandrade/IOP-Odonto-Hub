import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/crypto";
import { env } from "@/lib/env";
import { runDueJobs } from "@/services/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Worker acionado por cron (Vercel Cron envia "Authorization: Bearer CRON_SECRET"). */
async function handle(request: NextRequest) {
  const secret = env.cronSecret;
  const header = request.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(header, `Bearer ${secret}`)) return new NextResponse("unauthorized", { status: 401 });
  return NextResponse.json(await runDueJobs({ limit: 50 }));
}

export const GET = handle;
export const POST = handle;
