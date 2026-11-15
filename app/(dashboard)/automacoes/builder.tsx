"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type ReactNode } from "react";
import { Cake, CalendarCheck, CalendarClock, ClipboardList, GripVertical, MessageSquareText, UserX } from "lucide-react";
import { ActionForm, type FormAction } from "@/components/client";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { cn } from "@/lib/format";

/* ───────── Lista ordenável (arrastar e soltar) ───────── */

export function FlowList({ items, reorder }: { items: { key: string; node: ReactNode }[]; reorder: FormAction }) {
  const router = useRouter();
  const [order, setOrder] = useState(items.map((i) => i.key));
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [, start] = useTransition();
  const byKey = new Map(items.map((i) => [i.key, i.node]));
  // Itens novos (criados depois) entram no fim; removidos somem.
  const keys = [...order.filter((k) => byKey.has(k)), ...items.map((i) => i.key).filter((k) => !order.includes(k))];

  const drop = (target: string) => {
    if (!dragging || dragging === target) return;
    const next = keys.filter((k) => k !== dragging);
    next.splice(next.indexOf(target), 0, dragging);
    setOrder(next);
    const form = new FormData();
    form.set("order", JSON.stringify(next));
    start(async () => { await reorder(null, form); router.refresh(); });
  };

  return (
    <ol className="space-y-3">
      {keys.map((k, i) => (
        <li key={k} draggable
          onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", k); setDragging(k); }}
          onDragEnd={() => { setDragging(null); setOver(null); }}
          onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(k); } }}
          onDrop={(e) => { e.preventDefault(); drop(k); setOver(null); }}
          className={cn("vidro group relative flex items-stretch gap-3 rounded-lg transition-[opacity,box-shadow]",
            dragging === k && "opacity-40", over === k && dragging !== k && "shadow-[0_-2px_0_0_rgb(var(--acento-rgb))]")}>
          <span className="flex w-10 shrink-0 cursor-grab flex-col items-center justify-center gap-1 rounded-l-lg border-r border-line text-bone-mute active:cursor-grabbing group-hover:text-bone-dim" title="Arraste para reordenar" aria-hidden>
            <span className="font-mono text-[11px]">{String(i + 1).padStart(2, "0")}</span>
            <GripVertical size={16} />
          </span>
          <div className="min-w-0 flex-1 py-5 pr-5">{byKey.get(k)}</div>
        </li>
      ))}
    </ol>
  );
}

/* ───────── Interruptor liga/desliga ───────── */

export function Switch({ name, on, action, label }: { name: string; on: boolean; action: FormAction; label: string }) {
  const router = useRouter();
  const [value, setValue] = useState(on);
  const [pending, start] = useTransition();
  return (
    <button type="button" role="switch" aria-checked={value} aria-label={label} disabled={pending}
      onClick={() => {
        const next = !value;
        setValue(next);
        const form = new FormData();
        form.set("key", name);
        form.set("on", String(next));
        start(async () => {
          const r = await action(null, form);
          if (r?.error) setValue(!next);
          router.refresh();
        });
      }}
      className="group inline-flex items-center gap-2.5 disabled:opacity-60">
      <span className={cn("relative inline-block h-6 w-11 shrink-0 rounded-full border transition-colors", value ? "border-ok bg-ok" : "border-line bg-surface-2")}>
        <span className={cn("absolute left-0 top-[2px] size-[18px] rounded-full shadow transition-transform", value ? "translate-x-[21px] bg-white" : "translate-x-[2px] bg-bone-mute")} />
      </span>
      <span className={cn("w-14 text-left font-mono text-[10.5px] uppercase tracking-[0.1em]", value ? "text-ok" : "text-bone-mute")}>{value ? "Ativa" : "Pausada"}</span>
    </button>
  );
}

/* ───────── Formulário de automação da clínica ───────── */

export type RuleDraft = {
  id?: string; name: string; trigger: string; amount: number; unit: "minutes" | "hours" | "days"; time: string;
  action: "message" | "task"; body: string; taskTitle: string; templateName: string;
};

