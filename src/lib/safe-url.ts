import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Proteção contra SSRF: endereços informados pelas clínicas (Evolution, gateway wacli, IA compatível)
 * só podem apontar para hosts públicos via HTTPS. Bloqueia localhost, redes privadas, link-local
 * (incluindo metadados de nuvem 169.254.169.254) e IPs reservados, inclusive depois de resolver o DNS.
 */
export class UnsafeUrlError extends Error {}

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function privateV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) return privateV4(v.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}
export function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 4 ? privateV4(ip) : isIP(ip) === 6 ? privateV6(ip) : true;
}

const cache = new Map<string, number>();
type Resolver = (host: string) => Promise<{ address: string }[]>;
let resolver: Resolver = (host) => lookup(host, { all: true });
/** Somente testes: troca a resolução de DNS (a rede de teste não resolve domínios externos). */
export function setResolverForTests(r: Resolver | null): void { resolver = r ?? ((host) => lookup(host, { all: true })); cache.clear(); }

/** Lança UnsafeUrlError se a URL não for https pública. Resultado positivo fica em cache por 5 min. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UnsafeUrlError("Endereço inválido."); }
  const devLocal = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (devLocal) return url;
  if (url.protocol !== "https:") throw new UnsafeUrlError("Use um endereço https://.");
  if (url.username || url.password) throw new UnsafeUrlError("O endereço não pode conter usuário ou senha.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new UnsafeUrlError("Endereços internos não são permitidos.");
  }
  const hit = cache.get(host);
  if (hit && hit > Date.now()) return url;
  const addresses = isIP(host) ? [{ address: host }] : await resolver(host).catch(() => { throw new UnsafeUrlError("Não foi possível encontrar esse endereço."); });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UnsafeUrlError("Endereços de rede interna ou privada não são permitidos.");
  }
  cache.set(host, Date.now() + 5 * 60_000);
  return url;
}
