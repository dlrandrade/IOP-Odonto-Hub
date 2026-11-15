import { cn } from "@/lib/format";
import { ThemeToggle } from "@/components/nav";

/** Marca só em texto, como no iopbusiness: o nome da escola ao lado do nome do produto. */
export function Logo({ className }: { light?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-3", className)}>
      <span className="eyebrow hidden text-bone-mute sm:inline">IOP</span>
      <span aria-hidden className="hidden h-3 w-px bg-line sm:block" />
      <span className="display text-[16px] uppercase tracking-[-0.01em] text-bone">Odonto Hub</span>
    </span>
  );
}

const FATOS = [
  ["WhatsApp da clínica", "Cada clínica conecta o próprio número: pela Meta (recomendado) ou por QR Code."],
  ["Agenda sem conflito", "O banco recusa dois pacientes na mesma cadeira e no mesmo horário."],
  ["Assistente com limites", "Nunca diagnostica, não inventa preço e chama a equipe quando precisa."],
];

/** Moldura das telas de entrada: painel escuro com a proposta + formulário. */
export function AuthFrame({ title, subtitle, children }: { title: string; highlight?: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden border-r border-line bg-surface p-12 lg:flex">
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(60% 45% at 20% 0%, rgb(var(--acento-rgb) / 0.14), transparent 70%)" }} />
        <Logo className="relative" />
        <div className="relative max-w-xl">
          <h1 className="display text-[56px] leading-[1.02]">{title}</h1>
          <p className="mt-5 max-w-md text-[17px] leading-relaxed text-bone-dim">{subtitle}</p>
        </div>
        <dl className="relative max-w-xl divide-y divide-line border-y border-line">
          {FATOS.map(([t, d]) => (
            <div key={t} className="flex gap-6 py-4">
              <dt className="w-44 shrink-0 font-display text-[15px] font-bold">{t}</dt>
              <dd className="text-[13px] text-bone-dim">{d}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="relative flex items-center justify-center p-5 sm:p-10">
        <ThemeToggle className="absolute right-5 top-5" />
        <div className="w-full max-w-md">
          <Logo className="mb-10 lg:hidden" />
          {children}
        </div>
      </section>
    </main>
  );
}
