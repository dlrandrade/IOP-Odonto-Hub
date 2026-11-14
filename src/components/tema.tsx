"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { temaDaRota } from "@/lib/tema";

/** Aplica a cor da página (--acento-rgb) e a tintura das superfícies ([data-tema]). */
export function TemaPagina() {
  const caminho = usePathname();
  useEffect(() => {
    const t = temaDaRota(caminho);
    document.body.style.setProperty("--acento-rgb", t.rgb);
    document.documentElement.style.setProperty("--acento-rgb", t.rgb);
    document.body.dataset.tema = t.hex;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#0a0e13");
  }, [caminho]);
  return null;
}
