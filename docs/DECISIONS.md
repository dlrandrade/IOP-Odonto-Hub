# Decisões

Registro das decisões tomadas na construção. Defaults da seção 17 do PRD foram adotados como estão; abaixo, o que foi decidido além deles e onde houve desvio.

## Defaults do PRD adotados

| Tema | Decisão |
|---|---|
| Multiclínica | Modelo multiclínica completo (`clinic_id` + RLS); cada clínica com 1 unidade |
| Agenda | Interna é a fonte de verdade |
| O que agenda direto | Só serviços com `bookable_directly` (avaliação, limpeza, retorno no modelo inicial) |
| Preços informáveis | Apenas `fixed`/`range`; o resto é "sob avaliação" |
| Aprovação de conteúdo | Admin/gestor publicam; urgências aparecem para toda a equipe com acesso a conversas |
| Convênios | Só o texto cadastrado na base de conhecimento |
| Fora do expediente | Mensagem configurável, enviada uma vez, sem promessa |
| Fuso | `America/Sao_Paulo`, editável por clínica |

## Ajustes para vender como SaaS e facilitar a configuração

1. **Onboarding em um passo.** Cadastro → nome da clínica, cadeiras e dentistas → a clínica nasce com unidade, cadeiras, expediente por dentista, catálogo em rascunho (sem preço e sem texto clínico), base de conhecimento, templates e sugestão de protocolo de alerta. A Visão geral mostra um checklist "Primeiros passos".
2. **Operador da plataforma** (`platform_admins`, e-mails em `PLATFORM_ADMIN_EMAILS`): painel `/admin` com as clínicas clientes, uso agregado, situação (teste/ativa/suspensa), criação de clínica com usuário do cliente e criação de clínica de demonstração. Para ver dados de uma clínica o operador precisa "entrar" nela, e o acesso é gravado na auditoria da clínica.
3. **WhatsApp por clínica.** Cada clínica cadastra o próprio número em Configurações → WhatsApp (`clinic_integrations`, token e app secret criptografados). O webhook é único e roteia por `phone_number_id`. As variáveis `WHATSAPP_*` do PRD viraram fallback para instalação de clínica única.
4. **Protocolo de alerta como pré-requisito.** A IA só pode ser ativada depois que o responsável técnico aprova sinais e mensagem (PRD 7.4). Alterar o protocolo derruba a aprovação. A lista inicial é apenas sugestão.
5. **Tela `/setup`** mostra o que falta de variáveis/migrações, sem expor valores.
6. **Simulador** usa o mesmo pipeline (canal `simulator`); contatos de simulação ficam fora dos indicadores.

## Desvios do PRD (e por quê)

| PRD | O que foi feito | Motivo |
|---|---|---|
| Acesso ao banco pelo cliente Supabase | SQL direto (`postgres`) com `set role authenticated` + claims por transação (`asUser`) | Transações reais (reserva, reagendamento), as mesmas políticas RLS do Supabase e testes de integração contra Postgres puro. Exige `DATABASE_URL` além das chaves do Supabase |
| shadcn/ui | Componentes próprios no mesmo espírito (`src/components/ui.tsx`) | Design system próprio (IOP Business) em um único arquivo de tokens; sem dependência de CLI |
| Debounce de 6 s via cron | Job com debounce executado logo após o webhook (`after()`), com o cron por minuto como rede de segurança | Cron por minuto sozinho não atinge p95 ≤ 15 s |
| `service_role` em toda query de servidor | Só Storage e criação de usuários usam a service role | Telas rodam com a RLS do usuário |
| Arrastar para reagendar | Reagendar pelo cartão da consulta, escolhendo entre horários realmente livres | Garante a mesma revalidação transacional; arrastar fica como melhoria |
| Detecção de alerta só pela IA | Detecção determinística por palavras aprovadas **antes** do modelo, além da instrução no prompt | O fluxo prioritário não pode depender do modelo |
| Imagens enviadas ao modelo | Imagens nunca vão ao provedor de IA; a conversa é sempre encaminhada | Minimização (LGPD) e proibição de laudo |
| Confirmação "1/2" pelo agente | Tratada de forma determinística no pipeline | Mais previsível e sem custo de IA |
| Só Cloud API oficial ("APIs não oficiais proibidas") | Cloud API continua o padrão; **Evolution API v2 (WhatsApp Web por QR code)** fica como alternativa opcional por clínica (`wa_provider = 'evolution'`), com aviso de risco na tela | Decisão do dono do produto: clínicas pequenas sem acesso ao Business Manager. Sem janela de 24 h nem templates (o lembrete vai como texto), mas o número pode ser banido pela Meta e não há garantia de entrega. Integração escrita a partir do código-fonte da Evolution v2; validar com uma instância real antes de usar com pacientes |
| Só Claude | `LlmProvider` por clínica: padrão da plataforma (Claude via `ANTHROPIC_API_KEY`), chave própria da Anthropic, **OpenRouter** ou qualquer API compatível com OpenAI (Groq, Together, servidor próprio) | Clínica escolhe custo/modelo. Chaves criptografadas (`encryptField`). Guardrails, tools tipadas e detecção de alerta são os mesmos para todos; modelos menores podem errar mais no uso das tools — rode `npm run eval:agent` antes de trocar |

