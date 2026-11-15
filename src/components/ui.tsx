import Link from "next/link";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { Info, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/format";

/** Primitivos de interface no estilo IOP Business: superfícies escuras, linhas finas, ouro só em CTA e marca. */

type ButtonVariant = "primary" | "accent" | "outline" | "ghost" | "danger";
const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-gold text-on hover:bg-gold-deep",
  accent: "bg-gold text-on hover:bg-gold-deep",
  outline: "border border-line bg-surface/50 text-bone backdrop-blur-md hover:border-bone-mute/60 hover:bg-surface-2/80",
  ghost: "text-bone-dim hover:bg-surface-2 hover:text-bone",
  danger: "border border-danger/50 text-danger hover:bg-danger hover:text-on-danger",
};

/**
 * Botão padrão. Duas alturas, iguais às dos campos: md = 40 px (h-10), sm = 32 px (h-8).
 * Assim botões, campos e seletores numa mesma linha sempre alinham.
 */
export function buttonClass(variant: ButtonVariant = "primary", size: "sm" | "md" = "md"): string {
  return cn(
    "btn inline-flex shrink-0 items-center justify-center gap-2 rounded-sm font-mono font-medium uppercase whitespace-nowrap disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5",
    size === "sm" ? "h-8 px-3 text-[10.5px] tracking-[0.12em]" : "h-10 px-5 text-[11.5px] tracking-[0.13em]", BUTTON[variant],
  );
}

export function Button({ variant = "primary", size = "md", className, ...props }: ComponentProps<"button"> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  return <button className={cn(buttonClass(variant, size), className)} {...props} />;
}

/** Cartão de vidro: mesma moldura e o mesmo respiro (24 px) em todo o sistema. Ocupa a altura da linha da grade. */
export function Card({ className, tone = "white", ...props }: ComponentProps<"div"> & { tone?: "white" | "navy" | "sun" }) {
  // Sem tailwind-merge: o respiro e a altura padrão só entram se a página não definir os seus.
  const pad = className && /(^|\s)(p|px|py)-/.test(className) ? "" : "p-6";
  const h = className && /(^|\s)h-/.test(className) ? "" : "h-full";
  return <div className={cn("vidro flex flex-col rounded-lg", tone === "navy" && "bg-surface-2/60", pad, h, className)} {...props} />;
}

/**
 * Explicação recolhida: um "i" discreto ao lado do título; o texto aparece ao passar o mouse ou tocar.
 * Usado na visualização simples, no lugar das frases de apoio.
 */
export function InfoTip({ text, className }: { text: string; className?: string }) {
  return (
    <span tabIndex={0} role="note" aria-label={text} className={cn("group/tip relative inline-flex size-6 shrink-0 cursor-help items-center justify-center rounded-full text-bone-mute outline-none transition-colors hover:text-bone focus-visible:text-bone", className)}>
      <Info size={15} aria-hidden />
      <span aria-hidden className="vidro-forte pointer-events-none absolute left-1/2 top-full z-30 mt-2 w-max max-w-[280px] -translate-x-1/2 rounded-md border px-3 py-2 text-left font-sans text-[12.5px] font-normal normal-case leading-relaxed tracking-normal text-bone opacity-0 shadow-deep transition-opacity duration-150 group-hover/tip:opacity-100 group-focus/tip:opacity-100">{text}</span>
    </span>
  );
}

/** Cabeçalho de cartão/seção: título (h2), apoio opcional e ação alinhada ao topo. Na visualização simples, o apoio vira um "i". */
export function CardTitle({ children, action, hint }: { children: ReactNode; action?: ReactNode; hint?: string }) {
  return (
    <div className="mb-5 flex min-h-8 items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="t-h2 flex items-center gap-1.5">{children}{hint && <InfoTip text={hint} className="detalhado:hidden" />}</h2>
        {/* reserva duas linhas: cartões lado a lado começam o conteúdo na mesma altura */}
        {hint && <p className="t-small mt-1 min-h-[38px] simples:hidden">{hint}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

/** Cabeçalho de página: h1, uma frase de apoio e as ações principais à direita. Na visualização simples, o apoio vira um "i". */
export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="mb-10 flex flex-col gap-5 simples:mb-8 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
      <div className="min-w-0 max-w-2xl lg:flex-1">
        <h1 className="t-h1 flex items-center gap-2">{title}{subtitle && <InfoTip text={subtitle} className="detalhado:hidden" />}</h1>
        {subtitle && <p className="t-body mt-2 text-bone-dim simples:hidden">{subtitle}</p>}
      </div>
      {children && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3 lg:shrink-0 lg:justify-end">{children}</div>}
    </div>
  );
}

/** Grade padrão de 12 colunas com o mesmo espaçamento (24 px) em todas as páginas. */
export function Grid({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid gap-6", className)} {...props} />;
}

type Tone = "neutral" | "navy" | "sun" | "ok" | "warn" | "danger" | "info" | "violet";
const TONES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-bone-dim", navy: "bg-bone/10 text-bone", sun: "bg-gold text-on",
  ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info", violet: "bg-violet-soft text-violet",
};

export function Badge({ tone = "neutral", className, ...props }: ComponentProps<"span"> & { tone?: Tone }) {
  return <span className={cn("inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-sm px-2 font-mono text-[10.5px] font-medium uppercase leading-none tracking-[0.08em] [&_svg]:size-3", TONES[tone], className)} {...props} />;
}

/** Alternador padrão (abas de visualização): mesma altura dos botões, segmentos de largura igual. */
export function Segmented({ items, label, className }: { items: { href: string; label: string; active: boolean }[]; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={cn("vidro inline-grid h-10 auto-cols-fr grid-flow-col rounded-sm p-1", className)}>
      {items.map((i) => (
        <Link key={i.href} href={i.href} aria-current={i.active ? "page" : undefined}
          className={cn("flex min-w-[76px] items-center justify-center whitespace-nowrap rounded-[7px] px-3 text-[13px] font-medium transition-colors", i.active ? "bg-acento text-on" : "text-bone-dim hover:text-bone")}>{i.label}</Link>
      ))}
    </nav>
  );
}

/** Largura total por padrão; passe uma classe w-* para sobrescrever sem conflito de utilitários. */
const width = (className?: string) => (className && /(^|\s)w-/.test(className) ? "" : "w-full");
const height = (className: string | undefined, fallback: string, prefix: RegExp) => (className && prefix.test(className) ? "" : fallback);
const FIELD = "rounded-sm border border-line bg-surface-2/70 px-3 text-[14px] text-bone placeholder:text-bone-mute transition-colors hover:border-bone-mute/50 focus:border-acento focus:bg-surface-2 focus:outline-none focus:ring-4 focus:ring-acento/15 disabled:opacity-60";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(FIELD, width(className), height(className, "h-10", /(^|\s)h-/), className)} {...props} />;
}
export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(FIELD, width(className), height(className, "h-10", /(^|\s)h-/), className)} {...props} />;
}
/** Cresce com o texto (field-sizing): começa compacto e nunca esconde o que foi escrito. */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(FIELD, width(className), height(className, "min-h-20", /(^|\s)min-h-/), "max-h-[60vh] py-2.5 leading-relaxed [field-sizing:content]", className)} {...props} />;
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-2 block text-[13px] font-medium text-bone">{label}</span>
      {children}
      {hint && <span className="t-small mt-1.5 block">{hint}</span>}
    </label>
  );
}

