import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

function key(): Buffer {
  const raw = env.fieldKey;
  if (!raw) throw new Error("FIELD_ENCRYPTION_KEY não configurada");
  return createHash("sha256").update(raw).digest();
}

/** AES-256-GCM. Formato: v1.<iv>.<tag>.<dados> em base64url. */
export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptField(enc: string | null | undefined): string | null {
  if (!enc) return null;
  const [v, iv, tag, data] = enc.split(".");
  if (v !== "v1" || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function hmacHex(secret: string, payload: string | Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Assinatura do webhook da Meta: cabeçalho X-Hub-Signature-256 = "sha256=<hmac do corpo bruto>". */
export function verifyMetaSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  return safeEqual(header.slice(7), hmacHex(appSecret, rawBody));
}

/** Telefone mascarado para logs e telas de menor privilégio. */
export function maskPhone(phone: string): string {
  return phone.length <= 4 ? "****" : `${"*".repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;
}
