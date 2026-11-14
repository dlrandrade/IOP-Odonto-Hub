import Link from "next/link";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, Modal } from "@/components/client";
import { Badge, Button, Card, CardTitle, Checkbox, Empty, Field, Input, Notice, PageHeader, Select, Table, Textarea, buttonClass } from "@/components/ui";
import { formatShort } from "@/lib/datetime";
import { completeTaskAction, saveAutomationSettingsAction, saveTemplateAction } from "./actions";

export const metadata = { title: "Automações" };

const JOB_LABEL: Record<string, string> = {
  process_conversation: "Resposta da IA", transcribe: "Transcrição de áudio", fetch_media: "Download de mídia", send_message: "Reenvio de mensagem",
  followup_1: "Follow-up 1", followup_2: "Follow-up 2", reminder: "Lembrete de consulta", confirmation_request: "Pedido de confirmação",
};
const TEMPLATE_STATUS: Record<string, string> = { not_submitted: "Não enviado à Meta", pending: "Em análise na Meta", approved: "Aprovado", rejected: "Rejeitado" };
const TEMPLATE_USE: Record<string, string> = {
  lembrete_consulta: "Lembrete 48 h antes, quando a janela de 24 h está fechada.",
  confirmacao_consulta: "Pedido de confirmação 24 h antes, fora da janela.",
  retomada_contato: "Retomar conversa fora da janela (envio manual ou follow-up).",
};

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
  }));
  const rules = [
    { name: "Follow-up 1", on: s.followupsEnabled, purpose: "Retomar quem parou de responder.", trigger: `${s.followup1Hours} h após a última mensagem sem resposta do paciente.`, msg: s.followup1Text },
    { name: "Follow-up 2", on: s.followupsEnabled, purpose: "Última tentativa dentro da janela gratuita.", trigger: `${s.followup2Hours} h após a última mensagem do paciente (ainda dentro das 24 h).`, msg: s.followup2Text },
    { name: "Lembrete de consulta", on: s.remindersEnabled, purpose: "Reduzir faltas.", trigger: "48 h antes da consulta (não envia retroativo).", msg: "Lembrete com paciente, serviço, dentista e data completa." },
    { name: "Pedido de confirmação", on: s.remindersEnabled, purpose: "Confirmar presença ou abrir espaço para remarcar.", trigger: "24 h antes da consulta.", msg: "“Responda 1 para confirmar ou 2 para remarcar.”" },
  ];

  return (
    <>
      <PageHeader title="Automações" subtitle="Mensagens de serviço enviadas sozinhas — sempre conferindo estado, resposta recente, descadastro, janela de 24 h e limite de frequência antes de cada envio." />
      {(data.counts?.failed ?? 0) > 0 && <div className="mb-6"><Notice tone="danger">{data.counts!.failed} automação(ões) falharam nos últimos 7 dias. Veja o histórico abaixo; cada falha virou uma tarefa para a equipe.</Notice></div>}
      <div className="grid gap-6 lg:grid-cols-2">
        {rules.map((r) => (
          <Card key={r.name}>
            <CardTitle action={<Badge tone={r.on ? "ok" : "warn"}>{r.on ? "Ativa" : "Pausada"}</Badge>}>{r.name}</CardTitle>
            <p className="t-body -mt-2 mb-5 text-bone-dim">{r.purpose}</p>
            <dl className="divide-y divide-line border-t border-line">
              {[
                ["Quando", r.trigger],
                ["Condições", `Sem resposta nova, sem descadastro, sem pessoa atendendo, entre ${s.quietStartHour}h e ${s.quietEndHour}h, até ${s.maxAutomatedPerDay} por dia.`],
                ["Mensagem", r.msg],
                ["Após 24 h", "Só com template aprovado; sem template, vira tarefa para a equipe."],
              ].map(([k, v]) => (
                <div key={k} className="grid grid-cols-[104px_1fr] gap-4 py-3">
                  <dt className="eyebrow pt-0.5 text-bone-mute">{k}</dt>
                  <dd className="t-small text-bone-dim">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardTitle hint="Valem imediatamente para os próximos envios.">Regras e limites</CardTitle>
          <ActionForm action={saveAutomationSettingsAction} className="flex flex-1 flex-col gap-5" resetOnDone={false}>
            <div className="grid gap-6 sm:grid-cols-2">
              <Checkbox name="followupsEnabled" defaultChecked={s.followupsEnabled} label="Follow-ups ativos" hint="Desmarque para pausar." />
              <Checkbox name="remindersEnabled" defaultChecked={s.remindersEnabled} label="Lembretes e confirmação ativos" hint="Desmarque para pausar." />
            </div>
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-6 [&>*]:sm:col-span-2 [&>*:nth-child(n+4)]:sm:col-span-3">
              <Field label="Follow-up 1 (horas)"><Input type="number" step="0.5" min="0.5" max="23" name="followup1Hours" defaultValue={s.followup1Hours} /></Field>
              <Field label="Follow-up 2 (horas)"><Input type="number" step="0.5" min="1" max="23.5" name="followup2Hours" defaultValue={s.followup2Hours} /></Field>
              <Field label="Máx. automáticas/dia"><Input type="number" min="1" max="10" name="maxAutomatedPerDay" defaultValue={s.maxAutomatedPerDay} /></Field>
              <Field label="Enviar a partir de (h)"><Input type="number" min="0" max="23" name="quietStartHour" defaultValue={s.quietStartHour} /></Field>
              <Field label="Enviar até (h)"><Input type="number" min="1" max="24" name="quietEndHour" defaultValue={s.quietEndHour} /></Field>
            </div>
            <Field label="Texto do follow-up 1"><Textarea name="followup1Text" defaultValue={s.followup1Text} className="min-h-16" /></Field>
            <Field label="Texto do follow-up 2"><Textarea name="followup2Text" defaultValue={s.followup2Text} className="min-h-16" /></Field>
            <div className="mt-auto flex justify-end border-t border-line pt-5"><Button type="submit">Salvar regras</Button></div>
          </ActionForm>
        </Card>
        <Card>
          <CardTitle hint="Fora da janela de 24 h o WhatsApp só aceita templates aprovados pela Meta. Crie o template com o mesmo nome no WhatsApp Manager e, quando aprovado, marque aqui.">Templates do WhatsApp</CardTitle>
          <ul className="space-y-6">
            {data.templates.map((t) => (
              <li key={t.id} className="rounded-md border border-line p-4">
                <div className="flex items-center justify-between gap-2"><code className="font-mono text-[13px] font-semibold">{t.name}</code><Badge tone={t.wa_template_status === "approved" ? "ok" : t.wa_template_status === "rejected" ? "danger" : "warn"}>{TEMPLATE_STATUS[t.wa_template_status]}</Badge></div>
                <p className="t-small mt-1">{TEMPLATE_USE[t.name] ?? ""}</p>
                <p className="mt-2 rounded-sm bg-surface-2 px-3 py-2.5 text-sm leading-relaxed">{t.body}</p>
                <div className="mt-3 flex justify-end">
                  <Modal trigger="Editar / atualizar situação" title={`Template ${t.name}`} triggerClass={buttonClass("outline", "sm")}>
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
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
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
        <Card>
          <CardTitle hint={`${data.counts?.pending ?? 0} na fila agora`}>Histórico de execuções</CardTitle>
          {data.jobs.length === 0 ? <Empty title="Nenhuma execução ainda" /> : (
            <Table head={["Automação", "Quando", "Situação"]}>
              {data.jobs.map((j) => (
                <tr key={j.id}>
                  <td className="max-w-[240px]"><p className="truncate">{JOB_LABEL[j.type] ?? j.type}</p><p className="t-small truncate" title={j.last_error ?? j.result ?? ""}>{j.last_error ?? j.result ?? "—"}{j.attempts > 1 ? ` · ${j.attempts} tentativas` : ""}</p></td><td className="whitespace-nowrap">{formatShort(j.run_at, ctx.tz)}</td>
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
