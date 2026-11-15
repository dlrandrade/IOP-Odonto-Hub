import type { ReactNode } from "react";
import Link from "next/link";
import { Bot, LogOut, ShieldCheck, TriangleAlert } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { Logo } from "@/components/brand";
import { Frame, MobileTabs, ThemeToggle, SearchBox, Sidebar, type NavEntry, type NavGroup } from "@/components/nav";
import { Avatar, Badge } from "@/components/ui";
import { can, ROLE_LABELS } from "@/domain/permissions";
import { setupSteps } from "@/services/setup-progress";
import { logoutAction } from "../(auth)/actions";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const ctx = await requireCtx();
  // As duas consultas seguem juntas na mesma transação (pipeline do driver): uma única espera.
  const { counts, steps } = await q(ctx, async (tx) => {
    const [rows, steps] = await Promise.all([
      can(ctx.role, "conversations.view")
        ? tx<{ waiting: number; urgent: number }[]>`
            select count(*) filter (where state = 'awaiting_human')::int as waiting,
                   count(*) filter (where state = 'awaiting_human' and handoff_priority = 'urgente')::int as urgent
            from conversations`
        : Promise.resolve([]),
      setupSteps(tx, ctx),
    ]);
    return { counts: rows[0], steps };
  });

  // Menu por tarefa: o dia a dia no topo; gestão separada. Módulos P1 ficam ocultos até serem entregues.
  const entry = (href: string, label: string, icon: string, allowed: boolean, badge?: number): NavEntry[] => (allowed ? [{ href, label, icon, badge }] : []);
  const groups: NavGroup[] = [
    {
      title: null,
      items: [
        ...entry("/", "Hoje", "hoje", true),
        ...entry("/conversas", "Conversas", "conversas", can(ctx.role, "conversations.view"), counts?.waiting || undefined),
        ...entry("/agenda", "Agenda", "agenda", can(ctx.role, "agenda.view")),
        ...entry("/pacientes", "Pacientes", "pacientes", can(ctx.role, "patients.view")),
      ],
    },
    { title: "Relacionamento", items: entry("/crm", "Oportunidades", "crm", can(ctx.role, "crm.view")) },
    {
      title: "Gestão",
      items: [
        ...entry("/indicadores", "Indicadores", "indicadores", can(ctx.role, "dashboard.view")),
        ...entry("/servicos", "Serviços e conhecimento", "servicos", can(ctx.role, "catalog.publish")),
        ...entry("/automacoes", "Automações", "automacoes", can(ctx.role, "automations.manage")),
        ...entry("/simulador", "Simulador de paciente", "simulador", can(ctx.role, "simulator.use")),
      ],
    },
  ].filter((g) => g.items.length > 0);
  const settings = can(ctx.role, "audit.view") ? { href: "/configuracoes", label: "Configurações", icon: "config" } : undefined;
  const flat = [...groups.flatMap((g) => g.items), ...(settings ? [settings] : [])];
  const primary = flat.filter((i) => ["/", "/conversas", "/agenda", "/pacientes"].includes(i.href));
  const primaryHrefs = new Set(primary.map((i) => i.href));
  const more: NavGroup[] = [{ title: null, items: flat.filter((i) => !primaryHrefs.has(i.href)) }];
  const aiOn = ctx.clinic.ai_enabled && !ctx.clinic.ai_kill_switch;
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);

  const footer = (
    <>
      {next && (
        <Link href={next.href} className="block rounded-md border border-line bg-surface-2/50 p-3 transition-colors hover:border-bone-mute/50">
          <span className="flex items-center justify-between text-[11px] font-medium text-bone-mute"><span>Primeiros passos</span><span className="font-mono">{done}/{steps.length}</span></span>
          <span className="mt-2 block h-1 overflow-hidden rounded-full bg-line"><span className="block h-full rounded-full bg-gold" style={{ width: `${(done / steps.length) * 100}%` }} /></span>
          <span className="mt-2.5 block text-[12.5px] font-medium">{next.label}</span>
        </Link>
      )}
      <div className="flex items-center gap-1 px-1">
        <Link href="/perfil" title="Meu perfil: nome, foto e senha" className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-sm p-1 transition-colors hover:bg-surface-2">
          <Avatar name={ctx.name} src={ctx.avatar} size={32} />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[13px] font-medium group-hover:text-bone">{ctx.name}</span>
            <span className="block truncate text-[11px] text-bone-mute">{ctx.actingAsPlatform ? "Plataforma" : ROLE_LABELS[ctx.role]} · {ctx.clinic.name}</span>
          </span>
        </Link>
        <form action={logoutAction}>
          <button aria-label="Sair" title="Sair" className="flex size-8 items-center justify-center rounded-sm text-bone-mute transition-colors hover:bg-surface-2 hover:text-bone"><LogOut size={15} /></button>
        </form>
      </div>
    </>
  );

  return (
    <div className="min-h-dvh lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-surface lg:block">
        <div className="flex h-14 items-center border-b border-line px-6"><Link href="/" aria-label="Início"><Logo /></Link></div>
        <div className="h-[calc(100%-3.5rem)]"><Sidebar groups={groups} settings={settings} footer={footer} /></div>
      </aside>
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-20 border-b border-line bg-ink/85 backdrop-blur">
          <Frame className="flex h-14 items-center gap-3">
          <Link href="/" aria-label="Início" className="lg:hidden"><Logo /></Link>
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 lg:ml-0 lg:justify-between lg:gap-6">
            <div className="hidden min-w-0 max-w-[480px] flex-1 lg:block"><SearchBox pages={flat} /></div>
            <div className="flex items-center gap-2">
              {!!counts?.urgent && (
                <Link href="/conversas?f=urgentes" className="flex items-center gap-1.5 rounded-sm bg-danger px-2.5 py-1.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-on-danger">
                  <TriangleAlert size={13} aria-hidden /> {counts.urgent}<span className="hidden sm:inline"> urgente{counts.urgent > 1 ? "s" : ""}</span>
                </Link>
              )}
              <Link href={can(ctx.role, "ai.configure") ? "/configuracoes?aba=ia" : "/conversas"} className="hidden sm:block">
                <Badge tone={aiOn ? "ok" : "warn"}><Bot size={11} aria-hidden /> IA {ctx.clinic.ai_kill_switch ? "pausada" : aiOn ? "ativa" : "desligada"}</Badge>
              </Link>
              {ctx.clinic.is_demo && <Badge tone="sun" className="hidden md:inline-flex">Demonstração</Badge>}
              {ctx.isPlatformAdmin && (
                <Link href="/admin" aria-label="Painel da plataforma" className="flex items-center gap-1.5 rounded-sm border border-line px-2.5 py-1.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-bone-dim transition-colors hover:border-gold hover:text-gold">
                  <ShieldCheck size={13} aria-hidden /><span className="hidden md:inline">Plataforma</span>
                </Link>
              )}
              <ThemeToggle />
              <span className="lg:hidden"><SearchIconOnly pages={flat} /></span>
            </div>
          </div>
          </Frame>
        </header>
        <main className="entrada flex-1 pb-28 pt-8 lg:pb-16 lg:pt-12"><Frame>{children}</Frame></main>
      </div>
      <MobileTabs primary={primary} more={more} />
    </div>
  );
}

function SearchIconOnly({ pages }: { pages: NavEntry[] }) {
  return <SearchBox pages={pages} compact />;
}
