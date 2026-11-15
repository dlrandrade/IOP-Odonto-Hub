import type { MetadataRoute } from "next";

/** Manifesto do app instalável (Android, desktop e iOS 16.4+). Ícones gerados por scripts/pwa/generate.mjs. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "IOP Odonto Hub",
    short_name: "Odonto Hub",
    description: "Central da clínica: conversas, agenda, pacientes e assistente com IA.",
    lang: "pt-BR",
    dir: "ltr",
    start_url: "/?origem=app",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#0a0e13",
    theme_color: "#0a0e13",
    categories: ["medical", "business", "productivity"],
    icons: [
      { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-1024.png", sizes: "1024x1024", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // Atalhos ao segurar o ícone (Android e desktop).
    shortcuts: [
      { name: "Conversas", url: "/conversas", icons: [{ src: "/pwa/icon-96.png", sizes: "96x96" }] },
      { name: "Agenda de hoje", url: "/agenda", icons: [{ src: "/pwa/icon-96.png", sizes: "96x96" }] },
      { name: "Nova consulta", url: "/agenda?nova=1", icons: [{ src: "/pwa/icon-96.png", sizes: "96x96" }] },
      { name: "Novo paciente", url: "/pacientes?novo=1", icons: [{ src: "/pwa/icon-96.png", sizes: "96x96" }] },
    ],
  };
}
