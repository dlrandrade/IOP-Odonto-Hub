"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import {
  BarChart3, Bot, Moon, CalendarDays, KanbanSquare, MessageCircle, Search, Settings, Sparkles, Sun, Users, Zap, X, MoreHorizontal, CornerDownLeft,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/format";
import { searchAction, type SearchResult } from "../../app/(dashboard)/search-actions";

const ICONS: Record<string, LucideIcon> = {
  hoje: Sun, conversas: MessageCircle, agenda: CalendarDays, pacientes: Users, crm: KanbanSquare, indicadores: BarChart3,
  servicos: Sparkles, automacoes: Zap, simulador: Bot, config: Settings,
};

export type NavEntry = { href: string; label: string; icon: string; badge?: number };
export type NavGroup = { title: string | null; items: NavEntry[] };

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

function Item({ item, onNavigate }: { item: NavEntry; onNavigate?: () => void }) {
  const path = usePathname();
  const active = isActive(path, item.href);
  const Icon = ICONS[item.icon] ?? Sun;
  return (
    <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined}
      className={cn("group relative flex items-center gap-3 rounded-md py-2 pl-4 pr-3 text-[13.5px] font-medium transition-colors",
        active ? "bg-surface-2 text-bone" : "text-bone-dim hover:bg-surface-2/60 hover:text-bone")}>
      <span aria-hidden className={cn("absolute left-1.5 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-acento transition-opacity", active ? "opacity-100" : "opacity-0")} />
      <Icon size={16} aria-hidden className={cn("shrink-0 transition-colors", active ? "text-acento" : "text-bone-mute group-hover:text-bone-dim")} />
      <span className="flex-1 truncate">{item.label}</span>
      {!!item.badge && <span className="rounded-sm bg-acento px-1.5 py-px font-mono text-[10px] font-medium text-on">{item.badge}</span>}
    </Link>
  );
}

/** Menu lateral (desktop): grupos por tarefa, configurações no rodapé, progresso dos primeiros passos e usuário. */
export function Sidebar({ groups, settings, footer }: { groups: NavGroup[]; settings?: NavEntry; footer: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <nav aria-label="Principal" className="scroll-thin flex-1 space-y-6 overflow-y-auto px-3 py-4">
        {groups.map((g, i) => (
          <div key={i}>
            {g.title && <p className="mb-1.5 px-3 text-[11px] font-medium text-bone-mute">{g.title}</p>}
            <div className="space-y-0.5">{g.items.map((it) => <Item key={it.href} item={it} />)}</div>
          </div>
        ))}
      </nav>
      <div className="space-y-3 border-t border-line p-3">
        {settings && <Item item={settings} />}
        {footer}
      </div>
    </div>
  );
}

/** Barra inferior (celular): as quatro tarefas do dia a dia e "Mais". */
export function MobileTabs({ primary, more }: { primary: NavEntry[]; more: NavGroup[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close(); }, [open]);
  useEffect(() => { setOpen(false); }, [path]);
  const moreActive = more.some((g) => g.items.some((i) => isActive(path, i.href)));
  return (
    <>
      <nav aria-label="Principal" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-line bg-ink/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {primary.slice(0, 4).map((item) => {
          const active = isActive(path, item.href);
          const Icon = ICONS[item.icon] ?? Sun;
          return (
            <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}
              className={cn("relative flex flex-col items-center gap-1 py-2.5 text-[10.5px] font-medium", active ? "text-bone" : "text-bone-mute")}>
              <span className={cn("absolute inset-x-5 top-0 h-0.5 rounded-full bg-acento transition-opacity", active ? "opacity-100" : "opacity-0")} aria-hidden />
              <span className="relative"><Icon size={19} aria-hidden className={active ? "text-acento" : ""} />
                {!!item.badge && <span className="absolute -right-2.5 -top-1.5 rounded-sm bg-acento px-1 font-mono text-[9px] font-medium text-on">{item.badge}</span>}
              </span>
              {item.label}
            </Link>
          );
        })}
        <button type="button" onClick={() => setOpen(true)} className={cn("flex flex-col items-center gap-1 py-2.5 text-[10.5px] font-medium", moreActive ? "text-bone" : "text-bone-mute")}>
          <MoreHorizontal size={19} aria-hidden className={moreActive ? "text-acento" : ""} />Mais
        </button>
      </nav>
      <dialog ref={ref} onClose={() => setOpen(false)} onClick={(e) => { if (e.target === ref.current) setOpen(false); }}
        className="m-0 mt-auto w-full max-w-none rounded-t-lg border border-b-0 border-line bg-surface p-0 text-bone">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <p className="font-display text-[17px] font-bold">Mais opções</p>
          <button type="button" aria-label="Fechar" onClick={() => setOpen(false)} className="rounded-sm p-1.5 hover:bg-surface-2"><X size={18} /></button>
        </div>
        <div className="space-y-5 px-3 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          {more.map((g, i) => (
            <div key={i}>
              {g.title && <p className="mb-1.5 px-3 text-[11px] font-medium text-bone-mute">{g.title}</p>}
              <div className="space-y-0.5">{g.items.map((it) => <Item key={it.href} item={it} onNavigate={() => setOpen(false)} />)}</div>
            </div>
          ))}
        </div>
      </dialog>
    </>
  );
}

