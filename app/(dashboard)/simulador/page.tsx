import Link from "next/link";
import { Bot, ImageIcon, Send, Wrench } from "lucide-react";
import { StateTag } from "@/components/tags";
import type { ConversationState } from "@/domain/states";
import { requireCtx, q } from "@/auth/session";
import { ActionForm, LiveRefresh, ScrollToEnd } from "@/components/client";
import { Badge, Button, Card, CardTitle, Empty, Input, Notice, PageHeader, buttonClass } from "@/components/ui";
import { db } from "@/db/client";
import { env } from "@/lib/env";
import { localTime } from "@/lib/datetime";
import { cn, normalizePhone } from "@/lib/format";
import { resetSimulationAction, simulateAction } from "./actions";

export const metadata = { title: "Simulador" };

const OUTCOME: Record<string, string> = {
  replied: "respondeu", alert: "alerta", handoff: "passou à equipe", no_provider: "sem IA", discarded_handoff: "descartada", error: "erro", budget_exceeded: "teto de custo", skipped: "ignorada",
};

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
  const [llm] = await db()<{ llm_provider: string; has_key: boolean }[]>`select llm_provider, llm_api_key_enc is not null as has_key from clinic_integrations where clinic_id = ${ctx.clinicId}`;
  const llmReady = llm && llm.llm_provider !== "platform" ? llm.has_key || llm.llm_provider === "openai_compatible" : !!env.anthropicKey;

  return (
    // Tela travada na altura da janela: só a conversa e os bastidores rolam, nunca a página.
    <div className="flex flex-col lg:h-[calc(100dvh-10.5rem)] lg:min-h-[560px]">
      <LiveRefresh seconds={3} clinicId={ctx.clinicId} />
      <PageHeader title="Simulador de paciente" subtitle="Converse como se fosse um paciente. As mensagens seguem o mesmo caminho do WhatsApp, sem enviar nada para fora." />
      <div className="mb-6 space-y-3 empty:hidden">
        {!aiOn && <Notice tone="sun">A assistente está {ctx.clinic.ai_kill_switch ? "pausada" : "desligada"}: as mensagens entram na fila humana. <Link className="font-semibold underline" href="/configuracoes?aba=ia">Ativar a IA</Link></Notice>}
        {aiOn && !llmReady && <Notice tone="sun">Nenhuma inteligência artificial configurada: a conversa é encaminhada para a equipe (o restante do fluxo funciona normalmente). Configure em <Link className="underline underline-offset-2" href="/configuracoes?aba=ia">Configurações → Assistente</Link>.</Notice>}
      </div>
      <div className="grid gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_360px] simples:lg:grid-cols-1">
        <Card className="flex min-h-[65dvh] flex-col p-0 lg:min-h-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4">
            <form className="flex items-center gap-2 simples:hidden" action="/simulador">
              <label className="t-small" htmlFor="tel">Telefone fictício</label>
              <Input id="tel" name="tel" defaultValue={phone} className="h-8 w-44 font-mono text-[13px]" />
              <Button size="sm" variant="outline">Trocar</Button>
            </form>
            <div className="flex items-center gap-2">
              {data.conv && <StateTag state={data.conv.state as ConversationState} />}
              {data.conv && <Link className={buttonClass("outline", "sm")} href={`/conversas?c=${data.conv.id}`}>Ver em Conversas</Link>}
              <ActionForm action={resetSimulationAction}><input type="hidden" name="phone" value={phone} /><Button size="sm" variant="ghost">Recomeçar</Button></ActionForm>
            </div>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-surface-2/40">
            <div className="mx-auto w-full max-w-[760px] space-y-3 px-6 py-6">
            {data.messages.length === 0 && <Empty title="Comece a conversa">Experimente: “Oi, quanto custa a limpeza?” ou “Quero marcar uma avaliação”.</Empty>}
            {data.messages.map((m) => {
              if (m.type === "note") {
                return (
                  <div key={m.id} className="flex justify-center">
                    <p className="max-w-[90%] rounded-md border border-dashed border-line bg-surface/60 px-3 py-2 text-center text-[12.5px] text-bone-dim">{m.body}</p>
                  </div>
                );
              }
              const mine = m.direction === "inbound";
              const tone = mine ? "border-line bg-surface" : m.sender_type === "ai" ? "border-info/25 bg-info-soft" : "border-violet/25 bg-violet-soft";
              const dot = mine ? "bg-bone-mute" : m.sender_type === "ai" ? "bg-info" : "bg-violet";
              return (
                <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
                  <div className={cn("max-w-[80%] rounded-md border px-4 py-3", tone, mine ? "rounded-tr-sm" : "rounded-tl-sm")}>
                    <p className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-bone-dim"><span aria-hidden className={cn("size-1.5 rounded-full", dot)} />{mine ? "Você (paciente)" : m.sender_type === "ai" ? `${ctx.clinic.assistant_name} · assistente` : m.sender_type === "human" ? "Equipe" : "Automação"}</p>
                    <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">{m.type === "image" ? `📷 Imagem${m.body ? `: ${m.body}` : ""}` : m.body}</p>
                    <p className="mt-1.5 text-right font-mono text-[10.5px] text-bone-mute">{localTime(m.created_at, ctx.tz)}</p>
                  </div>
                </div>
              );
            })}
            <ScrollToEnd dep={data.messages.length} />
            </div>
          </div>
          <div className="border-t border-line">
            <ActionForm action={simulateAction} className="mx-auto flex w-full max-w-[760px] flex-wrap items-center gap-3 px-6 py-5">
              <input type="hidden" name="phone" value={phone} />
              <Input name="text" placeholder="Escreva como se fosse o paciente…" aria-label="Mensagem do paciente" className="flex-1 basis-56" autoComplete="off" />
              {/* "Enviar" vem primeiro no HTML: é o botão que o Enter aciona. A foto fica à esquerda só visualmente. */}
              <Button type="submit" name="kind" value="text" className="order-last"><Send aria-hidden /> Enviar</Button>
              <Button type="submit" name="kind" value="image" variant="outline" title="Simula o envio de uma foto (sem texto, como um paciente mandando imagem)"><ImageIcon aria-hidden /> Simular foto</Button>
            </ActionForm>
          </div>
        </Card>

        <Card className="lg:min-h-0 simples:hidden">
          <CardTitle hint="O que a assistente consultou ou fez em cada resposta (só gestores veem).">Bastidores da IA</CardTitle>
          {data.runs.length === 0 ? <Empty title="Nenhuma execução ainda">As ferramentas chamadas e o desfecho aparecem aqui.</Empty> : (
            <ul className="scroll-thin -mr-2 min-h-0 flex-1 space-y-3 overflow-y-auto pr-2">
              {data.runs.map((r) => (
                <li key={r.id} className="rounded-md border border-line p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-mono text-[12px] text-bone-dim"><Bot size={13} aria-hidden /> {localTime(r.created_at, ctx.tz)}</span>
                    <Badge tone={r.outcome === "replied" ? "ok" : r.outcome === "alert" ? "danger" : "warn"}>{OUTCOME[r.outcome ?? ""] ?? r.outcome}</Badge>
                  </div>
                  {r.tools_called.length > 0 && (
                    <ol className="mt-2 space-y-1">
                      {r.tools_called.map((t, i) => (
                        <li key={i} className="flex items-center gap-1.5 text-xs"><Wrench size={11} aria-hidden /><code>{t.name}</code><span className={t.ok ? "text-ok" : "text-danger"}>{t.ok ? "ok" : "erro"}</span></li>
                      ))}
                    </ol>
                  )}
                  <p className="t-small mt-3 font-mono text-[11px]">{r.model ?? "sem modelo"} · {r.latency_ms ?? 0} ms · {r.tokens_in}/{r.tokens_out} tokens</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
