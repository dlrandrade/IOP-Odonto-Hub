import Link from "next/link";
import { Plus } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, Modal } from "@/components/client";
import { Badge, Button, buttonClass, Card, CardTitle, Checkbox, Empty, Field, Input, Notice, PageHeader, Select, Table, Textarea } from "@/components/ui";
import { can, ROLE_LABELS, ROLES, type Role } from "@/domain/permissions";
import { formatShort, WEEKDAY_KEYS, WEEKDAY_LABELS, type BusinessHours } from "@/lib/datetime";
import { env } from "@/lib/env";
import { brl, cn } from "@/lib/format";
import { inviteUserAction, saveAiAction, saveClinicAction, saveProfessionalAction, saveResourceAction, saveWhatsAppAction, updateUserAction } from "./actions";

export const metadata = { title: "Configurações" };

const TABS = [["clinica", "Clínica"], ["equipe", "Equipe"], ["agenda", "Agenda"], ["whatsapp", "WhatsApp"], ["ia", "Assistente (IA)"], ["auditoria", "Auditoria"]] as const;
const ranges = (list?: [string, string][]) => (list ?? []).map(([a, b]) => `${a}-${b}`).join(", ");

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const ctx = await requireCtx("audit.view");
  const isAdmin = can(ctx.role, "settings.manage");
  const requested = (await searchParams).aba;
  const tab = TABS.some(([k]) => k === requested) ? requested! : isAdmin ? "clinica" : "auditoria";
  const allowed = isAdmin || tab === "auditoria";
  const hours = ctx.clinic.business_hours as BusinessHours;
  const s = ctx.settings;

  const data = await q(ctx, async (tx) => ({
    unit: (await tx<{ address: string | null; accessibility_info: string | null }[]>`select address, accessibility_info from units order by created_at limit 1`)[0],
    users: tab === "equipe" || tab === "agenda" ? await tx<{ id: string; name: string; email: string; role: Role; active: boolean }[]>`select id, name, email, role, active from app_users order by active desc, name` : [],
    professionals: tab === "agenda" ? await tx<{ id: string; name: string; specialty: string | null; council_number: string | null; color: string; app_user_id: string | null; active: boolean }[]>`
      select id, name, specialty, council_number, color, app_user_id, active from professionals order by active desc, name` : [],
    rules: tab === "agenda" ? await tx<{ professional_id: string; weekday: number; start_time: string; end_time: string }[]>`select professional_id, weekday, start_time::text, end_time::text from availability_rules order by start_time` : [],
    resources: tab === "agenda" ? await tx<{ id: string; name: string; kind: string; active: boolean }[]>`select id, name, kind, active from resources where kind <> 'professional' order by kind, name` : [],
    wa: tab === "whatsapp" && isAdmin ? (await tx<{ wa_phone_number_id: string | null; wa_business_account_id: string | null; wa_display_phone: string | null; has_token: boolean; has_secret: boolean; wa_verify_token: string; wa_connected_at: Date | null; wa_last_inbound_at: Date | null }[]>`
      select wa_phone_number_id, wa_business_account_id, wa_display_phone, wa_access_token_enc is not null as has_token, wa_app_secret_enc is not null as has_secret, wa_verify_token, wa_connected_at, wa_last_inbound_at from clinic_integrations`)[0] : undefined,
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
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome"><Input name="name" defaultValue={p?.name} required placeholder="Dra. Ana Lima" /></Field>
        <Field label="Especialidade"><Input name="specialty" defaultValue={p?.specialty ?? ""} /></Field>
        <Field label="Nº do conselho (CRO)"><Input name="council" defaultValue={p?.council_number ?? ""} /></Field>
        <Field label="Cor na agenda"><Input type="color" name="color" defaultValue={p?.color ?? "#0F2A3D"} className="h-10 w-20 p-1" /></Field>
        <Field label="Usuário do sistema (opcional)" hint="Vincule para o dentista ver só a própria agenda.">
          <Select name="appUserId" defaultValue={p?.app_user_id ?? ""}><option value="">—</option>{data.users.filter((u) => u.role === "dentista").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
        </Field>
        <div className="flex items-end pb-2"><Checkbox name="active" defaultChecked={p?.active ?? true} label="Ativo" /></div>
      </div>
      <fieldset className="rounded-2xl border border-line p-3">
        <legend className="px-1 text-xs font-semibold">Expediente do dentista</legend>
        <p className="mb-2 text-[11px] text-bone-mute">Formato 08:00-12:00, 13:00-18:00. Deixe vazio nos dias sem atendimento.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {WEEKDAY_KEYS.map((key, weekday) => {
            const current = p ? data.rules.filter((r) => r.professional_id === p.id && r.weekday === weekday).map((r) => `${r.start_time.slice(0, 5)}-${r.end_time.slice(0, 5)}`).join(", ") : ranges(hours[key]);
            return <label key={key} className="flex items-center gap-2 text-xs"><span className="w-16 font-medium">{WEEKDAY_LABELS[weekday]}</span><Input name={`rule_${key}`} defaultValue={current} className="h-8 text-xs" placeholder="fechado" /></label>;
          })}
        </div>
      </fieldset>
      <Button type="submit">Salvar</Button>
    </ActionForm>
  );

  return (
    <>
      <PageHeader title="Configurações" subtitle="Tudo é ajustável por aqui, sem mexer em código." />
      <div className="scroll-thin mb-3 flex gap-1 overflow-x-auto rounded-full bg-surface p-1 border border-line sm:inline-flex">
        {TABS.filter(([k]) => isAdmin || k === "auditoria").map(([k, label]) => (
          <Link key={k} href={`/configuracoes?aba=${k}`} className={cn("shrink-0 rounded-full px-4 py-1.5 text-sm font-medium", tab === k ? "bg-gold text-ink" : "text-bone-dim")}>{label}</Link>
        ))}
      </div>
      {!allowed && <Notice tone="danger">Apenas administradores acessam esta seção.</Notice>}

      {allowed && tab === "clinica" && (
        <Card className="max-w-3xl">
          <ActionForm action={saveClinicAction} className="space-y-5" resetOnDone={false}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nome da clínica"><Input name="name" defaultValue={ctx.clinic.name} required /></Field>
              <Field label="Fuso horário" hint="Todos os horários são exibidos neste fuso."><Input name="timezone" defaultValue={ctx.clinic.timezone} required list="tz" /><datalist id="tz">{["America/Sao_Paulo", "America/Manaus", "America/Recife", "America/Belem", "America/Cuiaba", "America/Rio_Branco", "America/Noronha"].map((z) => <option key={z} value={z} />)}</datalist></Field>
              <Field label="Nome da assistente virtual" hint="Ela sempre se apresenta como assistente virtual."><Input name="assistantName" defaultValue={ctx.clinic.assistant_name} required /></Field>
              <Field label="Endereço da unidade"><Input name="address" defaultValue={data.unit?.address ?? ""} /></Field>
            </div>
            <Field label="Acessibilidade da unidade"><Input name="accessibility" defaultValue={data.unit?.accessibility_info ?? ""} placeholder="Ex.: rampa, elevador, vaga reservada" /></Field>
            <fieldset className="rounded-2xl border border-line p-3">
              <legend className="px-1 text-xs font-semibold">Horário de atendimento humano</legend>
              <p className="mb-2 text-[11px] text-bone-mute">Formato 08:00-18:00 (use vírgula para dois períodos). Vazio = fechado.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {WEEKDAY_KEYS.map((key, i) => <label key={key} className="flex items-center gap-2 text-xs"><span className="w-16 font-medium">{WEEKDAY_LABELS[i]}</span><Input name={`hours_${key}`} defaultValue={ranges(hours[key])} className="h-8 text-xs" placeholder="fechado" /></label>)}
              </div>
            </fieldset>
            <Field label="Mensagem fora do expediente" hint="Enviada uma vez quando não há IA nem equipe atendendo. Sem promessa de prazo."><Textarea name="afterHours" defaultValue={ctx.clinic.after_hours_message} className="min-h-16" required /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Antecedência mínima para a IA agendar (min)"><Input type="number" min={0} name="minLeadMinutes" defaultValue={s.minLeadMinutes} /></Field>
              <Field label="Agenda aberta até (dias à frente)"><Input type="number" min={1} max={365} name="maxAdvanceDays" defaultValue={s.maxAdvanceDays} /></Field>
            </div>
            <Button type="submit">Salvar</Button>
          </ActionForm>
        </Card>
      )}

      {allowed && tab === "equipe" && (
        <Card>
          <CardTitle action={
            <Modal trigger={<><Plus size={14} aria-hidden /> Novo usuário</>} title="Novo usuário" triggerClass={buttonClass("accent", "sm")}>
              <ActionForm action={inviteUserAction} className="space-y-4" resetOnDone={false}>
                <Field label="Nome"><Input name="name" required /></Field>
                <Field label="E-mail"><Input type="email" name="email" required /></Field>
                <Field label="Papel"><Select name="role" defaultValue="recepcao">{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select></Field>
                <Field label="Senha provisória" hint="Mínimo 8 caracteres. Entregue por um canal seguro."><Input name="password" minLength={8} required autoComplete="off" /></Field>
                <Button type="submit">Criar usuário</Button>
              </ActionForm>
            </Modal>} hint="Recepção atende e agenda; gestor publica conteúdo e vê indicadores; dentista vê só o que é dele; comercial cuida do funil; financeiro só o cadastro.">Usuários e papéis</CardTitle>
          <Table head={["Nome", "E-mail", "Papel", "Situação", ""]}>
            {data.users.map((u) => (
              <tr key={u.id} className={cn(!u.active && "opacity-60")}>
                <td className="font-medium">{u.name}{u.id === ctx.userId && <span className="ml-1 text-[10px] text-bone-mute">(você)</span>}</td><td>{u.email}</td>
                <td><Badge tone={u.role === "admin" ? "navy" : "neutral"}>{ROLE_LABELS[u.role]}</Badge></td>
                <td>{u.active ? <Badge tone="ok">Ativo</Badge> : <Badge tone="danger">Desativado</Badge>}</td>
                <td className="text-right">
                  <Modal trigger="Editar" title={u.name} triggerClass="text-xs font-semibold underline">
                    <ActionForm action={updateUserAction} className="space-y-4" resetOnDone={false}>
                      <input type="hidden" name="userId" value={u.id} />
                      <Field label="Papel"><Select name="role" defaultValue={u.role}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select></Field>
                      <Checkbox name="active" defaultChecked={u.active} label="Acesso ativo" hint="Ao desmarcar, o usuário perde o acesso imediatamente." />
                      <Field label="Redefinir senha (opcional)"><Input name="password" minLength={8} autoComplete="off" /></Field>
                      <Button type="submit">Salvar</Button>
                    </ActionForm>
                  </Modal>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {allowed && tab === "agenda" && (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Card>
            <CardTitle action={<Modal trigger={<><Plus size={14} aria-hidden /> Novo dentista</>} title="Novo dentista" wide triggerClass={buttonClass("accent", "sm")}><ProfessionalForm /></Modal>}
              hint="A disponibilidade é: expediente do dentista ∩ habilitado para o serviço ∩ recursos livres ∩ sem bloqueio.">Dentistas e expediente</CardTitle>
            {data.professionals.length === 0 ? <Empty title="Nenhum dentista cadastrado">Sem dentistas com expediente, a agenda não oferece horários.</Empty> : (
              <ul className="divide-y divide-line">
                {data.professionals.map((p) => {
                  const count = data.rules.filter((r) => r.professional_id === p.id).length;
                  return (
                    <li key={p.id} className={cn("flex items-center justify-between gap-3 py-3", !p.active && "opacity-60")}>
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="size-3 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
                        <div className="min-w-0"><p className="truncate font-semibold">{p.name}</p><p className="truncate text-xs text-bone-mute">{p.specialty ?? "—"}{p.council_number ? ` · ${p.council_number}` : ""} · {count ? `${count} período(s) por semana` : "sem expediente"}</p></div>
                      </div>
                      <div className="flex items-center gap-2">{!p.active && <Badge>inativo</Badge>}{count === 0 && p.active && <Badge tone="warn">sem horários</Badge>}
                        <Modal trigger="Editar" title={p.name} wide triggerClass="text-xs font-semibold underline"><ProfessionalForm p={p} /></Modal></div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card>
            <CardTitle hint="Cada consulta ocupa o dentista e os recursos exigidos pelo serviço. Dois agendamentos nunca dividem a mesma cadeira no mesmo horário.">Cadeiras e recursos</CardTitle>
            <ul className="mb-4 divide-y divide-line">
              {data.resources.map((r) => (
                <li key={r.id} className="py-2">
                  <ActionForm action={saveResourceAction} className="flex items-center gap-2" resetOnDone={false}>
                    <input type="hidden" name="resourceId" value={r.id} /><input type="hidden" name="kind" value={r.kind} />
                    <Input name="name" defaultValue={r.name} aria-label="Nome do recurso" className="h-8 flex-1 text-sm" />
                    <Badge>{{ chair: "cadeira", equipment: "equipamento", assistant: "auxiliar" }[r.kind]}</Badge>
                    <Checkbox name="active" defaultChecked={r.active} label="ativo" />
                    <Button size="sm" variant="ghost">Salvar</Button>
                  </ActionForm>
                </li>
              ))}
            </ul>
            <ActionForm action={saveResourceAction} className="flex flex-wrap items-end gap-2">
              <Field label="Novo recurso" className="flex-1"><Input name="name" placeholder="Cadeira 4" required /></Field>
              <Field label="Tipo"><Select name="kind" className="w-auto"><option value="chair">Cadeira</option><option value="equipment">Equipamento</option><option value="assistant">Auxiliar</option></Select></Field>
              <Button type="submit" variant="outline">Adicionar</Button>
            </ActionForm>
          </Card>
        </div>
      )}

      {allowed && tab === "whatsapp" && data.wa && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardTitle action={<Badge tone={data.wa.wa_phone_number_id && data.wa.has_token ? "ok" : "warn"}>{data.wa.wa_phone_number_id && data.wa.has_token ? "Conectado" : "Pendente"}</Badge>}
              hint="WhatsApp Business Platform (Cloud API oficial da Meta). APIs não oficiais não são suportadas.">Credenciais do número</CardTitle>
            <ActionForm action={saveWhatsAppAction} className="space-y-4" resetOnDone={false}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="ID do número (Phone Number ID)"><Input name="phoneNumberId" defaultValue={data.wa.wa_phone_number_id ?? ""} required inputMode="numeric" /></Field>
                <Field label="ID da conta (WABA ID)"><Input name="wabaId" defaultValue={data.wa.wa_business_account_id ?? ""} inputMode="numeric" /></Field>
              </div>
              <Field label="Número exibido"><Input name="displayPhone" defaultValue={data.wa.wa_display_phone ?? ""} placeholder="+55 11 99999-0000" /></Field>
              <Field label="Token de acesso permanente" hint={data.wa.has_token ? "Já cadastrado. Preencha apenas para trocar." : "Token de usuário do sistema com permissão whatsapp_business_messaging."}><Input name="accessToken" type="password" autoComplete="off" placeholder={data.wa.has_token ? "••••••••" : ""} /></Field>
              <Field label="Chave secreta do app (App Secret)" hint={data.wa.has_secret ? "Já cadastrada. Preencha apenas para trocar." : "Usada para validar a assinatura de cada webhook."}><Input name="appSecret" type="password" autoComplete="off" placeholder={data.wa.has_secret ? "••••••••" : ""} /></Field>
              <Button type="submit">Salvar credenciais</Button>
            </ActionForm>
          </Card>
          <div className="space-y-3">
            <Card>
              <CardTitle hint="Cole no painel da Meta: WhatsApp → Configuração → Webhook. Assine o campo “messages”.">Webhook</CardTitle>
              <dl className="space-y-3 text-sm">
                <div><dt className="text-xs font-semibold text-bone-dim">URL de callback</dt><dd><code className="mt-1 block select-all break-all rounded-xl bg-surface-2 px-3 py-2 text-xs">{env.appUrl}/api/webhooks/whatsapp</code></dd></div>
                <div><dt className="text-xs font-semibold text-bone-dim">Token de verificação</dt><dd><code className="mt-1 block select-all break-all rounded-xl bg-surface-2 px-3 py-2 text-xs">{data.wa.wa_verify_token}</code></dd></div>
              </dl>
            </Card>
            <Card>
              <CardTitle>Situação</CardTitle>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-bone-mute">Credenciais salvas em</dt><dd>{data.wa.wa_connected_at ? formatShort(data.wa.wa_connected_at, ctx.tz) : "—"}</dd></div>
                <div className="flex justify-between"><dt className="text-bone-mute">Último evento recebido</dt><dd>{data.wa.wa_last_inbound_at ? formatShort(data.wa.wa_last_inbound_at, ctx.tz) : "nenhum ainda"}</dd></div>
              </dl>
              <p className="mt-3 text-xs text-bone-mute">Enquanto o número não estiver conectado, use o <Link href="/simulador" className="font-semibold underline">Simulador</Link> para treinar a equipe e validar a assistente.</p>
            </Card>
          </div>
        </div>
      )}

      {allowed && tab === "ia" && (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <Card>
            <ActionForm action={saveAiAction} className="space-y-5" resetOnDone={false}>
              <div>
                <h2 className="text-base font-semibold">Protocolo de sinais de alerta</h2>
                <p className="mt-0.5 text-xs text-bone-mute">Quando o paciente relata um destes sinais, a assistente interrompe qualquer assunto comercial, envia a mensagem abaixo e chama a equipe com urgência. A detecção serve só para encaminhar — nunca para avaliar a condição.</p>
              </div>
              {ctx.clinic.alert_approved_at
                ? <Notice tone="ok">Protocolo aprovado em {formatShort(ctx.clinic.alert_approved_at, ctx.tz)}. Qualquer alteração exige nova aprovação.</Notice>
                : <Notice tone="sun">Protocolo ainda <strong>não aprovado</strong>. A lista abaixo é apenas uma sugestão inicial: o responsável técnico precisa revisar, ajustar e aprovar antes de a assistente ser ativada.</Notice>}
              <Field label="Sinais de alerta (um por linha)"><Textarea name="alertKeywords" defaultValue={ctx.clinic.alert_keywords.join("\n")} className="min-h-40 font-mono text-xs" /></Field>
              <Field label="Mensagem de encaminhamento (expediente)" hint="Texto exato enviado ao paciente. Deve ser redigido/aprovado pelo responsável técnico."><Textarea name="alertMessage" defaultValue={ctx.clinic.alert_message ?? ""} className="min-h-20" /></Field>
              <Field label="Mensagem fora do expediente" hint="Inclua a alternativa definida pela clínica para urgências fora do horário."><Textarea name="alertAfterHours" defaultValue={ctx.clinic.alert_after_hours_message ?? ""} className="min-h-20" /></Field>
              <Checkbox name="approve" label="Sou (ou represento) o responsável técnico e aprovo este protocolo" hint="A aprovação fica registrada na auditoria com seu usuário, data e hora." />
              <hr className="border-line" />
              <h2 className="text-base font-semibold">Assistente virtual</h2>
              <Checkbox name="aiEnabled" defaultChecked={ctx.clinic.ai_enabled} label="Assistente ativada" hint="Responde conversas em “IA ativa”. Exige protocolo aprovado." />
              <Checkbox name="killSwitch" defaultChecked={ctx.clinic.ai_kill_switch} label="Pausa de emergência (kill switch)" hint="Interrompe todas as respostas automáticas na hora. A inbox humana continua funcionando." />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Espera para agrupar mensagens (s)" hint="A assistente aguarda este tempo para responder mensagens em sequência de uma vez."><Input type="number" min={0} max={60} name="debounceSeconds" defaultValue={s.debounceSeconds} /></Field>
                <Field label="Teto mensal de custo da IA (US$)" hint="Ao atingir, as conversas vão para a equipe. Vazio = sem teto."><Input name="budget" inputMode="decimal" defaultValue={s.aiMonthlyBudgetCents != null ? (s.aiMonthlyBudgetCents / 100).toFixed(2) : ""} /></Field>
              </div>
              <Button type="submit">Salvar</Button>
            </ActionForm>
          </Card>
          <div className="space-y-3">
            <Card>
              <CardTitle>Integrações</CardTitle>
              <ul className="space-y-2 text-sm">
                <li className="flex items-center justify-between">Modelo de IA (Claude)<Badge tone={env.anthropicKey ? "ok" : "warn"}>{env.anthropicKey ? env.anthropicModel : "sem chave"}</Badge></li>
                <li className="flex items-center justify-between">Transcrição de áudio<Badge tone={env.transcriptionUrl && env.transcriptionKey ? "ok" : "warn"}>{env.transcriptionUrl && env.transcriptionKey ? "configurada" : "não configurada"}</Badge></li>
                <li className="flex items-center justify-between">Worker (cron)<Badge tone={env.cronSecret ? "ok" : "warn"}>{env.cronSecret ? "protegido" : "sem CRON_SECRET"}</Badge></li>
              </ul>
              <p className="mt-3 text-xs text-bone-mute">Chaves são definidas pelo operador da plataforma nas variáveis de ambiente. Sem chave de IA, as conversas vão direto para a equipe; sem transcrição, a assistente pede para o paciente escrever.</p>
            </Card>
            <Card>
              <CardTitle hint="Mês corrente">Operação da IA</CardTitle>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-bone-mute">Custo estimado</dt><dd className="font-semibold">US$ {(Number(data.ops?.cost ?? 0) / 100).toFixed(2)}</dd></div>
                <div className="flex justify-between"><dt className="text-bone-mute">Atendimentos</dt><dd>{data.ops?.runs ?? 0}</dd></div>
                <div className="flex justify-between"><dt className="text-bone-mute">Respostas descartadas por handoff</dt><dd>{data.ops?.discarded ?? 0}</dd></div>
                <div className="flex justify-between"><dt className="text-bone-mute">Jobs com falha (7 dias)</dt><dd className={cn(data.ops?.failed ? "font-semibold text-danger" : "")}>{data.ops?.failed ?? 0}</dd></div>
                {s.aiMonthlyBudgetCents != null && <div className="flex justify-between"><dt className="text-bone-mute">Teto mensal</dt><dd>US$ {(s.aiMonthlyBudgetCents / 100).toFixed(2)}</dd></div>}
              </dl>
              <p className="mt-3 text-[11px] text-bone-mute">Estimativa por tokens (preço de tabela do modelo); a fatura do provedor é a referência. Equivale a cerca de {brl(Math.round(Number(data.ops?.cost ?? 0) * 5.5))} a R$ 5,50/US$ (câmbio ilustrativo).</p>
            </Card>
          </div>
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
    </>
  );
}
