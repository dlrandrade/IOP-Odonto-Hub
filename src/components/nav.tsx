"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Bot, CalendarDays, KanbanSquare, LayoutDashboard, MessageCircle, Settings, Sparkles, Users, Zap, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/format";

const ICONS: Record<string, LucideIcon> = {
  home: LayoutDashboard, chat: MessageCircle, crm: KanbanSquare, agenda: CalendarDays, patients: Users,
  services: Sparkles, automations: Zap, settings: Settings, simulator: Bot, reports: BarChart3,
};

export type NavItem = { href: string; label: string; icon: string; badge?: number };

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

/** Navegação principal em "pílulas" (referência visual): ativa em marinho, demais discretas. */
export function TopNav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Principal" className="scroll-thin -mx-1 flex items-center gap-1 overflow-x-auto px-1">
      {items.map((item) => {
        const active = isActive(path, item.href);
        const Icon = ICONS[item.icon] ?? LayoutDashboard;
        return (
          <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}
            className={cn("relative flex shrink-0 items-center gap-2 px-3 py-3 text-[13px] font-medium transition-colors",
              active ? "text-bone" : "text-bone-mute hover:text-bone")}>
            <Icon size={14} aria-hidden className={active ? "text-acento" : ""} />
            {item.label}
            {!!item.badge && <span className="rounded-sm bg-acento px-1.5 font-mono text-[10px] font-medium text-ink">{item.badge}</span>}
            <span aria-hidden className={cn("absolute inset-x-3 -bottom-px h-0.5 bg-acento transition-transform duration-300", active ? "scale-x-100" : "scale-x-0")} />
          </Link>
        );
      })}
    </nav>
  );
}
