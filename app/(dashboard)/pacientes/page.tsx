import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, Modal } from "@/components/client";
import { Avatar, Badge, Button, buttonClass, Card, Empty, Field, Input, PageHeader, Table, Textarea } from "@/components/ui";
import { can } from "@/domain/permissions";
import { formatShort } from "@/lib/datetime";
import { formatPhone } from "@/lib/format";
import { savePatientAction } from "./actions";

export const metadata = { title: "Pacientes" };

export default async function PatientsPage({ searchParams }: { searchParams: Promise<{ q?: string; p?: string }> }) {
  const ctx = await requireCtx("patients.view");
  const sp = await searchParams;
  const search = (sp.q ?? "").trim().slice(0, 80);
  const page = Math.max(1, Number(sp.p) || 1);
  const SIZE = 30;
  const rows = await q(ctx, async (tx) => {
    const [own] = ctx.role === "dentista" && ctx.userId ? await tx<{ id: string }[]>`select id from professionals where app_user_id = ${ctx.userId}` : [];
    const like = `%${search}%`;
    return tx<{ id: string; full_name: string; birth_date: string | null; phones: string[] | null; next_at: Date | null; total: number; guardian_of: number }[]>`
      select p.id, p.full_name, p.birth_date::text,
             (select array_agg(ct.phone_e164) from contact_patient_links l join contacts ct on ct.id = l.contact_id where l.patient_id = p.id) as phones,
             (select min(a.starts_at) from appointments a where a.patient_id = p.id and a.starts_at > now() and a.status in ('scheduled','confirmed')) as next_at,
             (select count(*)::int from appointments a where a.patient_id = p.id and a.status <> 'cancelled') as total,
             (select count(*)::int from contact_patient_links l where l.patient_id = p.id and l.is_guardian) as guardian_of
      from patients p
      where p.merged_into_patient_id is null
        ${search ? tx`and (p.full_name ilike ${like} or exists (select 1 from contact_patient_links l join contacts ct on ct.id = l.contact_id where l.patient_id = p.id and ct.phone_e164 ilike ${like}))` : tx``}
        ${ctx.role === "dentista" ? tx`and exists (select 1 from appointments a where a.patient_id = p.id and a.professional_id = ${own?.id ?? null})` : tx``}
      order by p.full_name limit ${SIZE + 1} offset ${(page - 1) * SIZE}`;
  });
  const hasMore = rows.length > SIZE;

  return (
    <>
      <PageHeader title="Pacientes" subtitle="Dados administrativos. Contato (telefone) e paciente são coisas diferentes: um responsável pode agendar para os filhos.">
        <form className="relative" action="/pacientes">
          <Search size={15} className="absolute left-3 top-3 text-navy-300" aria-hidden />
          <Input name="q" defaultValue={search} placeholder="Nome ou telefone" aria-label="Buscar pacientes" className="w-60 pl-9" />
        </form>
        {can(ctx.role, "patients.write") && (
          <Modal trigger={<><Plus size={15} aria-hidden /> Novo paciente</>} title="Novo paciente" triggerClass={buttonClass("accent")}>
            <ActionForm action={savePatientAction} className="space-y-4">
              <Field label="Nome completo"><Input name="fullName" required /></Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Data de nascimento" hint="Usada na verificação de identidade."><Input type="date" name="birthDate" /></Field>
                <Field label="WhatsApp (com DDD)"><Input name="phone" inputMode="tel" /></Field>
              </div>
              <Field label="Observações administrativas" hint="Não registre informação clínica aqui."><Textarea name="notes" className="min-h-16" /></Field>
              <Button type="submit">Salvar</Button>
            </ActionForm>
          </Modal>
        )}
      </PageHeader>
      <Card>
        {rows.length === 0 ? <Empty title={search ? "Nenhum paciente encontrado" : "Nenhum paciente ainda"}>Pacientes são criados pela recepção, pela agenda ou pela assistente durante o agendamento.</Empty> : (
          <Table head={["Paciente", "Telefone", "Próxima consulta", "Consultas", ""]}>
            {rows.slice(0, SIZE).map((p) => (
              <tr key={p.id}>
                <td><Link href={`/pacientes/${p.id}`} className="flex items-center gap-3"><Avatar name={p.full_name} size={32} /><span><span className="block font-semibold">{p.full_name}</span>{p.guardian_of > 0 && <Badge>tem responsável</Badge>}</span></Link></td>
                <td className="text-navy-700">{p.phones?.length ? formatPhone(p.phones[0]!) : "—"}{(p.phones?.length ?? 0) > 1 ? ` +${p.phones!.length - 1}` : ""}</td>
                <td>{p.next_at ? formatShort(p.next_at, ctx.tz) : <span className="text-navy-300">—</span>}</td>
                <td>{p.total}</td>
                <td className="text-right"><Link href={`/pacientes/${p.id}`} className="text-xs font-semibold underline">Abrir ficha</Link></td>
              </tr>
            ))}
          </Table>
        )}
        <div className="mt-4 flex justify-between text-sm">
          {page > 1 ? <Link className="font-semibold underline" href={`/pacientes?q=${encodeURIComponent(search)}&p=${page - 1}`}>← Anteriores</Link> : <span />}
          {hasMore && <Link className="font-semibold underline" href={`/pacientes?q=${encodeURIComponent(search)}&p=${page + 1}`}>Próximos →</Link>}
        </div>
      </Card>
    </>
  );
}