export function Checkbox({ label, hint, ...props }: ComponentProps<"input"> & { label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-[14px]">
      <input type="checkbox" className="mt-0.5 size-[18px] shrink-0 cursor-pointer accent-gold" {...props} />
      <span><span className="font-medium">{label}</span>{hint && <span className="t-small mt-0.5 block">{hint}</span>}</span>
    </label>
  );
}

/** Estado vazio: diz o que é e, quando houver, qual o próximo passo. Sem moldura pesada. */
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center rounded-md bg-bone/[0.03] px-6 py-10 text-center">
      <p className="t-h3">{title}</p>
      {children && <div className="t-small mt-1.5 max-w-sm">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Avatar({ name, color, size = 36, src }: { name: string; color?: string; size?: number; src?: string | null }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" aria-hidden width={size} height={size} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("");
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-full font-display font-bold text-on"
      style={{ width: size, height: size, fontSize: size * 0.36, background: color ?? "rgb(var(--acento-rgb))" }}>
      {letters || "?"}
    </span>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-[14px]">
        <thead>
          <tr className="border-b border-line font-mono text-[10.5px] uppercase tracking-[0.14em] text-bone-mute">
            {head.map((h, i) => <th key={`${h}-${i}`} className="h-10 px-3 font-medium first:pl-0 last:pr-0">{h}</th>)}
          </tr>
        </thead>
        <tbody className="[&_td]:h-14 [&_td]:px-3 [&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_tr]:border-b [&_tr]:border-line [&_tr]:transition-colors [&_tr:hover]:bg-surface-2/40 [&_tr:last-child]:border-0">{children}</tbody>
      </table>
    </div>
  );
}

export function Notice({ tone = "sun", children }: { tone?: "sun" | "danger" | "ok" | "neutral"; children: ReactNode }) {
  const map = { sun: "bg-gold/[0.07] border-gold/70", danger: "bg-danger-soft border-danger", ok: "bg-ok-soft border-ok", neutral: "bg-surface-2/60 border-line" };
  return <div className={cn("rounded-sm border-l-2 px-4 py-3 text-[14px] leading-relaxed", map[tone])}>{children}</div>;
}

/**
 * Bloco quadrado grande (atalho), no estilo dos ícones do iOS/macOS: ícone colorido, rótulo e uma linha de apoio.
 * `rgb` define a cor do ícone (ex.: a cor da página de destino). Fica quadrado na grade (aspect-square) a partir de sm.
 */
export function Tile({ href, icon: Icon, title, text, rgb, badge, active, square = true, className }: {
  href: string; icon: LucideIcon; title: string; text?: string; rgb?: string; badge?: ReactNode; active?: boolean; square?: boolean; className?: string;
}) {
  const style = rgb ? ({ "--icone-rgb": rgb } as CSSProperties) : undefined;
  return (
    <Link href={href} style={style} aria-current={active ? "page" : undefined}
      className={cn("vidro bloco group relative flex min-h-[136px] flex-col justify-between gap-3 rounded-lg p-4 sm:p-5 xl:p-4", square && "sm:aspect-square sm:min-h-0", className)}>
      <span className="flex items-start justify-between gap-2">
        <span className="icone-app size-12 rounded-[14px]"><Icon size={24} aria-hidden strokeWidth={1.9} /></span>
        {badge}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[15.5px] font-semibold leading-snug">{title}</span>
        {text && <span className="t-small mt-0.5 line-clamp-2 block xl:line-clamp-1">{text}</span>}
      </span>
    </Link>
  );
}
