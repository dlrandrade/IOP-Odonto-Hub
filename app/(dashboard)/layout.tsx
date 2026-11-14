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
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-ink/85 backdrop-blur">
        <div className="mx-auto w-full max-w-[1500px] px-3 sm:px-5">
          <div className="flex h-14 items-center justify-between gap-3">
            <Link href="/" aria-label="Início"><Logo /></Link>
            <div className="flex min-w-0 items-center justify-end gap-2">
              {!!counts?.urgent && (
                <Link href="/conversas?f=urgentes" className="flex items-center gap-1.5 rounded-sm bg-danger px-3 py-1.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.1em] text-ink">
                  <TriangleAlert size={13} aria-hidden /> {counts.urgent} urgente{counts.urgent > 1 ? "s" : ""}
                </Link>
              )}
              <Badge tone={aiOn ? "ok" : "warn"} className="hidden sm:inline-flex"><Bot size={11} aria-hidden /> IA {ctx.clinic.ai_kill_switch ? "pausada" : aiOn ? "ativa" : "desligada"}</Badge>
              {ctx.clinic.is_demo && <Badge tone="sun" className="hidden sm:inline-flex">Demonstração</Badge>}
              {ctx.isPlatformAdmin && (
                <Link href="/admin" className="flex items-center gap-1.5 rounded-sm border border-line px-3 py-1.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.1em] text-bone-dim transition-colors hover:border-gold hover:text-gold"><ShieldCheck size={13} aria-hidden /> <span className="hidden sm:inline">Plataforma</span><span className="sr-only sm:hidden">Plataforma</span></Link>
              )}
              <div className="hidden items-center gap-2.5 border-l border-line pl-3 md:flex">
                <Avatar name={ctx.name} size={28} />
                <span className="leading-tight">
                  <span className="block max-w-36 truncate text-xs font-medium">{ctx.name}</span>
                  <span className="block max-w-36 truncate text-[10.5px] text-bone-mute">{ROLE_LABELS[ctx.role]} · {ctx.clinic.name}</span>
                </span>
              </div>
              <form action={logoutAction}>
                <button aria-label="Sair" title="Sair" className="flex size-8 items-center justify-center rounded-sm border border-line text-bone-dim transition-colors hover:border-bone-dim hover:text-bone"><LogOut size={14} /></button>
              </form>
            </div>
          </div>
          <TopNav items={items} />
        </div>
      </header>
      <main className="mx-auto mt-6 w-full min-w-0 max-w-[1500px] flex-1 px-3 pb-12 sm:px-5">{children}</main>
    </div>
  );
}
