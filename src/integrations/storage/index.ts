import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/** Mídia sempre em armazenamento privado; acesso só por link temporário ou rota autenticada. */
export interface MediaStore {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  signedUrl(key: string, seconds: number): Promise<string | null>;
}

const BUCKET = "media";

class SupabaseStore implements MediaStore {
  private client = createClient(env.supabaseUrl ?? "", env.supabaseServiceKey ?? "", { auth: { persistSession: false, autoRefreshToken: false } });
  async put(key: string, data: Buffer, mime: string): Promise<void> {
    const { error } = await this.client.storage.from(BUCKET).upload(key, data, { contentType: mime, upsert: true });
    if (error) throw new Error("Falha ao salvar mídia");
  }
  async get(key: string): Promise<Buffer | null> {
    const { data } = await this.client.storage.from(BUCKET).download(key);
    return data ? Buffer.from(await data.arrayBuffer()) : null;
  }
  async signedUrl(key: string, seconds: number): Promise<string | null> {
    const { data } = await this.client.storage.from(BUCKET).createSignedUrl(key, seconds);
    return data?.signedUrl ?? null;
  }
}

class LocalStore implements MediaStore {
  private file(key: string): string {
    const root = path.resolve(env.mediaDir);
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error("Caminho inválido");
    return full;
  }
  async put(key: string, data: Buffer): Promise<void> {
    await mkdir(path.dirname(this.file(key)), { recursive: true });
    await writeFile(this.file(key), data);
  }
  async get(key: string): Promise<Buffer | null> {
    return readFile(this.file(key)).catch(() => null);
  }
  async signedUrl(): Promise<string | null> { return null; }
}

export function mediaStore(): MediaStore {
  return env.supabaseUrl && env.supabaseServiceKey ? new SupabaseStore() : new LocalStore();
}

export function extensionFor(mime: string): string {
  const map: Record<string, string> = { "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/webm": "webm", "audio/wav": "wav", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  return map[mime.split(";")[0]?.trim() ?? ""] ?? "bin";
}
