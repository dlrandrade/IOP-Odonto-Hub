# IOP Odonto Hub

Central web para clínicas odontológicas (SaaS multiclínica): WhatsApp, atendimento por IA, recepção humana, CRM, agenda, pacientes, automações e indicadores.
Especificação completa: [docs/PRD.md](docs/PRD.md). Decisões e desvios: [docs/DECISIONS.md](docs/DECISIONS.md). Instalação: [docs/SETUP.md](docs/SETUP.md).

## Stack

- Next.js 15 (App Router) + React 19 + TypeScript estrito + Tailwind v4. Deploy na Vercel.
- Supabase: Postgres (com RLS), Auth, Storage privado e Realtime.
- Acesso ao banco no servidor por SQL direto (`postgres`), sempre dentro de `asUser()` (RLS do usuário) ou, em webhooks/jobs, pela conexão de sistema filtrando `clinic_id`.
- IA: `LlmProvider` configurável por clínica (Claude da plataforma, Anthropic, OpenRouter ou compatível com OpenAI), sempre com tool use. WhatsApp atrás de `WhatsAppProvider`: Cloud API oficial (padrão) ou Evolution API (QR code, não oficial). Transcrição atrás de `TranscriptionProvider`.
- Fila: tabela `scheduled_jobs` + worker (`/api/jobs/run`, cron) com `FOR UPDATE SKIP LOCKED`.

## Comandos

```bash
npm run dev          # servidor local
npm test             # unidade + integração (Postgres real; ver TEST_DATABASE_URL em vitest.config.ts)
npm run lint && npm run typecheck
npm run db:migrate   # aplica supabase/migrations no banco de DATABASE_URL
npm run db:local     # idem, em Postgres puro (cria o shim de auth local)
npm run db:seed      # cria a "Clínica Sorriso Demo" (dados fictícios)
npm run setup:admin  # cria o operador da plataforma (ADMIN_EMAIL / ADMIN_PASSWORD)
npm run eval:agent   # conversas roteirizadas contra o modelo real (exige ANTHROPIC_API_KEY)
```

Desenvolvimento sem Supabase: Postgres local + `AUTH_MODE=local` no `.env.local`.

## Convenções (não negociáveis)

- TypeScript estrito, sem `any`. Entrada externa (formulário, webhook, tool da IA) validada com Zod.
- Toda tabela tem `clinic_id` e RLS. Telas e server actions usam `q(ctx, tx => ...)`; a conexão de sistema (`db()`) só em webhook, worker e agente, sempre filtrando `clinic_id`.
- Permissão verificada no servidor em toda ação (`act("permissão", ...)`, matriz em `src/domain/permissions.ts`) e espelhada em RLS (`supabase/migrations/0002_rls.sql`).
- **A IA nunca escreve direto no banco**: ela chama tools tipadas (`src/agent/tools.ts`); o servidor valida e executa. `clinic_id` e `contact_id` vêm da conversa, nunca do modelo.
- Horários em `timestamptz` (UTC); exibição no fuso da clínica (`src/lib/datetime.ts`). IDs `uuid`. Dinheiro em centavos (`integer`), BRL.
- Interface em pt-BR; código, tabelas e variáveis em inglês.
- Banco só muda por migração versionada em `supabase/migrations`.
- Segredos só em variáveis de ambiente ou criptografados no banco (`encryptField`). Logs nunca contêm corpo de mensagem, telefone completo nem dado de saúde.
- Nunca inventar dado clínico, preço ou horário em seed, prompt ou teste: dados de demonstração são marcados como demo.
- Regra de negócio pura fica em `src/domain` (testável sem banco). Não avance com teste vermelho.

## Estrutura

```
app/                      Next.js (App Router)
  (auth)/                 login, cadastro
  (dashboard)/            telas: hoje (início), conversas, agenda, pacientes, crm, indicadores, servicos, automacoes, simulador, configuracoes
  admin/                  painel do operador da plataforma (clínicas clientes)
  onboarding/ setup/      criação da clínica; checagem de instalação
  api/webhooks/whatsapp   webhook da Cloud API
  api/webhooks/evolution  webhook da Evolution API (token secreto na URL)
  api/jobs/run            worker (protegido por CRON_SECRET)
  api/media/[id]          mídia privada
src/
  domain/                 regras puras: slots, estados, permissões, automações, alertas
  agent/                  prompt, tools tipadas, orquestrador
  services/               casos de uso com banco: booking, conversations, jobs, automation-rules, crm, dashboard, webhook, clinic-setup, demo
  integrations/           whatsapp/, llm/, transcription/, storage/ (adaptadores)
  auth/                   provedor de auth (Supabase | local) e sessão/contexto
  db/                     cliente Postgres (asUser, inTx)
  components/             UI (design system IOP Business em app/globals.css)
supabase/migrations       schema, RLS, views de indicadores
supabase/local/shim.sql   só para Postgres puro (papéis e auth.users)
tests/                    unit, integration e providers (.test.ts)
docs/                     PRD.md, DECISIONS.md, SETUP.md, RELEASE-CHECKLIST.md, IOP-BUSINESS.md (proposta de integração)
```

## Estado das fatias (PRD seção 13)

S0–S9 implementadas (P0). P1 (lista de espera, propostas e pagamentos, faltas e retornos, relatórios) ainda não — os módulos ficam ocultos no menu.
Antes de atender pacientes reais, cumprir `docs/RELEASE-CHECKLIST.md`.
