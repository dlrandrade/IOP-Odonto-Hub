/**
 * Uma cor por recurso, nunca repetida entre recursos diferentes. A roda parte da mostarda da marca
 * e espaça os tons para que cada área seja reconhecida de relance (psicologia das cores):
 *
 * - Hoje — mostarda da marca (42°): acolhimento, energia do dia, "casa".
 * - Automações — tangerina (18°): ação, movimento, coisas acontecendo sozinhas.
 * - Pacientes — rosa (345°): cuidado, vínculo humano.
 * - Oportunidades — violeta (275°): valor, decisão, transformação do sorriso.
 * - Indicadores — índigo (238°): análise, profundidade, visão estratégica.
 * - Agenda — azul (210°): confiança, organização, pontualidade.
 * - Simulador — ciano (188°): tecnologia e IA, leveza para testar.
 * - Conversas — verde-água (168°): diálogo, calma, a cor da mensagem.
 * - Serviços e conhecimento — lima (90°): crescimento, aprendizado, saúde.
 * - Configurações e plataforma — aço neutro: bastidores, sem competir com o resto.
 *
 * Vermelho fica reservado a urgência e erro; o verde de "ok" e a mostarda de CTA seguem como semântica.
 */
export type Tema = { rgb: string; hex: string };

const t = (hex: string): Tema => ({ hex, rgb: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ") });

export const CORES = {
  hoje: t("#E8B54B"),
  automacoes: t("#F2834B"),
  pacientes: t("#EE6E9D"),
  oportunidades: t("#A97CF0"),
  indicadores: t("#6F78F2"),
  agenda: t("#4A9DF0"),
  simulador: t("#2EC1D9"),
  conversas: t("#2FC79F"),
  servicos: t("#9BC64F"),
  ajustes: t("#7C8DA6"),
} as const;

export function temaDaRota(caminho: string): Tema {
  if (caminho.startsWith("/conversas")) return CORES.conversas;
  if (caminho.startsWith("/crm")) return CORES.oportunidades;
  if (caminho.startsWith("/agenda")) return CORES.agenda;
  if (caminho.startsWith("/pacientes")) return CORES.pacientes;
  if (caminho.startsWith("/servicos")) return CORES.servicos;
  if (caminho.startsWith("/simulador")) return CORES.simulador;
  if (caminho.startsWith("/automacoes")) return CORES.automacoes;
  if (caminho.startsWith("/indicadores")) return CORES.indicadores;
  if (caminho.startsWith("/configuracoes") || caminho.startsWith("/admin") || caminho.startsWith("/perfil")) return CORES.ajustes;
  return CORES.hoje; // início, login, cadastro, onboarding, instalação
}
