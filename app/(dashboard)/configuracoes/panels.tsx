"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { Check, Loader2, QrCode, Smartphone, TriangleAlert } from "lucide-react";
import { ActionForm } from "@/components/client";
import { Badge, Button, Field, Input, Notice, Select } from "@/components/ui";
import { cn } from "@/lib/format";
import { evolutionLogoutAction, evolutionQrAction, evolutionStatusAction, listModelsAction, saveEvolutionAction, saveLlmAction, testLlmAction, useOfficialWhatsAppAction } from "./actions";

/** Escolha entre opções do mesmo peso: cartões do mesmo tamanho, lado a lado. */
export function ChoiceCards<T extends string>({ name, value, onChange, options }: {
  name: string; value: T; onChange: (v: T) => void; options: { value: T; title: string; text: string; tag?: ReactNode }[];
}) {
  return (
    <div role="radiogroup" className={cn("grid gap-4", options.length === 4 ? "sm:grid-cols-2 xl:grid-cols-4" : options.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <label key={o.value} className={cn("btn relative flex h-full cursor-pointer flex-col gap-2 rounded-md border p-5", on ? "border-acento bg-acento/[0.07]" : "border-line bg-surface-2/40 hover:border-bone-mute/60")}>
            <input type="radio" name={name} value={o.value} checked={on} onChange={() => onChange(o.value)} className="sr-only" />
            <span className="flex items-center justify-between gap-3">
              <span className="t-h3">{o.title}</span>
              <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border", on ? "border-acento bg-acento text-ink" : "border-line")}>{on && <Check size={12} strokeWidth={3} aria-hidden />}</span>
            </span>
            <span className="t-small">{o.text}</span>
            {o.tag && <span className="mt-auto pt-1">{o.tag}</span>}
          </label>
        );
      })}
    </div>
  );
}

// ───────────── WhatsApp ─────────────

export function WhatsAppPanel({ provider, official, evolution }: {
  provider: "cloud" | "evolution";
  official: ReactNode;
  evolution: { baseUrl: string; instance: string; hasKey: boolean; webhookUrl: string; connected: boolean };
}) {
  const [choice, setChoice] = useState(provider);
  return (
    <div className="space-y-8">
      <ChoiceCards name="channel" value={choice} onChange={setChoice} options={[
        { value: "cloud", title: "WhatsApp oficial (Meta)", text: "Número verificado pela Meta. Estável e sem risco de bloqueio. Exige cadastro na Meta e mensagens prontas aprovadas.", tag: <Badge tone="ok">Recomendado</Badge> },
        { value: "evolution", title: "Conexão por QR Code", text: "Usa o WhatsApp de um celular comum, pela Evolution API. Rápido de ligar, mas não é oficial.", tag: <Badge tone="warn">Não oficial</Badge> },
      ]} />
      {choice === "cloud" ? (
        <div className="space-y-6">
          {provider === "evolution" && (
            <ActionForm action={useOfficialWhatsAppAction} className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-line p-5">
              <p className="t-body text-bone-dim">Hoje a clínica usa a conexão por QR Code. Quer voltar ao WhatsApp oficial?</p>
              <Button>Usar o oficial</Button>
            </ActionForm>
          )}
          {official}
        </div>
      ) : <EvolutionSetup {...evolution} active={provider === "evolution"} />}
    </div>
  );
}