/** Busca global. ⌘K / Ctrl+K em qualquer tela; acha pacientes, conversas e páginas. */
export function SearchBox({ pages, compact }: { pages: NavEntry[]; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [pending, start] = useTransition();
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const close = useCallback(() => { setOpen(false); setTerm(""); setResults([]); setCursor(0); }, []);
  useEffect(() => {
    if (compact) return; // só a busca do cabeçalho de desktop escuta o atalho
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen(true); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compact]);
  useEffect(() => { if (open) { ref.current?.showModal(); setTimeout(() => input.current?.focus(), 30); } else ref.current?.close(); }, [open]);
  useEffect(() => {
    const id = ++seq.current;
    if (term.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(() => start(async () => { const r = await searchAction(term); if (id === seq.current) { setResults(r); setCursor(0); } }), 180);
    return () => clearTimeout(t);
  }, [term]);

  const lower = term.trim().toLowerCase();
  const pageHits: SearchResult[] = lower.length >= 2
    ? pages.filter((p) => p.label.toLowerCase().includes(lower)).slice(0, 3).map((p) => ({ kind: "paciente" as const, id: p.href, title: p.label, detail: "Ir para a página", href: p.href }))
    : [];
  const all = [...results, ...pageHits];
  const go = (href: string) => { close(); window.location.assign(href); };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Buscar (Ctrl K)"
        className={compact ? "flex size-9 items-center justify-center rounded-md border border-line text-bone-dim" : "flex h-9 w-full max-w-md items-center gap-2.5 rounded-md border border-line bg-surface px-3 text-left text-[13px] text-bone-mute transition-colors hover:border-bone-mute/60"}>
        <Search size={15} aria-hidden />
        {!compact && <><span className="flex-1 truncate">Buscar paciente, conversa ou página</span>
        <kbd className="hidden rounded-sm border border-line px-1.5 py-px font-mono text-[10px] sm:inline">⌘K</kbd></>}
      </button>
      <dialog ref={ref} onClose={close} onClick={(e) => { if (e.target === ref.current) close(); }}
        className="mt-[12vh] w-[calc(100vw-2rem)] max-w-xl rounded-lg border border-line bg-surface p-0 text-bone shadow-deep">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search size={16} aria-hidden className="text-bone-mute" />
          <input ref={input} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Nome, telefone ou página…" aria-label="Buscar"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, Math.max(all.length - 1, 0))); }
              if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
              if (e.key === "Enter" && all[cursor]) go(all[cursor]!.href);
            }}
            className="h-12 flex-1 bg-transparent text-[15px] placeholder:text-bone-mute focus:outline-none" />
          {pending && <span className="text-[11px] text-bone-mute">buscando…</span>}
        </div>
        <ul className="scroll-thin max-h-[50vh] overflow-y-auto p-2" role="listbox">
          {term.trim().length < 2 && <li className="px-3 py-6 text-center text-[13px] text-bone-mute">Digite ao menos 2 letras. Dica: um final de telefone também funciona.</li>}
          {term.trim().length >= 2 && all.length === 0 && !pending && <li className="px-3 py-6 text-center text-[13px] text-bone-mute">Nada encontrado para “{term.trim()}”.</li>}
          {all.map((r, i) => (
            <li key={`${r.kind}-${r.id}`} role="option" aria-selected={i === cursor}>
              <button type="button" onClick={() => go(r.href)} onMouseEnter={() => setCursor(i)}
                className={cn("flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left", i === cursor ? "bg-surface-2" : "")}>
                <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-bone-mute">{r.detail === "Ir para a página" ? "página" : r.kind}</span>
                <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{r.title}</span>{r.detail !== "Ir para a página" && <span className="block truncate text-[12px] text-bone-mute">{r.detail}</span>}</span>
                {i === cursor && <CornerDownLeft size={14} aria-hidden className="text-bone-mute" />}
              </button>
            </li>
          ))}
        </ul>
      </dialog>
    </>
  );
}

/** Páginas que usam toda a largura da janela (quadros largos, como o funil). */
const FULL_WIDTH = ["/crm"];

/** Moldura de largura: topo e conteúdo compartilham exatamente a mesma coluna, em qualquer tamanho de tela. */
export function Frame({ className, children }: { className?: string; children: ReactNode }) {
  const path = usePathname();
  const full = FULL_WIDTH.some((p) => path === p || path.startsWith(p + "/"));
  return <div className={cn("mx-auto w-full min-w-0 px-4 sm:px-6 lg:px-10", full ? "max-w-none" : "max-w-[1320px]", className)}>{children}</div>;
}

/** Alterna entre tema escuro e claro. Salva a escolha em cookie (1 ano) para o servidor já renderizar certo. */
export function ThemeToggle({ className }: { className?: string }) {
  const [light, setLight] = useState(false);
  useEffect(() => { setLight(document.documentElement.dataset.theme === "light"); }, []);
  const toggle = () => {
    const next = light ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    document.cookie = `tema=${next}; path=/; max-age=31536000; samesite=lax`;
    setLight(!light);
  };
  return (
    <button type="button" onClick={toggle} aria-label={light ? "Usar tema escuro" : "Usar tema claro"} title={light ? "Tema escuro" : "Tema claro"}
      className={cn("flex size-8 items-center justify-center rounded-sm border border-line text-bone-dim transition-colors hover:border-bone-mute/50 hover:text-bone", className)}>
      {light ? <Moon size={15} aria-hidden /> : <Sun size={15} aria-hidden />}
    </button>
  );
}
