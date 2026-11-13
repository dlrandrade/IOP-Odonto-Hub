import type { ReactNode } from "react";
import Link from "next/link";
import { Bot, LogOut, ShieldCheck, TriangleAlert } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { Logo } from "@/components/brand";
import { TopNav, type NavItem } from "@/components/nav";
import { Avatar, Badge } from "@/components/ui";
import { can, ROLE_LABELS } from "@/domain/permissions";
import { logoutAction } from "../(auth)/actions";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const ctx = await requireCtx();
  const counts = can(ctx.role, "conversations.view")
    ? await q(ctx, async (tx) => (await tx<{ waiting: number; urgent: number }[]>`
        select count(*) filter (where state = 'awaiting_human')::int as waiting,
               count(*) filter (where state = 'awaiting_human' and handoff_priority = 'urgente')::int as urgent
        from conversations`)[0])
    : undefined;

  // Menu respeita permissões; módulos P1 (propostas, financeiro, relatórios) ficam ocultos até serem entregues.
  const items: NavItem[] = [
    { href: "/", label: "Visão geral", icon: "home" },
    ...(can(ctx.role, "conversations.view") ? [{ href: "/conversas", label: "Conversas", icon: "chat", badge: counts?.waiting }] : []),
    ...(can(ctx.role, "crm.view") ? [{ href: "/crm", label: "CRM", icon: "crm" }] : []),
    ...(can(ctx.role, "agenda.view") ? [{ href: "/agenda", label: "Agenda", icon: "agenda" }] : []),
    ...(can(ctx.role, "patients.view") ? [{ href: "/pacientes", label: "Pacientes", icon: "patients" }] : []),
    ...(can(ctx.role, "catalog.publish") ? [{ href: "/servicos", label: "Serviços e conhecimento", icon: "services" }] : []),
    ...(can(ctx.role, "automations.manage") ? [{ href: "/automacoes", label: "Automações", icon: "automations" }] : []),
    ...(can(ctx.role, "simulator.use") ? [{ href: "/simulador", label: "Simulador", icon: "simulator" }] : []),
    ...(can(ctx.role, "audit.view") ? [{ href: "/configuracoes", label: "Configurações", icon: "settings" }] : []),
  ];
  const aiOn = ctx.clinic.ai_enabled && !ctx.clinic.ai_kill_switch;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1500px] flex-col overflow-x-clip px-3 pb-8 sm:px-5">
      <header className="sticky top-0 z-30 -mx-3 bg-ink/90 px-3 pb-2 pt-3 backdrop-blur sm:-mx-5 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" aria-label="Início"><Logo /></Link>
          <div className="flex min-w-0 items-center justify-end gap-2">
            {!!counts?.urgent && (
              <Link href="/conversas?f=urgentes" className="flex items-center gap-1.5 rounded-full bg-danger px-3 py-1.5 text-xs font-bold text-white">
                <TriangleAlert size={14} aria-hidden /> {counts.urgent} urgente{counts.urgent > 1 ? "s" : ""}
              </Link>
            )}
            <Badge tone={aiOn ? "ok" : "warn"} className="hidden sm:inline-flex"><Bot size={12} aria-hidden /> IA {ctx.clinic.ai_kill_switch ? "pausada" : aiOn ? "ativa" : "desligada"}</Badge>
            {ctx.clinic.is_demo && <Badge tone="sun" className="hidden sm:inline-flex">Demonstração</Badge>}
            {ctx.isPlatformAdmin && (
              <Link href="/admin" className="flex items-center gap-1 rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-semibold"><ShieldCheck size={14} aria-hidden /> <span className="hidden sm:inline">Plataforma</span><span className="sr-only sm:hidden">Plataforma</span></Link>
            )}
            <div className="hidden items-center gap-2 rounded-full bg-surface py-1 pl-1 pr-3 border border-line md:flex">
              <Avatar name={ctx.name} size={30} />
              <span className="leading-tight">
                <span className="block max-w-36 truncate text-xs font-semibold">{ctx.name}</span>
                <span className="block max-w-36 truncate text-[10px] text-bone-mute">{ROLE_LABELS[ctx.role]} · {ctx.clinic.name}</span>
              </span>
            </div>
            <form action={logoutAction}>
              <button aria-label="Sair" title="Sair" className="flex size-9 items-center justify-center rounded-full bg-surface border border-line hover:bg-surface-2"><LogOut size={15} /></button>
            </form>
          </div>
        </div>
        <div className="mt-2"><TopNav items={items} /></div>
      </header>
      <main className="mt-3 min-w-0 flex-1">{children}</main>
    </div>
  );
}
