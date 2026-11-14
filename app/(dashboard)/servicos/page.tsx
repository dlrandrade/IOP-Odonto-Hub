import Link from "next/link";
import { Plus } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, Modal } from "@/components/client";
import { Badge, Button, buttonClass, Card, Checkbox, Empty, Field, Input, Notice, PageHeader, Select, Table, Textarea } from "@/components/ui";
import { brl, cn } from "@/lib/format";
import { formatShort } from "@/lib/datetime";
import { saveDocAction, saveServiceAction } from "./actions";

export const metadata = { title: "Serviços e conhecimento" };

type Service = {
  id: string; name: string; specialty: string | null; kind: string; duration_min: number; buffer_min: number; price_mode: string; price_min_cents: number | null; price_max_cents: number | null;
  bookable_directly: boolean; leads_to_evaluation_service_id: string | null; patient_description: string | null; preparation: string | null; status: string; version: number; is_demo: boolean;
  approver: string | null; approved_at: Date | null; professional_ids: string[];
};
const KIND: Record<string, string> = { evaluation: "Avaliação", procedure: "Procedimento", return: "Retorno" };
const money = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));

function price(s: Service): string {
  if (s.price_mode === "fixed") return brl(s.price_min_cents);
  if (s.price_mode === "range") return `${brl(s.price_min_cents)} – ${brl(s.price_max_cents)}`;
  return "Sob avaliação";
}

