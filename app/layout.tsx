import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist_Mono, Inter } from "next/font/google";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { TemaPagina } from "@/components/tema";
import { PwaRegister } from "@/components/pwa";
import { startupImages } from "@/lib/pwa";
import "./globals.css";

const display = Bricolage_Grotesque({ subsets: ["latin"], weight: ["700", "800"], variable: "--font-bricolage", display: "swap" });
const sans = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-geist-mono", display: "swap" });

const INK = { dark: "#0a0e13", light: "#f5f3ee" } as const;
const themeOf = async () => ((await cookies()).get("tema")?.value === "light" ? "light" : "dark");

/** Metadados do app instalável: no iPhone abre em tela cheia, com ícone, nome e tela de abertura próprios. */
export async function generateMetadata(): Promise<Metadata> {
  const theme = await themeOf();
  return {
    title: { default: "IOP Odonto Hub", template: "%s · IOP Odonto Hub" },
    description: "Central odontológica com IA: WhatsApp, agenda, CRM e pacientes em um só lugar.",
    applicationName: "Odonto Hub",
    appleWebApp: {
      capable: true,
      title: "Odonto Hub",
      // Escuro: o conteúdo passa por baixo da barra de status (texto branco). Claro: barra padrão com texto escuro.
      statusBarStyle: theme === "dark" ? "black-translucent" : "default",
      startupImage: startupImages,
    },
    formatDetection: { telephone: false, email: false, address: false },
    icons: {
      icon: [{ url: "/pwa/icon-32.png", sizes: "32x32", type: "image/png" }, { url: "/pwa/icon-192.png", sizes: "192x192", type: "image/png" }],
      apple: [{ url: "/pwa/apple-touch-icon.png", sizes: "180x180" }],
    },
    // iOS anterior ao 16.4 ainda lê a tag antiga para abrir em tela cheia.
    other: { "apple-mobile-web-app-capable": "yes" },
  };
}

export async function generateViewport(): Promise<Viewport> {
  // viewport-fit=cover: o app ocupa a tela inteira, inclusive atrás do notch; as áreas seguras são tratadas no CSS.
  return { themeColor: INK[await themeOf()], width: "device-width", initialScale: 1, viewportFit: "cover" };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Tema escolhido pelo usuário (cookie): aplicado já no HTML do servidor, sem piscar.
  const theme = await themeOf();
  return (
    <html lang="pt-BR" data-theme={theme} className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh text-bone antialiased" data-tema="">
        <TemaPagina />
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
