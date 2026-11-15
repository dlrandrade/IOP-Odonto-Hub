-- Terceiro canal de WhatsApp: gateway wacli (WhatsApp Web, não oficial), uma sessão por clínica.
-- O gateway padrão vem das variáveis da plataforma (WACLI_GATEWAY_URL/TOKEN); a clínica pode apontar para um próprio.

alter table clinic_integrations drop constraint clinic_integrations_wa_provider_check;
alter table clinic_integrations add constraint clinic_integrations_wa_provider_check check (wa_provider in ('cloud', 'evolution', 'wacli'));

alter table clinic_integrations
  add column wacli_gateway_url text,
  add column wacli_gateway_token_enc text,
  -- segredo do HMAC (X-Wacli-Signature) com que o gateway assina o que envia ao Hub; criptografado pela aplicação
  add column wacli_webhook_secret_enc text,
  -- token na URL do webhook: identifica a clínica antes de conferir a assinatura
  add column wacli_webhook_token text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  add column wacli_connected_at timestamptz;
create unique index clinic_integrations_wacli_token on clinic_integrations (wacli_webhook_token);

-- IA pelo OpenRouter: modo "gratuitos com rotação automática" e modelos reserva tentados em ordem.
alter table clinic_integrations
  add column llm_free_auto boolean not null default false,
  add column llm_fallback_models text[] not null default '{}';
