import { redirect } from "next/navigation";
import { Logo } from "@/components/brand";
import { Card } from "@/components/ui";
import { db } from "@/db/client";
import { missingEnv } from "@/lib/env";

export const metadata = { title: "Instalação" };
export const dynamic = "force-dynamic";

const HELP: Record<string, string> = {
  DATABASE_URL: "Supabase → Project Settings → Database → Connection string → Transaction pooler.",
  NEXT_PUBLIC_SUPABASE_URL: "Supabase → Project Settings → API → Project URL.",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "Supabase → Project Settings → API → anon / publishable key.",
  SUPABASE_SERVICE_ROLE_KEY: "Supabase → Project Settings → API → service_role (secreta).",
  FIELD_ENCRYPTION_KEY: "Gere com: openssl rand -hex 32",
};

/** Tela de instalação: mostra exatamente o que falta. Nunca exibe valores. */
export default async function SetupPage() {
  const missing = missingEnv();
  let dbOk = false;
  let migrated = false;
  if (!missing.includes("DATABASE_URL")) {
    try {
      await db()`select 1`;
      dbOk = true;
      const [t] = await db()`select 1 from information_schema.tables where table_schema = 'public' and table_name = 'clinics'`;
      migrated = !!t;
    } catch { dbOk = false; }
  }
  if (missing.length === 0 && dbOk && migrated) redirect("/login");
  const steps = [
    { done: missing.length === 0, title: "Variáveis de ambiente", detail: missing.length ? "Faltam as variáveis abaixo (na Vercel: Settings → Environment Variables)." : "Tudo definido." },
    { done: dbOk, title: "Conexão com o banco", detail: dbOk ? "Conectado." : "Não foi possível conectar com DATABASE_URL." },
    { done: migrated, title: "Estrutura do banco", detail: migrated ? "Migrações aplicadas." : "Rode: npm run db:migrate" },
  ];
  return (
    <main className="mx-auto max-w-2xl p-6 py-12">
      <Logo />
      <h1 className="mt-8 text-3xl font-bold">Falta pouco para <span className="marker">começar</span></h1>
      <p className="mt-2 text-bone-mute">Siga os passos de <code>docs/SETUP.md</code>. Esta página some quando tudo estiver configurado.</p>
      <div className="mt-6 space-y-3">
        {steps.map((s, i) => (
          <Card key={s.title} className="flex items-start gap-4">
            <span className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${s.done ? "bg-ok-soft text-ok" : "bg-gold"}`}>{s.done ? "✓" : i + 1}</span>
            <div className="min-w-0">
              <p className="font-semibold">{s.title}</p>
              <p className="text-sm text-bone-mute">{s.detail}</p>
              {i === 0 && missing.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {missing.map((m) => (
                    <li key={m} className="rounded-xl bg-surface-2 px-3 py-2 text-xs"><code className="font-semibold">{m}</code><span className="mt-0.5 block text-bone-mute">{HELP[m]}</span></li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        ))}
      </div>
    </main>
  );
}
