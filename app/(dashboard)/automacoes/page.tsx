import Link from "next/link";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, Modal } from "@/components/client";
import { Badge, Button, Card, CardTitle, Checkbox, Empty, Field, Input, Notice, PageHeader, Select, Table, Textarea } from "@/components/ui";
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
      {(data.counts?.failed ?? 0) > 0 && <div className="mb-3"><Notice tone="danger">{data.counts!.failed} automação(ões) falharam nos últimos 7 dias. Veja o histórico abaixo; cada falha virou uma tarefa para a equipe.</Notice></div>}
      <div className="grid gap-3 lg:grid-cols-2">
        {rules.map((r) => (
          <Card key={r.name}>
            <CardTitle action={<Badge tone={r.on ? "ok" : "warn"}>{r.on ? "Ativa" : "Pausada"}</Badge>}>{r.name}</CardTitle>
            <dl className="space-y-1.5 text-sm">
              <div><dt className="inline font-semibold">Finalidade: </dt><dd className="inline text-bone-dim">{r.purpose}</dd></div>
              <div><dt className="inline font-semibold">Gatilho: </dt><dd className="inline text-bone-dim">{r.trigger}</dd></div>
              <div><dt className="inline font-semibold">Elegibilidade: </dt><dd className="inline text-bone-dim">sem resposta nova, sem descadastro, conversa não assumida por humano, dentro de {s.quietStartHour}h–{s.quietEndHour}h, até {s.maxAutomatedPerDay} envio(s) automático(s) por dia.</dd></div>
              <div><dt className="inline font-semibold">Mensagem: </dt><dd className="inline text-bone-dim">{r.msg}</dd></div>
              <div><dt className="inline font-semibold">Fora da janela de 24 h: </dt><dd className="inline text-bone-dim">só template aprovado; sem template, vira tarefa humana.</dd></div>
            </dl>
          </Card>
        ))}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardTitle hint="Valem imediatamente para os próximos envios.">Regras e limites</CardTitle>
          <ActionForm action={saveAutomationSettingsAction} className="space-y-4" resetOnDone={false}>
            <div className="grid gap-2 sm:grid-cols-2">
              <Checkbox name="followupsEnabled" defaultChecked={s.followupsEnabled} label="Follow-ups ativos" hint="Desmarque para pausar." />
              <Checkbox name="remindersEnabled" defaultChecked={s.remindersEnabled} label="Lembretes e confirmação ativos" hint="Desmarque para pausar." />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Follow-up 1 (horas)"><Input type="number" step="0.5" min="0.5" max="23" name="followup1Hours" defaultValue={s.followup1Hours} /></Field>
              <Field label="Follow-up 2 (horas)"><Input type="number" step="0.5" min="1" max="23.5" name="followup2Hours" defaultValue={s.followup2Hours} /></Field>
              <Field label="Máx. automáticas/dia"><Input type="number" min="1" max="10" name="maxAutomatedPerDay" defaultValue={s.maxAutomatedPerDay} /></Field>
              <Field label="Enviar a partir de (h)"><Input type="number" min="0" max="23" name="quietStartHour" defaultValue={s.quietStartHour} /></Field>
              <Field label="Enviar até (h)"><Input type="number" min="1" max="24" name="quietEndHour" defaultValue={s.quietEndHour} /></Field>
            </div>
            <Field label="Texto do follow-up 1"><Textarea name="followup1Text" defaultValue={s.followup1Text} className="min-h-16" /></Field>
            <Field label="Texto do follow-up 2"><Textarea name="followup2Text" defaultValue={s.followup2Text} className="min-h-16" /></Field>
            <Button type="submit">Salvar regras</Button>
          </ActionForm>
        </Card>
        <Card>
          <CardTitle hint="Fora da janela de 24 h o WhatsApp só aceita templates aprovados pela Meta. Crie o template com o mesmo nome no WhatsApp Manager e, quando aprovado, marque aqui.">Templates do WhatsApp</CardTitle>
          <ul className="space-y-3">
            {data.templates.map((t) => (
              <li key={t.id} className="rounded-2xl border border-line p-3">
                <div className="flex items-center justify-between gap-2"><code className="text-sm font-semibold">{t.name}</code><Badge tone={t.wa_template_status === "approved" ? "ok" : t.wa_template_status === "rejected" ? "danger" : "warn"}>{TEMPLATE_STATUS[t.wa_template_status]}</Badge></div>
                <p className="mt-1 text-xs text-bone-mute">{TEMPLATE_USE[t.name] ?? ""}</p>
                <p className="mt-2 rounded-xl bg-surface-2 px-3 py-2 text-sm">{t.body}</p>
                <div className="mt-2 text-right">
                  <Modal trigger="Editar / atualizar situação" title={`Template ${t.name}`} triggerClass="text-xs font-semibold underline">
                    <ActionForm action={saveTemplateAction} className="space-y-4" resetOnDone={false}>
                      <input type="hidden" name="templateId" value={t.id} />
                      <Field label="Texto (igual ao aprovado na Meta)" hint="Variáveis: {{1}} paciente, {{2}} serviço, {{3}} dentista, {{4}} data completa."><Textarea name="body" defaultValue={t.body} /></Field>
                      <Field label="Situação na Meta"><Select name="status" defaultValue={t.wa_template_status}>{Object.entries(TEMPLATE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
                      <Button type="submit">Salvar</Button>
                    </ActionForm>
                  </Modal>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card>
          <CardTitle hint="Quando a automação não pode agir sozinha, ela pede uma pessoa.">Tarefas para a equipe ({data.tasks.length})</CardTitle>
          {data.tasks.length === 0 ? <Empty title="Nada pendente" /> : (
            <ul className="divide-y divide-line">
              {data.tasks.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0"><p className="font-medium">{t.title}</p><p className="text-xs text-bone-mute">{t.detail} · {formatShort(t.created_at, ctx.tz)}</p></div>
                  <div className="flex shrink-0 items-center gap-2">
                    {t.conversation_id && <Link href={`/conversas?c=${t.conversation_id}`} className="text-xs font-semibold underline">Conversa</Link>}
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
            <Table head={["Tipo", "Quando", "Situação", "Resultado"]}>
              {data.jobs.map((j) => (
                <tr key={j.id}>
                  <td>{JOB_LABEL[j.type] ?? j.type}</td><td className="whitespace-nowrap">{formatShort(j.run_at, ctx.tz)}</td>
                  <td><Badge tone={j.status === "done" ? "ok" : j.status === "failed" ? "danger" : j.status === "cancelled" ? "neutral" : "warn"}>{{ pending: "na fila", running: "rodando", done: "feito", failed: "falhou", cancelled: "cancelado" }[j.status] ?? j.status}</Badge></td>
                  <td className="max-w-48 truncate text-xs text-bone-mute" title={j.last_error ?? j.result ?? ""}>{j.last_error ?? j.result ?? "—"}{j.attempts > 1 ? ` (${j.attempts} tent.)` : ""}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
