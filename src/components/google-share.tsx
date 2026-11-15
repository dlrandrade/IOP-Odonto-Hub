"use client";

import { useState } from "react";
import { Check, Copy, Download, ExternalLink, Star } from "lucide-react";
import { buttonClass } from "./ui";

/**
 * Link de avaliação do Google + QR code para compartilhar (balcão, cartão, WhatsApp).
 * O QR é gerado no servidor (SVG); aqui só copiar, abrir e baixar.
 */
export function GoogleShare({ reviewUrl, profileUrl, qr, clinicName, compact }: { reviewUrl: string; profileUrl?: string | null; qr: string; clinicName: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(reviewUrl); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* navegador sem permissão: o link segue visível */ }
  };
  const file = `avaliar-${clinicName.normalize("NFD").replace(/[^\w]+/g, "-").toLowerCase()}.svg`;
  return (
    <div className={compact ? "flex flex-wrap items-center gap-5" : "grid items-center gap-6 sm:grid-cols-[176px_minmax(0,1fr)]"}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qr} alt="QR code para avaliar a clínica no Google" className={compact ? "size-28 rounded-md bg-white p-1.5" : "size-44 rounded-lg bg-white p-2"} />
      <div className="min-w-0 space-y-3">
        <p className="flex items-center gap-2 text-[14px] font-medium"><Star size={15} className="text-gold" aria-hidden /> Link para avaliar no Google</p>
        <code className="block select-all truncate rounded-sm bg-bone/[0.05] px-3 py-2 font-mono text-[12px] text-bone-dim" title={reviewUrl}>{reviewUrl}</code>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={copy} className={buttonClass("outline", "sm")}>{copied ? <Check aria-hidden /> : <Copy aria-hidden />}{copied ? "Copiado" : "Copiar link"}</button>
          <a href={qr} download={file} className={buttonClass("outline", "sm")}><Download aria-hidden /> Baixar QR</a>
          <a href={reviewUrl} target="_blank" rel="noopener noreferrer" className={buttonClass("ghost", "sm")}><ExternalLink aria-hidden /> Testar</a>
          {profileUrl && <a href={profileUrl} target="_blank" rel="noopener noreferrer" className={buttonClass("ghost", "sm")}><ExternalLink aria-hidden /> Ver perfil</a>}
        </div>
      </div>
    </div>
  );
}
