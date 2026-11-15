import Link from "next/link";
import { Bot, Building2, CalendarDays, Eye, MessageCircle, Plus, ScrollText, Users, type LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { VistaSwitch } from "@/components/vista";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, Modal } from "@/components/client";
import { Badge, Button, buttonClass, Card, CardTitle, Checkbox, Empty, Field, Input, Notice, PageHeader, Select, Table, Textarea } from "@/components/ui";
import { can, ROLE_LABELS, ROLES, type Role } from "@/domain/permissions";
import { formatShort, WEEKDAY_KEYS, WEEKDAY_LABELS, type BusinessHours } from "@/lib/datetime";
import { env } from "@/lib/env";
import { cn } from "@/lib/format";
import { LlmPanel, WhatsAppPanel } from "./panels";
import { inviteUserAction, saveAiAction, saveClinicAction, saveProfessionalAction, saveResourceAction, saveWhatsAppAction, updateUserAction } from "./actions";

export const metadata = { title: "Configurações" };

const TABS = [["clinica", "Clínica"], ["equipe", "Equipe"], ["agenda", "Agenda"], ["whatsapp", "WhatsApp"], ["ia", "Assistente"], ["visualizacao", "Visualização"], ["auditoria", "Auditoria"]] as const;
type TabKey = (typeof TABS)[number][0];
/** Cada seção é um bloco com ícone colorido, como nos Ajustes do iPhone. */
const TAB_ICON: Record<TabKey, { icon: LucideIcon; rgb: string; text: string }> = {
  clinica: { icon: Building2, rgb: "232 181 75", text: "Nome, endereço e horários" },
  equipe: { icon: Users, rgb: "87 166 240", text: "Acessos de cada pessoa" },
  agenda: { icon: CalendarDays, rgb: "124 131 245", text: "Dentistas e cadeiras" },
  whatsapp: { icon: MessageCircle, rgb: "37 190 100", text: "Conectar o número" },
  ia: { icon: Bot, rgb: "167 139 250", text: "Como a assistente atende" },
  visualizacao: { icon: Eye, rgb: "124 141 166", text: "Simples ou com detalhes" },
  auditoria: { icon: ScrollText, rgb: "124 141 166", text: "Quem alterou o quê" },
};
const ranges = (list?: [string, string][]) => (list ?? []).map(([a, b]) => `${a}-${b}`).join(", ");

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const ctx = await requireCtx("audit.view");
  const isAdmin = can(ctx.role, "settings.manage");
  const requested = (await searchParams).aba;
  const tab = TABS.some(([k]) => k === requested) ? requested! : isAdmin ? "clinica" : "visualizacao";
  const allowed = isAdmin || tab === "auditoria" || tab === "visualizacao";
  const hours = ctx.clinic.business_hours as BusinessHours;
  const s = ctx.settings;

  const data = await q(ctx, async (tx) => ({
    unit: (await tx<{ address: string | null; accessibility_info: string | null }[]>`select address, accessibility_info from units order by created_at limit 1`)[0],
    users: tab === "equipe" || tab === "agenda" ? await tx<{ id: string; name: string; email: string; role: Role; active: boolean }[]>`select id, name, email, role, active from app_users order by active desc, name` : [],
    professionals: tab === "agenda" ? await tx<{ id: string; name: string; specialty: string | null; council_number: string | null; color: string; app_user_id: string | null; active: boolean }[]>`
      select id, name, specialty, council_number, color, app_user_id, active from professionals order by active desc, name` : [],
    rules: tab === "agenda" ? await tx<{ professional_id: string; weekday: number; start_time: string; end_time: string }[]>`select professional_id, weekday, start_time::text, end_time::text from availability_rules order by start_time` : [],
    resources: tab === "agenda" ? await tx<{ id: string; name: string; kind: string; active: boolean }[]>`select id, name, kind, active from resources where kind <> 'professional' order by kind, name` : [],
    wa: (tab === "whatsapp" || tab === "ia") && isAdmin ? (await tx<{
      wa_provider: "cloud" | "evolution" | "wacli"; wacli_gateway_url: string | null; has_wacli_token: boolean; wacli_connected_at: Date | null; wa_phone_number_id: string | null; wa_business_account_id: string | null; wa_display_phone: string | null; has_token: boolean; has_secret: boolean;
      wa_verify_token: string; wa_connected_at: Date | null; wa_last_inbound_at: Date | null; evo_base_url: string | null; evo_instance: string | null; has_evo_key: boolean; evo_webhook_token: string; evo_connected_at: Date | null;
      llm_provider: "platform" | "anthropic" | "openrouter" | "openai_compatible"; llm_free_auto: boolean; llm_fallback_models: string[]; llm_model: string | null; llm_base_url: string | null; has_llm_key: boolean; llm_checked_at: Date | null; llm_last_error: string | null;
    }[]>`
      select wa_provider, wa_phone_number_id, wa_business_account_id, wa_display_phone, wa_access_token_enc is not null as has_token, wa_app_secret_enc is not null as has_secret, wa_verify_token, wa_connected_at, wa_last_inbound_at,
             evo_base_url, evo_instance, evo_api_key_enc is not null as has_evo_key, evo_webhook_token, evo_connected_at,
             wacli_gateway_url, wacli_gateway_token_enc is not null as has_wacli_token, wacli_connected_at,
             llm_provider, llm_free_auto, llm_fallback_models, llm_model, llm_base_url, llm_api_key_enc is not null as has_llm_key, llm_checked_at, llm_last_error
      from clinic_integrations`)[0] : undefined,
    ops: tab === "ia" ? (await tx<{ cost: string; runs: number; failed: number; discarded: number }[]>`
      select (select coalesce(sum(cost_cents), 0)::text from ai_runs where created_at >= date_trunc('month', now())) as cost,
             (select count(*)::int from ai_runs where created_at >= date_trunc('month', now())) as runs,
             (select count(*)::int from scheduled_jobs where status = 'failed' and updated_at > now() - interval '7 days') as failed,
             (select count(*)::int from ai_runs where outcome = 'discarded_handoff' and created_at >= date_trunc('month', now())) as discarded`)[0] : undefined,
    audit: tab === "auditoria" ? await tx<{ id: string; actor_label: string | null; action: string; entity: string; before: unknown; after: unknown; created_at: Date }[]>`
      select id, actor_label, action, entity, before, after, created_at from audit_events order by created_at desc limit 100` : [],
  }));

  const ProfessionalForm = ({ p }: { p?: (typeof data.professionals)[number] }) => (
    <ActionForm action={saveProfessionalAction} className="space-y-4" resetOnDone={!p}>
      {p && <input type="hidden" name="professionalId" value={p.id} />}
      <div className="grid gap-6 sm:grid-cols-2">
        <Field label="Nome"><Input name="name" defaultValue={p?.name} required placeholder="Dra. Ana Lima" /></Field>
        <Field label="Especialidade"><Input name="specialty" defaultValue={p?.specialty ?? ""} /></Field>
        <Field label="Nº do conselho (CRO)"><Input name="council" defaultValue={p?.council_number ?? ""} /></Field>
        <Field label="Cor na agenda"><Input type="color" name="color" defaultValue={p?.color ?? "#0F2A3D"} className="h-10 w-20 p-1" /></Field>
        <Field label="Usuário do sistema (opcional)" hint="Vincule para o dentista ver só a própria agenda.">
          <Select name="appUserId" defaultValue={p?.app_user_id ?? ""}><option value="">—</option>{data.users.filter((u) => u.role === "dentista").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
        </Field>
        <div className="flex items-end pb-2"><Checkbox name="active" defaultChecked={p?.active ?? true} label="Ativo" /></div>
      </div>
      <fieldset className="rounded-md border border-line p-4">
        <legend className="eyebrow px-1.5 text-bone-mute">Expediente do dentista</legend>
        <p className="t-small mb-3">Formato 08:00-12:00, 13:00-18:00. Deixe vazio nos dias sem atendimento.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {WEEKDAY_KEYS.map((key, weekday) => {
            const current = p ? data.rules.filter((r) => r.professional_id === p.id && r.weekday === weekday).map((r) => `${r.start_time.slice(0, 5)}-${r.end_time.slice(0, 5)}`).join(", ") : ranges(hours[key]);
            return <label key={key} className="flex items-center gap-2 text-xs"><span className="w-16 font-medium">{WEEKDAY_LABELS[weekday]}</span><Input name={`rule_${key}`} defaultValue={current} className="h-8 text-xs" placeholder="fechado" /></label>;
          })}
        </div>
      </fieldset>
      <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Salvar</Button></div>
    </ActionForm>
  );

  return (
    <>
      <PageHeader title="Configurações" subtitle="Tudo é ajustável por aqui, sem mexer em código." />
      <div className="space-y-8">
        {/* Seções em blocos quadrados: alvo grande, ícone e uma linha dizendo o que tem dentro. Auditoria só na visualização detalhada. */}
        <nav aria-label="Seções de configuração" className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7 lg:gap-4 simples:lg:grid-cols-6">
          {TABS.filter(([k]) => (isAdmin || k === "auditoria" || k === "visualizacao")).map(([k, label]) => {
            const t = TAB_ICON[k];
            return (
              <Link key={k} href={`/configuracoes?aba=${k}`} aria-current={tab === k ? "page" : undefined} style={{ "--icone-rgb": t.rgb } as CSSProperties}
                className={cn("vidro bloco flex flex-col justify-between gap-3 rounded-lg p-4 lg:aspect-square", k === "auditoria" && tab !== k && "simples:hidden")}>
                <span className="icone-app size-11 rounded-[13px]"><t.icon size={22} aria-hidden strokeWidth={1.9} /></span>
                <span className="min-w-0"><span className="block text-[14.5px] font-semibold leading-tight">{label}</span><span className="t-small mt-0.5 line-clamp-2 block leading-snug">{t.text}</span></span>
              </Link>
            );
          })}
        </nav>
        <div className="min-w-0 space-y-6">
      {!allowed && <Notice tone="danger">Apenas administradores acessam esta seção.</Notice>}

      {tab === "visualizacao" && (
        <Card className="h-auto">
          <CardTitle hint="Vale só para este navegador. Cada pessoa da equipe escolhe a sua em Meu perfil.">Visualização</CardTitle>
          <div className="max-w-xl"><VistaSwitch detailed={ctx.detailed} /></div>
          <p className="t-small mt-5 max-w-xl">Na visualização simples ficam escondidos custos da IA, históricos de execução, auditoria, códigos e opções avançadas de conexão. Nada é apagado: ligue quando precisar.</p>
        </Card>
      )}

      {allowed && tab === "clinica" && (
        <Card>
          <ActionForm action={saveClinicAction} className="space-y-5" resetOnDone={false}>
            <div className="grid gap-6 sm:grid-cols-2">
              <Field label="Nome da clínica"><Input name="name" defaultValue={ctx.clinic.name} required /></Field>
              <Field label="Fuso horário" hint="Todos os horários são exibidos neste fuso." className="simples:hidden"><Input name="timezone" defaultValue={ctx.clinic.timezone} required list="tz" /><datalist id="tz">{["America/Sao_Paulo", "America/Manaus", "America/Recife", "America/Belem", "America/Cuiaba", "America/Rio_Branco", "America/Noronha"].map((z) => <option key={z} value={z} />)}</datalist></Field>
              <Field label="Nome da assistente virtual" hint="Ela sempre se apresenta como assistente virtual."><Input name="assistantName" defaultValue={ctx.clinic.assistant_name} required /></Field>
              <Field label="Endereço da unidade"><Input name="address" defaultValue={data.unit?.address ?? ""} /></Field>
            </div>
            <Field label="Acessibilidade da unidade"><Input name="accessibility" defaultValue={data.unit?.accessibility_info ?? ""} placeholder="Ex.: rampa, elevador, vaga reservada" /></Field>
            <fieldset className="rounded-md border border-line p-4">
              <legend className="eyebrow px-1.5 text-bone-mute">Horário de atendimento humano</legend>
              <p className="t-small mb-3">Formato 08:00-18:00 (use vírgula para dois períodos). Vazio = fechado.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {WEEKDAY_KEYS.map((key, i) => <label key={key} className="flex items-center gap-2 text-xs"><span className="w-16 font-medium">{WEEKDAY_LABELS[i]}</span><Input name={`hours_${key}`} defaultValue={ranges(hours[key])} className="h-8 text-xs" placeholder="fechado" /></label>)}
              </div>
            </fieldset>
            <Field label="Mensagem fora do expediente" hint="Enviada uma vez quando não há IA nem equipe atendendo. Sem promessa de prazo."><Textarea name="afterHours" defaultValue={ctx.clinic.after_hours_message} className="min-h-16" required /></Field>
            <div className="grid gap-6 simples:hidden sm:grid-cols-2">
              <Field label="Antecedência mínima para a IA agendar (min)"><Input type="number" min={0} name="minLeadMinutes" defaultValue={s.minLeadMinutes} /></Field>
              <Field label="Agenda aberta até (dias à frente)"><Input type="number" min={1} max={365} name="maxAdvanceDays" defaultValue={s.maxAdvanceDays} /></Field>
            </div>
            <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Salvar</Button></div>
          </ActionForm>
        </Card>
      )}

      {allowed && tab === "equipe" && (
        <Card>
          <CardTitle action={
            <Modal trigger={<><Plus size={14} aria-hidden /> Novo usuário</>} title="Novo usuário" description="Defina uma senha provisória e entregue por um canal seguro. A pessoa só vê o que o papel permite." triggerClass={buttonClass("accent", "sm")}>
              <ActionForm action={inviteUserAction} className="space-y-4" resetOnDone={false}>
                <Field label="Nome"><Input name="name" required /></Field>
                <Field label="E-mail"><Input type="email" name="email" required /></Field>
                <Field label="Papel"><Select name="role" defaultValue="recepcao">{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select></Field>
                <Field label="Senha provisória" hint="Mínimo 8 caracteres. Entregue por um canal seguro."><Input name="password" minLength={8} required autoComplete="off" /></Field>
                <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Criar usuário</Button></div>
              </ActionForm>
            </Modal>} hint="Recepção atende e agenda; gestor publica conteúdo e vê indicadores; dentista vê só o que é dele; comercial cuida do funil; financeiro só o cadastro.">Usuários e papéis</CardTitle>
          {data.users.length === 0 ? <Empty title="Nenhum usuário nesta clínica ainda">Crie um acesso para cada pessoa da equipe. Cada uma só vê o que o papel dela permite.</Empty> : (
          <Table head={["Nome", "E-mail", "Papel", "Situação", ""]}>
            {data.users.map((u) => (
              <tr key={u.id} className={cn(!u.active && "opacity-60")}>
                <td className="font-medium">{u.name}{u.id === ctx.userId && <span className="ml-1 text-[10px] text-bone-mute">(você)</span>}</td><td>{u.email}</td>
                <td><Badge tone={u.role === "admin" ? "navy" : "neutral"}>{ROLE_LABELS[u.role]}</Badge></td>
                <td>{u.active ? <Badge tone="ok">Ativo</Badge> : <Badge tone="danger">Desativado</Badge>}</td>
                <td className="text-right">
                  <Modal trigger="Editar" title="Editar usuário" description={u.name} triggerClass={buttonClass("outline", "sm")}>
                    <ActionForm action={updateUserAction} className="space-y-4" resetOnDone={false}>
                      <input type="hidden" name="userId" value={u.id} />
                      <Field label="Papel"><Select name="role" defaultValue={u.role}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select></Field>
                      <Checkbox name="active" defaultChecked={u.active} label="Acesso ativo" hint="Ao desmarcar, o usuário perde o acesso imediatamente." />
                      <Field label="Redefinir senha (opcional)"><Input name="password" minLength={8} autoComplete="off" /></Field>
                      <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Salvar</Button></div>
                    </ActionForm>
                  </Modal>
                </td>
              </tr>
            ))}
          </Table>
          )}
        </Card>
      )}

      {allowed && tab === "agenda" && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Card>
            <CardTitle action={<Modal trigger={<><Plus size={14} aria-hidden /> Novo dentista</>} title="Novo dentista" description="O expediente define os horários livres na agenda." wide triggerClass={buttonClass("accent", "sm")}><ProfessionalForm /></Modal>}
              hint="Um horário aparece livre quando o dentista está no expediente, atende o serviço, há cadeira livre e não há bloqueio.">Dentistas e expediente</CardTitle>
            {data.professionals.length === 0 ? <Empty title="Nenhum dentista cadastrado">Sem dentistas com expediente, a agenda não oferece horários.</Empty> : (
              <ul className="divide-y divide-line">
                {data.professionals.map((p) => {
                  const count = data.rules.filter((r) => r.professional_id === p.id).length;
                  return (
                    <li key={p.id} className={cn("flex min-h-16 items-center justify-between gap-3 py-3", !p.active && "opacity-60")}>
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="size-3 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
                        <div className="min-w-0"><p className="t-h3 truncate">{p.name}</p><p className="t-small truncate">{p.specialty ?? "—"}{p.council_number ? ` · ${p.council_number}` : ""} · {count ? `${count} período(s) por semana` : "sem expediente"}</p></div>
                      </div>
                      <div className="flex items-center gap-2">{!p.active && <Badge>inativo</Badge>}{count === 0 && p.active && <Badge tone="warn">sem horários</Badge>}
                        <Modal trigger="Editar" title="Editar dentista" description={p.name} wide triggerClass={buttonClass("outline", "sm")}><ProfessionalForm p={p} /></Modal></div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card>
            <CardTitle hint="Cada consulta ocupa o dentista e os recursos exigidos pelo serviço. Dois agendamentos nunca dividem a mesma cadeira no mesmo horário.">Cadeiras e recursos</CardTitle>
            <ul className="divide-y divide-line">
              {data.resources.map((r) => (
                <li key={r.id} className="py-3 first:pt-0">
                  <ActionForm action={saveResourceAction} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3" resetOnDone={false}>
                    <input type="hidden" name="resourceId" value={r.id} /><input type="hidden" name="kind" value={r.kind} />
                    <div className="min-w-0">
                      <Input name="name" defaultValue={r.name} aria-label="Nome do recurso" />
                      <span className="t-small mt-1 block">{{ chair: "Cadeira", equipment: "Equipamento", assistant: "Auxiliar" }[r.kind]}</span>
                    </div>
                    <Checkbox name="active" defaultChecked={r.active} label="Ativo" />
                    <Button size="sm" variant="outline">Salvar</Button>
                  </ActionForm>
                </li>
              ))}
            </ul>
            <ActionForm action={saveResourceAction} className="mt-auto space-y-4 border-t border-line pt-5">
              <p className="t-h3">Adicionar recurso</p>
              <div className="grid grid-cols-[minmax(0,1fr)_150px] gap-3">
                <Field label="Nome"><Input name="name" placeholder="Ex.: Cadeira 4" required /></Field>
                <Field label="Tipo"><Select name="kind"><option value="chair">Cadeira</option><option value="equipment">Equipamento</option><option value="assistant">Auxiliar</option></Select></Field>
              </div>
              <div className="flex justify-end"><Button type="submit" variant="outline"><Plus aria-hidden /> Adicionar</Button></div>
            </ActionForm>
          </Card>
        </div>
      )}

      {allowed && tab === "whatsapp" && data.wa && (
        <Card>
          <CardTitle hint="Escolha como a clínica conecta o WhatsApp. Dá para trocar depois sem perder as conversas.">Canal de WhatsApp</CardTitle>
          <WhatsAppPanel
            provider={data.wa.wa_provider}
            evolution={{ baseUrl: data.wa.evo_base_url ?? "", instance: data.wa.evo_instance ?? "", hasKey: data.wa.has_evo_key, connected: !!data.wa.evo_connected_at, webhookUrl: `${env.appUrl}/api/webhooks/evolution/${data.wa.evo_webhook_token}` }}
            wacli={{ platformGateway: !!(env.wacli.gatewayUrl && env.wacli.gatewayToken), ownUrl: data.wa.wacli_gateway_url ?? "", hasOwnToken: data.wa.has_wacli_token, connected: !!data.wa.wacli_connected_at }}
            official={
              <div className="grid gap-6 lg:grid-cols-2">
                <section className="flex h-full flex-col rounded-md border border-line p-6">
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <h3 className="t-h3">1. Dados do número na Meta</h3>
                    <Badge tone={data.wa.wa_provider === "cloud" && data.wa.wa_phone_number_id && data.wa.has_token ? "ok" : "neutral"}>{data.wa.wa_provider === "cloud" && data.wa.wa_phone_number_id && data.wa.has_token ? "Conectado" : "Pendente"}</Badge>
                  </div>
                  <p className="t-small mb-5">No Meta for Developers: WhatsApp → Configuração da API.</p>
                  <ActionForm action={saveWhatsAppAction} className="flex flex-1 flex-col gap-5" resetOnDone={false}>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="ID do número"><Input name="phoneNumberId" defaultValue={data.wa.wa_phone_number_id ?? ""} required inputMode="numeric" /></Field>
                      <Field label="ID da conta (WABA)"><Input name="wabaId" defaultValue={data.wa.wa_business_account_id ?? ""} inputMode="numeric" /></Field>
                    </div>
                    <Field label="Número exibido"><Input name="displayPhone" defaultValue={data.wa.wa_display_phone ?? ""} placeholder="+55 11 99999-0000" /></Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Token permanente" hint={data.wa.has_token ? "Já salvo. Preencha só para trocar." : "Usuário do sistema no Business Manager."}><Input name="accessToken" type="password" autoComplete="off" placeholder={data.wa.has_token ? "••••••••" : ""} /></Field>
                      <Field label="App Secret" hint={data.wa.has_secret ? "Já salvo. Preencha só para trocar." : "Valida a assinatura de cada aviso."}><Input name="appSecret" type="password" autoComplete="off" placeholder={data.wa.has_secret ? "••••••••" : ""} /></Field>
                    </div>
                    <div className="mt-auto flex justify-end border-t border-line pt-5"><Button type="submit">Salvar e usar o oficial</Button></div>
                  </ActionForm>
                </section>
                <section className="flex h-full flex-col rounded-md border border-line p-6">
                  <h3 className="t-h3 mb-1">2. Avisos de mensagens (webhook)</h3>
                  <p className="t-small mb-5">Cole no painel da Meta em WhatsApp → Configuração → Webhook e assine o campo “messages”.</p>
                  <dl className="space-y-5">
                    <div><dt className="mb-2 text-[13px] font-medium">URL de retorno</dt><dd><code className="block select-all break-all rounded-sm bg-surface-2/70 px-3 py-2.5 font-mono text-[12.5px]">{env.appUrl}/api/webhooks/whatsapp</code></dd></div>
                    <div><dt className="mb-2 text-[13px] font-medium">Token de verificação</dt><dd><code className="block select-all break-all rounded-sm bg-surface-2/70 px-3 py-2.5 font-mono text-[12.5px]">{data.wa.wa_verify_token}</code></dd></div>
                  </dl>
                  <dl className="mt-auto grid grid-cols-2 gap-4 border-t border-line pt-5">
                    <div><dt className="t-small">Credenciais salvas em</dt><dd className="mt-1 text-[14px]">{data.wa.wa_connected_at ? formatShort(data.wa.wa_connected_at, ctx.tz) : "—"}</dd></div>
                    <div><dt className="t-small">Última mensagem recebida</dt><dd className="mt-1 text-[14px]">{data.wa.wa_last_inbound_at ? formatShort(data.wa.wa_last_inbound_at, ctx.tz) : "nenhuma ainda"}</dd></div>
                  </dl>
                </section>
              </div>
            }
          />
        </Card>
      )}

      {allowed && tab === "ia" && (
        <div className="space-y-6">
        {data.wa && (
          <Card className="hidden h-auto detalhado:hidden simples:flex">
            <div className="flex flex-wrap items-center gap-4">
              <span className="icone-app size-12 rounded-[14px]" style={{ "--icone-rgb": "167 139 250" } as CSSProperties}><Bot size={24} aria-hidden /></span>
              <div className="min-w-0 flex-1">
                <p className="t-h3">Inteligência artificial: {{ platform: "a da plataforma", anthropic: "Claude (chave própria)", openrouter: "OpenRouter", openai_compatible: "provedor próprio" }[data.wa.llm_provider]}</p>
                <p className="t-small">Para trocar de provedor ou de modelo, ligue “Mostrar detalhes técnicos” em <Link href="/configuracoes?aba=visualizacao" className="underline underline-offset-2">Visualização</Link>.</p>
              </div>
            </div>
          </Card>
        )}
        {data.wa && (
          <Card className="simples:hidden">
            <CardTitle hint="Escolha qual inteligência artificial responde os pacientes. A chave fica criptografada.">Provedor de IA</CardTitle>
            <LlmPanel provider={data.wa.llm_provider} model={data.wa.llm_model ?? ""} baseUrl={data.wa.llm_base_url ?? ""} hasKey={data.wa.has_llm_key} freeAuto={data.wa.llm_free_auto} fallbackModels={data.wa.llm_fallback_models}
              checkedAt={data.wa.llm_checked_at ? formatShort(data.wa.llm_checked_at, ctx.tz) : null} lastError={data.wa.llm_last_error} platformReady={!!env.anthropicKey} />
          </Card>
        )}
        <div className="grid gap-6 simples:hidden lg:grid-cols-2">
            <Card>
              <CardTitle>Integrações</CardTitle>
              <ul className="text-[14px]">
                <li className="flex h-10 items-center justify-between border-b border-line">Provedor de IA<Badge tone="ok">{{ platform: "Plataforma", anthropic: "Anthropic", openrouter: "OpenRouter", openai_compatible: "Compatível" }[data.wa?.llm_provider ?? "platform"]}</Badge></li>
                <li className="flex h-10 items-center justify-between border-b border-line">Transcrição de áudio<Badge tone={env.transcriptionUrl && env.transcriptionKey ? "ok" : "warn"}>{env.transcriptionUrl && env.transcriptionKey ? "configurada" : "não configurada"}</Badge></li>
                <li className="flex h-10 items-center justify-between">Tarefas automáticas<Badge tone={env.cronSecret ? "ok" : "warn"}>{env.cronSecret ? "protegido" : "sem CRON_SECRET"}</Badge></li>
              </ul>
              <p className="t-small mt-auto pt-4">Sem IA configurada, as conversas vão direto para a equipe. Sem transcrição, a assistente pede para o paciente escrever.</p>
            </Card>
            <Card>
              <CardTitle hint="Mês corrente">Operação da IA</CardTitle>
              <dl className="divide-y divide-line text-[14px] [&>div]:flex [&>div]:h-10 [&>div]:items-center [&>div]:justify-between">
                <div className="flex justify-between"><dt className="text-bone-mute">Custo estimado</dt><dd className="font-semibold">US$ {(Number(data.ops?.cost ?? 0) / 100).toFixed(2).replace(".", ",")}</dd></div>
                <div className="flex justify-between"><dt className="text-bone-mute">Atendimentos</dt><dd>{data.ops?.runs ?? 0}</dd></div>
                <div className="flex justify-between"><dt className="text-bone-mute">Respostas descartadas por handoff</dt><dd>{data.ops?.discarded ?? 0}</dd></div>
                <div className="flex justify-between"><dt className="text-bone-mute">Jobs com falha (7 dias)</dt><dd className={cn(data.ops?.failed ? "font-semibold text-danger" : "")}>{data.ops?.failed ?? 0}</dd></div>
                {s.aiMonthlyBudgetCents != null && <div className="flex justify-between"><dt className="text-bone-mute">Teto mensal</dt><dd>US$ {(s.aiMonthlyBudgetCents / 100).toFixed(2).replace(".", ",")}</dd></div>}
              </dl>
              <p className="t-small mt-auto pt-4">Estimativa pelos tokens de cada atendimento. A fatura do provedor é a referência.</p>
            </Card>
        </div>
        <Card>
            <ActionForm action={saveAiAction} className="space-y-5" resetOnDone={false}>
              <div>
                <h2 className="t-h2">Protocolo de urgência</h2>
                <p className="t-small mt-1">Quando o paciente relata um destes sinais, a assistente interrompe qualquer assunto comercial, envia a mensagem abaixo e chama a equipe com urgência. A detecção serve só para encaminhar — nunca para avaliar a condição.</p>
              </div>
              {ctx.clinic.alert_approved_at
                ? <Notice tone="ok">Protocolo aprovado em {formatShort(ctx.clinic.alert_approved_at, ctx.tz)}. Qualquer alteração exige nova aprovação.</Notice>
                : <Notice tone="sun">Protocolo ainda <strong>não aprovado</strong>. A lista abaixo é apenas uma sugestão inicial: o responsável técnico precisa revisar, ajustar e aprovar antes de a assistente ser ativada.</Notice>}
              <div className="grid gap-6 lg:grid-cols-2">
                <Field label="Sinais de alerta (um por linha)"><Textarea name="alertKeywords" defaultValue={ctx.clinic.alert_keywords.join("\n")} className="min-h-[264px] font-mono text-xs" /></Field>
                <div className="space-y-5">
                  <Field label="Mensagem de encaminhamento (expediente)" hint="Texto exato enviado ao paciente, aprovado pelo responsável técnico."><Textarea name="alertMessage" defaultValue={ctx.clinic.alert_message ?? ""} className="min-h-24" /></Field>
                  <Field label="Mensagem fora do expediente" hint="Inclua a alternativa da clínica para urgências fora do horário."><Textarea name="alertAfterHours" defaultValue={ctx.clinic.alert_after_hours_message ?? ""} className="min-h-24" /></Field>
                </div>
              </div>
              <Checkbox name="approve" label="Sou (ou represento) o responsável técnico e aprovo este protocolo" hint="A aprovação fica registrada na auditoria com seu usuário, data e hora." />
              <hr className="border-line" />
              <h2 className="t-h2">Assistente virtual</h2>
              <div className="grid gap-6 lg:grid-cols-2">
              <Checkbox name="aiEnabled" defaultChecked={ctx.clinic.ai_enabled} label="Assistente ativada" hint="Responde conversas em “IA ativa”. Exige protocolo aprovado." />
              <Checkbox name="killSwitch" defaultChecked={ctx.clinic.ai_kill_switch} label="Pausa de emergência" hint="Interrompe todas as respostas automáticas na hora. A inbox humana continua funcionando." />
              </div>
              <div className="grid gap-6 simples:hidden lg:grid-cols-2">
                <Field label="Espera para agrupar mensagens (s)" hint="A assistente aguarda este tempo para responder mensagens em sequência de uma vez."><Input type="number" min={0} max={60} name="debounceSeconds" defaultValue={s.debounceSeconds} /></Field>
                <Field label="Teto mensal de custo da IA (US$)" hint="Ao atingir, as conversas vão para a equipe. Vazio = sem teto."><Input name="budget" inputMode="decimal" defaultValue={s.aiMonthlyBudgetCents != null ? (s.aiMonthlyBudgetCents / 100).toFixed(2) : ""} /></Field>
              </div>
              <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Salvar</Button></div>
            </ActionForm>
          </Card>
        </div>
      )}

      {tab === "auditoria" && (
        <Card>
          <CardTitle hint="Alterações de preço, permissão, publicação, IA e acessos de suporte, com antes e depois. Não contém mensagens nem dados de saúde.">Trilha de auditoria</CardTitle>
          {data.audit.length === 0 ? <Empty title="Nenhum evento ainda" /> : (
            <Table head={["Quando", "Quem", "Ação", "Antes", "Depois"]}>
              {data.audit.map((a) => (
                <tr key={a.id} className="align-top">
                  <td className="whitespace-nowrap">{formatShort(a.created_at, ctx.tz)}</td><td>{a.actor_label ?? "Sistema"}</td>
                  <td><code className="text-xs">{a.action}</code><span className="block text-[10px] text-bone-mute">{a.entity}</span></td>
                  <td className="max-w-56"><pre className="scroll-thin overflow-x-auto whitespace-pre-wrap break-words text-[10px] text-bone-dim">{a.before ? JSON.stringify(a.before, null, 1) : "—"}</pre></td>
                  <td className="max-w-56"><pre className="scroll-thin overflow-x-auto whitespace-pre-wrap break-words text-[10px] text-bone-dim">{a.after ? JSON.stringify(a.after, null, 1) : "—"}</pre></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
        </div>
      </div>
    </>
  );
}
