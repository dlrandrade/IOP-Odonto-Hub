import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist_Mono, Inter } from "next/font/google";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { TemaPagina } from "@/components/tema";
import "./globals.css";

const display = Bricolage_Grotesque({ subsets: ["latin"], weight: ["700", "800"], variable: "--font-bricolage", display: "swap" });
const sans = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "IOP Odonto Hub", template: "%s · IOP Odonto Hub" },
  description: "Central odontológica com IA: WhatsApp, agenda, CRM e pacientes em um só lugar.",
};
export const viewport: Viewport = { themeColor: "#0a0e13", width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Tema escolhido pelo usuário (cookie): aplicado já no HTML do servidor, sem piscar.
  const theme = (await cookies()).get("tema")?.value === "light" ? "light" : "dark";
  return (
    <html lang="pt-BR" data-theme={theme} className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh text-bone antialiased" data-tema="">
        <TemaPagina />
        {children}
      </body>
    </html>
  );
}
