"use client";

import { useTransition, type CSSProperties } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { setVistaAction } from "../../app/(dashboard)/vista-actions";
import { cn } from "@/lib/format";

/** Interruptor "Mostrar detalhes técnicos" (Meu perfil e Configurações). */
export function VistaSwitch({ detailed }: { detailed: boolean }) {
  const [pending, start] = useTransition();
  const toggle = () => start(() => setVistaAction(detailed ? "simples" : "detalhada"));
  return (
    <button type="button" role="switch" aria-checked={detailed} onClick={toggle} disabled={pending}
      className="vidro bloco flex w-full items-center gap-4 rounded-lg p-5 text-left">
      <span className="icone-app size-12 rounded-[14px]" style={{ "--icone-rgb": "124 141 166" } as CSSProperties}>{detailed ? <Eye size={22} aria-hidden /> : <EyeOff size={22} aria-hidden />}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15.5px] font-semibold">Mostrar detalhes técnicos</span>
        <span className="t-small block">{detailed ? "Ligado: custos da IA, históricos, códigos e opções avançadas aparecem." : "Desligado: a tela mostra só o essencial do dia a dia."}</span>
      </span>
      <span aria-hidden className={cn("relative inline-block h-[31px] w-[51px] shrink-0 rounded-full transition-colors", detailed ? "bg-ok" : "bg-line")}>
        {pending ? <Loader2 size={14} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 animate-spin text-bone" />
          : <span className={cn("absolute top-[2px] size-[27px] rounded-full bg-white shadow-[0_2px_6px_rgb(0_0_0/0.3)] transition-[left] duration-200", detailed ? "left-[22px]" : "left-[2px]")} />}
      </span>
    </button>
  );
}

/** Botão do operador no topo: alterna entre a visão completa e a visão do cliente. */
export function VerComoCliente({ detailed }: { detailed: boolean }) {
  const [pending, start] = useTransition();
  return (
    <button type="button" onClick={() => start(() => setVistaAction(detailed ? "simples" : "detalhada"))} disabled={pending}
      title={detailed ? "Ver a tela como a clínica vê (visualização simples)" : "Voltar a ver todos os detalhes"}
      className={cn("hidden h-8 items-center gap-1.5 rounded-sm border px-2.5 font-mono sm:flex text-[10.5px] font-medium uppercase tracking-[0.08em] transition-colors",
        detailed ? "border-line text-bone-dim hover:border-bone-mute/50 hover:text-bone" : "border-acento/60 bg-acento/15 text-acento")}>
      {pending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : detailed ? <Eye size={13} aria-hidden /> : <EyeOff size={13} aria-hidden />}
      <span className="hidden md:inline">{detailed ? "Ver como cliente" : "Vendo como cliente"}</span>
    </button>
  );
}
