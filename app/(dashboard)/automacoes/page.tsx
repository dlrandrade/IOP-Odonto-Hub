import Link from "next/link";
import { ArrowRight, Check, Plus } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, Modal } from "@/components/client";
import { Badge, Button, Card, CardTitle, Checkbox, Empty, Field, Input, Notice, PageHeader, Select, Table, Textarea, buttonClass } from "@/components/ui";
import { formatShort } from "@/lib/datetime";
import { cn } from "@/lib/format";
import { db } from "@/db/client";
import { env } from "@/lib/env";
import { emailConfigured } from "@/integrations/email";
import { completeTaskAction, deleteRuleAction, reorderAutomationsAction, saveBuiltinAction, saveLimitsAction, saveRuleAction, saveTemplateAction, toggleAutomationAction } from "./actions";
import { FlowList, RuleForm, Switch } from "./builder";
import type { AutomationRule } from "@/services/automation-rules";

export const metadata = { title: "Automações" };

const JOB_LABEL: Record<string, string> = {
  process_conversation: "Resposta da IA", transcribe: "Transcrição de áudio", fetch_media: "Download de mídia", send_message: "Reenvio de mensagem", automation: "Automação da clínica",
  followup_1: "Follow-up 1", followup_2: "Follow-up 2", reminder: "Lembrete de consulta", confirmation_request: "Pedido de confirmação",
};
const TEMPLATE_STATUS: Record<string, string> = { not_submitted: "Não enviado à Meta", pending: "Em análise na Meta", approved: "Aprovado", rejected: "Rejeitado" };
const TEMPLATE_USE: Record<string, string> = {
  lembrete_consulta: "Lembrete 48 h antes, quando a janela de 24 h está fechada.",
  confirmacao_consulta: "Pedido de confirmação 24 h antes, fora da janela.",
  retomada_contato: "Retomar conversa fora da janela (envio manual ou follow-up).",
};

type FlowItem = {
  key: string; name: string; builtin: boolean; on: boolean; trigger: string; wait: string; action: "message" | "task" | "confirmation"; channel?: "whatsapp" | "email" | "instagram";
  preview: string; purpose: string; edit: React.ReactNode;
};

const TRIGGER_LABEL: Record<string, string> = {
  no_reply: "Paciente parou de responder", before_appointment: "Antes da consulta", after_appointment: "Depois da consulta",
  no_show: "Paciente faltou", birthday: "Aniversário do paciente",
};
const hoursLabel = (h: number) => (h >= 24 && h % 24 === 0 ? `${h / 24} dia${h / 24 > 1 ? "s" : ""}` : `${String(h).replace(".", ",")} h`);
const minutesLabel = (m: number) => (m % 1440 === 0 && m > 0 ? `${m / 1440} dia${m / 1440 > 1 ? "s" : ""}` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);

