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
    <nav aria-label="Principal" className="scroll-thin -mx-1 flex items-center gap-1 overflow-x-auto px-1 py-1">
      {items.map((item) => {
        const active = isActive(path, item.href);
        const Icon = ICONS[item.icon] ?? LayoutDashboard;
        return (
          <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}
            className={cn("flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium transition",
              active ? "bg-gold text-ink shadow" : "text-bone-dim hover:bg-surface")}>
            <Icon size={15} aria-hidden />
            {item.label}
            {!!item.badge && <span className={cn("rounded-full px-1.5 text-[10px] font-bold", active ? "bg-gold text-ink" : "bg-gold text-ink")}>{item.badge}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
