import { cn } from "@/lib/format";

export function Logo({ light, className }: { light?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-lg font-extrabold tracking-tight", light ? "text-white" : "text-navy-900", className)}>
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="10" fill="#ffd42a" />
        <path d="M8.5 14.5c0 6 3.3 10 7.5 10s7.5-4 7.5-10" fill="none" stroke="#0f2a3d" strokeWidth="3" strokeLinecap="round" />
        <circle cx="11" cy="10" r="1.8" fill="#0f2a3d" /><circle cx="21" cy="10" r="1.8" fill="#0f2a3d" />
      </svg>
      IOP <span className={light ? "text-sun-500" : "text-navy-500"}>Odonto Hub</span>
    </span>
  );
}

/** Moldura das telas de entrada: painel marinho com a marca + cartão claro. */
export function AuthFrame({ title, highlight, subtitle, children }: { title: string; highlight?: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-navy-900 p-12 text-white lg:flex">
        <Logo light />
        <div>
          <h1 className="text-5xl font-extrabold leading-[1.1] tracking-tight">
            {title} {highlight && <span className="marker text-navy-900">{highlight}</span>}
          </h1>
          <p className="mt-5 max-w-md text-lg text-navy-100">{subtitle}</p>
        </div>
        <ul className="grid max-w-md grid-cols-2 gap-3 text-sm text-navy-100">
          {["WhatsApp oficial", "Agenda sem conflito", "IA com guardrails", "CRM e indicadores"].map((t) => (
            <li key={t} className="rounded-2xl border border-navy-700 px-4 py-3">{t}</li>
          ))}
        </ul>
        <div aria-hidden className="absolute -right-24 -top-24 size-72 rounded-full bg-sun-500/15" />
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