function EvolutionSetup({ baseUrl, instance, hasKey, webhookUrl, connected, active }: { baseUrl: string; instance: string; hasKey: boolean; webhookUrl: string; connected: boolean; active: boolean }) {
  const [qr, setQr] = useState<{ image: string | null; pairingCode: string | null; error?: string } | null>(null);
  const [state, setState] = useState(connected ? "open" : "close");
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  const showQr = () => start(async () => {
    const r = await evolutionQrAction();
    setState(r.state);
    setQr(r.state === "open" ? null : r);
    if (timer.current) clearInterval(timer.current);
    if (r.state !== "open" && !r.error) {
      timer.current = setInterval(async () => {
        const s = await evolutionStatusAction();
        setState(s.state);
        if (s.state === "open") { setQr(null); if (timer.current) clearInterval(timer.current); }
      }, 4000);
    }
  });

  return (
    <div className="space-y-6">
      <Notice tone="sun">
        <span className="flex gap-3"><TriangleAlert size={18} className="mt-0.5 shrink-0 text-gold" aria-hidden />
          <span>Esta conexão não é oficial: ela viola os termos do WhatsApp e <strong>o número pode ser bloqueado</strong>, principalmente se mandar muitas mensagens para quem não salvou o contato. Use um número só da clínica, mantenha o celular ligado e na internet, e prefira o oficial quando puder. As regras de descadastro e limite de mensagens continuam valendo.</span>
        </span>
      </Notice>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="flex h-full flex-col rounded-md border border-line p-6">
          <h3 className="t-h3 mb-1">1. Servidor Evolution API</h3>
          <p className="t-small mb-5">Peça estes dados a quem instalou a Evolution API (ou à hospedagem dela).</p>
          <ActionForm action={saveEvolutionAction} resetOnDone={false} className="flex flex-1 flex-col gap-5">
            <Field label="Endereço do servidor"><Input name="baseUrl" type="url" defaultValue={baseUrl} placeholder="https://evolution.suaempresa.com.br" required /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome da instância" hint="Se ainda não existir, criamos."><Input name="instance" defaultValue={instance} placeholder="clinica-centro" required /></Field>
              <Field label="Chave (API key)" hint={hasKey ? "Já salva. Preencha só para trocar." : "Fica guardada criptografada."}><Input name="apiKey" type="password" autoComplete="off" placeholder={hasKey ? "••••••••" : ""} /></Field>
            </div>
            <div className="mt-auto flex justify-end border-t border-line pt-5"><Button type="submit">Salvar e configurar</Button></div>
          </ActionForm>
        </section>
        <section className="flex h-full flex-col rounded-md border border-line p-6">
          <div className="mb-1 flex items-center justify-between gap-3">
            <h3 className="t-h3">2. Conectar o celular da clínica</h3>
            {state === "open" ? <Badge tone="ok">Conectado</Badge> : state === "connecting" ? <Badge tone="warn">Conectando</Badge> : <Badge>Desconectado</Badge>}
          </div>
          <p className="t-small mb-5">No celular: WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho → leia o código.</p>
          <div className="flex flex-1 items-center justify-center rounded-sm bg-surface-2/50 p-5">
            {state === "open" ? (
              <p className="flex flex-col items-center gap-3 text-center"><Smartphone size={32} className="text-ok" aria-hidden /><span className="t-h3">Celular conectado</span><span className="t-small">As mensagens já chegam em Conversas.</span></p>
            ) : qr?.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr.image} alt="QR Code para conectar o WhatsApp" className="size-56 rounded-sm bg-white p-2" />
            ) : qr?.pairingCode ? (
              <p className="text-center"><span className="t-small block">Código de pareamento</span><span className="display mt-2 block text-[32px] tracking-[0.2em]">{qr.pairingCode}</span></p>
            ) : (
              <p className="flex flex-col items-center gap-3 text-center"><QrCode size={32} className="text-bone-mute" aria-hidden /><span className="t-small max-w-xs">{qr?.error ?? (active ? "Clique em “Mostrar QR Code”. Ele se renova sozinho até o celular conectar." : "Salve o servidor no passo 1 antes.")}</span></p>
            )}
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-line pt-5">
            {state === "open" ? (
              <ActionForm action={evolutionLogoutAction}><Button variant="danger">Desconectar celular</Button></ActionForm>
            ) : (
              <Button type="button" onClick={showQr} disabled={!active || pending}>{pending ? <Loader2 className="animate-spin" aria-hidden /> : <QrCode aria-hidden />} Mostrar QR Code</Button>
            )}
          </div>
        </section>
      </div>
      {active && <p className="t-small">Endereço que configuramos na Evolution para receber mensagens: <code className="break-all font-mono text-bone-dim">{webhookUrl}</code></p>}
    </div>
  );
}

