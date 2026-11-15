import Link from "next/link";
import { requireCtx, q } from "@/auth/session";
import { Bars, Stat } from "@/components/charts";
import { SubmitOnChange } from "@/components/client";
import { Card, CardTitle, Empty, Input, PageHeader, Select, Table, buttonClass } from "@/components/ui";
import { addDays, formatShort, localDate, WEEKDAY_LABELS } from "@/lib/datetime";
import { loadDashboard } from "@/services/dashboard";

export const metadata = { title: "Indicadores" };

function duration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1).replace(".", ",")} h`;
}

export default async function IndicatorsPage({ searchParams }: { searchParams: Promise<{ de?: string; ate?: string; prof?: string }> }) {
  const ctx = await requireCtx("dashboard.view");
  const sp = await searchParams;
  const today = localDate(new Date(), ctx.tz);
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const from = isDate(sp.de) ? sp.de! : addDays(today, -29);
  const to = isDate(sp.ate) ? sp.ate! : today;

  const data = await q(ctx, async (tx) => {
    const professionals = await tx<{ id: string; name: string }[]>`select id, name from professionals where active order by name`;
    // Dentista enxerga apenas os próprios números.
    const [own] = ctx.role === "dentista" && ctx.userId ? await tx<{ id: string }[]>`select id from professionals where app_user_id = ${ctx.userId}` : [];
    const professionalId = ctx.role === "dentista" ? own?.id ?? "00000000-0000-0000-0000-000000000000" : professionals.find((p) => p.id === sp.prof)?.id ?? null;
    const dash = await loadDashboard(tx, { clinicId: ctx.clinicId, tz: ctx.tz, from, to, professionalId });
    const tasks = await tx<{ id: string; title: string; detail: string | null; conversation_id: string | null; created_at: Date }[]>`
      select id, title, detail, conversation_id, created_at from tasks where status = 'open' order by created_at desc limit 6`;
    return { professionals, dash, tasks, professionalId };
  });
  const d = data.dash;
  const showFunnel = ["admin", "gestor", "comercial", "recepcao"].includes(ctx.role);
  const financeOnly = ctx.role === "financeiro";

  return (
    <>
      <PageHeader title="Indicadores" subtitle={`Fuso ${ctx.tz} · atualizado em ${formatShort(d.updatedAt, ctx.tz)}. Cada número tem a memória de cálculo no final da página.`}>
        <SubmitOnChange className="flex flex-wrap items-center gap-2">
          <Input type="date" name="de" defaultValue={from} max={to} aria-label="De" className="w-auto" />
          <Input type="date" name="ate" defaultValue={to} aria-label="Até" className="w-auto" />
          {ctx.role !== "dentista" && (
            <Select name="prof" defaultValue={data.professionalId ?? ""} aria-label="Profissional" className="w-auto">
              <option value="">Todos os profissionais</option>
              {data.professionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}
        </SubmitOnChange>
      </PageHeader>

      {financeOnly ? (
        <Empty title="Indicadores financeiros chegam com o módulo de pagamentos (P1)">Por enquanto, seu acesso é ao cadastro de pacientes.</Empty>
      ) : (
        <div className="space-y-6">
          <div className={`grid gap-6 sm:grid-cols-2 ${showFunnel ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
            <Stat label="Novos contatos" value={String(d.newContacts)} note="Telefones vistos pela 1ª vez" />
            <Stat label="Conversas recebidas" value={String(d.conversations)} note="Conversas novas no período" />
            <Stat label="Consultas marcadas" value={String(d.appointmentsBooked)} note="Criadas no período" tone="sun" />
            {showFunnel && (
              <Stat tone="navy" label="Contato → avaliação" value={d.conversion.rate == null ? "—" : `${Math.round(d.conversion.rate * 100)}%`}
                note={`${d.conversion.converted} de ${d.conversion.eligible} em 30 dias${d.conversion.partial ? " · parcial" : ""}`} />
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardTitle hint="Mensagens de pacientes por hora do dia (horário da clínica).">Horários de maior movimento</CardTitle>
              <Bars label="Mensagens recebidas por hora do dia" data={d.byHour.filter((h) => h.hour >= 7 && h.hour <= 20).map((h) => ({ key: `${h.hour}`, hint: `${h.hour}h`, value: h.total }))} />
            </Card>
            <Card>
              <CardTitle hint="Mensagens de pacientes por dia da semana.">Dias de maior movimento</CardTitle>
              <Bars label="Mensagens recebidas por dia da semana" data={d.byWeekday.map((w) => ({ key: WEEKDAY_LABELS[w.weekday]!.slice(0, 3), hint: WEEKDAY_LABELS[w.weekday], value: w.total }))} />
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardTitle hint="Consultas com início no período, em ordem alfabética. Volume sozinho não mede desempenho.">Consultas por profissional</CardTitle>
              {d.byProfessional.length === 0 ? <Empty title="Sem consultas no período" /> : (
                <Table head={["Profissional", "Consultas", "Vieram", "Faltaram"]}>
                  {d.byProfessional.map((p) => (
                    <tr key={p.professional}><td className="font-medium">{p.professional}</td><td className="num">{p.total}</td><td className="num">{p.attended}</td><td className="num">{p.noShow}</td></tr>
                  ))}
                </Table>
              )}
              <p className="t-small mt-auto border-t border-line pt-4">
                No período: {d.attendance.attended} vieram, {d.attendance.noShow} faltaram, {d.attendance.cancelled} foram canceladas e {d.attendance.pending} já passaram sem registro de presença.
              </p>
            </Card>
            <Card>
              <CardTitle hint="Mediana do tempo até a primeira resposta em conversas novas." action={<Link href="/conversas?f=nao-atribuidas" className={buttonClass("outline", "sm")}>Abrir fila</Link>}>Tempo de resposta e fila</CardTitle>
              <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md bg-line">
                {[["Assistente", d.firstResponse.ai], ["Equipe", d.firstResponse.human], ["À noite", d.firstResponse.afterHours]].map(([k, v]) => (
                  <div key={String(k)} className="flex min-h-[104px] flex-col justify-between gap-3 bg-surface p-5">
                    <dt className="eyebrow text-bone-mute">{k}</dt>
                    <dd className="display num text-[28px] leading-none">{duration(v as number | null)}</dd>
                  </div>
                ))}
              </dl>
              <p className="t-small mb-5 mt-3">{d.firstResponse.samples} conversa{d.firstResponse.samples === 1 ? "" : "s"} respondida{d.firstResponse.samples === 1 ? "" : "s"} no período.</p>
              <dl className="mt-auto grid grid-cols-4 gap-px overflow-hidden rounded-md bg-line">
                {[["Urgentes", d.queue.urgent, d.queue.urgent ? "text-danger" : ""], ["Esperando", d.queue.awaiting, d.queue.awaiting ? "text-gold" : ""], ["Com a equipe", d.queue.humanActive, ""], ["Com a IA", d.queue.aiActive, ""]].map(([k, v, c]) => (
                  <div key={String(k)} className="flex flex-col gap-2 bg-surface px-4 py-3">
                    <dt className="t-small truncate">{k}</dt>
                    <dd className={`display num text-[22px] leading-none ${c}`}>{v}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="simples:lg:col-span-2">
              <CardTitle hint="Criadas pelas automações quando precisam de uma pessoa." action={<Link className={buttonClass("outline", "sm")} href="/automacoes">Ver todas</Link>}>Tarefas abertas ({d.queue.openTasks})</CardTitle>
              {data.tasks.length === 0 ? <Empty title="Nenhuma tarefa pendente" /> : (
                <ul className="divide-y divide-line">
                  {data.tasks.map((t) => (
                    <li key={t.id} className="flex min-h-14 items-center justify-between gap-4 py-2">
                      <div className="min-w-0"><p className="t-h3 truncate">{t.title}</p><p className="t-small truncate">{t.detail}</p></div>
                      {t.conversation_id && <Link className={buttonClass("ghost", "sm")} href={`/conversas?c=${t.conversation_id}`}>Abrir</Link>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card className="simples:hidden">
              <CardTitle hint="Todos os números saem das tabelas por SQL e conciliam com os registros.">Como cada número é calculado</CardTitle>
              <dl className="divide-y divide-line">
                {[
                  ["Novo contato", "Telefone visto pela primeira vez na clínica. Exclui simulador, testes, spam e fornecedores."],
                  ["Conversão", "Contatos novos com avaliação agendada em até 30 dias ÷ contatos novos. Períodos recentes são parciais."],
                  ["Consultas marcadas", "Criadas no período. A consulta nova de uma remarcação não conta duas vezes."],
                  ["Primeira resposta", "Da primeira mensagem do paciente até a primeira resposta da assistente ou da equipe."],
                  ["Gasto com IA", `US$ ${(d.aiCostCents / 100).toFixed(2).replace(".", ",")} no período, estimado pelos tokens de cada atendimento.`],
                ].map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[140px_1fr] gap-4 py-3">
                    <dt className="t-h3 text-[13.5px]">{k}</dt>
                    <dd className="t-small text-bone-dim">{v}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
