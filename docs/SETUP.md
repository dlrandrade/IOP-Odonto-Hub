# Instalação (≈ 20 minutos)

Você precisa de: um projeto **Supabase**, um projeto **Vercel** ligado a este repositório e, para a assistente, uma chave da **API da Anthropic**. O WhatsApp é conectado depois, por clínica, dentro do próprio sistema.

## 1. Supabase

1. Crie um projeto em supabase.com (região `sa-east-1` para o Brasil). O plano gratuito permite 2 projetos ativos por organização.
2. Copie de **Project Settings**:
   - **Database → Connection string → Transaction pooler** → `DATABASE_URL` (troque `[YOUR-PASSWORD]` pela senha do banco)
   - **API → Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **API → anon / publishable** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **API → service_role** → `SUPABASE_SERVICE_ROLE_KEY` (secreta)
3. Em **Authentication → Providers → Email**, mantenha "Email" habilitado. O cadastro pelo sistema já cria usuários confirmados.

## 2. Variáveis de ambiente

Copie `.env.example` para `.env.local` (uso local) e cadastre as mesmas chaves na Vercel (**Settings → Environment Variables**):

| Variável | Obrigatória | Como obter |
|---|---|---|
| `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | sim | passo 1 |
| `FIELD_ENCRYPTION_KEY` | sim | `openssl rand -hex 32` — guarde; trocar invalida tokens de WhatsApp e CPFs já gravados |
| `CRON_SECRET` | sim | `openssl rand -hex 32` |
| `PLATFORM_ADMIN_EMAILS` | sim | seu e-mail de operador (separe vários por vírgula) |
| `NEXT_PUBLIC_APP_URL` | sim | URL pública, ex.: `https://app.suaempresa.com.br` |
| `ANTHROPIC_API_KEY` | para a IA | console.anthropic.com. Sem ela, as conversas vão direto para a equipe |
| `ANTHROPIC_MODEL` | não | padrão `claude-opus-5-5` |
| `TRANSCRIPTION_API_URL`, `TRANSCRIPTION_API_KEY`, `TRANSCRIPTION_MODEL` | para áudio | qualquer serviço compatível com `/audio/transcriptions` |
| `ALLOW_SIGNUP` | não | `false` fecha o cadastro público |

## 3. Banco e seu usuário

Com o `.env.local` preenchido:

```bash
npm install
```

```bash
npm run db:migrate
```

```bash
ADMIN_EMAIL=voce@exemplo.com ADMIN_PASSWORD='uma-senha-forte' npm run setup:admin
```

Opcional — clínica de demonstração com dados fictícios:

```bash
npm run db:seed
```

## 4. Vercel

1. **Add New → Project** → importe o repositório. Framework: Next.js (detectado).
2. Cadastre as variáveis do passo 2 e faça o deploy.
3. **Worker:** `vercel.json` agenda `/api/jobs/run` a cada minuto (plano Pro). No plano Hobby, remova o cron do `vercel.json` e agende pelo Supabase (SQL Editor), trocando a URL e o segredo:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('odontocentral-worker', '* * * * *', $$
  select net.http_post(
    url := 'https://SEU-DOMINIO/api/jobs/run',
    headers := '{"Authorization": "Bearer SEU_CRON_SECRET"}'::jsonb
  );
$$);
```

4. Abra o site. Se algo faltar, a tela `/setup` diz exatamente o quê. Entre com o usuário do passo 3: você cai no painel **Plataforma**, de onde cria as clínicas clientes.

## 5. Colocar uma clínica no ar

Dentro da clínica, a **Visão geral** mostra o checklist "Primeiros passos":

1. **Dentistas com expediente** — Configurações → Agenda.
2. **Serviços e preços** — revise os rascunhos, escreva a descrição aprovada e publique.
3. **Base de conhecimento** — endereço, pagamento, convênios, acessibilidade.
4. **WhatsApp** — Configurações → WhatsApp (abaixo).
5. **Protocolo de urgência** — o responsável técnico revisa sinais e mensagem e aprova.
6. **Ativar a assistente.** Teste antes no **Simulador**.

### WhatsApp (Cloud API oficial)

No Meta for Developers, com um app do tipo Business e o produto WhatsApp:

1. Copie **Phone Number ID** e **WABA ID** (WhatsApp → Configuração da API).
2. Gere um **token permanente** (Usuário do sistema no Business Manager, permissões `whatsapp_business_messaging` e `whatsapp_business_management`).
3. Copie o **App Secret** (Configurações do app → Básico).
4. Cole tudo em Configurações → WhatsApp e salve.
5. Em WhatsApp → Configuração → **Webhook**, informe a URL de callback e o token de verificação mostrados na tela e assine o campo **messages**.
6. Crie no WhatsApp Manager os templates `lembrete_consulta`, `confirmacao_consulta` e `retomada_contato` (categoria Utilidade, pt_BR) com o texto exibido em Automações. Quando a Meta aprovar, marque "Aprovado" em Automações.

## Desenvolvimento local sem Supabase

```bash
createdb odonto
```

`.env.local`:

```
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/odonto
AUTH_MODE=local
FIELD_ENCRYPTION_KEY=qualquer-texto-longo-para-desenvolvimento
CRON_SECRET=local
PLATFORM_ADMIN_EMAILS=voce@exemplo.com
```

```bash
npm run db:local
```

```bash
AUTH_MODE=local ADMIN_EMAIL=voce@exemplo.com ADMIN_PASSWORD='senha-local' npm run setup:admin
```

```bash
npm run dev
```

`AUTH_MODE=local` existe só para desenvolvimento e testes: nunca use em produção.

## Backup e restauração (RPO 1 h / RTO 4 h)

- Ative **Point-in-Time Recovery** no Supabase (plano Pro) para atender RPO de 1 h; no plano gratuito há apenas backup diário.
- Ensaie a restauração antes do piloto: restaure para um projeto novo, aponte um deploy de teste para ele e rode `npm run db:migrate` (deve informar que nada há a aplicar).
- A mídia fica no bucket privado `media`; inclua-o na rotina de backup.
