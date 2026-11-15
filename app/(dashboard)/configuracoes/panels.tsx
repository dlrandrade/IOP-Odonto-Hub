"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { Check, Loader2, QrCode, Smartphone, TriangleAlert } from "lucide-react";
import { ActionForm } from "@/components/client";
import { Badge, Button, Field, Input, Notice, Select } from "@/components/ui";
import { cn } from "@/lib/format";
import { connectWacliAction, evolutionLogoutAction, evolutionQrAction, evolutionStatusAction, listFreeModelsAction, listModelsAction, saveEvolutionAction, saveLlmAction, testLlmAction, useOfficialWhatsAppAction, wacliLogoutAction, wacliStatusAction } from "./actions";

/** Escolha entre opções do mesmo peso: cartões do mesmo tamanho, lado a lado. */
export function ChoiceCards<T extends string>({ name, value, onChange, options, className }: {
  name: string; value: T; onChange: (v: T) => void; options: { value: T; title: string; text: string; tag?: ReactNode; className?: string }[]; className?: string;
}) {
  return (
    <div role="radiogroup" className={cn("grid gap-4", className ?? (options.length === 4 ? "sm:grid-cols-2 xl:grid-cols-4" : options.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"))}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <label key={o.value} className={cn("bloco relative flex h-full cursor-pointer flex-col gap-2 rounded-lg border p-5", on ? "border-acento bg-acento/[0.08]" : "border-line bg-bone/[0.03] hover:border-bone-mute/60", o.className)}>
            <input type="radio" name={name} value={o.value} checked={on} onChange={() => onChange(o.value)} className="sr-only" />
            <span className="flex items-center justify-between gap-3">
              <span className="t-h3">{o.title}</span>
              <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border", on ? "border-acento bg-acento text-on" : "border-line")}>{on && <Check size={12} strokeWidth={3} aria-hidden />}</span>
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

export function WhatsAppPanel({ provider, official, evolution, wacli }: {
  provider: "cloud" | "evolution" | "wacli";
  official: ReactNode;
  evolution: { baseUrl: string; instance: string; hasKey: boolean; webhookUrl: string; connected: boolean };
  wacli: { platformGateway: boolean; ownUrl: string; hasOwnToken: boolean; connected: boolean };
}) {
  const [choice, setChoice] = useState(provider);
  return (
    <div className="space-y-8">
      <ChoiceCards name="channel" value={choice} onChange={setChoice} className={provider === "evolution" ? "sm:grid-cols-3" : "sm:grid-cols-3 simples:sm:grid-cols-2"} options={[
        { value: "cloud", title: "WhatsApp oficial (Meta)", text: "Número verificado pela Meta. Estável e sem risco de bloqueio. Exige cadastro na Meta e mensagens prontas aprovadas.", tag: <Badge tone="ok">Recomendado</Badge> },
        { value: "wacli", title: "QR Code direto", text: "Leia um QR Code com o celular da clínica e pronto, como no WhatsApp Web. Nada para instalar.", tag: <Badge tone="warn">Não oficial</Badge> },
        // Evolution exige servidor próprio: só aparece na visualização detalhada (ou se já estiver em uso).
        { value: "evolution", title: "QR Code pela Evolution API", text: "Para quem já tem um servidor Evolution API próprio. Também não é oficial.", tag: <Badge tone="warn">Não oficial</Badge>, className: provider === "evolution" ? undefined : "simples:hidden" },
      ]} />
      {choice === "cloud" ? (
        <div className="space-y-6">
          {provider !== "cloud" && (
            <ActionForm action={useOfficialWhatsAppAction} className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-line p-5">
              <p className="t-body text-bone-dim">Hoje a clínica usa a conexão por QR Code. Quer voltar ao WhatsApp oficial?</p>
              <Button>Usar o oficial</Button>
            </ActionForm>
          )}
          {official}
        </div>
      ) : choice === "wacli" ? <WacliSetup {...wacli} active={provider === "wacli"} /> : <EvolutionSetup {...evolution} active={provider === "evolution"} />}
    </div>
  );
}

const RISK = (
  <Notice tone="sun">
    <span className="flex gap-3"><TriangleAlert size={18} className="mt-0.5 shrink-0 text-gold" aria-hidden />
      <span>Esta conexão não é oficial: ela viola os termos do WhatsApp e <strong>o número pode ser bloqueado</strong>, principalmente se mandar muitas mensagens para quem não salvou o contato. Use um número só da clínica, mantenha o celular ligado e na internet, e prefira o oficial quando puder. As regras de descadastro e limite de mensagens continuam valendo.</span>
    </span>
  </Notice>
);

function WacliSetup({ platformGateway, ownUrl, hasOwnToken, connected, active }: { platformGateway: boolean; ownUrl: string; hasOwnToken: boolean; connected: boolean; active: boolean }) {
  const [status, setStatus] = useState<{ state: string; image: string | null; pairCode: string | null; error: string | null }>({ state: connected ? "connected" : "idle", image: null, pairCode: null, error: null });
  const [byPhone, setByPhone] = useState(false);
  const [ownGateway, setOwnGateway] = useState(!!ownUrl || !platformGateway);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [, start] = useTransition();

  const poll = () => {
    if (timer.current) clearInterval(timer.current);
    const tick = () => start(async () => {
      const s = await wacliStatusAction();
      setStatus(s);
      if (["connected", "error", "disconnected", "idle"].includes(s.state) && timer.current) { clearInterval(timer.current); timer.current = null; }
    });
    tick();
    timer.current = setInterval(tick, 3000);
  };
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  useEffect(() => { if (active) start(async () => setStatus(await wacliStatusAction())); }, [active]);

  const on = status.state === "connected";
  return (
    <div className="space-y-6">
      {RISK}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="flex h-full flex-col rounded-md border border-line p-6">
          <h3 className="t-h3 mb-1">1. Conectar</h3>
          <p className="t-small mb-5">{platformGateway ? "A plataforma já mantém o servidor que conversa com o WhatsApp. É só gerar o QR Code." : "Informe o servidor (gateway wacli) que a sua equipe instalou."}</p>
          <ActionForm action={connectWacliAction} resetOnDone={false} className="flex flex-1 flex-col gap-5">
            {platformGateway && (
              <label className={cn("flex items-center gap-2.5 text-[13.5px]", !ownGateway && "simples:hidden")}><input type="checkbox" checked={ownGateway} onChange={(e) => setOwnGateway(e.target.checked)} className="size-4 accent-[var(--color-gold)]" /> Usar um gateway próprio</label>
            )}
            {ownGateway && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Endereço do gateway"><Input name="gatewayUrl" type="url" defaultValue={ownUrl} placeholder="https://wa.suaclinica.com.br" required /></Field>
                <Field label="Chave do gateway" hint={hasOwnToken ? "Já salva. Preencha só para trocar." : "Fica guardada criptografada."}><Input name="gatewayToken" type="password" autoComplete="off" placeholder={hasOwnToken ? "••••••••" : ""} /></Field>
              </div>
            )}
            <label className="flex items-center gap-2.5 text-[13.5px]"><input type="checkbox" checked={byPhone} onChange={(e) => setByPhone(e.target.checked)} className="size-4 accent-[var(--color-gold)]" /> Prefiro digitar um código no celular em vez de ler o QR Code</label>
            {byPhone && <Field label="Número do WhatsApp da clínica" hint="Com DDI e DDD, ex.: 55 11 98765-4321."><Input name="phone" inputMode="tel" required /></Field>}
            <div className="mt-auto flex justify-end border-t border-line pt-5">
              <Button type="submit" onClick={() => setTimeout(poll, 1200)} disabled={on}>{byPhone ? "Gerar código" : <><QrCode aria-hidden /> Gerar QR Code</>}</Button>
            </div>
          </ActionForm>
        </section>
        <section className="flex h-full flex-col rounded-md border border-line p-6">
          <div className="mb-1 flex items-center justify-between gap-3">
            <h3 className="t-h3">2. Ler com o celular da clínica</h3>
            {on ? <Badge tone="ok">Conectado</Badge> : status.state === "pairing" ? <Badge tone="warn">Aguardando leitura</Badge> : <Badge>Desconectado</Badge>}
          </div>
          <p className="t-small mb-5">No celular: WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho{status.pairCode ? " → Conectar com número de telefone" : ""}.</p>
          <div className="flex min-h-64 flex-1 items-center justify-center rounded-sm bg-surface-2/50 p-5">
            {on ? (
              <p className="flex flex-col items-center gap-3 text-center"><Smartphone size={32} className="text-ok" aria-hidden /><span className="t-h3">Celular conectado</span><span className="t-small">As mensagens já chegam em Conversas e as automações já enviam por aqui.</span></p>
            ) : status.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={status.image} alt="QR Code para conectar o WhatsApp" className="size-60 rounded-sm bg-white p-2" />
            ) : status.pairCode ? (
              <p className="text-center"><span className="t-small block">Digite este código no celular</span><span className="display mt-2 block text-[32px] tracking-[0.2em]">{status.pairCode}</span></p>
            ) : status.state === "pairing" ? (
              <Loader2 size={28} className="animate-spin text-bone-mute" aria-label="Gerando" />
            ) : (
              <p className="flex flex-col items-center gap-3 text-center"><QrCode size={32} className="text-bone-mute" aria-hidden /><span className="t-small max-w-xs">{status.error ?? "Clique em “Gerar QR Code”. O código se renova sozinho até o celular ler."}</span></p>
            )}
          </div>
          {on && (
            <div className="mt-5 flex justify-end border-t border-line pt-5">
              <ActionForm action={wacliLogoutAction}><Button variant="danger">Desconectar celular</Button></ActionForm>
            </div>
          )}
        </section>
      </div>
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
      {RISK}
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
      {active && <p className="t-small simples:hidden">Endereço que configuramos na Evolution para receber mensagens: <code className="break-all font-mono text-bone-dim">{webhookUrl}</code></p>}
    </div>
  );
}

// ───────────── Provedor de IA ─────────────

export function LlmPanel({ provider, model, baseUrl, hasKey, checkedAt, lastError, platformReady, freeAuto, fallbackModels }: {
  provider: "platform" | "anthropic" | "openrouter" | "openai_compatible"; model: string; baseUrl: string; hasKey: boolean; checkedAt: string | null; lastError: string | null; platformReady: boolean;
  freeAuto: boolean; fallbackModels: string[];
}) {
  const [choice, setChoice] = useState(provider);
  const [mode, setMode] = useState<"pick" | "free">(freeAuto ? "free" : "pick");
  const [free, setFree] = useState<{ id: string; context: number }[]>([]);
  const [pinned, setPinned] = useState<string[]>(freeAuto ? fallbackModels : []);
  const [reserves, setReserves] = useState<string[]>(freeAuto ? ["", ""] : [fallbackModels[0] ?? "", fallbackModels[1] ?? ""]);
  const [models, setModels] = useState<string[]>([...new Set([model, ...fallbackModels].filter(Boolean))]);
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
  const loadFree = () => start(async () => {
    const r = await listFreeModelsAction(data());
    if (r.error) setNote({ ok: false, message: r.error });
    else { setFree(r.models); setNote({ ok: true, message: r.models.length ? `${r.models.length} modelos gratuitos com suporte a ferramentas agora.` : "Nenhum modelo gratuito com ferramentas disponível agora." }); }
  });
  const test = () => start(async () => setNote(await testLlmAction(data())));
  const freeMode = choice === "openrouter" && mode === "free";
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
            {choice === "openrouter" && (
              <div className="lg:col-span-2">
                <ChoiceCards name="orMode" value={mode} onChange={setMode} options={[
                  { value: "pick", title: "Eu escolho o modelo", text: "Um modelo principal e, se quiser, até dois reservas para quando ele falhar." },
                  { value: "free", title: "Só modelos gratuitos, em rodízio", text: "O sistema usa os modelos gratuitos do momento e troca sozinho quando um atinge o limite ou sai do ar.", tag: <Badge tone="ok">Custo zero</Badge> },
                ]} />
                {freeMode && <input type="hidden" name="freeAuto" value="on" />}
              </div>
            )}
            <Field label="Chave de API" hint={keyHint} className={freeMode ? "lg:col-span-2" : undefined}><Input name="apiKey" type="password" autoComplete="off" placeholder={hasKey && choice === provider ? "••••••••" : ""} /></Field>
            {freeMode ? (
              <div className="space-y-4 lg:col-span-2">
                <Notice tone="sun">Modelos gratuitos têm limite diário de uso e podem ficar mais lentos ou sair do ar sem aviso. O rodízio contorna isso, mas a qualidade das respostas varia de um modelo para outro. Se nenhum responder, a conversa vai para a equipe, como sempre.</Notice>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="t-small">Opcional: marque os que devem ser tentados primeiro. Os demais entram na fila automaticamente.</p>
                  <Button type="button" variant="outline" onClick={loadFree} disabled={pending}>{pending ? <Loader2 className="animate-spin" aria-hidden /> : null}Ver gratuitos de agora</Button>
                </div>
                {(free.length > 0 || pinned.length > 0) && (
                  <ul className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
                    {[...new Set([...pinned, ...free.map((m) => m.id)])].map((id) => {
                      const info = free.find((m) => m.id === id);
                      const on = pinned.includes(id);
                      return (
                        <li key={id}>
                          <label className={cn("flex h-14 cursor-pointer items-center gap-3 rounded-md border px-3", on ? "border-acento bg-acento/[0.07]" : "border-line hover:border-bone-mute/50")}>
                            <input type="checkbox" name="fallback" value={id} checked={on} onChange={(e) => setPinned((p) => e.target.checked ? [...p, id].slice(0, 5) : p.filter((x) => x !== id))} className="size-4 accent-[var(--color-gold)]" />
                            <span className="min-w-0"><span className="block truncate font-mono text-[12.5px]">{id}</span><span className="t-small">{info ? `contexto de ${Math.round(info.context / 1000)} mil tokens` : "fora da lista de agora"}</span></span>
                            {on && <span className="ml-auto font-mono text-[11px] text-acento">{pinned.indexOf(id) + 1}º</span>}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ) : (
            <Field label="Modelo" hint="Carregue a lista e escolha. O modelo precisa aceitar ferramentas (tool calling).">
              <div className="flex gap-3">
                <Select name="model" value={selected} onChange={(e) => setSelected(e.target.value)} className="min-w-0 flex-1">
                  <option value="">{models.length ? "Escolha um modelo…" : "Clique em Carregar modelos"}</option>
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                </Select>
                <Button type="button" variant="outline" onClick={load} disabled={pending}>{pending ? <Loader2 className="animate-spin" aria-hidden /> : null}Carregar modelos</Button>
              </div>
            </Field>
            )}
            {!freeMode && choice !== "anthropic" && models.length > 0 && (
              <div className="grid gap-5 sm:grid-cols-2 lg:col-span-2">
                {[0, 1].map((i) => (
                  <Field key={i} label={`Reserva ${i + 1} (opcional)`} hint={i === 0 ? "Usado se o principal falhar por limite ou instabilidade." : "Tentado depois da reserva 1."}>
                    <Select name="fallback" value={reserves[i]} onChange={(e) => setReserves((r) => r.map((x, j) => (j === i ? e.target.value : x)))}>
                      <option value="">Nenhum</option>
                      {models.filter((m) => m !== selected).map((m) => <option key={m} value={m}>{m}</option>)}
                    </Select>
                  </Field>
                ))}
              </div>
            )}
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