export default async function AutomationsPage() {
  const ctx = await requireCtx("automations.manage");
  const s = ctx.settings;
  const data = await q(ctx, async (tx) => ({
    templates: await tx<{ id: string; name: string; body: string; wa_template_status: string }[]>`select id, name, body, wa_template_status from message_templates order by name`,
    jobs: await tx<{ id: string; type: string; run_at: Date; status: string; result: string | null; last_error: string | null; attempts: number }[]>`
      select id, type, run_at, status, result, last_error, attempts from scheduled_jobs order by run_at desc limit 40`,
    tasks: await tx<{ id: string; title: string; detail: string | null; conversation_id: string | null; created_at: Date }[]>`
      select id, title, detail, conversation_id, created_at from tasks where status = 'open' order by created_at desc limit 30`,
    counts: (await tx<{ pending: number; failed: number }[]>`
      select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'failed' and updated_at > now() - interval '7 days')::int as failed from scheduled_jobs`)[0],
    rules: await tx<AutomationRule[]>`select * from automation_rules order by position, created_at`,
  }));
  const templateNames = data.templates.map((t) => t.name);
  // A tabela de integrações só é legível pelo admin (RLS); aqui basta saber se há canal ligado.
  const [channel] = await db()<{ ok: boolean }[]>`
    select case wa_provider when 'evolution' then evo_connected_at is not null when 'wacli' then wacli_connected_at is not null
                else wa_phone_number_id is not null and wa_access_token_enc is not null end as ok
    from clinic_integrations where clinic_id = ${ctx.clinicId}`;
  const waOn = !!channel?.ok || !!(env.wa.phoneNumberId && env.wa.accessToken);
  const channelStatus = { whatsapp: waOn, email: emailConfigured(), googleLink: !!(ctx.clinic.google_review_url || ctx.clinic.google_place_id) };

  const BuiltinEdit = ({ k, hours, text }: { k: string; hours: number; text?: string }) => (
    <Modal trigger="Editar" title="Editar automação" description="Automação nativa: o texto do lembrete é montado com paciente, serviço, dentista e data." triggerClass={buttonClass("outline", "sm")}>
      <ActionForm action={saveBuiltinAction} className="space-y-5" resetOnDone={false}>
        <input type="hidden" name="key" value={k} />
        <Field label={k.startsWith("followup") ? "Horas depois da última mensagem" : "Horas antes da consulta"}><Input type="number" step="0.5" min="0.5" name="hours" defaultValue={hours} className="w-40" /></Field>
        {text !== undefined && <Field label="Mensagem"><Textarea name="text" defaultValue={text} className="min-h-20" /></Field>}
        <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Salvar</Button></div>
      </ActionForm>
    </Modal>
  );

  const builtins: FlowItem[] = [
    { key: "followup_1", name: "Follow-up 1", builtin: true, on: s.followupsEnabled, trigger: "no_reply", wait: `${hoursLabel(s.followup1Hours)} depois`, action: "message",
      preview: s.followup1Text, purpose: "Retoma quem parou de responder durante o atendimento da assistente.", edit: <BuiltinEdit k="followup_1" hours={s.followup1Hours} text={s.followup1Text} /> },
    { key: "followup_2", name: "Follow-up 2", builtin: true, on: s.followup2Enabled, trigger: "no_reply", wait: `${hoursLabel(s.followup2Hours)} depois`, action: "message",
      preview: s.followup2Text, purpose: "Última tentativa, ainda dentro da janela gratuita de 24 h.", edit: <BuiltinEdit k="followup_2" hours={s.followup2Hours} text={s.followup2Text} /> },
    { key: "reminder", name: "Lembrete de consulta", builtin: true, on: s.remindersEnabled, trigger: "before_appointment", wait: `${hoursLabel(s.reminderHours[0] ?? 48)} antes`, action: "message",
      preview: "Olá! Lembrete da {clínica}: {paciente} tem {serviço} com {dentista} em {data}.", purpose: "Reduz faltas. Não envia se a consulta foi marcada em cima da hora.", edit: <BuiltinEdit k="reminder" hours={s.reminderHours[0] ?? 48} /> },
    { key: "confirmation", name: "Pedido de confirmação", builtin: true, on: s.confirmationEnabled, trigger: "before_appointment", wait: `${hoursLabel(s.reminderHours[1] ?? 24)} antes`, action: "confirmation",
      preview: "… Responda 1 para confirmar ou 2 para remarcar.", purpose: "A resposta “1” confirma sozinha; “2” abre a remarcação.", edit: <BuiltinEdit k="confirmation" hours={s.reminderHours[1] ?? 24} /> },
  ];
  const customs: FlowItem[] = data.rules.map((r) => {
    const draft = {
      id: r.id, name: r.name, trigger: r.trigger, action: r.action, body: r.body ?? "", taskTitle: r.task_title ?? "", templateName: r.template_name ?? "", channel: r.channel,
      time: `${String(Math.floor(r.offset_minutes / 60)).padStart(2, "0")}:${String(r.offset_minutes % 60).padStart(2, "0")}`,
      ...(r.offset_minutes % 1440 === 0 && r.offset_minutes > 0 ? { amount: r.offset_minutes / 1440, unit: "days" as const } : r.offset_minutes % 60 === 0 ? { amount: r.offset_minutes / 60, unit: "hours" as const } : { amount: r.offset_minutes, unit: "minutes" as const }),
    };
    return {
      key: r.id, name: r.name, builtin: false, on: r.enabled, trigger: r.trigger, action: r.action, channel: r.channel,
      wait: r.trigger === "birthday" ? `às ${draft.time}` : r.offset_minutes === 0 ? "na hora" : `${minutesLabel(r.offset_minutes)} ${r.trigger === "before_appointment" ? "antes" : "depois"}`,
      preview: (r.action === "message" ? r.body : r.task_title) ?? "", purpose: r.action === "task" ? "Cria uma tarefa para a equipe." : "Mensagem automática criada pela clínica.",
      edit: (
        <Modal trigger="Editar" title="Editar automação" description={r.name} wide triggerClass={buttonClass("outline", "sm")}>
          <RuleForm rule={draft} templates={templateNames} action={saveRuleAction} status={channelStatus} />
          <ActionForm action={deleteRuleAction} className="mt-6 flex items-center justify-between gap-4 rounded-md border border-danger/30 bg-danger-soft/40 px-4 py-3">
            <input type="hidden" name="ruleId" value={r.id} />
            <span className="text-[13px] text-bone-dim">Excluir apaga a automação e cancela os envios ainda não feitos.</span>
            <Button type="submit" size="sm" variant="danger">Excluir</Button>
          </ActionForm>
        </Modal>
      ),
    };
  });
  const all = [...builtins, ...customs];
  const order = s.automationOrder;
  all.sort((x, y) => {
    const ix = order.indexOf(x.key), iy = order.indexOf(y.key);
    return (ix < 0 ? 999 : ix) - (iy < 0 ? 999 : iy);
  });
  const active = all.filter((f) => f.on).length;

  const Chip = ({ eyebrow, children, tone }: { eyebrow: string; children: React.ReactNode; tone: string }) => (
    <span className={cn("flex min-w-0 flex-col rounded-md border px-3 py-2", tone)}>
      <span className="eyebrow text-[9.5px] text-bone-mute">{eyebrow}</span>
      <span className="truncate text-[13px] font-medium">{children}</span>
    </span>
  );

  return (
    <>
      <PageHeader title="Automações" subtitle="Mensagens e tarefas que acontecem sozinhas. Ligue, desligue, edite ou arraste para organizar. Antes de cada envio o sistema confere se ainda faz sentido.">
        <Modal trigger={<><Plus aria-hidden /> Nova automação</>} title="Nova automação" description="Escolha quando acontece, quanto tempo esperar e o que fazer." wide triggerClass={buttonClass("primary")}>
          <RuleForm templates={templateNames} action={saveRuleAction} status={channelStatus} />
        </Modal>
      </PageHeader>
      {!waOn && (
        <div className="mb-6">
          <Notice tone="sun">
            <strong>WhatsApp ainda não conectado.</strong> As automações já estão programadas, mas as mensagens só saem quando houver um canal ligado em{" "}
            <Link className="underline underline-offset-2" href="/configuracoes?aba=whatsapp">Configurações → WhatsApp</Link>.<span className="simples:hidden"> Até lá, elas ficam como “não entregue”. Para testar agora, use o Simulador: lembretes e follow-ups de pacientes do simulador chegam lá normalmente. Automações que só criam tarefa funcionam sem WhatsApp.</span>
          </Notice>
        </div>
      )}
      {(data.counts?.failed ?? 0) > 0 && <div className="mb-6"><Notice tone="danger">{data.counts!.failed} automação(ões) falharam nos últimos 7 dias. Cada falha virou uma tarefa para a equipe<span className="simples:hidden"> (detalhes no histórico abaixo)</span>.</Notice></div>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-labelledby="fluxos">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <h2 id="fluxos" className="t-h2">Seus fluxos</h2>
              <p className="t-small mt-1">{active} de {all.length} ativos<span className="simples:hidden"> · arraste pela alça à esquerda para mudar a ordem</span>.</p>
            </div>
          </div>
          <FlowList reorder={reorderAutomationsAction} items={all.map((f) => ({
            key: f.key,
            node: (
              <div>
                <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2"><h3 className="t-h3">{f.name}</h3><span className="simples:hidden">{f.builtin ? <Badge>nativa</Badge> : <Badge tone="violet">da clínica</Badge>}</span></div>
                    <p className="t-small mt-0.5">{f.purpose}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Switch name={f.key} on={f.on} action={toggleAutomationAction} label={`${f.on ? "Pausar" : "Ativar"} ${f.name}`} />
                    {f.edit}
                  </div>
                </div>
                <div className={cn("mt-4 grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,0.7fr)_auto_minmax(0,1fr)]", !f.on && "opacity-55")}>
                  <Chip eyebrow="Quando" tone="border-info/30 bg-info-soft/60">{TRIGGER_LABEL[f.trigger] ?? f.trigger}</Chip>
                  <ArrowRight size={14} aria-hidden className="hidden text-bone-mute sm:block" />
                  <Chip eyebrow="Espera" tone="border-line bg-surface-2/60">{f.wait}</Chip>
                  <ArrowRight size={14} aria-hidden className="hidden text-bone-mute sm:block" />
                  <Chip eyebrow="Faz" tone={f.action === "task" ? "border-warn/30 bg-warn-soft/60" : "border-ok/30 bg-ok-soft/60"}>{f.action === "task" ? "Cria tarefa" : f.action === "confirmation" ? "Pede confirmação" : f.channel === "email" ? "Envia e-mail" : f.channel === "instagram" ? "Envia no Instagram" : "Envia no WhatsApp"}</Chip>
                </div>
                {f.preview && <p className="mt-3 line-clamp-2 border-l-2 border-line pl-3 text-[13px] italic text-bone-dim">“{f.preview}”</p>}
              </div>
            ),
          }))} />
        </section>

        <aside className="flex flex-col gap-6">
          <Card className="h-auto">
            <CardTitle hint="Valem para todas as automações de mensagem.">Limites para todas</CardTitle>
            <ActionForm action={saveLimitsAction} className="space-y-5" resetOnDone={false}>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Enviar a partir de"><Select name="quietStartHour" defaultValue={s.quietStartHour}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</Select></Field>
                <Field label="Enviar até"><Select name="quietEndHour" defaultValue={s.quietEndHour}>{Array.from({ length: 24 }, (_, h) => h + 1).map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</Select></Field>
              </div>
              <Field label="Máximo de mensagens automáticas por dia, por paciente"><Input type="number" min="1" max="10" name="maxAutomatedPerDay" defaultValue={s.maxAutomatedPerDay} className="w-28" /></Field>
              <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Salvar limites</Button></div>
            </ActionForm>
          </Card>
          <Card className="h-auto simples:hidden">
            <CardTitle>Sempre conferido antes de enviar</CardTitle>
            <ul className="space-y-2.5 text-[13px] text-bone-dim">
              {["O paciente não pediu para parar de receber mensagens.", "Ninguém da equipe está atendendo a conversa.", "O paciente não respondeu nem agendou nesse meio-tempo.", "Está dentro do horário e do limite diário.", "No WhatsApp oficial, fora da janela de 24 h só vai template aprovado; sem ele, vira tarefa."].map((t) => (
                <li key={t} className="flex gap-2.5"><Check size={15} aria-hidden className="mt-0.5 shrink-0 text-ok" />{t}</li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="simples:hidden">
          <CardTitle hint="Fora da janela de 24 h o WhatsApp só aceita templates aprovados pela Meta. Crie o template com o mesmo nome no WhatsApp Manager e, quando aprovado, marque aqui.">Templates do WhatsApp</CardTitle>
          <ul className="space-y-6">
            {data.templates.map((t) => (
              <li key={t.id} className="rounded-md border border-line p-4">
                <div className="flex items-center justify-between gap-2"><code className="font-mono text-[13px] font-semibold">{t.name}</code><Badge tone={t.wa_template_status === "approved" ? "ok" : t.wa_template_status === "rejected" ? "danger" : "warn"}>{TEMPLATE_STATUS[t.wa_template_status]}</Badge></div>
                <p className="t-small mt-1">{TEMPLATE_USE[t.name] ?? ""}</p>
                <p className="mt-2 rounded-sm bg-surface-2 px-3 py-2.5 text-sm leading-relaxed">{t.body}</p>
                <div className="mt-3 flex justify-end">
                  <Modal trigger="Editar / atualizar situação" title="Template do WhatsApp" description={`${t.name} · o texto precisa ser igual ao aprovado pela Meta.`} triggerClass={buttonClass("outline", "sm")}>
                    <ActionForm action={saveTemplateAction} className="space-y-4" resetOnDone={false}>
                      <input type="hidden" name="templateId" value={t.id} />
                      <Field label="Texto (igual ao aprovado na Meta)" hint="Variáveis: {{1}} paciente, {{2}} serviço, {{3}} dentista, {{4}} data completa."><Textarea name="body" defaultValue={t.body} /></Field>
                      <Field label="Situação na Meta"><Select name="status" defaultValue={t.wa_template_status}>{Object.entries(TEMPLATE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
                      <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Salvar</Button></div>
                    </ActionForm>
                  </Modal>
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="simples:lg:col-span-2">
          <CardTitle hint="Quando a automação não pode agir sozinha, ela pede uma pessoa.">Tarefas para a equipe ({data.tasks.length})</CardTitle>
          {data.tasks.length === 0 ? <Empty title="Nada pendente" /> : (
            <ul className="divide-y divide-line">
              {data.tasks.map((t) => (
                <li key={t.id} className="flex min-h-14 items-center justify-between gap-4 py-3">
                  <div className="min-w-0"><p className="t-h3 truncate">{t.title}</p><p className="t-small truncate">{t.detail} · {formatShort(t.created_at, ctx.tz)}</p></div>
                  <div className="flex shrink-0 items-center gap-2">
                    {t.conversation_id && <Link href={`/conversas?c=${t.conversation_id}`} className={buttonClass("outline", "sm")}>Conversa</Link>}
                    <ActionForm action={completeTaskAction}><input type="hidden" name="taskId" value={t.id} /><Button size="sm" variant="outline">Concluir</Button></ActionForm>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6 simples:hidden">
        <Card>
          <CardTitle hint={`${data.counts?.pending ?? 0} na fila agora`}>Histórico de execuções</CardTitle>
          {data.jobs.length === 0 ? <Empty title="Nenhuma execução ainda" /> : (
            <Table head={["Automação", "Quando", "Situação"]}>
              {data.jobs.map((j) => (
                <tr key={j.id}>
                  <td className="max-w-[420px]"><p className="truncate">{JOB_LABEL[j.type] ?? j.type}</p><p className="t-small truncate" title={j.last_error ?? j.result ?? ""}>{j.last_error ?? j.result ?? "—"}{j.attempts > 1 ? ` · ${j.attempts} tentativas` : ""}</p></td><td className="whitespace-nowrap">{formatShort(j.run_at, ctx.tz)}</td>
                  <td><Badge tone={j.status === "done" ? "ok" : j.status === "failed" ? "danger" : j.status === "cancelled" ? "neutral" : "warn"}>{{ pending: "na fila", running: "rodando", done: "feito", failed: "falhou", cancelled: "cancelado" }[j.status] ?? j.status}</Badge></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
