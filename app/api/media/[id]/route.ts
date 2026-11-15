import { NextResponse } from "next/server";
import { getCtx, q } from "@/auth/session";
import { db } from "@/db/client";
import { can } from "@/domain/permissions";
import { mediaStore } from "@/integrations/storage";
import { ensureMedia } from "@/services/jobs";

export const dynamic = "force-dynamic";

/** Mídia privada: só quem enxerga a mensagem (RLS) recebe o arquivo ou um link temporário. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getCtx();
  if (!ctx || !can(ctx.role, "conversations.view") || !/^[0-9a-f-]{36}$/.test(id)) return new NextResponse("not found", { status: 404 });
  const [msg] = await q(ctx, (tx) => tx<{ id: string; media_path: string | null; media_mime: string | null }[]>`select id, media_path, media_mime from messages where id = ${id}`);
  if (!msg) return new NextResponse("not found", { status: 404 });
  if (msg.media_path) {
    const url = await mediaStore().signedUrl(msg.media_path, 300);
    if (url) return NextResponse.redirect(url);
  }
  const media = await ensureMedia(db(), ctx.clinicId, msg.id).catch(() => null);
  if (!media) return new NextResponse("not found", { status: 404 });
  // O tipo declarado vem de quem mandou a mensagem: só imagem e áudio são exibidos; o resto vira download,
  // para um "documento" HTML/SVG nunca rodar dentro do sistema com a sessão da equipe.
  const mime = media.mime.toLowerCase().split(";")[0]!.trim();
  const inline = /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|aac|amr|wav|webm))$/.test(mime);
  return new NextResponse(new Uint8Array(media.data), {
    headers: {
      "Content-Type": inline ? mime : "application/octet-stream",
      "Content-Disposition": inline ? "inline" : "attachment",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, max-age=300",
    },
  });
}
