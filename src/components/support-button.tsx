"use client";

import { usePathname } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { whatsappLink } from "@/domain/contact";

/**
 * Suporte da plataforma pelo WhatsApp: botão flutuante discreto no canto inferior direito.
 * A mensagem já vai com a clínica, a pessoa e a tela em que ela está, para o suporte entender rápido.
 * Some nas telas de conversa (o canto é do botão de enviar).
 */
export function SupportButton({ phone, clinic, name }: { phone: string; clinic: string; name: string }) {
  const path = usePathname();
  if (path.startsWith("/conversas") || path.startsWith("/simulador")) return null;
  const text = `Olá! Sou ${name}, da ${clinic}. Preciso de ajuda no Odonto Hub (tela: ${path === "/" ? "Hoje" : path}).`;
  return (
    <a href={whatsappLink(phone, text)} target="_blank" rel="noopener noreferrer" aria-label="Falar com o suporte pelo WhatsApp" title="Suporte pelo WhatsApp"
      className="group fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-30 flex h-11 items-center gap-2 rounded-full bg-[#25D366] pl-3 pr-3 text-[#0a0e13] opacity-80 shadow-[0_8px_24px_-8px_rgb(37_211_102/0.7)] transition-all hover:opacity-100 hover:pr-4 lg:bottom-6">
      <MessageCircle size={20} aria-hidden strokeWidth={2.2} />
      <span className="max-w-0 overflow-hidden whitespace-nowrap text-[13px] font-semibold transition-[max-width] duration-300 group-hover:max-w-[80px] group-focus-visible:max-w-[80px]">Suporte</span>
    </a>
  );
}
