/**
 * Visualização simples x detalhada.
 * Clientes (equipe da clínica) começam na simples: só o que serve ao dia a dia, sem termos técnicos.
 * O operador da plataforma começa na detalhada e pode "ver como cliente".
 * A escolha fica num cookie (1 ano), por navegador; muda em Meu perfil, em Configurações ou no topo (operador).
 */
export const VISTA_COOKIE = "vista";
export type Vista = "simples" | "detalhada";

export function resolveVista(cookie: string | undefined, isPlatformAdmin: boolean): Vista {
  if (cookie === "simples" || cookie === "detalhada") return cookie;
  return isPlatformAdmin ? "detalhada" : "simples";
}
