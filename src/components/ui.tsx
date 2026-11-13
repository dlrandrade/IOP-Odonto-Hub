import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/format";

/** Primitivos de interface no estilo IOP Business (cartões brancos arredondados sobre creme, marinho + amarelo). */

type ButtonVariant = "primary" | "accent" | "outline" | "ghost" | "danger";
const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-gold text-ink hover:bg-gold-soft",
  accent: "bg-bone text-ink hover:opacity-90",
  outline: "border border-line bg-surface text-bone hover:bg-surface-2",
  ghost: "text-bone-dim hover:bg-surface-2",
  danger: "bg-danger text-white hover:opacity-90",
};

export function buttonClass(variant: ButtonVariant = "primary", size: "sm" | "md" = "md"): string {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-full font-semibold transition disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap",
    size === "sm" ? "h-8 px-3 text-xs" : "h-10 px-5 text-sm", BUTTON[variant],
  );
}

export function Button({ variant = "primary", size = "md", className, ...props }: ComponentProps<"button"> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  return <button className={cn(buttonClass(variant, size), className)} {...props} />;
}

export function Card({ className, tone = "white", ...props }: ComponentProps<"div"> & { tone?: "white" | "navy" | "sun" }) {
  const bg = tone === "navy" ? "bg-surface-2" : tone === "sun" ? "bg-gold text-ink" : "bg-surface";
  return <div className={cn("rounded-[var(--radius-card)] border border-line p-5", bg, className)} {...props} />;
}

export function CardTitle({ children, action, hint }: { children: ReactNode; action?: ReactNode; hint?: string }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold">{children}</h2>
        {hint && <p className="mt-0.5 text-xs text-bone-mute">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight md:text-[28px]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-bone-mute">{subtitle}</p>}
      </div>
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

type Tone = "neutral" | "navy" | "sun" | "ok" | "warn" | "danger";
const TONES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-bone-dim", navy: "bg-bone text-ink", sun: "bg-gold text-ink",
  ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", danger: "bg-danger-soft text-danger",
};

export function Badge({ tone = "neutral", className, ...props }: ComponentProps<"span"> & { tone?: Tone }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold", TONES[tone], className)} {...props} />;
}

/** Largura total por padrão; passe uma classe w-* para sobrescrever sem conflito de utilitários. */
const width = (className?: string) => (className && /(^|\s)w-/.test(className) ? "" : "w-full");
const height = (className: string | undefined, fallback: string, prefix: RegExp) => (className && prefix.test(className) ? "" : fallback);
const FIELD = "rounded-xl border border-line bg-surface px-3 text-sm text-bone placeholder:text-bone-mute focus:border-line focus:outline-none";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(FIELD, width(className), height(className, "h-10", /(^|\s)h-/), className)} {...props} />;
}
export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(FIELD, width(className), height(className, "h-10", /(^|\s)h-/), className)} {...props} />;
}
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(FIELD, width(className), height(className, "min-h-24", /(^|\s)min-h-/), "py-2", className)} {...props} />;
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-xs font-semibold text-bone-dim">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-bone-mute">{hint}</span>}
    </label>
  );
}

export function Checkbox({ label, hint, ...props }: ComponentProps<"input"> & { label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-2.5 text-sm">
      <input type="checkbox" className="mt-0.5 size-4 accent-gold" {...props} />
      <span><span className="font-medium">{label}</span>{hint && <span className="block text-[11px] text-bone-mute">{hint}</span>}</span>
    </label>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-4 py-8 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1 text-sm text-bone-mute">{children}</div>}
    </div>
  );
}

export function Avatar({ name, color, size = 36 }: { name: string; color?: string; size?: number }) {
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("");
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.36, background: color ?? "var(--color-line)" }}>
      {letters || "?"}
    </span>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-wider text-bone-mute">
            {head.map((h) => <th key={h} className="px-2 py-2 font-semibold">{h}</th>)}
          </tr>
        </thead>
        <tbody className="[&_td]:px-2 [&_td]:py-2.5 [&_tr]:border-b [&_tr]:border-line [&_tr:last-child]:border-0">{children}</tbody>
      </table>
    </div>
  );
}

export function Notice({ tone = "sun", children }: { tone?: "sun" | "danger" | "ok" | "neutral"; children: ReactNode }) {
  const map = { sun: "bg-gold/10 border-gold", danger: "bg-danger-soft border-danger", ok: "bg-ok-soft border-ok", neutral: "bg-surface-2 border-line" };
  return <div className={cn("rounded-2xl border-l-4 px-4 py-3 text-sm", map[tone])}>{children}</div>;
}
