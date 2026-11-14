"use client";

import { useActionState, useEffect, useRef, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { buttonClass } from "./ui";
import { cn } from "@/lib/format";

export type ActionState = { ok?: boolean; error?: string; message?: string } | null;
export type FormAction = (prev: ActionState, data: FormData) => Promise<ActionState>;

/** Formulário ligado a uma server action: mostra erro/sucesso e fecha o modal pai quando dá certo. */
export function ActionForm({ action, children, className, resetOnDone = true }: { action: FormAction; children: ReactNode; className?: string; resetOnDone?: boolean }) {
  const [state, formAction, pending] = useActionState(action, null);
  const [, startTransition] = useTransition();
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) {
      if (resetOnDone) ref.current?.reset();
      ref.current?.dispatchEvent(new CustomEvent("action:done", { bubbles: true }));
    }
  }, [state, resetOnDone]);
  return (
    <form
      ref={ref}
      action={formAction}
      aria-busy={pending}
      // Enviamos manualmente para o React não limpar os campos quando a ação devolve erro
      // (o comportamento padrão de <form action> apaga o que a pessoa digitou).
      onSubmit={(e) => {
        e.preventDefault();
        const submitter = (e.nativeEvent as SubmitEvent).submitter;
        const data = new FormData(e.currentTarget, submitter);
        startTransition(() => formAction(data));
      }}
    >
      {/* O layout (space-y, flex, grid) vai no fieldset, que é o pai direto dos campos. */}
      <fieldset disabled={pending} className={cn("m-0 min-w-0 border-0 p-0", className)}>{children}</fieldset>
      {state?.error && <p role="alert" className="mt-4 rounded-sm border-l-2 border-danger bg-danger-soft px-4 py-3 text-[14px] text-danger">{state.error}</p>}
      {state?.ok && state.message && <p role="status" className="mt-4 rounded-sm border-l-2 border-ok bg-ok-soft px-4 py-3 text-[14px] text-ok">{state.message}</p>}
    </form>
  );
}

/**
 * Janela sobreposta padrão. `defaultOpen` abre sozinha (links como /agenda?nova=1 levam direto ao formulário).
 * Fecha com Esc, com o X ou clicando fora, e também quando o formulário dentro dela conclui.
 */
export function Modal({ trigger, title, children, triggerClass, wide, defaultOpen, description }: {
  trigger: ReactNode; title: string; children: ReactNode; triggerClass?: string; wide?: boolean; defaultOpen?: boolean; description?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const close = () => el.close();
    el.addEventListener("action:done", close);
    if (defaultOpen && !el.open) el.showModal();
    return () => el.removeEventListener("action:done", close);
  }, [defaultOpen]);
  return (
    <>
      <button type="button" className={triggerClass ?? buttonClass("primary")} onClick={() => ref.current?.showModal()}>{trigger}</button>
      <dialog ref={ref} className={cn("relative w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface p-0 text-bone shadow-deep", wide ? "max-w-2xl" : "max-w-lg")}
        onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}>
        <div className="border-b border-line py-5 pl-6 pr-16">
          <h2 className="t-h2">{title}</h2>
          {description && <p className="t-small mt-1">{description}</p>}
        </div>
        <div className="max-h-[75vh] overflow-y-auto px-6 py-6">{children}</div>
        {/* o botão de fechar vem depois do conteúdo: ao abrir, o foco cai no primeiro campo, não no X */}
        <button type="button" aria-label="Fechar" className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-sm text-bone-mute transition-colors hover:bg-surface-2 hover:text-bone" onClick={() => ref.current?.close()}><X size={18} /></button>
      </dialog>
    </>
  );
}

/** Atualiza a tela sem recarregar: Realtime do Supabase quando configurado, com polling curto como garantia. */
export function LiveRefresh({ seconds = 5, clinicId }: { seconds?: number; clinicId?: string }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") router.refresh(); };
    const timer = setInterval(tick, seconds * 1000);
    let cleanup = () => {};
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (url && key && clinicId) {
      void import("@supabase/ssr").then(({ createBrowserClient }) => {
        const client = createBrowserClient(url, key);
        const channel = client.channel(`inbox-${clinicId}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `clinic_id=eq.${clinicId}` }, tick)
          .on("postgres_changes", { event: "*", schema: "public", table: "conversations", filter: `clinic_id=eq.${clinicId}` }, tick)
          .subscribe();
        cleanup = () => { void client.removeChannel(channel); };
      });
    }
    return () => { clearInterval(timer); cleanup(); };
  }, [router, seconds, clinicId]);
  return null;
}

export function SubmitOnChange({ children, className }: { children: ReactNode; className?: string }) {
  return <form className={className} onChange={(e) => e.currentTarget.requestSubmit()}>{children}</form>;
}

export function ScrollToEnd({ dep }: { dep: string | number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ block: "end" }); }, [dep]);
  return <div ref={ref} />;
}
