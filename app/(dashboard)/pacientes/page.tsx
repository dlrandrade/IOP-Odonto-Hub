import Link from "next/link";
import { ChevronDown, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, Modal } from "@/components/client";
import { Avatar, Badge, Button, buttonClass, Card, Empty, Field, Input, PageHeader, Select, Table, Textarea } from "@/components/ui";
import { OPPORTUNITY_STAGE_LABELS, type OpportunityStage } from "@/domain/states";
import { can } from "@/domain/permissions";
import { formatShort } from "@/lib/datetime";
import { formatPhone } from "@/lib/format";
import { savePatientAction } from "./actions";

export const metadata = { title: "Pacientes" };

const FILTER_KEYS = ["q", "prof", "svc", "sit", "ultDe", "ultAte", "proxDe", "proxAte", "cadDe", "cadAte", "aniv", "idMin", "idMax", "resp", "crm", "ord"] as const;
type Filters = Partial<Record<(typeof FILTER_KEYS)[number], string>>;
const SITUATION: Record<string, string> = {
  futura: "Com consulta marcada", sem_futura: "Sem consulta marcada", nunca: "Nunca consultou", faltou: "Já faltou", sumido: "Sem vir há 6 meses ou mais",
};
const ORDER: Record<string, string> = { nome: "Nome (A–Z)", proxima: "Próxima consulta", ultima: "Última consulta", recentes: "Cadastrados por último" };
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const isDate = (v?: string): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const int = (v?: string) => (v && /^\d{1,3}$/.test(v) ? Number(v) : null);

/** Entende "15/03", "15/03/1985" ou "1985-03-15" digitados na busca geral. */
function parseTypedDate(v: string): { day: number; month: number; year: number | null } | null {
  const br = v.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (br) {
    const year = br[3] ? Number(br[3].length === 2 ? `19${br[3]}` : br[3]) : null;
    return { day: Number(br[1]), month: Number(br[2]), year };
  }
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return iso ? { day: Number(iso[3]), month: Number(iso[2]), year: Number(iso[1]) } : null;
}

