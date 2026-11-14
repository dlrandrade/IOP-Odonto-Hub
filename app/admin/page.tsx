import { redirect } from "next/navigation";
import { getIdentity } from "@/auth/session";
import { Logo } from "@/components/brand";
import { Stat } from "@/components/charts";
import { ActionForm, Modal } from "@/components/client";
import { Badge, Button, buttonClass, Card, CardTitle, Checkbox, Empty, Field, Input, Select, Table } from "@/components/ui";
import { db } from "@/db/client";
import { missingEnv } from "@/lib/env";
import { logoutAction } from "../(auth)/actions";
import { clinicStatusAction, createClientClinicAction, enterClinicAction, leaveClinicAction } from "./actions";

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
      exists (select 1 from clinic_integrations i where i.clinic_id = c.id and i.wa_phone_number_id is not null) as wa,
      (select coalesce(sum(cost_cents), 0)::text from ai_runs r where r.clinic_id = c.id and r.created_at > now() - interval '30 days') as ai_cost
    from clinics c order by c.created_at desc`;
  const acting = clinics.find((c) => c.id === me.actingClinicId);

  return (
    <main className="mx-auto max-w-6xl p-4 py-6 sm:p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Logo />
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-bone-mute sm:inline">{me.email}</span>
          {acting && <form action={leaveClinicAction}><Button size="sm" variant="outline">Sair de “{acting.name}”</Button></form>}
          <form action={logoutAction}><Button size="sm" variant="ghost">Sair</Button></form>
        </div>
      </div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow mb-2 text-bone-mute">Operador da plataforma</p>
          <h1 className="display text-[40px] leading-none">Suas clínicas</h1>
        </div>
        <Modal trigger="Nova clínica cliente" title="Nova clínica cliente" triggerClass={buttonClass("accent")}>
          <ActionForm action={createClientClinicAction} className="space-y-4" resetOnDone={false}>
            <Field label="Nome da clínica"><Input name="clinicName" required /></Field>
            <div className="grid gap-6 sm:grid-cols-2">
              <Field label="Responsável"><Input name="ownerName" required /></Field>
              <Field label="Cadeiras"><Input name="chairs" type="number" min={1} max={30} defaultValue={2} required /></Field>
            </div>
            <Field label="E-mail do responsável"><Input name="ownerEmail" type="email" required /></Field>
            <Field label="Senha provisória" hint="Entregue ao cliente por um canal seguro; ele entra como administrador da clínica."><Input name="ownerPassword" type="text" minLength={8} required autoComplete="off" /></Field>
            <Checkbox name="demo" label="Criar com dados de demonstração" hint="Pacientes, consultas e funil fictícios — ideal para apresentações de venda." />
            <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Criar clínica</Button></div>
          </ActionForm>
        </Modal>
      </div>
      <div className="mb-4 grid gap-6 sm:grid-cols-3">
        <Stat label="Clínicas" value={String(clinics.length)} note={`${clinics.filter((c) => c.status === "active").length} ativas · ${clinics.filter((c) => c.status === "trial").length} em teste`} />
        <Stat label="Conversas (30 dias)" value={String(clinics.reduce((a, c) => a + c.conversations_30d, 0))} tone="sun" />
        <Stat label="Consultas marcadas (30 dias)" value={String(clinics.reduce((a, c) => a + c.appointments_30d, 0))} tone="navy" />
      </div>
      <Card>
        <CardTitle hint="Apenas números agregados; para ver dados de uma clínica é preciso entrar nela (o acesso fica registrado na auditoria da clínica).">Clientes</CardTitle>
        {clinics.length === 0 ? <Empty title="Nenhuma clínica ainda">Crie a primeira clínica cliente ou uma demonstração.</Empty> : (
          <Table head={["Clínica", "Situação", "Usuários", "Conversas 30d", "Consultas 30d", "WhatsApp", "IA", ""]}>
            {clinics.map((c) => (
              <tr key={c.id}>
                <td><p className="font-semibold">{c.name}</p><p className="text-[11px] text-bone-mute">desde {new Intl.DateTimeFormat("pt-BR").format(c.created_at)}{c.is_demo ? " · demo" : ""}</p></td>
                <td>
                  <ActionForm action={clinicStatusAction} className="flex items-center gap-1">
                    <input type="hidden" name="clinicId" value={c.id} />
                    <Select name="status" defaultValue={c.status} aria-label={`Situação de ${c.name}`} className="h-8 w-auto text-xs">{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
                    <Button size="sm" variant="ghost">ok</Button>
                  </ActionForm>
                </td>
                <td>{c.users}</td><td>{c.conversations_30d}</td><td>{c.appointments_30d}</td>
                <td><Badge tone={c.wa ? "ok" : "neutral"}>{c.wa ? "conectado" : "pendente"}</Badge></td>
                <td><Badge tone={c.ai_enabled ? "ok" : "neutral"}>{c.ai_enabled ? "ativa" : "desligada"}</Badge></td>
                <td><form action={enterClinicAction}><input type="hidden" name="clinicId" value={c.id} /><Button size="sm">Entrar</Button></form></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </main>
  );
}