export const TRIGGERS: { key: string; title: string; text: string; icon: typeof Cake }[] = [
  { key: "before_appointment", title: "Antes da consulta", text: "Um tempo antes do horário marcado.", icon: CalendarClock },
  { key: "after_appointment", title: "Depois da consulta", text: "Quando a consulta é concluída.", icon: CalendarCheck },
  { key: "no_show", title: "Quando falta", text: "Quando a falta é registrada.", icon: UserX },
  { key: "birthday", title: "No aniversário", text: "No dia, no horário escolhido.", icon: Cake },
];

const PRESETS: (Omit<RuleDraft, "id"> & { hint: string })[] = [
  { name: "Agradecimento pós-consulta", hint: "2 h depois da consulta", trigger: "after_appointment", amount: 2, unit: "hours", time: "09:00", action: "message", taskTitle: "", templateName: "",
    body: "Olá, {primeiro_nome}! Obrigado pela visita hoje à {clinica}. Se ficar qualquer dúvida, é só responder por aqui." },
  { name: "Convite para remarcar após falta", hint: "1 h depois da falta", trigger: "no_show", amount: 1, unit: "hours", time: "09:00", action: "message", taskTitle: "", templateName: "",
    body: "Olá, {primeiro_nome}! Sentimos sua falta hoje na {clinica}. Quer que eu veja um novo horário para você?" },
  { name: "Parabéns de aniversário", hint: "às 9h do dia", trigger: "birthday", amount: 0, unit: "hours", time: "09:00", action: "message", taskTitle: "", templateName: "",
    body: "Feliz aniversário, {primeiro_nome}! Toda a equipe da {clinica} deseja um ótimo dia." },
  { name: "Ligar antes de procedimentos", hint: "3 dias antes, vira tarefa", trigger: "before_appointment", amount: 3, unit: "days", time: "09:00", action: "task", body: "", templateName: "",
    taskTitle: "Ligar para {paciente} sobre {servico} em {data}" },
];

const VARS: [string, string][] = [["{primeiro_nome}", "Primeiro nome"], ["{paciente}", "Nome completo"], ["{servico}", "Serviço"], ["{dentista}", "Dentista"], ["{data}", "Data e hora"], ["{clinica}", "Clínica"]];

const EMPTY: RuleDraft = { name: "", trigger: "after_appointment", amount: 2, unit: "hours", time: "09:00", action: "message", body: "", taskTitle: "", templateName: "" };