| Automações fixas (follow-ups, lembrete, confirmação) | Além das quatro nativas, a clínica cria as suas no construtor visual (`automation_rules`): antes/depois da consulta, falta e aniversário, enviando mensagem ou criando tarefa | Pedido do dono do produto. As regras passam pelas mesmas checagens (opt-out, horário, limite diário, janela de 24 h); aniversário é varrido pelo worker com idempotência anual |
| Tema único escuro | Escuro (padrão da marca) e claro, escolhido por usuário em cookie e aplicado no servidor | Pedido do dono do produto; tokens redefinidos para AA nos dois temas |

| Só Cloud API oficial | Terceira opção: **gateway wacli** (`gateway/wacli`), uma sessão de WhatsApp Web por clínica num servidor sempre ligado, com webhook assinado por HMAC | Pedido do dono do produto: cada clínica conecta o próprio número com um QR Code, sem servidor por clínica. O wacli precisa de processo contínuo e disco, por isso não roda na Vercel. Mesmo risco de bloqueio da Evolution |
| Um modelo de IA por clínica | OpenRouter com modelos reserva ou em **rodízio de modelos gratuitos** (lista com ferramentas, atualizada a cada hora; troca em 429/5xx/404; espera de 10 min para o que falhou) | Pedido do dono do produto: custo zero para clínicas pequenas. Modelos gratuitos variam em qualidade e limite; sem resposta, a conversa vai para a equipe |

| Cadastro público com conta criada já confirmada | Cadastro via `auth.signUp` com link de confirmação; operador da plataforma só por `setup:admin` | Inspeção de segurança: e-mail não verificado + promoção por e-mail permitiam tomar o painel da plataforma |

## Decisões técnicas complementares

- **Modelo de IA:** `claude-opus-5-5` por padrão (`ANTHROPIC_MODEL`), pensamento adaptativo, `effort: low` (chat), cache do prompt de sistema e fallback de recusa do lado do servidor. Sem chave configurada, a conversa vai para a equipe.
- **Transcrição (S5):** `TranscriptionProvider` com implementação HTTP compatível com `/audio/transcriptions` (`TRANSCRIPTION_API_URL/KEY/MODEL`), sempre com `language=pt`. A escolha do fornecedor fica com o operador; sem ele, o áudio é preservado e a IA pede texto.
- **Follow-up fora da janela:** usa o template `retomada_contato` se aprovado; senão vira tarefa humana.
- **Corrida de reservas:** constraint `EXCLUDE` em `appointment_resources` (o dentista é um recurso `kind = professional`). Quem perde a corrida tenta de novo até 3 vezes (pode haver outra cadeira) e então recebe conflito.
- **Verificação de identidade:** nome completo + data de nascimento por conversa (`conversations.verified_patient_ids`). Paciente sem data de nascimento não é verificável pela IA → equipe.
- **Um usuário pertence a uma clínica** (`app_users.auth_user_id` único). Multiunidade/multi-clínica por usuário é P2.
- **Custo de IA:** estimado por tokens × tabela de preços do modelo (USD), gravado em `ai_runs`. A fatura do provedor é a referência.
- **Cadastro público** (`/signup`) cria o usuário já confirmado. Para fechar o cadastro, `ALLOW_SIGNUP=false` (clínicas passam a ser criadas só pelo operador).
- **Vercel Cron por minuto** exige plano Pro. No Hobby, use `pg_cron` + `pg_net` do Supabase chamando `/api/jobs/run` (ver SETUP).

## Em aberto (precisam da clínica ou do operador)

- Bases legais, retenção e tratamento de menores (LGPD) — definir com cada clínica; o sistema não certifica conformidade.
- Textos clínicos, de encaminhamento e pós-atendimento — aprovação do responsável técnico de cada clínica.
- Revalidar a política vigente do WhatsApp Business (janela, templates, opt-in) antes de cada ativação; a versão da Graph API fica em `WHATSAPP_GRAPH_VERSION`.
- Plano de cobrança do SaaS (assinatura, limites por plano) — não implementado; `clinics.status` já permite suspender.
- Estimativa de prazo e orçamento do P1: após validar o piloto com dados reais.
