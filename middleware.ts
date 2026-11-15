import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/** Renova a sessão do Supabase Auth a cada requisição (padrão @supabase/ssr). Sem Supabase, não faz nada. */
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || process.env.AUTH_MODE === "local") return NextResponse.next();
  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  // getClaims renova o token vencido e valida a assinatura localmente (sem viagem ao Auth a cada clique).
  await supabase.auth.getClaims();
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|pwa/|sw.js|manifest.webmanifest|offline.html|api/webhooks|api/jobs).*)"] };
