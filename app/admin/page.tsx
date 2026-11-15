import Link from "next/link";
import { redirect } from "next/navigation";
import { getIdentity } from "@/auth/session";
import { Logo } from "@/components/brand";
import { ThemeToggle } from "@/components/nav";
import { ProfileForm } from "../perfil/profile-form";
import { Stat } from "@/components/charts";
import { ActionForm, Modal } from "@/components/client";
import { Avatar, Badge, Button, buttonClass, Card, Checkbox, Empty, Field, InfoTip, Input, Select } from "@/components/ui";
import { db } from "@/db/client";
import { missingEnv } from "@/lib/env";
import { logoutAction } from "../(auth)/actions";
import { clinicStatusAction, createClientClinicAction, demoActivityAction, enterClinicAction, leaveClinicAction } from "./actions";

export const metadata = { title: "Plataforma" };
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = { trial: "Em teste", active: "Ativa", suspended: "Suspensa" };

/** Painel do operador do SaaS: todas as clínicas clientes, uso e acesso de suporte. */
export default async function PlatformPage() {
  if (missingEnv().length > 0) redirect("/setup");
  const me = await getIdentity();
  if (!me) redirect("/login");
  if (!me.isPlatformAdmin) redirect("/");
  // Consulta de sistema restrita ao operador da plataforma (verificado acima): só agregados por clínica.
  const clinics = await db()<{ id: string; name: string; status: string; is_demo: boolean; created_at: Date; ai_enabled: boolean; users: number; conversations_30d: number; appointments_30d: number; wa: boolean; ai_cost: string }[]>`
    select c.id, c.name, c.status, c.is_demo, c.created_at, c.ai_enabled,
      (select count(*)::int from app_users u where u.clinic_id = c.id and u.active) as users,
      (select count(*)::int from conversations v where v.clinic_id = c.id and v.created_at > now() - interval '30 days') as conversations_30d,
      (select count(*)::int from appointments a where a.clinic_id = c.id and a.created_at > now() - interval '30 days') as appointments_30d,
      exists (select 1 from clinic_integrations i where i.clinic_id = c.id and case i.wa_provider when 'evolution' then i.evo_connected_at is not null when 'wacli' then i.wacli_connected_at is not null else i.wa_phone_number_id is not null end) as wa,
      (select coalesce(sum(cost_cents), 0)::text from ai_runs r where r.clinic_id = c.id and r.created_at > now() - interval '30 days') as ai_cost
    from clinics c order by c.created_at desc`;
  const acting = clinics.find((c) => c.id === me.actingClinicId);

  return (
    <main className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 lg:px-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Logo />
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-bone-mute sm:inline">{me.email}</span>
          <Modal trigger={<><Avatar name={me.platformName ?? me.email} src={me.platformAvatar} size={26} /> <span className="hidden sm:inline">{me.platformName ?? "Meu perfil"}</span></>} title="Meu perfil" description="Seu nome e sua foto aparecem quando você entra nas clínicas como suporte." wide triggerClass={buttonClass("ghost", "sm")} triggerTitle="Meu perfil">
            <ProfileForm name={me.platformName ?? ""} email={me.email} avatar={me.platformAvatar} roleLabel="Operador da plataforma" />
          </Modal>
          <ThemeToggle />
          <form action={logoutAction}><Button size="sm" variant="ghost">Sair</Button></form>
        </div>
      </div>
      {acting && (
        <div className="vidro mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg px-5 py-3.5">
          <p className="text-[14px]">Você está acessando <strong>{acting.name}</strong> como suporte.</p>
          <div className="flex items-center gap-2">
            <Link href="/" className={buttonClass("primary", "sm")}>Voltar para a clínica</Link>
            <form action={leaveClinicAction}><Button size="sm" variant="ghost">Sair da clínica</Button></form>
          </div>
        </div>
      )}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow mb-2 text-bone-mute">Operador da plataforma</p>
          <h1 className="display text-[40px] leading-none">Suas clínicas</h1>
        </div>
        <Modal trigger="Nova clínica cliente" title="Nova clínica cliente" description="Cria a clínica com o responsável como administrador e uma senha provisória para você entregar a ele." wide triggerClass={buttonClass("accent")}>
          <ActionForm action={createClientClinicAction} className="space-y-4" resetOnDone={false}>
            <Field label="Nome da clínica"><Input name="clinicName" required /></Field>
            <div className="grid gap-6 sm:grid-cols-2">
              <Field label="Responsável"><Input name="ownerName" required /></Field>
              <Field label="Cadeiras"><Input name="chairs" type="number" min={1} max={30} defaultValue={2} required /></Field>
            </div>
            <Field label="E-mail do responsável"><Input name="ownerEmail" type="email" required /></Field>
            <Field label="Senha provisória" hint="Entregue ao cliente por um canal seguro; ele entra como administrador da clínica."><Input name="ownerPassword" type="text" minLength={8} required autoComplete="off" /></Field>
<fieldset className="space-y-4 rounded-lg border border-line p-4">
              <legend className="eyebrow px-1.5 text-bone-mute">Dados da contratação (opcional)</legend>
              <p className="t-small">Configuram a conta já na criação: contatos e endereço para a assistente, Google com QR code e a automação de pedir avaliação.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Telefone da clínica"><Input name="contactPhone" inputMode="tel" /></Field>
                <Field label="E-mail da clínica"><Input name="contactEmail" type="email" /></Field>
                <Field label="Instagram"><Input name="instagram" placeholder="@clinica" /></Field>
                <Field label="Site"><Input name="website" /></Field>
              </div>
              <Field label="Endereço"><Input name="address" /></Field>
              <Field label="Link de avaliação do Google"><Input name="googleReviewUrl" placeholder="https://g.page/r/…/review" /></Field>
            </fieldset>
            <Checkbox name="demo" label="Criar com dados de demonstração" hint="Pacientes, consultas e funil fictícios — ideal para apresentações de venda." />
            <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Criar clínica</Button></div>
          </ActionForm>
        </Modal>
      </div>
      <div className="mb-10 grid gap-6 sm:grid-cols-3">
        <Stat label="Clínicas" value={String(clinics.length)} note={`${clinics.filter((c) => c.status === "active").length} ativas · ${clinics.filter((c) => c.status === "trial").length} em teste`} />
        <Stat label="Conversas (30 dias)" value={String(clinics.reduce((a, c) => a + c.conversations_30d, 0))} tone="sun" />
        <Stat label="Consultas marcadas (30 dias)" value={String(clinics.reduce((a, c) => a + c.appointments_30d, 0))} tone="navy" />
      </div>
      <section aria-labelledby="clientes">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 id="clientes" className="t-h2 flex items-center gap-1.5">Clientes <InfoTip text="Apenas números agregados; para ver dados de uma clínica é preciso entrar nela (o acesso fica registrado na auditoria da clínica)." /></h2>
            <p className="t-small mt-1">{clinics.length} clínica{clinics.length === 1 ? "" : "s"} · números dos últimos 30 dias</p>
          </div>
        </div>
        {clinics.length === 0 ? <Card><Empty title="Nenhuma clínica ainda">Crie a primeira clínica cliente ou uma demonstração.</Empty></Card> : (
          // Um cartão por clínica (em vez de tabela larga): identidade, números e uma ação principal; o resto em "Gerenciar".
          <ul className="space-y-4">
            {clinics.map((c) => (
              <li key={c.id} className="vidro grid items-center gap-5 rounded-lg p-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_auto] lg:gap-8">
                <div className="flex min-w-0 items-center gap-4">
                  <span className="icone-app size-12 shrink-0 rounded-[14px] font-display text-[17px] font-bold">{c.name.split(/\s+/).filter((w) => w.length > 2).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "C"}</span>
                  <div className="min-w-0">
                    <p className="t-h3 truncate text-[16px]" title={c.name}>{c.name}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge tone={c.status === "active" ? "ok" : c.status === "suspended" ? "danger" : "warn"}>{STATUS_LABEL[c.status] ?? c.status}</Badge>
                      {c.is_demo && <Badge tone="sun">Demo</Badge>}
                      <span className="t-small">desde {new Intl.DateTimeFormat("pt-BR").format(c.created_at)}</span>
                    </div>
                  </div>
                </div>
                <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md bg-line/60 sm:grid-cols-5">
                  {([
                    ["Usuários", String(c.users)],
                    ["Conversas", String(c.conversations_30d)],
                    ["Consultas", String(c.appointments_30d)],
                    ["WhatsApp", c.wa ? "Conectado" : "Pendente", c.wa ? "bg-ok" : "bg-bone-mute/50"],
                    ["IA", c.ai_enabled ? "Ativa" : "Desligada", c.ai_enabled ? "bg-ok" : "bg-bone-mute/50"],
                  ] as [string, string, string?][]).map(([k, v, dot]) => (
                    <div key={k} className="flex flex-col gap-1 bg-surface/80 px-3 py-2.5">
                      <dt className="t-small truncate text-[11.5px]">{k}</dt>
                      <dd className={dot ? "flex items-center gap-1.5 text-[13px] font-medium" : "display num text-[20px] leading-none"}>{dot && <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} />}{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  <form action={enterClinicAction}><input type="hidden" name="clinicId" value={c.id} /><Button title="Abre a clínica com todos os detalhes">Entrar</Button></form>
                  <Modal trigger="Gerenciar" title={c.name} description="Situação da conta, visão do cliente e dados de demonstração." triggerClass={buttonClass("outline")}>
                    <div className="space-y-6">
                      <form action={enterClinicAction} className="flex items-center justify-between gap-4 rounded-lg border border-line p-4">
                        <input type="hidden" name="clinicId" value={c.id} /><input type="hidden" name="vista" value="simples" />
                        <span><span className="t-h3 block">Ver como cliente</span><span className="t-small">Abre na visualização simples, como a equipe da clínica vê.</span></span>
                        <Button variant="outline" size="sm">Abrir</Button>
                      </form>
                      <ActionForm action={clinicStatusAction} className="space-y-4" resetOnDone={false}>
                        <input type="hidden" name="clinicId" value={c.id} />
                        <Field label="Situação da conta" hint="Suspensa: a equipe da clínica perde o acesso até reativar.">
                          <Select name="status" defaultValue={c.status}>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
                        </Field>
                        <div className="flex justify-end"><Button type="submit" size="sm">Salvar situação</Button></div>
                      </ActionForm>
                      {c.is_demo && (
                        <form action={demoActivityAction} className="flex items-center justify-between gap-4 rounded-lg border border-line p-4">
                          <input type="hidden" name="clinicId" value={c.id} />
                          <span><span className="t-h3 block">Movimentar demonstração</span><span className="t-small">Cria conversas, tarefas e consultas de hoje (fictícias).</span></span>
                          <Button variant="outline" size="sm">Movimentar</Button>
                        </form>
                      )}
                      <p className="t-small border-t border-line pt-4">Custo estimado de IA (30 dias): US$ {(Number(c.ai_cost) / 100).toFixed(2).replace(".", ",")}</p>
                    </div>
                  </Modal>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