export default async function ServicesPage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const ctx = await requireCtx("catalog.publish");
  const tab = (await searchParams).aba === "conhecimento" ? "conhecimento" : "servicos";
  const data = await q(ctx, async (tx) => ({
    services: await tx<Service[]>`
      select s.id, s.name, s.specialty, s.kind, s.duration_min, s.buffer_min, s.price_mode, s.price_min_cents, s.price_max_cents, s.bookable_directly, s.leads_to_evaluation_service_id,
             s.patient_description, s.preparation, s.status, s.version, s.is_demo, u.name as approver, s.approved_at,
             coalesce((select array_agg(sp.professional_id) from service_professionals sp where sp.service_id = s.id), '{}') as professional_ids
      from services s left join app_users u on u.id = s.approved_by order by s.kind, s.name`,
    professionals: await tx<{ id: string; name: string }[]>`select id, name from professionals where active order by name`,
    docs: await tx<{ id: string; title: string; body: string; status: string; version: number; approver: string | null; approved_at: Date | null; updated_at: Date; versions: number }[]>`
      select d.id, d.title, d.body, d.status, d.version, u.name as approver, d.approved_at, d.updated_at,
             (select count(*)::int from knowledge_doc_versions v where v.doc_id = d.id) as versions
      from knowledge_docs d left join app_users u on u.id = d.approved_by order by d.title`,
  }));
  const evaluations = data.services.filter((s) => s.kind === "evaluation");

  const ServiceForm = ({ s }: { s?: Service }) => (
    <ActionForm action={saveServiceAction} className="space-y-4" resetOnDone={!s}>
      {s && <input type="hidden" name="serviceId" value={s.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome"><Input name="name" defaultValue={s?.name} required /></Field>
        <Field label="Especialidade"><Input name="specialty" defaultValue={s?.specialty ?? ""} /></Field>
        <Field label="Tipo"><Select name="kind" defaultValue={s?.kind ?? "procedure"}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Duração (min)"><Input type="number" name="duration" min={5} defaultValue={s?.duration_min ?? 30} required /></Field>
          <Field label="Intervalo (min)"><Input type="number" name="buffer" min={0} defaultValue={s?.buffer_min ?? 0} /></Field>
        </div>
      </div>
      <fieldset className="rounded-2xl border border-line p-3">
        <legend className="px-1 text-xs font-semibold">Preço que a assistente pode informar</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Modo"><Select name="priceMode" defaultValue={s?.price_mode ?? "on_evaluation"}><option value="on_evaluation">Sob avaliação</option><option value="fixed">Valor fixo</option><option value="range">Faixa</option></Select></Field>
          <Field label="Valor / mínimo (R$)"><Input name="priceMin" inputMode="decimal" defaultValue={money(s?.price_min_cents ?? null)} placeholder="0,00" /></Field>
          <Field label="Máximo (R$)"><Input name="priceMax" inputMode="decimal" defaultValue={money(s?.price_max_cents ?? null)} placeholder="só para faixa" /></Field>
        </div>
        <p className="mt-2 text-[11px] text-bone-mute">Sem preço cadastrado, a assistente diz que depende de avaliação. Ela nunca inventa valor nem oferece desconto.</p>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Checkbox name="bookable" defaultChecked={s?.bookable_directly ?? false} label="Agenda direto pela assistente" hint="Indicado para avaliação, limpeza e retorno." />
        <Field label="Se não agenda direto, leva à avaliação"><Select name="leadsTo" defaultValue={s?.leads_to_evaluation_service_id ?? evaluations[0]?.id ?? ""}><option value="">—</option>{evaluations.filter((e) => e.id !== s?.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
      </div>
      <Field label="Descrição para o paciente (texto aprovado)" hint="É o único texto que a assistente usa para explicar o serviço. Não prometa resultado nem ausência de dor."><Textarea name="description" defaultValue={s?.patient_description ?? ""} /></Field>
      <Field label="Preparo / orientações administrativas"><Textarea name="preparation" defaultValue={s?.preparation ?? ""} className="min-h-16" /></Field>
      <fieldset>
        <legend className="mb-1 text-xs font-semibold text-bone-dim">Dentistas habilitados</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {data.professionals.map((p) => <Checkbox key={p.id} name="professionals" value={p.id} label={p.name} defaultChecked={s ? s.professional_ids.includes(p.id) : true} />)}
          {data.professionals.length === 0 && <p className="text-xs text-bone-mute">Cadastre dentistas em Configurações → Agenda.</p>}
        </div>
      </fieldset>
      <Field label="Situação" hint="Publicado vale já na próxima resposta da assistente, sem retreinar."><Select name="status" defaultValue={s?.status ?? "draft"}><option value="draft">Rascunho</option><option value="published">Publicado</option></Select></Field>
      <Button type="submit">Salvar</Button>
    </ActionForm>
  );

  return (
    <>
      <PageHeader title="Serviços e conhecimento" subtitle="Tudo o que a assistente pode dizer sai daqui: catálogo, preços e textos aprovados.">
        {tab === "servicos" ? (
          <Modal trigger={<><Plus size={15} aria-hidden /> Novo serviço</>} title="Novo serviço" wide triggerClass={buttonClass("accent")}><ServiceForm /></Modal>
        ) : (
          <Modal trigger={<><Plus size={15} aria-hidden /> Novo documento</>} title="Novo documento" wide triggerClass={buttonClass("accent")}>
            <ActionForm action={saveDocAction} className="space-y-4">
              <Field label="Título"><Input name="title" required placeholder="Ex.: Formas de pagamento" /></Field>
              <Field label="Conteúdo"><Textarea name="body" className="min-h-40" /></Field>
              <Field label="Situação"><Select name="status" defaultValue="draft"><option value="draft">Rascunho</option><option value="published">Publicado</option></Select></Field>
              <Button type="submit">Salvar</Button>
            </ActionForm>
          </Modal>
        )}
      </PageHeader>
      <div className="mb-3 inline-flex rounded-full bg-surface p-1 border border-line">
        {[["servicos", "Serviços"], ["conhecimento", "Base de conhecimento"]].map(([k, label]) => (
          <Link key={k} href={k === "servicos" ? "/servicos" : "/servicos?aba=conhecimento"} className={cn("rounded-full px-4 py-1.5 text-sm font-medium", tab === k ? "bg-acento text-ink" : "text-bone-dim")}>{label}</Link>
        ))}
      </div>
      {ctx.clinic.is_demo && <div className="mb-3"><Notice tone="sun">Clínica de demonstração: preços e textos são <strong>fictícios</strong>.</Notice></div>}

      {tab === "servicos" ? (
        <Card>
          {data.services.length === 0 ? <Empty title="Nenhum serviço cadastrado" /> : (
            <Table head={["Serviço", "Tipo", "Duração", "Preço informável", "Agendamento", "Situação", ""]}>
              {data.services.map((s) => (
                <tr key={s.id}>
                  <td><p className="font-semibold">{s.name}{s.is_demo && <span className="ml-1 text-[10px] font-normal text-bone-mute">(demo)</span>}</p><p className="text-[11px] text-bone-mute">{s.specialty ?? "—"} · {s.professional_ids.length} dentista(s)</p></td>
                  <td>{KIND[s.kind]}</td>
                  <td>{s.duration_min} min{s.buffer_min ? ` +${s.buffer_min}` : ""}</td>
                  <td>{price(s)}</td>
                  <td>{s.bookable_directly ? <Badge tone="ok">direto</Badge> : <Badge>via avaliação</Badge>}</td>
                  <td><Badge tone={s.status === "published" ? "navy" : "warn"}>{s.status === "published" ? "Publicado" : "Rascunho"}</Badge><p className="mt-0.5 text-[10px] text-bone-mute">v{s.version}{s.approver ? ` · ${s.approver.split(" ")[0]}` : ""}</p></td>
                  <td className="text-right"><Modal trigger="Editar" title={`Editar: ${s.name}`} wide triggerClass="text-xs font-semibold underline"><ServiceForm s={s} /></Modal></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {data.docs.length === 0 && <Empty title="Nenhum documento" />}
          {data.docs.map((d) => (
            <Card key={d.id}>
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold">{d.title}</h2>
                <Badge tone={d.status === "published" ? "navy" : "warn"}>{d.status === "published" ? "Publicado" : "Rascunho"}</Badge>
              </div>
              <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm text-bone-dim">{d.body || <span className="text-bone-mute">Sem conteúdo ainda. A assistente não responde sobre este tema até você publicar.</span>}</p>
              <div className="mt-3 flex items-center justify-between text-[11px] text-bone-mute">
                <span>v{d.version} · {d.versions} versão(ões) no histórico · {formatShort(d.updated_at, ctx.tz)}{d.approver ? ` · aprovado por ${d.approver.split(" ")[0]}` : ""}</span>
                <Modal trigger="Editar" title={`Editar: ${d.title}`} wide triggerClass="text-xs font-semibold text-bone underline">
                  <ActionForm action={saveDocAction} className="space-y-4" resetOnDone={false}>
                    <input type="hidden" name="docId" value={d.id} />
                    <Field label="Título"><Input name="title" defaultValue={d.title} required /></Field>
                    <Field label="Conteúdo" hint="Texto administrativo aprovado: endereço, horários, pagamento, convênios, acessibilidade."><Textarea name="body" defaultValue={d.body} className="min-h-48" /></Field>
                    <Field label="Situação"><Select name="status" defaultValue={d.status}><option value="draft">Rascunho</option><option value="published">Publicado</option></Select></Field>
                    <Button type="submit">Salvar nova versão</Button>
                  </ActionForm>
                </Modal>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
