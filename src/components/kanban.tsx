"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import type { ActionState } from "@/components/client";
import { cn } from "@/lib/format";

type MoveAction = (prev: ActionState, form: FormData) => Promise<ActionState>;

/** Cartão arrastável do funil. O conteúdo (e o botão "Mover / editar", que continua valendo) vem do servidor. */
export function DragCard({ id, children, className, enabled }: { id: string; children: ReactNode; className?: string; enabled: boolean }) {
  const [dragging, setDragging] = useState(false);
  return (
    <li draggable={enabled} data-id={id}
      onDragStart={(e) => { e.dataTransfer.setData("text/opportunity", id); e.dataTransfer.effectAllowed = "move"; setDragging(true); }}
      onDragEnd={() => setDragging(false)}
      className={cn(className, enabled && "cursor-grab active:cursor-grabbing", dragging && "opacity-40")}>
      {children}
    </li>
  );
}

/**
 * Coluna que recebe cartões. "Aceito" pede a evidência e "Perdido" o motivo antes de mover —
 * as mesmas regras do servidor, que valida tudo de novo.
 */
export function DropColumn({ stage, label, move, enabled, className, children }: {
  stage: string; label: string; move: MoveAction; enabled: boolean; className?: string; children: ReactNode;
}) {
  const router = useRouter();
  const [over, setOver] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-label={label} aria-busy={pending}
      onDragOver={(e) => { if (!enabled || !e.dataTransfer.types.includes("text/opportunity")) return; e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData("text/opportunity");
        if (!id) return;
        e.preventDefault();
        const form = new FormData();
        form.set("opportunityId", id);
        form.set("to", stage);
        if (stage === "lost") {
          const reason = window.prompt("Qual o motivo da perda? (obrigatório)");
          if (!reason?.trim()) return;
          form.set("lostReason", reason.trim());
        }
        if (stage === "accepted") {
          const evidence = window.prompt("O que comprova o aceite? (mensagem, assinatura, registro)");
          if (!evidence?.trim()) return;
          form.set("evidence", evidence.trim());
        }
        start(async () => {
          const r = await move(null, form);
          setError(r?.error ?? null);
          router.refresh();
        });
      }}
      className={cn(className, "transition-[box-shadow,background-color]", over && "shadow-[inset_0_0_0_2px_rgb(var(--acento-rgb)/0.7)]", pending && "opacity-70")}>
      {children}
      {error && <p role="alert" className="mx-1 mt-2 rounded-sm bg-danger-soft px-3 py-2 text-[12px] text-danger">{error}</p>}
    </section>
  );
}
