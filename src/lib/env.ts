/** Leitura central de variáveis de ambiente. Segredos nunca vão para o cliente nem para logs. */
function opt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export const env = {
  get databaseUrl() { return opt("DATABASE_URL"); },
  get supabaseUrl() { return opt("NEXT_PUBLIC_SUPABASE_URL"); },
  get supabaseAnonKey() { return opt("NEXT_PUBLIC_SUPABASE_ANON_KEY"); },
  get supabaseServiceKey() { return opt("SUPABASE_SERVICE_ROLE_KEY"); },
  get fieldKey() { return opt("FIELD_ENCRYPTION_KEY"); },
  get cronSecret() { return opt("CRON_SECRET"); },
  get anthropicKey() { return opt("ANTHROPIC_API_KEY"); },
  get anthropicModel() { return opt("ANTHROPIC_MODEL") ?? "claude-opus-5-5"; },
  get transcriptionUrl() { return opt("TRANSCRIPTION_API_URL"); },
  get transcriptionKey() { return opt("TRANSCRIPTION_API_KEY"); },
  get transcriptionModel() { return opt("TRANSCRIPTION_MODEL") ?? "whisper-1"; },
  get appUrl() { return opt("NEXT_PUBLIC_APP_URL") ?? (opt("VERCEL_PROJECT_PRODUCTION_URL") ? `https://${opt("VERCEL_PROJECT_PRODUCTION_URL")}` : "http://localhost:3000"); },
  get mediaDir() { return opt("MEDIA_DIR") ?? ".data/media"; },
  /** Login local (Postgres puro) só quando pedido explicitamente; nunca é o padrão. */
  get authMode(): "supabase" | "local" { return opt("AUTH_MODE") === "local" ? "local" : "supabase"; },
  /** Gateway wacli da plataforma (WhatsApp por QR Code, não oficial). A clínica pode usar um próprio. */
  wacli: {
    get gatewayUrl() { return opt("WACLI_GATEWAY_URL"); },
    get gatewayToken() { return opt("WACLI_GATEWAY_TOKEN"); },
  },
  /** WhatsApp do suporte da plataforma (botão flutuante). Só números com DDI, ex.: 5511999990000. */
  get supportWhatsApp() { return opt("SUPPORT_WHATSAPP"); },
  /** Google Places API (nota e total de avaliações do Perfil da Empresa). Opcional: sem ela, a clínica registra à mão. */
  get googlePlacesKey() { return opt("GOOGLE_PLACES_API_KEY"); },
  /** E-mail transacional das automações (Resend). Remetente verificado no Resend, ex.: "Clínica <avisos@seudominio.com.br>". */
  email: {
    get resendKey() { return opt("RESEND_API_KEY"); },
    get from() { return opt("EMAIL_FROM"); },
  },
  wa: {
    get verifyToken() { return opt("WHATSAPP_VERIFY_TOKEN"); },
    get appSecret() { return opt("WHATSAPP_APP_SECRET"); },
    get accessToken() { return opt("WHATSAPP_ACCESS_TOKEN"); },
    get phoneNumberId() { return opt("WHATSAPP_PHONE_NUMBER_ID"); },
  },
};

/** O que falta para o sistema funcionar — usado pela tela /setup. */
export function missingEnv(): string[] {
  const missing: string[] = [];
  if (!env.databaseUrl) missing.push("DATABASE_URL");
  if (!env.fieldKey) missing.push("FIELD_ENCRYPTION_KEY");
  if (env.authMode === "supabase") {
    if (!env.supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL");
    if (!env.supabaseAnonKey) missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    if (!env.supabaseServiceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  }
  return missing;
}
