import { cn } from "@/lib/format";

export function Logo({ light, className }: { light?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-lg font-extrabold tracking-tight", light ? "text-white" : "text-bone", className)}>
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="10" fill="#c8a24a" />
        <path d="M8.5 14.5c0 6 3.3 10 7.5 10s7.5-4 7.5-10" fill="none" stroke="#0a0e13" strokeWidth="3" strokeLinecap="round" />
        <circle cx="11" cy="10" r="1.8" fill="#0a0e13" /><circle cx="21" cy="10" r="1.8" fill="#0A0E13" />
      </svg>
      IOP <span className={light ? "text-gold" : "text-bone-mute"}>Odonto Hub</span>
    </span>
  );
}

/** Moldura das telas de entrada: painel marinho com a marca + cartão claro. */
export function AuthFrame({ title, highlight, subtitle, children }: { title: string; highlight?: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden border-r border-line bg-surface p-12 text-bone lg:flex">
        <Logo light />
        <div>
          <h1 className="text-5xl font-extrabold leading-[1.1] tracking-tight">
            {title} {highlight && <span className="marker text-ink">{highlight}</span>}
          </h1>
          <p className="mt-5 max-w-md text-lg text-bone-dim">{subtitle}</p>
        </div>
        <ul className="grid max-w-md grid-cols-2 gap-3 text-sm text-bone-dim">
          {["WhatsApp oficial", "Agenda sem conflito", "IA com guardrails", "CRM e indicadores"].map((t) => (
            <li key={t} className="rounded-2xl border border-line px-4 py-3">{t}</li>
          ))}
        </ul>
        <div aria-hidden className="absolute -right-24 -top-24 size-72 rounded-full bg-gold/10" />
      </section>
      <section className="flex items-center justify-center p-5 sm:p-10">
        <div className="w-full max-w-md">
          <Logo className="mb-8 lg:hidden" />
          {children}
        </div>
      </section>
    </main>
  );
}
