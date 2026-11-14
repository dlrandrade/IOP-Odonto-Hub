/**
 * Uma cor predominante por página (mesma lógica do iopbusiness): você sabe onde está sem ler o menu.
 * Verde e coral ficam de fora: são semântica de indicador. Ouro segue reservado a dinheiro, CTA e marca.
 */
export type Tema = { rgb: string; hex: string };

const OURO: Tema = { rgb: "232 181 75", hex: "#E8B54B" };
const AZUL: Tema = { rgb: "87 166 240", hex: "#57A6F0" };
const VIOLETA: Tema = { rgb: "167 139 250", hex: "#A78BFA" };
const TURQUESA: Tema = { rgb: "69 199 192", hex: "#45C7C0" };
const MAGENTA: Tema = { rgb: "237 107 166", hex: "#ED6BA6" };
const INDIGO: Tema = { rgb: "124 131 245", hex: "#7C83F5" };
const LIMA: Tema = { rgb: "170 214 90", hex: "#AAD65A" };
const ACO: Tema = { rgb: "124 141 166", hex: "#7C8DA6" };

export function temaDaRota(caminho: string): Tema {
  if (caminho.startsWith("/conversas")) return TURQUESA;
  if (caminho.startsWith("/crm")) return VIOLETA;
  if (caminho.startsWith("/agenda")) return INDIGO;
  if (caminho.startsWith("/pacientes")) return MAGENTA;
  if (caminho.startsWith("/servicos") || caminho.startsWith("/simulador")) return LIMA;
  if (caminho.startsWith("/automacoes") || caminho.startsWith("/configuracoes") || caminho.startsWith("/admin")) return ACO;
  if (caminho === "/") return AZUL;
  return OURO; // login, cadastro, onboarding, instalação
}