export function RuleForm({ rule, templates, action }: { rule?: RuleDraft; templates: string[]; action: FormAction }) {
  const [d, setD] = useState<RuleDraft>(rule ?? EMPTY);
  const [formKey, setFormKey] = useState(0);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<RuleDraft>) => setD((x) => ({ ...x, ...patch }));
  const insertVar = (v: string) => {
    const el = bodyRef.current;
    const field = d.action === "message" ? "body" : "taskTitle";
    const current = d[field];
    const pos = el && d.action === "message" ? el.selectionStart : current.length;
    set({ [field]: current.slice(0, pos) + v + current.slice(pos) });
  };

  return (
    <div className="space-y-6">
      {!rule && (
        <section>
          <h3 className="t-h3">Comece por um modelo</h3>
          <p className="t-small mt-1">Ou monte do zero logo abaixo. Tudo pode ser ajustado.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {PRESETS.map((p) => (
              <button key={p.name} type="button" onClick={() => { setD({ ...p }); setFormKey((k) => k + 1); }}
                className={cn("flex h-[72px] flex-col justify-center rounded-md border px-4 text-left transition-colors", d.name === p.name ? "border-acento bg-acento/10" : "border-line hover:border-bone-mute/50")}>
                <span className="text-[14px] font-medium">{p.name}</span>
                <span className="t-small">{p.hint}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <ActionForm key={formKey} action={action} className="space-y-6" resetOnDone={!rule}>
        {rule?.id && <input type="hidden" name="ruleId" value={rule.id} />}
        <input type="hidden" name="trigger" value={d.trigger} />
        <input type="hidden" name="action" value={d.action} />

        <Field label="Nome da automação"><Input name="name" value={d.name} onChange={(e) => set({ name: e.target.value })} required placeholder="Ex.: Agradecimento pós-consulta" /></Field>

        <section>
          <p className="mb-2 text-[13px] font-medium">1. Quando acontece</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {TRIGGERS.map((t) => (
              <button key={t.key} type="button" aria-pressed={d.trigger === t.key} onClick={() => set({ trigger: t.key })}
                className={cn("flex min-h-[104px] flex-col gap-2 rounded-md border p-3 text-left transition-colors", d.trigger === t.key ? "border-acento bg-acento/10" : "border-line hover:border-bone-mute/50")}>
                <t.icon size={18} aria-hidden className={d.trigger === t.key ? "text-acento" : "text-bone-mute"} />
                <span className="text-[13px] font-medium leading-tight">{t.title}</span>
                <span className="t-small text-[11.5px] leading-snug">{t.text}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <p className="mb-2 text-[13px] font-medium">2. {d.trigger === "birthday" ? "Em que horário" : d.trigger === "before_appointment" ? "Quanto tempo antes" : "Quanto tempo depois"}</p>
          {d.trigger === "birthday" ? (
            <Input type="time" name="time" value={d.time} onChange={(e) => set({ time: e.target.value })} className="w-40" required />
          ) : (
            <div className="flex gap-2">
              <Input type="number" name="amount" min={0} step="any" value={d.amount} onChange={(e) => set({ amount: Number(e.target.value) })} className="w-28" required />
              <Select name="unit" value={d.unit} onChange={(e) => set({ unit: e.target.value as RuleDraft["unit"] })} className="w-40">
                <option value="minutes">minutos</option><option value="hours">horas</option><option value="days">dias</option>
              </Select>
            </div>
          )}
          <p className="t-small mt-2">Mensagens respeitam o horário permitido e o limite diário definidos em “Limites para todas”.</p>
        </section>

        <section>
          <p className="mb-2 text-[13px] font-medium">3. O que fazer</p>
          <div className="grid grid-cols-2 gap-2">
            {([["message", "Enviar mensagem no WhatsApp", MessageSquareText], ["task", "Criar tarefa para a equipe", ClipboardList]] as const).map(([k, label, Icon]) => (
              <button key={k} type="button" aria-pressed={d.action === k} onClick={() => set({ action: k })}
                className={cn("flex h-14 items-center gap-3 rounded-md border px-4 text-left text-[13.5px] font-medium transition-colors", d.action === k ? "border-acento bg-acento/10" : "border-line hover:border-bone-mute/50")}>
                <Icon size={17} aria-hidden className={d.action === k ? "text-acento" : "text-bone-mute"} /> {label}
              </button>
            ))}
          </div>
          <div className="mt-4 space-y-3">
            {d.action === "message" ? (
              <Field label="Mensagem"><Textarea ref={bodyRef} name="body" value={d.body} onChange={(e) => set({ body: e.target.value })} className="min-h-24" required /></Field>
            ) : (
              <Field label="Título da tarefa"><Input name="taskTitle" value={d.taskTitle} onChange={(e) => set({ taskTitle: e.target.value })} required /></Field>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="t-small mr-1">Inserir:</span>
              {VARS.map(([v, label]) => (
                <button key={v} type="button" onClick={() => insertVar(v)} className="h-7 rounded-sm border border-line px-2 text-[12px] text-bone-dim transition-colors hover:border-acento hover:text-bone">{label}</button>
              ))}
            </div>
            {d.action === "message" && templates.length > 0 && (
              <Field label="Template para fora da janela de 24 h (opcional)" hint="No WhatsApp oficial, sem template aprovado a mensagem vira tarefa para a equipe.">
                <Select name="templateName" value={d.templateName} onChange={(e) => set({ templateName: e.target.value })}>
                  <option value="">Nenhum</option>{templates.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
              </Field>
            )}
          </div>
        </section>

        <div className="flex justify-end border-t border-line pt-5">
          <Button type="submit">{rule ? "Salvar automação" : "Criar automação"}</Button>
        </div>
      </ActionForm>
    </div>
  );
}
