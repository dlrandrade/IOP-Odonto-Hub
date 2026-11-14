import Link from "next/link";
import { requireCtx, q } from "@/auth/session";
import { Bars, Stat } from "@/components/charts";
import { SubmitOnChange } from "@/components/client";
import { Badge, Card, CardTitle, Empty, Input, PageHeader, Select, Table } from "@/components/ui";
import { can } from "@/domain/permissions";
import { addDays, formatShort, localDate, WEEKDAY_LABELS } from "@/lib/datetime";
import { brl } from "@/lib/format";
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
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Novos contatos" value={String(d.newContacts)} note="Telefones vistos pela primeira vez" />
            <Stat label="Conversas recebidas" value={String(d.conversations)} note="Conversas novas no período" />
            <Stat label="Consultas marcadas" value={String(d.appointmentsBooked)} note="Criadas no período (sem reagendamentos)" tone="sun" />
            {showFunnel && (
              <Stat tone="navy" label="Contato → avaliação" value={d.conversion.rate == null ? "—" : `${Math.round(d.conversion.rate * 100)}%`}
                note={`${d.conversion.converted} de ${d.conversion.eligible} em até 30 dias${d.conversion.partial ? " · coorte parcial" : ""}`} />
            )}
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardTitle hint="Mensagens recebidas de pacientes, por hora local">Horários de maior movimento</CardTitle>
              <Bars label="Mensagens recebidas por hora do dia" data={d.byHour.filter((h) => h.hour >= 6 && h.hour <= 22).map((h) => ({ key: `${h.hour}h`, value: h.total }))} />
            </Card>
            <Card>
              <CardTitle hint="Mensagens recebidas por dia da semana">Dias de maior movimento</CardTitle>
              <Bars label="Mensagens recebidas por dia da semana" data={d.byWeekday.map((w) => ({ key: WEEKDAY_LABELS[w.weekday]!.slice(0, 3), hint: WEEKDAY_LABELS[w.weekday], value: w.total }))} />
            </Card>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardTitle hint="Consultas com início no período. A lista é alfabética: volume sozinho não mede desempenho.">Consultas por profissional</CardTitle>
              {d.byProfessional.length === 0 ? <Empty title="Sem consultas no período" /> : (
                <Table head={["Profissional", "Consultas", "Compareceram", "Faltas"]}>
                  {d.byProfessional.map((p) => (
                    <tr key={p.professional}><td className="font-medium">{p.professional}</td><td>{p.total}</td><td>{p.attended}</td><td>{p.noShow}</td></tr>
                  ))}
                </Table>
              )}
              <p className="mt-3 text-xs text-bone-mute">
                Desfechos no período: {d.attendance.attended} compareceram · {d.attendance.noShow} faltaram · {d.attendance.cancelled} canceladas · {d.attendance.pending} passadas sem desfecho registrado.
              </p>
            </Card>
            <div className="space-y-3">
              <Card>
                <CardTitle hint="Mediana da primeira resposta em conversas novas">Tempo de primeira resposta</CardTitle>
                <dl className="space-y-2 text-sm">
                  {[["Assistente virtual", d.firstResponse.ai], ["Equipe", d.firstResponse.human], ["Fora do expediente", d.firstResponse.afterHours]].map(([k, v]) => (
                    <div key={String(k)} className="flex items-center justify-between"><dt className="text-bone-mute">{k}</dt><dd className="font-semibold">{duration(v as number | null)}</dd></div>
                  ))}
                </dl>
                <p className="mt-2 text-[11px] text-bone-mute">{d.firstResponse.samples} conversa(s) respondida(s) no período.</p>
              </Card>
              <Card>
                <CardTitle action={<Link href="/conversas?f=nao-atribuidas" className="text-xs font-semibold underline">Abrir fila</Link>}>Fila humana agora</CardTitle>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={d.queue.urgent ? "danger" : "neutral"}>{d.queue.urgent} urgentes</Badge>
                  <Badge tone={d.queue.awaiting ? "warn" : "neutral"}>{d.queue.awaiting} aguardando</Badge>
                  <Badge>{d.queue.humanActive} com a equipe</Badge>
                  <Badge>{d.queue.aiActive} com a IA</Badge>
                </div>
                {can(ctx.role, "audit.view") && <p className="mt-3 text-xs text-bone-mute">Custo estimado de IA no período: {brl(Math.round(d.aiCostCents))} (referência em USD convertida 1:1; ver Configurações).</p>}
              </Card>
            </div>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Card>
              <CardTitle hint="Geradas por automações que precisam de uma pessoa">Tarefas abertas ({d.queue.openTasks})</CardTitle>
              {data.tasks.length === 0 ? <Empty title="Nenhuma tarefa pendente" /> : (
                <ul className="divide-y divide-line">
                  {data.tasks.map((t) => (
                    <li key={t.id} className="flex items-start justify-between gap-3 py-2.5">
                      <div className="min-w-0"><p className="truncate font-medium">{t.title}</p><p className="truncate text-xs text-bone-mute">{t.detail}</p></div>
                      {t.conversation_id ? <Link className="shrink-0 text-xs font-semibold underline" href={`/conversas?c=${t.conversation_id}`}>Abrir</Link>
                        : <Link className="shrink-0 text-xs font-semibold underline" href="/automacoes">Ver</Link>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <CardTitle>Como cada número é calculado</CardTitle>
              <dl className="space-y-2 text-xs text-bone-dim">
                <div><dt className="font-semibold">Novo contato</dt><dd>Telefone visto pela primeira vez na clínica no período. Não mede pacientes únicos. Exclui testes, simulador e contatos marcados como spam/fornecedor.</dd></div>
                <div><dt className="font-semibold">Conversão</dt><dd>Contatos novos da coorte com ao menos uma avaliação agendada em até 30 dias ÷ contatos novos elegíveis. Coortes com menos de 30 dias aparecem como parciais.</dd></div>
                <div><dt className="font-semibold">Consultas marcadas</dt><dd>Consultas criadas no período; a nova consulta de um reagendamento não é contada de novo.</dd></div>
                <div><dt className="font-semibold">Primeira resposta</dt><dd>Primeira mensagem de uma conversa nova → primeira resposta da IA ou da equipe (mediana).</dd></div>
                <div><dt className="font-semibold">Origem</dt><dd>Views SQL <code>v_contact_cohort</code>, <code>v_appointment_facts</code> e <code>v_first_response</code>; os totais conciliam com as tabelas.</dd></div>
              </dl>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
