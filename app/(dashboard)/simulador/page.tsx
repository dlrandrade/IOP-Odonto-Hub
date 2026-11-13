import Link from "next/link";
import { Bot, ImageIcon, Wrench } from "lucide-react";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, LiveRefresh, ScrollToEnd } from "@/components/client";
import { Badge, Button, Card, CardTitle, Empty, Input, Notice, PageHeader } from "@/components/ui";
import { env } from "@/lib/env";
import { localTime } from "@/lib/datetime";
import { cn, normalizePhone } from "@/lib/format";
import { resetSimulationAction, simulateAction } from "./actions";

export const metadata = { title: "Simulador" };

export default async function SimulatorPage({ searchParams }: { searchParams: Promise<{ tel?: string }> }) {
  const ctx = await requireCtx("simulator.use");
  const { tel } = await searchParams;
  const phone = normalizePhone(tel && tel.replace(/\D/g, "").length >= 8 ? tel : "11900000001");
  const data = await q(ctx, async (tx) => {
    const [conv] = await tx<{ id: string; state: string; handoff_reason: string | null }[]>`
      select c.id, c.state, c.handoff_reason from conversations c join contacts ct on ct.id = c.contact_id
      where ct.phone_e164 = ${phone} and c.channel = 'simulator' order by c.created_at desc limit 1`;
    if (!conv) return { conv: null, messages: [], runs: [] };
    const messages = await tx<{ id: string; direction: string; sender_type: string; type: string; body: string | null; created_at: Date }[]>`
      select id, direction, sender_type, type, body, created_at from messages where conversation_id = ${conv.id} order by created_at, id`;
    const runs = ["admin", "gestor"].includes(ctx.role) ? await tx<{ id: string; outcome: string | null; model: string | null; latency_ms: number | null; tokens_in: number; tokens_out: number; tools_called: { name: string; ok: boolean }[]; created_at: Date }[]>`
      select id, outcome, model, latency_ms, tokens_in, tokens_out, tools_called, created_at from ai_runs where conversation_id = ${conv.id} order by created_at desc limit 12` : [];
    return { conv, messages, runs };
  });
  const aiOn = ctx.clinic.ai_enabled && !ctx.clinic.ai_kill_switch;

  return (
    <>
      <LiveRefresh seconds={3} clinicId={ctx.clinicId} />
      <PageHeader title="Simulador de paciente" subtitle="Converse como se fosse um paciente. As mensagens passam pelo mesmo pipeline do WhatsApp, sem enviar nada para fora." />
      <div className="mb-3 space-y-2">
        {!aiOn && <Notice tone="sun">A assistente está {ctx.clinic.ai_kill_switch ? "pausada" : "desligada"}: as mensagens entram na fila humana. <Link className="font-semibold underline" href="/configuracoes?aba=ia">Ativar a IA</Link></Notice>}
        {aiOn && !env.anthropicKey && <Notice tone="sun">Sem <code>ANTHROPIC_API_KEY</code> configurada, a assistente não responde: a conversa é encaminhada para a equipe (o restante do fluxo funciona normalmente).</Notice>}
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="flex min-h-[65dvh] flex-col p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cream-200 px-4 py-3">
            <form className="flex items-center gap-2" action="/simulador">
              <label className="text-xs font-semibold" htmlFor="tel">Telefone fictício</label>
              <Input id="tel" name="tel" defaultValue={phone} className="h-8 w-44" />
              <Button size="sm" variant="outline">Trocar</Button>
            </form>
            <div className="flex items-center gap-2">
              {data.conv && <Badge tone={data.conv.state === "ai_active" ? "ok" : "warn"}>{data.conv.state === "ai_active" ? "IA ativa" : data.conv.state === "closed" ? "Encerrada" : "Com a equipe"}</Badge>}
              {data.conv && <Link className="text-xs font-semibold underline" href={`/conversas?c=${data.conv.id}`}>Ver na inbox</Link>}
              <ActionForm action={resetSimulationAction}><input type="hidden" name="phone" value={phone} /><Button size="sm" variant="ghost">Limpar</Button></ActionForm>
            </div>
          </div>
          <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto bg-cream-50 p-4">
            {data.messages.length === 0 && <Empty title="Comece a conversa">Experimente: “Oi, quanto custa a limpeza?” ou “Quero marcar uma avaliação”.</Empty>}
            {data.messages.map((m) => m.type === "note" ? (
              <p key={m.id} className="mx-auto max-w-[85%] rounded-xl bg-sun-100 px-3 py-1.5 text-center text-xs">{m.body}</p>
            ) : (
              <div key={m.id} className={cn("flex", m.direction === "inbound" ? "justify-end" : "justify-start")}>
                <div className={cn("max-w-[78%] rounded-2xl px-3.5 py-2 text-sm shadow-sm", m.direction === "inbound" ? "bg-sun-200" : "bg-white")}>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-navy-500">{m.direction === "inbound" ? "Você (paciente)" : m.sender_type === "ai" ? `${ctx.clinic.assistant_name} (IA)` : m.sender_type === "human" ? "Equipe" : "Automação"}</p>
                  <p className="whitespace-pre-wrap break-words">{m.type === "image" ? `📷 Imagem${m.body ? `: ${m.body}` : ""}` : m.body}</p>
                  <p className="mt-0.5 text-right text-[10px] text-navy-500">{localTime(m.created_at, ctx.tz)}</p>
                </div>
              </div>
            ))}
            <ScrollToEnd dep={data.messages.length} />
          </div>
          <ActionForm action={simulateAction} className="flex flex-wrap items-center gap-2 border-t border-cream-200 p-3">
            <input type="hidden" name="phone" value={phone} />
            <Input name="text" placeholder="Mensagem do paciente…" aria-label="Mensagem do paciente" className="flex-1 basis-56" autoComplete="off" />
            <Button type="submit" name="kind" value="text" variant="accent">Enviar</Button>
            <Button type="submit" name="kind" value="image" variant="outline" title="Simula o envio de uma foto"><ImageIcon size={14} aria-hidden /> Foto</Button>
          </ActionForm>
        </Card>

        <Card>
          <CardTitle hint="O que a IA pediu ao servidor em cada resposta">Bastidores</CardTitle>
          {data.runs.length === 0 ? <Empty title="Nenhuma execução ainda">As ferramentas chamadas e o desfecho aparecem aqui.</Empty> : (
            <ul className="space-y-3">
              {data.runs.map((r) => (
                <li key={r.id} className="rounded-2xl border border-cream-200 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-xs font-semibold"><Bot size={13} aria-hidden /> {localTime(r.created_at, ctx.tz)}</span>
                    <Badge tone={r.outcome === "replied" ? "ok" : r.outcome === "alert" ? "danger" : "warn"}>{r.outcome}</Badge>
                  </div>
                  {r.tools_called.length > 0 && (
                    <ol className="mt-2 space-y-1">
                      {r.tools_called.map((t, i) => (
                        <li key={i} className="flex items-center gap-1.5 text-xs"><Wrench size={11} aria-hidden /><code>{t.name}</code><span className={t.ok ? "text-ok" : "text-danger"}>{t.ok ? "ok" : "erro"}</span></li>
                      ))}
                    </ol>
                  )}
                  <p className="mt-2 text-[10px] text-navy-500">{r.model ?? "sem modelo"} · {r.latency_ms ?? 0} ms · {r.tokens_in}/{r.tokens_out} tokens</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
