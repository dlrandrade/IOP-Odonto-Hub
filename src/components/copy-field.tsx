"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { buttonClass } from "./ui";

/** Campo só de leitura com botão "Copiar" (links secretos, endereços para colar em outro sistema). */
export function CopyField({ value, label = "Copiar link" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <code className="block min-w-0 flex-1 select-all truncate rounded-sm bg-bone/[0.05] px-3 py-2.5 font-mono text-[12px] text-bone-dim" title={value}>{value}</code>
      <button type="button" className={buttonClass("outline", "sm") + " sm:h-auto"} onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* sem permissão */ } }}>
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}{copied ? "Copiado" : label}
      </button>
    </div>
  );
}
