"use client";

import { useState, useTransition } from "react";
import { Check, Copy, MessageCircle } from "lucide-react";
import { whatsappLink } from "@/domain/contact";
import { markTaskDoneAction } from "../../app/(dashboard)/task-actions";
import { cn } from "@/lib/format";

/**
 * Envio por clique: abre o WhatsApp (Web no computador, app no celular) com o paciente e a mensagem prontos,
 * e marca a tarefa como feita. A pessoa só confere e aperta enviar no WhatsApp.
 */
export function ClickToSend({ taskId, phone, text, compact }: { taskId?: string; phone: string; text: string; compact?: boolean }) {
  const [, start] = useTransition();
  const [copied, setCopied] = useState(false);
  const open = () => {
    window.open(whatsappLink(phone, text), "_blank", "noopener,noreferrer");
    if (taskId) start(() => markTaskDoneAction(taskId));
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <button type="button" onClick={open} title="Abre o WhatsApp com a mensagem pronta"
        className={cn("btn inline-flex shrink-0 items-center gap-2 rounded-full bg-[#25D366] font-semibold text-[#0a0e13] transition-[filter] hover:brightness-95", compact ? "h-8 px-3 text-[12.5px]" : "h-10 px-4 text-[13.5px]")}>
        <MessageCircle size={compact ? 14 : 16} aria-hidden /> Enviar no WhatsApp
      </button>
      <button type="button" aria-label="Copiar mensagem" title="Copiar mensagem" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* sem permissão */ } }}
        className="flex size-8 items-center justify-center rounded-full text-bone-mute transition-colors hover:bg-bone/[0.08] hover:text-bone">
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
    </span>
  );
}
