"use client";

import { useEffect, useState } from "react";
import { Plus, Share, X } from "lucide-react";
import { buttonClass } from "./ui";

/** Registra o service worker (só em produção/https: no dev ele atrapalharia o recarregamento). */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => { /* sem SW o sistema funciona igual */ });
  }, []);
  return null;
}

type BeforeInstall = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
const KEY = "app-instalar-dispensado";
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/**
 * Convite para instalar o app. iPhone/iPad não têm botão de instalar: mostramos o passo a passo
 * (Compartilhar → Adicionar à Tela de Início). Android/Chrome: botão que abre o instalador do sistema.
 * Aparece uma vez por aparelho (pode ser reaberto em Meu perfil).
 */
export function InstallHint({ always = false }: { always?: boolean }) {
  const [mode, setMode] = useState<"ios" | "prompt" | null>(null);
  const [deferred, setDeferred] = useState<BeforeInstall | null>(null);

  useEffect(() => {
    if (isStandalone()) return;
    let dismissed = false;
    try { dismissed = localStorage.getItem(KEY) === "1"; } catch { /* modo privado */ }
    if (dismissed && !always) return;
    if (isIos()) { setMode("ios"); return; }
    const onPrompt = (e: Event) => { e.preventDefault(); setDeferred(e as BeforeInstall); setMode("prompt"); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, [always]);

  const dismiss = () => { try { localStorage.setItem(KEY, "1"); } catch { /* ignora */ } setMode(null); };
  if (!mode) return always ? <p className="t-small">O app já está instalado neste aparelho, ou este navegador não permite instalar.</p> : null;

  const body = (
    <div className="flex items-start gap-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/pwa/icon-192.png" alt="" className="size-14 shrink-0 rounded-[14px] shadow-deep" />
      <div className="min-w-0 flex-1">
        <p className="t-h3">Instale o Odonto Hub</p>
        {mode === "ios" ? (
          <ol className="t-small mt-1.5 space-y-1.5">
            <li className="flex flex-wrap items-center gap-1.5">1. Toque em <span className="inline-flex items-center gap-1 rounded-md bg-bone/[0.08] px-1.5 py-0.5 text-bone"><Share size={13} aria-hidden /> Compartilhar</span> na barra do Safari</li>
            <li className="flex flex-wrap items-center gap-1.5">2. Escolha <span className="inline-flex items-center gap-1 rounded-md bg-bone/[0.08] px-1.5 py-0.5 text-bone"><Plus size={13} aria-hidden /> Adicionar à Tela de Início</span></li>
          </ol>
        ) : (
          <p className="t-small mt-1">Abre em tela cheia, direto do ícone, como um aplicativo.</p>
        )}
        {mode === "prompt" && deferred && (
          <button type="button" className={buttonClass("primary", "sm") + " mt-3"} onClick={async () => { await deferred.prompt(); await deferred.userChoice; setMode(null); }}>Instalar app</button>
        )}
      </div>
      {!always && <button type="button" aria-label="Agora não" onClick={dismiss} className="flex size-8 shrink-0 items-center justify-center rounded-full bg-bone/[0.07] text-bone-mute hover:bg-bone/[0.14]"><X size={16} /></button>}
    </div>
  );
  if (always) return body;
  return (
    <div role="dialog" aria-label="Instalar o app" className="vidro-forte fixed inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-50 rounded-[22px] border p-4 shadow-deep lg:hidden">
      {body}
    </div>
  );
}