export default async function PatientsPage({ searchParams }: { searchParams: Promise<Filters & { p?: string; novo?: string }> }) {
  const ctx = await requireCtx("patients.view");
  const sp = await searchParams;
  const f: Filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, (sp[k] ?? "").trim().slice(0, 80)]).filter(([, v]) => v));
  // Parâmetros da URL são entrada externa: descarta o que não for válido em vez de quebrar a consulta.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (f.prof && !UUID.test(f.prof)) delete f.prof;
  if (f.svc && !UUID.test(f.svc)) delete f.svc;
  if (f.sit && !(f.sit in SITUATION)) delete f.sit;
  if (f.crm && !(f.crm in OPPORTUNITY_STAGE_LABELS)) delete f.crm;
  if (f.ord && !(f.ord in ORDER)) delete f.ord;
  if (f.resp && !["menor", "varios"].includes(f.resp)) delete f.resp;
  if (f.aniv && !(int(f.aniv)! >= 1 && int(f.aniv)! <= 12)) delete f.aniv;
  const search = f.q ?? "";
  const page = Math.max(1, Number(sp.p) || 1);
  const SIZE = 30;
  const { rows, total, professionals, services } = await q(ctx, async (tx) => {
    const [own] = ctx.role === "dentista" && ctx.userId ? await tx<{ id: string }[]>`select id from professionals where app_user_id = ${ctx.userId}` : [];
    const like = `%${search}%`;
    const digits = search.replace(/\D/g, "");
    const typed = parseTypedDate(search);
    const conds = [
      // Busca geral: nome, apelido do WhatsApp, telefone (só os números), observações, serviço já feito ou data de nascimento.
      search ? tx`and (p.full_name ilike ${like} or p.notes ilike ${like}
        or exists (select 1 from contact_patient_links l join contacts ct on ct.id = l.contact_id where l.patient_id = p.id
                   and (ct.wa_profile_name ilike ${like} ${digits.length >= 3 ? tx`or regexp_replace(ct.phone_e164, '\D', '', 'g') like ${`%${digits}%`}` : tx``}))
        or exists (select 1 from appointments a join services s on s.id = a.service_id where a.patient_id = p.id and s.name ilike ${like})
        ${typed ? tx`or (extract(day from p.birth_date) = ${typed.day} and extract(month from p.birth_date) = ${typed.month} ${typed.year ? tx`and extract(year from p.birth_date) = ${typed.year}` : tx``})` : tx``})` : tx``,
      f.prof ? tx`and exists (select 1 from appointments a where a.patient_id = p.id and a.professional_id = ${f.prof}::uuid)` : tx``,
      f.svc ? tx`and exists (select 1 from appointments a where a.patient_id = p.id and a.service_id = ${f.svc}::uuid and a.status <> 'cancelled')` : tx``,
      f.sit === "futura" ? tx`and next_at is not null` : tx``,
      f.sit === "sem_futura" ? tx`and next_at is null` : tx``,
      f.sit === "nunca" ? tx`and last_at is null` : tx``,
      f.sit === "faltou" ? tx`and exists (select 1 from appointments a where a.patient_id = p.id and a.status = 'no_show')` : tx``,
      f.sit === "sumido" ? tx`and next_at is null and last_at < now() - interval '6 months'` : tx``,
      isDate(f.ultDe) ? tx`and last_at >= ${f.ultDe}::date` : tx``,
      isDate(f.ultAte) ? tx`and last_at < ${f.ultAte}::date + 1` : tx``,
      isDate(f.proxDe) ? tx`and next_at >= ${f.proxDe}::date` : tx``,
      isDate(f.proxAte) ? tx`and next_at < ${f.proxAte}::date + 1` : tx``,
      isDate(f.cadDe) ? tx`and p.created_at >= ${f.cadDe}::date` : tx``,
      isDate(f.cadAte) ? tx`and p.created_at < ${f.cadAte}::date + 1` : tx``,
      int(f.aniv) ? tx`and extract(month from p.birth_date) = ${int(f.aniv)}` : tx``,
      int(f.idMin) != null ? tx`and p.birth_date <= current_date - make_interval(years => ${int(f.idMin)})` : tx``,
      int(f.idMax) != null ? tx`and p.birth_date > current_date - make_interval(years => ${int(f.idMax)! + 1})` : tx``,
      f.resp === "menor" ? tx`and exists (select 1 from contact_patient_links l where l.patient_id = p.id and l.is_guardian)` : tx``,
      f.resp === "varios" ? tx`and exists (select 1 from contact_patient_links l where l.patient_id = p.id and (select count(*) from contact_patient_links l2 where l2.contact_id = l.contact_id) > 1)` : tx``,
      f.crm ? tx`and exists (select 1 from opportunities o where (o.patient_id = p.id) and o.stage = ${f.crm})` : tx``,
      ctx.role === "dentista" ? tx`and exists (select 1 from appointments a where a.patient_id = p.id and a.professional_id = ${own?.id ?? null})` : tx``,
    ];
    const order = f.ord === "proxima" ? tx`next_at asc nulls last, full_name` : f.ord === "ultima" ? tx`last_at desc nulls last, full_name`
      : f.ord === "recentes" ? tx`p.created_at desc` : tx`full_name`;
    const rows = await tx<{ id: string; full_name: string; birth_date: string | null; phones: string[] | null; next_at: Date | null; last_at: Date | null; total: number; guardian_of: number; count: number }[]>`
      with base as (
        select p.*,
               (select min(a.starts_at) from appointments a where a.patient_id = p.id and a.starts_at > now() and a.status in ('scheduled','confirmed')) as next_at,
               (select max(a.starts_at) from appointments a where a.patient_id = p.id and a.starts_at <= now() and a.status in ('completed','arrived','in_service')) as last_at
        from patients p where p.merged_into_patient_id is null
      )
      select p.id, p.full_name, p.birth_date::text, next_at, last_at,
             (select array_agg(ct.phone_e164) from contact_patient_links l join contacts ct on ct.id = l.contact_id where l.patient_id = p.id) as phones,
             (select count(*)::int from appointments a where a.patient_id = p.id and a.status <> 'cancelled') as total,
             (select count(*)::int from contact_patient_links l where l.patient_id = p.id and l.is_guardian) as guardian_of,
             count(*) over ()::int as count
      from base p
      where true ${conds.reduce((acc, c) => tx`${acc} ${c}`, tx``)}
      order by ${order} limit ${SIZE + 1} offset ${(page - 1) * SIZE}`;
    const professionals = ctx.role === "dentista" ? [] : await tx<{ id: string; name: string }[]>`select id, name from professionals order by name`;
    const services = await tx<{ id: string; name: string }[]>`select id, name from services order by name`;
    return { rows, total: rows[0]?.count ?? 0, professionals, services };
  });
  const hasMore = rows.length > SIZE;
  const advancedKeys = FILTER_KEYS.filter((k) => k !== "q" && k !== "ord" && f[k]);
  const qs = (extra: Record<string, string | null>) => {
    const merged: Record<string, string | null | undefined> = { ...f, ...extra };
    const out = Object.entries(merged).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
    return out ? `/pacientes?${out}` : "/pacientes";
  };
  const label = (k: string, v: string): string => {
    const names: Record<string, string> = {
      prof: `Dentista: ${professionals.find((p) => p.id === v)?.name ?? "—"}`, svc: `Serviço: ${services.find((x) => x.id === v)?.name ?? "—"}`,
      sit: SITUATION[v] ?? v, ultDe: `Última consulta desde ${v.split("-").reverse().join("/")}`, ultAte: `Última consulta até ${v.split("-").reverse().join("/")}`,
      proxDe: `Próxima desde ${v.split("-").reverse().join("/")}`, proxAte: `Próxima até ${v.split("-").reverse().join("/")}`,
      cadDe: `Cadastro desde ${v.split("-").reverse().join("/")}`, cadAte: `Cadastro até ${v.split("-").reverse().join("/")}`,
      aniv: `Aniversário em ${MONTHS[Number(v) - 1] ?? v}`, idMin: `${v} anos ou mais`, idMax: `Até ${v} anos`,
      resp: v === "menor" ? "Tem responsável" : "Telefone compartilhado", crm: `CRM: ${OPPORTUNITY_STAGE_LABELS[v as OpportunityStage] ?? v}`,
    };
    return names[k] ?? v;
  };
  const age = (birth: string | null) => {
    if (!birth) return null;
    const [y, m, d] = birth.split("-").map(Number) as [number, number, number];
    const now = new Date();
    let years = now.getFullYear() - y;
    if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) years--;
    return years;
  };

  return (
    <>
      <PageHeader title="Pacientes" subtitle="Encontre qualquer paciente por nome, telefone, data de nascimento, serviço ou observação. Use os filtros para listas como “aniversariantes do mês” ou “sem vir há 6 meses”.">
        {can(ctx.role, "patients.write") && (
          <Modal trigger={<><Plus aria-hidden /> Cadastrar paciente</>} title="Cadastrar paciente" description="Só o nome é obrigatório. O WhatsApp liga o paciente às conversas." defaultOpen={sp.novo === "1"} triggerClass={buttonClass("primary")}>
            <ActionForm action={savePatientAction} className="space-y-5">
              <Field label="Nome completo"><Input name="fullName" required /></Field>
              <div className="grid gap-6 sm:grid-cols-2">
                <Field label="Data de nascimento" hint="Usada na verificação de identidade."><Input type="date" name="birthDate" /></Field>
                <Field label="WhatsApp (com DDD)"><Input name="phone" inputMode="tel" /></Field>
              </div>
              <Field label="Observações administrativas" hint="Não registre informação clínica aqui."><Textarea name="notes" className="min-h-16" /></Field>
              <div className="flex justify-end border-t border-line pt-5"><Button type="submit">Salvar</Button></div>
            </ActionForm>
          </Modal>
        )}
      </PageHeader>

      <form action="/pacientes" className="vidro mb-6 rounded-lg">
        <div className="flex flex-wrap items-center gap-3 p-3">
          <div className="relative min-w-0 flex-1 basis-72">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-bone-mute" aria-hidden />
            <Input name="q" defaultValue={search} placeholder="Buscar por nome, telefone, nascimento (15/03), serviço ou observação" aria-label="Buscar pacientes" className="h-11 pl-10 text-[15px]" />
          </div>
          <Select name="ord" defaultValue={f.ord ?? "nome"} aria-label="Ordenar por" className="h-11 w-auto">{Object.entries(ORDER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          <Button type="submit" className="h-11">Buscar</Button>
        </div>
        <details className="group border-t border-line" open={advancedKeys.length > 0}>
          <summary className="flex h-11 cursor-pointer list-none items-center gap-2 px-4 text-[13px] font-medium text-bone-dim hover:text-bone">
            <SlidersHorizontal size={15} aria-hidden /> Filtros avançados{advancedKeys.length > 0 && <Badge tone="sun">{advancedKeys.length}</Badge>}
            <ChevronDown size={15} aria-hidden className="ml-auto transition-transform group-open:rotate-180" />
          </summary>
          <div className="grid gap-x-6 gap-y-5 border-t border-line p-5 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Situação"><Select name="sit" defaultValue={f.sit ?? ""}><option value="">Todas</option>{Object.entries(SITUATION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            {ctx.role !== "dentista" && <Field label="Atendido por"><Select name="prof" defaultValue={f.prof ?? ""}><option value="">Qualquer dentista</option>{professionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>}
            <Field label="Já fez o serviço"><Select name="svc" defaultValue={f.svc ?? ""}><option value="">Qualquer serviço</option>{services.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
            <Field label="Interesse no CRM"><Select name="crm" defaultValue={f.crm ?? ""}><option value="">Qualquer</option>{Object.entries(OPPORTUNITY_STAGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Última consulta"><div className="grid grid-cols-2 gap-2"><Input type="date" name="ultDe" defaultValue={f.ultDe} aria-label="Última consulta desde" /><Input type="date" name="ultAte" defaultValue={f.ultAte} aria-label="Última consulta até" /></div></Field>
            <Field label="Próxima consulta"><div className="grid grid-cols-2 gap-2"><Input type="date" name="proxDe" defaultValue={f.proxDe} aria-label="Próxima consulta desde" /><Input type="date" name="proxAte" defaultValue={f.proxAte} aria-label="Próxima consulta até" /></div></Field>
            <Field label="Cadastrado em"><div className="grid grid-cols-2 gap-2"><Input type="date" name="cadDe" defaultValue={f.cadDe} aria-label="Cadastrado desde" /><Input type="date" name="cadAte" defaultValue={f.cadAte} aria-label="Cadastrado até" /></div></Field>
            <Field label="Idade"><div className="grid grid-cols-2 gap-2"><Input type="number" min={0} max={120} name="idMin" defaultValue={f.idMin} placeholder="de" aria-label="Idade mínima" /><Input type="number" min={0} max={120} name="idMax" defaultValue={f.idMax} placeholder="até" aria-label="Idade máxima" /></div></Field>
            <Field label="Aniversário no mês"><Select name="aniv" defaultValue={f.aniv ?? ""}><option value="">Qualquer mês</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select></Field>
            <Field label="Responsável e telefone"><Select name="resp" defaultValue={f.resp ?? ""}><option value="">Todos</option><option value="menor">Tem responsável (ex.: criança)</option><option value="varios">Telefone usado por mais de um paciente</option></Select></Field>
            <div className="flex items-end justify-end gap-2 sm:col-span-2">
              <Link href="/pacientes" className={buttonClass("ghost")}>Limpar tudo</Link>
              <Button type="submit">Aplicar filtros</Button>
            </div>
          </div>
        </details>
      </form>

      <div className="mb-4 flex min-h-8 flex-wrap items-center gap-2">
        <p className="t-small mr-2"><span className="font-mono text-bone">{total}</span> paciente{total === 1 ? "" : "s"}{search || advancedKeys.length ? ` encontrado${total === 1 ? "" : "s"}` : ""}</p>
        {search && <Link href={qs({ q: null, p: null })} className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-line px-2.5 text-[12px] text-bone-dim hover:border-bone-mute/50 hover:text-bone">“{search}” <X size={12} aria-hidden /></Link>}
        {advancedKeys.map((k) => (
          <Link key={k} href={qs({ [k]: null, p: null })} className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-acento/40 bg-acento/10 px-2.5 text-[12px] text-bone hover:border-acento" aria-label={`Remover filtro ${label(k, f[k]!)}`}>{label(k, f[k]!)} <X size={12} aria-hidden /></Link>
        ))}
      </div>

      <Card>
        {rows.length === 0 ? <Empty title={search || advancedKeys.length ? "Nenhum paciente com esses critérios" : "Nenhum paciente ainda"}>{search || advancedKeys.length ? "Tente remover algum filtro." : "Pacientes são criados pela recepção, pela agenda ou pela assistente durante o agendamento."}</Empty> : (
          <Table head={["Paciente", "Idade", "Telefone", "Última consulta", "Próxima consulta", "Consultas", ""]}>
            {rows.slice(0, SIZE).map((p) => (
              <tr key={p.id} className="transition-colors hover:bg-surface-2/50">
                <td><Link href={`/pacientes/${p.id}`} className="flex items-center gap-3"><Avatar name={p.full_name} size={32} /><span><span className="block font-semibold">{p.full_name}</span>{p.guardian_of > 0 && <Badge>tem responsável</Badge>}</span></Link></td>
                <td className="num text-bone-dim">{age(p.birth_date) ?? "—"}</td>
                <td className="whitespace-nowrap text-bone-dim">{p.phones?.length ? formatPhone(p.phones[0]!) : "—"}{(p.phones?.length ?? 0) > 1 ? ` +${p.phones!.length - 1}` : ""}</td>
                <td className="whitespace-nowrap">{p.last_at ? formatShort(p.last_at, ctx.tz) : <span className="text-bone-mute">—</span>}</td>
                <td className="whitespace-nowrap">{p.next_at ? formatShort(p.next_at, ctx.tz) : <span className="text-bone-mute">—</span>}</td>
                <td className="num">{p.total}</td>
                <td className="text-right"><Link href={`/pacientes/${p.id}`} className={buttonClass("outline", "sm")}>Abrir ficha</Link></td>
              </tr>
            ))}
          </Table>
        )}
        {(page > 1 || hasMore) && (
          <div className="mt-5 flex items-center justify-between border-t border-line pt-5">
            {page > 1 ? <Link className={buttonClass("outline", "sm")} href={qs({ p: String(page - 1) })}>← Anteriores</Link> : <span />}
            <span className="t-small">Página {page} de {Math.max(1, Math.ceil(total / SIZE))}</span>
            {hasMore ? <Link className={buttonClass("outline", "sm")} href={qs({ p: String(page + 1) })}>Próximos →</Link> : <span />}
          </div>
        )}
      </Card>
    </>
  );
}
