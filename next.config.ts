import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";
const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseWs = supabase.replace(/^https:/, "wss:");

/**
 * Cabeçalhos de segurança em todas as páginas. A CSP limita de onde vêm scripts, imagens e conexões:
 * o próprio sistema e o Supabase (login, Realtime e links temporários de mídia). Fontes são servidas
 * pelo próprio Next (next/font). 'unsafe-inline' em scripts é exigido pelo carregamento do App Router.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  ["img-src 'self' data: blob:", supabase].filter(Boolean).join(" "),
  ["media-src 'self' blob:", supabase].filter(Boolean).join(" "),
  "font-src 'self' data:",
  ["connect-src 'self'", supabase, supabase && supabaseWs, dev && "ws:"].filter(Boolean).join(" "),
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  ...(dev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const config: NextConfig = {
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