// ───────────── Provedor de IA ─────────────

export function LlmPanel({ provider, model, baseUrl, hasKey, checkedAt, lastError, platformReady }: {
  provider: "platform" | "anthropic" | "openrouter" | "openai_compatible"; model: string; baseUrl: string; hasKey: boolean; checkedAt: string | null; lastError: string | null; platformReady: boolean;
}) {
  const [choice, setChoice] = useState(provider);
  const [models, setModels] = useState<string[]>(model ? [model] : []);
  const [selected, setSelected] = useState(model);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(lastError ? { ok: false, message: lastError } : null);
  const [pending, start] = useTransition();
  const wrap = useRef<HTMLDivElement>(null);
  const data = () => new FormData(wrap.current?.querySelector("form") ?? undefined);

  const load = () => start(async () => {
    const r = await listModelsAction(data());
    if (r.error) setNote({ ok: false, message: r.error });
    else { setModels(r.models); setNote({ ok: true, message: `${r.models.length} modelos encontrados.` }); if (!r.models.includes(selected)) setSelected(""); }
  });
  const test = () => start(async () => setNote(await testLlmAction(data())));
  const keyHint = hasKey && choice === provider ? "Já salva. Preencha só para trocar." : "Fica guardada criptografada; ninguém consegue ver depois.";

  return (
    <div ref={wrap}>
      <ActionForm action={saveLlmAction} resetOnDone={false} className="space-y-6">
        <ChoiceCards name="provider" value={choice} onChange={(v) => { setChoice(v); setNote(null); setModels([]); setSelected(""); }} options={[
          { value: "platform", title: "Padrão da plataforma", text: "Usa a IA já contratada pela plataforma. Nada para configurar.", tag: platformReady ? <Badge tone="ok">Disponível</Badge> : <Badge tone="warn">Sem chave</Badge> },
          { value: "anthropic", title: "Claude (Anthropic)", text: "Sua própria chave da Anthropic. Os custos vão para a sua conta." },
          { value: "openrouter", title: "OpenRouter", text: "Uma chave dá acesso a muitos modelos (Claude, GPT, Gemini, Llama…)." },
          { value: "openai_compatible", title: "Outro compatível", text: "Qualquer API no formato OpenAI: Groq, Together, servidor próprio etc." },
        ]} />
        {choice !== "platform" && (
          <div className="grid gap-5 lg:grid-cols-2">
            {choice === "openai_compatible" && <Field label="Endereço da API" className="lg:col-span-2" hint="Até o /v1, sem /chat/completions."><Input name="baseUrl" type="url" defaultValue={baseUrl} placeholder="https://api.exemplo.com/v1" /></Field>}
            <Field label="Chave de API" hint={keyHint}><Input name="apiKey" type="password" autoComplete="off" placeholder={hasKey && choice === provider ? "••••••••" : ""} /></Field>
            <Field label="Modelo" hint="Carregue a lista e escolha. O modelo precisa aceitar ferramentas (tool calling).">
              <div className="flex gap-3">
                <Select name="model" value={selected} onChange={(e) => setSelected(e.target.value)} className="min-w-0 flex-1">
                  <option value="">{models.length ? "Escolha um modelo…" : "Clique em Carregar modelos"}</option>
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                </Select>
                <Button type="button" variant="outline" onClick={load} disabled={pending}>{pending ? <Loader2 className="animate-spin" aria-hidden /> : null}Carregar modelos</Button>
              </div>
            </Field>
          </div>
        )}
        {note && <p role="status" className={cn("rounded-sm border-l-2 px-4 py-3 text-[14px]", note.ok ? "border-ok bg-ok-soft text-ok" : "border-danger bg-danger-soft text-danger")}>{note.message}</p>}
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-5">
          {checkedAt && <span className="t-small mr-auto">Último teste bem-sucedido: {checkedAt}</span>}
          <Button type="button" variant="outline" onClick={test} disabled={pending}>Testar conexão</Button>
          <Button type="submit">Salvar provedor</Button>
        </div>
      </ActionForm>
    </div>
  );
}
