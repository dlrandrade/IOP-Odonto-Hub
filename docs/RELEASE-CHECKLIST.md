# Checklist de liberação do piloto (S9)

Pacientes reais só depois de **todos** os itens e da aprovação da recepção e do responsável técnico.

## Automático (CI)

- [ ] `npm run lint`, `npm run typecheck`, `npm test` e `npm run build` verdes.

Cobertura dos testes obrigatórios (PRD seção 14) em `tests/`:

| # | Cenário | Onde |
|---|---|---|
| 1 | Jornada mensagem → IA → reserva → lembrete → comparecimento → dashboard | "jornada…", "lembrete fora da janela…", "S8 — dashboard" |
| 2 | Corrida de reserva, cancelamento e reagendamento | "S2 — agenda" |
| 3 | Humano assume durante processamento e com resposta em fila | "RF-02 — assumir e devolver" |
| 4 | Follow-ups com resposta intermediária, descadastro e janela | "S7 — automações", "fora da janela de 24 h…" |
| 5 | Dois pacientes no mesmo telefone | "dois pacientes no mesmo telefone…" |
| 6 | Áudio ininteligível, imagem, fora da base, preço não cadastrado | "S5 — agente" |
| 7 | Injeção de prompt | "injeção de prompt…", teste de unidade de delimitação |
| 8 | Sinal de alerta clínico | "sinal de alerta…" |
| 9 | Usuário desativado, RLS, papéis | "S0 — isolamento e permissões" |
| 10 | Queda de provedor, reentrega de webhook, fila de erro | "S4 — webhook e inbox", "IA fora do ar…" |
| 11 | Fuso e data completa | "datas no fuso da clínica" |

Os testes usam modelo roteirizado: provam o que o **servidor** garante. O comportamento do **modelo** é verificado à parte:

- [ ] `npm run eval:agent` aprovado com a chave e o modelo de produção.

## Manual, por clínica

- [ ] Responsável técnico revisou e aprovou sinais de alerta, mensagem de encaminhamento e alternativa fora do expediente.
- [ ] Descrições de serviço e base de conhecimento revisadas e publicadas; nenhum texto de demonstração.
- [ ] Recepção treinada no Simulador: assumir, devolver, transferir, encerrar, agendar, reagendar, cancelar.
- [ ] Recepção operou um dia inteiro de agenda sem IA (kill switch ligado).
- [ ] Número do WhatsApp conectado; webhook verificado; mensagem de teste recebida e respondida.
- [ ] Templates `lembrete_consulta`, `confirmacao_consulta` e `retomada_contato` aprovados na Meta e marcados em Automações.
- [ ] Política vigente do WhatsApp Business revalidada (opt-in, janela, templates).
- [ ] LGPD: bases legais, retenção, atendimento a titulares e tratamento de menores definidos com a clínica; contrato com o provedor de IA sem reuso de dados.
- [ ] Usuários com o papel correto; ex-funcionários desativados.

## Manual, da plataforma

- [ ] Restauração de backup ensaiada (ver SETUP).
- [ ] Cron do worker ativo: Automações → histórico mostra execuções recentes.
- [ ] `FIELD_ENCRYPTION_KEY` e `CRON_SECRET` guardados em cofre.
- [ ] Teto mensal de custo de IA definido por clínica (Configurações → Assistente).
- [ ] Teste de carga de referência: 10 usuários, 30 conversas ativas; p95 da inbox ≤ 5 s e da resposta da IA ≤ 15 s.
- [ ] Alertas de erro da Vercel e do Supabase direcionados a alguém de plantão.
