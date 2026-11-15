import Link from "next/link";
import { requireCtx, q } from "@/auth/session";
import { Bars, Stat } from "@/components/charts";
import { SubmitOnChange } from "@/components/client";
import { Card, CardTitle, Empty, Input, PageHeader, Select, Table, buttonClass } from "@/components/ui";
import { addDays, formatShort, localDate, WEEKDAY_LABELS } from "@/lib/datetime";
import { loadDashboard } from "@/services/dashboard";
import { Star, TrendingUp } from "lucide-react";
import { ActionForm, Modal } from "@/components/client";
import { GoogleShare } from "@/components/google-share";
import { Button, Field } from "@/components/ui";
import { can } from "@/domain/permissions";
import { PATIENT_SOURCE_LABELS, type PatientSource } from "@/domain/contact";
import { loadReviewHistory, qrDataUrl, reviewLink } from "@/services/google-reviews";
import { saveReviewSnapshotAction } from "../configuracoes/actions";

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
    const reviews = await loadReviewHistory(tx, 400);
    const sources = await tx<{ source: PatientSource | null; n: number }[]>`
      select source, count(*)::int as n from patients
      where merged_into_patient_id is null and created_at >= ${from}::date and created_at < ${to}::date + 1
      group by source order by n desc`;
    return { professionals, dash, tasks, professionalId, reviews, sources };
  });
  const d = data.dash;
  const reviews = data.reviews;
  const canManage = can(ctx.role, "settings.manage");
  const googleLink = reviewLink(ctx.clinic);
  const googleQr = googleLink ? await qrDataUrl(googleLink) : null;
  // Uma barra por mês (último registro de cada mês), até 12 meses.
  const MONTH = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const byMonth = new Map<string, number>();
  for (const pt of reviews.points) byMonth.set(pt.day.slice(0, 7), pt.count);
  const monthly = [...byMonth.entries()].slice(-12).map(([ym, count]) => ({ label: MONTH[Number(ym.slice(5)) - 1] ?? ym, hint: `${MONTH[Number(ym.slice(5)) - 1]}/${ym.slice(0, 4)}`, count }));
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

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card>
              <CardTitle hint="Nota e total de avaliações no Google Meu Negócio, mês a mês. Atualiza sozinho todo dia quando o Google está ligado; dá para registrar à mão."
                action={canManage ? (
                  <Modal trigger="Registrar números" title="Avaliações no Google" description="Copie a nota e o total que aparecem no seu perfil do Google." triggerClass={buttonClass("outline", "sm")}>
                    <ActionForm action={saveReviewSnapshotAction} className="space-y-5" resetOnDone={false}>
                      <div className="grid gap-4 sm:grid-cols-3">
                        <Field label="Data"><Input type="date" name="day" defaultValue={today} max={today} required /></Field>
                        <Field label="Total de avaliações"><Input type="number" name="count" min={0} defaultValue={reviews.latest?.count ?? ""} required /></Field>
                        <Field label="Nota (1 a 5)"><Input name="rating" inputMode="decimal" placeholder="4,8" defaultValue={reviews.latest?.rating?.toString().replace(".", ",") ?? ""} /></Field>
                      </div>
                      <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Salvar</Button></div>
                    </ActionForm>
                  </Modal>) : undefined}>
                Avaliações no Google
              </CardTitle>
              {reviews.points.length === 0 && !googleLink ? (
                <Empty title="Google Meu Negócio ainda não cadastrado" action={canManage ? <Link href="/configuracoes?aba=google" className={buttonClass("outline", "sm")}>Cadastrar o Google</Link> : undefined}>
                  Cadastre o link de avaliação para ganhar o QR code e acompanhar o crescimento das avaliações aqui.
                </Empty>
              ) : (
                <div className="flex flex-1 flex-col gap-6">
                  <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md bg-line/70">
                    {[
                      ["Nota", reviews.latest?.rating != null ? reviews.latest.rating.toFixed(1).replace(".", ",") : "—", <Star key="s" size={18} className="text-gold" aria-hidden />],
                      ["Avaliações", reviews.latest ? String(reviews.latest.count) : "—", null],
                      ["Últimos 30 dias", reviews.growth30 == null ? "—" : `${reviews.growth30 >= 0 ? "+" : ""}${reviews.growth30}`, <TrendingUp key="t" size={18} className="text-ok" aria-hidden />],
                    ].map(([k, v, icon]) => (
                      <div key={String(k)} className="flex flex-col justify-between gap-3 bg-surface/90 p-5">
                        <dt className="eyebrow text-bone-mute">{k}</dt>
                        <dd className="display num flex items-center gap-2 text-[30px] leading-none">{v}{icon}</dd>
                      </div>
                    ))}
                  </dl>
                  <Bars label="Total de avaliações no Google ao fim de cada mês" emptyText="Registre os números para ver o crescimento."
                    data={monthly.map((m) => ({ key: m.label, hint: m.hint, value: m.count }))} />
                  {googleLink && googleQr && <div className="border-t border-line pt-5"><GoogleShare reviewUrl={googleLink} profileUrl={ctx.clinic.google_business_url} qr={googleQr} clinicName={ctx.clinic.name} compact /></div>}
                </div>
              )}
            </Card>
            <Card>
              <CardTitle hint="Como os pacientes cadastrados no período conheceram a clínica (campo da ficha).">Origem dos pacientes</CardTitle>
              {data.sources.length === 0 ? <Empty title="Nenhum paciente novo no período" /> : (
                <ul className="space-y-3">
                  {data.sources.map((r) => {
                    const total = data.sources.reduce((a, b) => a + b.n, 0);
                    return (
                      <li key={r.source ?? "nd"}>
                        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13.5px]">
                          <span className={r.source === "google" ? "font-semibold" : ""}>{r.source ? PATIENT_SOURCE_LABELS[r.source] : "Não informado"}</span>
                          <span className="num text-bone-dim">{r.n} · {Math.round((r.n / total) * 100)}%</span>
                        </div>
                        <span className="block h-2 overflow-hidden rounded-full bg-bone/[0.06]"><span className={`block h-full rounded-full ${r.source ? "bg-acento" : "bg-bone-mute/40"}`} style={{ width: `${(r.n / total) * 100}%` }} /></span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="t-small mt-auto pt-5">Preencha “Como conheceu a clínica” no cadastro do paciente para este gráfico ficar completo.</p>
            </Card>
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
