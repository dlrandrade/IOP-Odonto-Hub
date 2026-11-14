-- Provedores configuráveis pela clínica: WhatsApp (oficial ou Evolution API) e IA (Anthropic, OpenRouter, compatível com OpenAI).
-- Segredos sempre criptografados pela aplicação (FIELD_ENCRYPTION_KEY); nunca voltam para a tela.

alter table clinic_integrations
  add column wa_provider text not null default 'cloud' check (wa_provider in ('cloud', 'evolution')),
  add column evo_base_url text,
  add column evo_instance text,
  add column evo_api_key_enc text,
  -- token secreto que vai na URL do webhook da Evolution (ela não assina os eventos)
  add column evo_webhook_token text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  add column evo_connected_at timestamptz,
  add column llm_provider text not null default 'platform' check (llm_provider in ('platform', 'anthropic', 'openrouter', 'openai_compatible')),
  add column llm_api_key_enc text,
  add column llm_model text,
  add column llm_base_url text,
  add column llm_checked_at timestamptz,
  add column llm_last_error text;

create unique index clinic_integrations_evo_token on clinic_integrations (evo_webhook_token);
