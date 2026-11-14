# Integração com o IOP Business — proposta

**Situação:** proposta, ainda não implementada. Escrita a partir do código do IOP Business (`lib/sistemas.ts`, `lib/ciclo.ts` e `supabase/migrations`, na versão `main` de novembro de 2026).

## A ideia em uma frase

O IOP Business **ensina** um sistema por mês (aula + ferramenta + entregável + indicadores). O IOP Odonto Hub é **onde o sistema roda** no dia a dia da clínica. Os dois conversam em duas direções:

1. **Do IOP Business para o Hub:** o sistema do mês chega pronto para instalar: automações, textos, etapas do funil e metas já configurados.
2. **Do Hub para o IOP Business:** os indicadores que hoje o aluno digita à mão (faltas, conversão, tempo de resposta, novos pacientes) saem medidos do Hub, com a mesma memória de cálculo de Indicadores.

Para quem assina, a promessa passa a ser “instalou, está funcionando e medindo”, e não só “assistiu à aula”.

## Onde fica no Hub

Um grupo próprio no menu lateral, **Programa IOP**, entre “Relacionamento” e “Gestão”, com três telas:

| Tela | O que mostra |
|---|---|
| **Sistema do mês** | O módulo ao vivo (calendário real do `lib/ciclo.ts`): aula (link para o IOP Business), checklist “Instalar na clínica” e as metas do mês. |
| **Os 12 sistemas** | Grade com os 12 módulos, o que já foi instalado no Hub e o que falta. |
| **Meus números** | Os indicadores de cada sistema calculados pelo Hub, com a meta do IOP Business ao lado e o botão “Enviar ao IOP Business”. |

Fora do menu, a integração aparece em três pontos:

- No cartão **Primeiros passos** (rodapé do menu).
- Na tela **Hoje**, com um bloco “Sistema do mês”.
- Em **Configurações → Integrações**, onde se conecta a conta do IOP Business.

## O que cada sistema instala (mapa inicial)

| Sistema IOP Business | Ferramenta do curso | Vira no Hub | Indicador medido pelo Hub |
|---|---|---|---|
| 01 Aquisição | Playbook de Aplicação | Origem do contato no cadastro e nas conversas | Início de conversa, taxa de agendamento |
| 02 Hora clínica | Calculadora de Hora Clínica, Tabela com Margem | Preços e durações em Serviços | Ticket médio (com o módulo de pagamentos, P1) |
| 04 Conversão | Régua de Follow-up 7 Dias, Mapa de Objeções | Automações da clínica + etapas do CRM + base de conhecimento | Conversão de plano, planos em follow-up, tempo até a decisão |
| 05 Ticket médio | Controle de Avaliações | Serviço de avaliação + CRM “avaliação realizada” | Comparecimento na avaliação, avaliação → plano |
| 06 Experiência | Régua de Confirmação, Protocolo de Recall, Pesquisa de 1 Pergunta | Lembrete e confirmação nativos; automação pós-consulta; filtro “sem vir há 6 meses” | Taxa de faltas, reativados por recall |
| 07 Comunicação | Árvore de Respostas do WhatsApp, Cronômetro de Resposta | Base de conhecimento da assistente + fila de conversas | Tempo médio de resposta, contatos sem resposta |
| 09 Processos | Painel de 6 Indicadores | Tela Indicadores | Meses com números lançados |
| 12 IA na clínica | — | Assistente virtual e protocolo de urgência | Atendimentos da IA, passagens para a equipe |

Os sistemas sem contraparte operacional (Lucro, Liderança, Branding, Consultório legal) continuam só no IOP Business, com um link a partir do Hub.

## Como os dois conversam (arquitetura sugerida)

Os projetos continuam separados (Supabase e Vercel próprios). A integração é por API, sem banco compartilhado.

1. **Vínculo de conta.** Em Configurações, o administrador da clínica clica em “Conectar IOP Business” e entra com o e-mail da assinatura. O IOP Business devolve um token de vínculo, que o Hub guarda criptografado (`encryptField`), como já fazemos com as chaves de WhatsApp e IA. Uma clínica tem um vínculo; o assinante pode ter várias clínicas.
2. **Catálogo (IOP Business → Hub).** Um endpoint somente leitura, `GET /api/hub/sistemas`, devolve os 12 sistemas, o calendário e, para cada um, um “pacote de instalação” em JSON:
   - automações (no formato da tabela `automation_rules` do Hub);
   - documentos para a base de conhecimento;
   - metas.

   O Hub mostra o pacote e **só aplica depois que a clínica revisa e aprova**, a mesma regra do protocolo de urgência e dos textos publicados.
3. **Números (Hub → IOP Business).** No dia 1 de cada mês (Regra do Dia 5), um job do Hub calcula os indicadores do mês anterior e envia para `POST /api/hub/leituras`, que grava em `indicator_readings` e `monthly_metrics` do IOP Business. O envio só sai depois que o assinante clica em “Enviar” (ou ativa o envio automático) e leva apenas números agregados: nunca nome, telefone ou dado de saúde de paciente.
4. **Acesso.** O Hub libera o grupo “Programa IOP” só para clínicas com assinatura ativa, consultando o status do vínculo. Sem assinatura, o grupo mostra o convite para assinar.

## O que já está pronto no Hub para isso

- **Automações da clínica** (`automation_rules`) com gatilhos antes/depois da consulta, falta e aniversário: é o formato dos pacotes das réguas (confirmação, follow-up, pós-consulta).
- **Indicadores por SQL**, com memória de cálculo: faltas, conversão em avaliação, tempo de primeira resposta.
- **Segredos criptografados por clínica** e **auditoria**: base para o vínculo e para registrar a instalação de cada sistema.
- **Filtros avançados de pacientes**: o recall (“sem vir há 6 meses”) já é uma lista pronta.

## Próximos passos sugeridos

1. Definir no IOP Business o formato do “pacote de instalação” de dois sistemas piloto: **06 Experiência** e **07 Comunicação**, os que mais se apoiam no Hub.
2. Criar os dois endpoints no IOP Business (catálogo e leituras), autenticados pelo token de vínculo.
3. No Hub, criar a tabela de vínculo, a tela “Sistema do mês” e o job mensal de envio de números.
4. Medir: clínicas que instalaram o sistema do mês × indicador antes e depois.
