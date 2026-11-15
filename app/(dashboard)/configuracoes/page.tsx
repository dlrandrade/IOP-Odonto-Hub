import Link from "next/link";
import { Bot, Building2, CalendarDays, Download, Eye, MessageCircle, MousePointerClick, Plus, Upload, ScrollText, Star, Users, type LucideIcon } from "lucide-react";
import { CORES } from "@/lib/tema";
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
import { GooglePlaceSearch } from "./google-search";
import { GoogleShare } from "@/components/google-share";
import { CopyField } from "@/components/copy-field";
import { qrDataUrl, reviewLink } from "@/services/google-reviews";
import { addCalendarImportAction, removeCalendarImportAction, saveCalendarFeedAction, syncCalendarNowAction, inviteUserAction, saveAiAction, saveClinicAction, saveGoogleAction, saveIrritationAction, saveProfessionalAction, saveResourceAction, saveWhatsAppAction, updateUserAction } from "./actions";

export const metadata = { title: "Configurações" };

const TABS = [["clinica", "Clínica"], ["equipe", "Equipe"], ["agenda", "Agenda"], ["whatsapp", "WhatsApp"], ["google", "Google"], ["ia", "Assistente"], ["visualizacao", "Visualização"], ["auditoria", "Auditoria"]] as const;
type TabKey = (typeof TABS)[number][0];
/** Cada seção é um bloco com ícone colorido, como nos Ajustes do iPhone. */
const TAB_ICON: Record<TabKey, { icon: LucideIcon; rgb: string; text: string }> = {
  // cada seção usa a cor do recurso que ela configura (src/lib/tema.ts); equipe e bastidores têm tons próprios
  clinica: { icon: Building2, rgb: CORES.hoje.rgb, text: "Nome, contato e horários" },
  equipe: { icon: Users, rgb: "196 142 94", text: "Acessos de cada pessoa" },
  agenda: { icon: CalendarDays, rgb: CORES.agenda.rgb, text: "Dentistas e cadeiras" },
  whatsapp: { icon: MessageCircle, rgb: CORES.conversas.rgb, text: "Conectar o número" },
  google: { icon: Star, rgb: CORES.indicadores.rgb, text: "Avaliações e QR code" },
  ia: { icon: Bot, rgb: CORES.simulador.rgb, text: "Como ela atende" },
  visualizacao: { icon: Eye, rgb: CORES.ajustes.rgb, text: "Simples ou com detalhes" },
  auditoria: { icon: ScrollText, rgb: "110 120 135", text: "Quem alterou o quê" },
};
const Step = ({ n }: { n: number }) => <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-acento/15 text-[11px] font-bold text-acento">{n}</span>;
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
    calendar: tab === "agenda" && isAdmin ? {
      feed: (await tx<{ token: string; privacy: "busy" | "service" | "name_service" }[]>`select calendar_feed_token as token, calendar_feed_privacy as privacy from clinic_integrations`)[0],
      imports: await tx<{ id: string; label: string; professional: string | null; last_synced_at: Date | null; last_error: string | null; events_count: number }[]>`
        select i.id, i.label, p.name as professional, i.last_synced_at, i.last_error, i.events_count from calendar_imports i left join professionals p on p.id = i.professional_id order by i.created_at`,
    } : null,
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

  const googleLink = reviewLink(ctx.clinic);
  const googleQr = tab === "google" && googleLink ? await qrDataUrl(googleLink) : null;

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
        <nav aria-label="Seções de configuração" className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8 lg:gap-4 simples:lg:grid-cols-7">
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
            <fieldset className="rounded-lg border border-line p-4">
              <legend className="eyebrow px-1.5 text-bone-mute">Contato e redes</legend>
              <p className="t-small mb-4">Usados pela assistente para informar o paciente e como resposta dos e-mails automáticos.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Telefone da clínica"><Input name="contactPhone" defaultValue={ctx.clinic.contact_phone ?? ""} inputMode="tel" placeholder="(11) 3333-4444" /></Field>
                <Field label="E-mail da clínica"><Input name="contactEmail" type="email" defaultValue={ctx.clinic.contact_email ?? ""} placeholder="contato@clinica.com.br" /></Field>
                <Field label="Instagram"><Input name="instagram" defaultValue={ctx.clinic.instagram_handle ? `@${ctx.clinic.instagram_handle}` : ""} placeholder="@clinicasorriso" /></Field>
                <Field label="Site"><Input name="website" defaultValue={ctx.clinic.website_url ?? ""} placeholder="www.clinica.com.br" /></Field>
              </div>
            </fieldset>
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

      {allowed && tab === "agenda" && data.calendar?.feed && (
        <Card className="h-auto">
          <CardTitle hint="Funciona com o Google Agenda (e também Outlook e Apple). Não precisa de senha nem login do Google aqui.">Google Agenda</CardTitle>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="flex flex-col gap-4 rounded-lg border border-line p-5">
              <div className="flex items-center gap-3">
                <span className="icone-app size-10 rounded-[12px]" style={{ "--icone-rgb": CORES.agenda.rgb } as CSSProperties}><Upload size={18} aria-hidden /></span>
                <div><p className="t-h3">Espelhar no Google Agenda</p><p className="t-small">As consultas daqui aparecem no Google Agenda da clínica.</p></div>
              </div>
              <ol className="space-y-2 text-[13.5px]">
                <li className="flex gap-2"><Step n={1} /><span>Copie o link abaixo.</span></li>
                <li className="flex gap-2"><Step n={2} /><span>No Google Agenda, abra <a className="font-semibold underline underline-offset-2" href="https://calendar.google.com/calendar/u/0/r/settings/addbyurl" target="_blank" rel="noopener noreferrer">Adicionar agenda → Do URL</a>, cole e confirme.</span></li>
                <li className="flex gap-2"><Step n={3} /><span>Pronto. O Google atualiza sozinho a cada poucas horas.</span></li>
              </ol>
              <CopyField value={`${env.appUrl}/api/agenda/${data.calendar.feed.token}.ics`} />
              <ActionForm action={saveCalendarFeedAction} className="flex flex-wrap items-end gap-3" resetOnDone={false}>
                <Field label="O que aparece no Google" className="min-w-0 flex-1">
                  <Select name="privacy" defaultValue={data.calendar.feed.privacy}>
                    <option value="name_service">Primeiro nome e serviço</option>
                    <option value="service">Só serviço e dentista</option>
                    <option value="busy">Só “Ocupado”</option>
                  </Select>
                </Field>
                <Button type="submit" variant="outline">Salvar</Button>
              </ActionForm>
              <ActionForm action={saveCalendarFeedAction} className="mt-auto border-t border-line pt-4" resetOnDone={false}>
                <input type="hidden" name="privacy" value={data.calendar.feed.privacy} /><input type="hidden" name="rotate" value="1" />
                <p className="t-small">O link é secreto: quem tiver o link vê a agenda. Se ele vazar, gere outro.</p>
                <Button type="submit" size="sm" variant="ghost" className="mt-2">Gerar novo link</Button>
              </ActionForm>
            </section>
            <section className="flex flex-col gap-4 rounded-lg border border-line p-5">
              <div className="flex items-center gap-3">
                <span className="icone-app size-10 rounded-[12px]" style={{ "--icone-rgb": CORES.agenda.rgb } as CSSProperties}><Download size={18} aria-hidden /></span>
                <div><p className="t-h3">Puxar do Google Agenda</p><p className="t-small">Compromissos do Google viram bloqueios aqui: ninguém marca em cima.</p></div>
              </div>
              <ol className="space-y-2 text-[13.5px]">
                <li className="flex gap-2"><Step n={1} /><span>Abra as <a className="font-semibold underline underline-offset-2" href="https://calendar.google.com/calendar/u/0/r/settings" target="_blank" rel="noopener noreferrer">configurações do Google Agenda</a> e clique na agenda da clínica (à esquerda).</span></li>
                <li className="flex gap-2"><Step n={2} /><span>Em <strong>Integrar agenda</strong>, copie o <strong>Endereço secreto no formato iCal</strong>.</span></li>
                <li className="flex gap-2"><Step n={3} /><span>Cole abaixo e escolha quem fica bloqueado. Atualiza a cada 15 minutos.</span></li>
              </ol>
              <ActionForm action={addCalendarImportAction} className="space-y-4">
                <Field label="Endereço secreto no formato iCal"><Input name="url" required placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" autoComplete="off" /></Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Bloquear"><Select name="professionalId" defaultValue=""><option value="">A clínica toda</option>{data.professionals.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>Só {p.name}</option>)}</Select></Field>
                  <Field label="Nome (opcional)"><Input name="label" placeholder="Agenda pessoal da Dra. Ana" /></Field>
                </div>
                <div className="flex justify-end"><Button type="submit">Conectar agenda</Button></div>
              </ActionForm>
              {data.calendar.imports.length > 0 && (
                <ul className="divide-y divide-line border-t border-line">
                  {data.calendar.imports.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="t-h3 truncate">{i.label} <span className="t-small font-normal">· {i.professional ? `bloqueia ${i.professional}` : "bloqueia a clínica toda"}</span></p>
                        <p className={cn("t-small", i.last_error && "text-danger")}>{i.last_error ?? (i.last_synced_at ? `${i.events_count} compromisso(s) · atualizado ${formatShort(i.last_synced_at, ctx.tz)}` : "Aguardando a primeira leitura")}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <ActionForm action={syncCalendarNowAction}><input type="hidden" name="importId" value={i.id} /><Button size="sm" variant="ghost">Atualizar agora</Button></ActionForm>
                        <ActionForm action={removeCalendarImportAction}><input type="hidden" name="importId" value={i.id} /><Button size="sm" variant="ghost">Desconectar</Button></ActionForm>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </Card>
      )}

      {allowed && tab === "whatsapp" && data.wa && (
        <Card>
          <CardTitle hint="Escolha como a clínica conecta o WhatsApp. Dá para trocar depois sem perder as conversas.">Canal de WhatsApp</CardTitle>
          <div className="mb-6 flex items-start gap-4 rounded-lg border border-[#25D366]/30 bg-[#25D366]/[0.06] p-4">
            <span className="icone-app size-10 shrink-0 rounded-[12px]" style={{ "--icone-rgb": "37 211 102" } as CSSProperties}><MousePointerClick size={19} aria-hidden /></span>
            <div className="text-[13.5px]">
              <p className="font-semibold">Ainda não conectou? Já dá para usar, por clique.</p>
              <p className="t-small mt-0.5">Sem conexão, lembretes e automações aparecem na hora certa em <strong>Hoje</strong> com o botão “Enviar no WhatsApp”: abre o WhatsApp Web (ou o app no celular) com o paciente e a mensagem prontos. Você só confere e envia. Conectando um dos canais abaixo, os envios passam a sair sozinhos.</p>
            </div>
          </div>
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

      {allowed && tab === "google" && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <Card>
            <CardTitle hint="Com o Google cadastrado, a clínica ganha o link e o QR code de avaliação, a origem “Google” nos pacientes e o histórico de avaliações em Indicadores.">Google Meu Negócio</CardTitle>
            <ActionForm action={saveGoogleAction} className="space-y-5" resetOnDone={false}>
              <Field label="Link para pedir avaliação" hint="No Google: Perfil da Empresa → Pedir avaliações → copiar link (g.page/r/…).">
                <Input name="reviewUrl" defaultValue={ctx.clinic.google_review_url ?? ""} placeholder="https://g.page/r/…/review" />
              </Field>
              <Field label="Link do perfil no Google Maps (opcional)"><Input name="businessUrl" defaultValue={ctx.clinic.google_business_url ?? ""} placeholder="https://maps.app.goo.gl/…" /></Field>
              <div className="space-y-4 rounded-lg border border-line p-4">
                <div>
                  <p className="t-h3">ID do local no Google (Place ID)</p>
                  <p className="t-small mt-1">Com ele, o sistema monta o link de avaliação e acompanha a nota e o total de avaliações sozinho.</p>
                </div>
                {env.googlePlacesKey ? <GooglePlaceSearch defaultQuery={ctx.clinic.name} /> : (
                  <ol className="space-y-2 text-[13.5px]">
                    <li className="flex gap-2"><span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-acento/15 text-[11px] font-bold text-acento">1</span>
                      <span>Abra o <a href="https://developers.google.com/maps/documentation/places/web-service/place-id?hl=pt-br#find-id" target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">localizador de Place ID do Google</a>.</span></li>
                    <li className="flex gap-2"><span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-acento/15 text-[11px] font-bold text-acento">2</span>
                      <span>No mapa da página, digite o nome da clínica e escolha o resultado certo.</span></li>
                    <li className="flex gap-2"><span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-acento/15 text-[11px] font-bold text-acento">3</span>
                      <span>Copie o código que aparece em “Place ID” (começa com <code className="font-mono">ChIJ</code>) e cole abaixo.</span></li>
                  </ol>
                )}
                <Field label="Place ID" hint="Também aceita colar um link do Google que contenha o Place ID.">
                  <Input name="placeId" defaultValue={ctx.clinic.google_place_id ?? ""} placeholder="ChIJ…" className="font-mono text-[13px]" />
                </Field>
              </div>
              <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Salvar</Button></div>
            </ActionForm>
          </Card>
          <Card>
            <CardTitle hint="Imprima no balcão, mande no WhatsApp ou use na automação “Pedir avaliação no Google”.">Compartilhar</CardTitle>
            {googleLink && googleQr ? <GoogleShare reviewUrl={googleLink} profileUrl={ctx.clinic.google_business_url} qr={googleQr} clinicName={ctx.clinic.name} />
              : <Empty title="Cole o link de avaliação ao lado">O link e o QR code aparecem aqui assim que salvar.</Empty>}
            {googleLink && <p className="t-small mt-auto pt-5">Para pedir avaliação depois de cada consulta, crie em <Link className="underline underline-offset-2" href="/automacoes">Automações</Link> o modelo “Pedir avaliação no Google”.</p>}
          </Card>
        </div>
      )}

      {allowed && tab === "ia" && (
        <div className="space-y-6">
        {data.wa && (
          <Card className="hidden h-auto detalhado:hidden simples:flex">
            <div className="flex flex-wrap items-center gap-4">
              <span className="icone-app size-12 rounded-[14px]" style={{ "--icone-rgb": CORES.simulador.rgb } as CSSProperties}><Bot size={24} aria-hidden /></span>
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

      {allowed && tab === "ia" && (
        <Card className="mt-6 h-auto">
          <CardTitle hint="Palavrão, ofensa, ameaça de reclamação ou mensagem em CAIXA ALTA: a assistente para na hora, responde com acolhimento e passa a conversa para a equipe.">Paciente irritado</CardTitle>
          <ActionForm action={saveIrritationAction} className="space-y-6" resetOnDone={false}>
            <Checkbox name="enabled" defaultChecked={s.irritation.enabled} label="Detectar paciente irritado" hint="Recomendado. A conversa aparece em “Esperando você” com o motivo." />
            <div className="grid gap-4 sm:grid-cols-2">
              <Checkbox name="profanity" defaultChecked={s.irritation.profanity} label="Palavrões e ofensas" hint="Ex.: palavrões comuns e xingamentos." />
              <Checkbox name="harsh" defaultChecked={s.irritation.harsh} label="Expressões duras e ameaças" hint="“absurdo”, “descaso”, “vou no Procon”, “Reclame Aqui”, “nunca mais”…" />
              <Checkbox name="caps" defaultChecked={s.irritation.caps} label="Mensagem toda em CAIXA ALTA" hint="Quando o paciente está “gritando”." />
              <Checkbox name="exclamations" defaultChecked={s.irritation.exclamations} label="Muitas exclamações ou interrogações" hint="Quatro ou mais seguidas (!!!! ou ????)." />
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <Field label="Outras palavras ou frases (uma por linha)" hint="Termos que, na sua clínica, indicam insatisfação."><Textarea name="extra" defaultValue={s.irritation.extra.join("\n")} className="min-h-28" placeholder={"demora\nesperei mais de uma hora"} /></Field>
              <div className="space-y-5">
                <Field label="Resposta automática ao paciente" hint="Enviada uma vez, antes de a equipe assumir. Deixe vazio para não responder."><Textarea name="message" defaultValue={s.irritation.message} className="min-h-24" /></Field>
                <Checkbox name="urgent" defaultChecked={s.irritation.urgent} label="Marcar como urgente" hint="Aparece no topo da fila, em vermelho." />
              </div>
            </div>
            <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Salvar</Button></div>
          </ActionForm>
        </Card>
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
