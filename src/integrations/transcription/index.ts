import { z } from "zod";
import { env } from "@/lib/env";

/** Transcrição de áudio atrás de interface. Implementação padrão: qualquer API compatível com /audio/transcriptions. */
export interface TranscriptionProvider {
  transcribe(audio: Buffer, mime: string): Promise<string>;
}

class HttpTranscription implements TranscriptionProvider {
  constructor(private url: string, private key: string, private model: string) {}
  async transcribe(audio: Buffer, mime: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `audio.${mime.includes("ogg") ? "ogg" : "mp3"}`);
    form.append("model", this.model);
    form.append("language", "pt");
    const res = await fetch(this.url, { method: "POST", headers: { Authorization: `Bearer ${this.key}` }, body: form, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Transcrição falhou (HTTP ${res.status})`);
    return z.object({ text: z.string() }).parse(await res.json()).text.trim();
  }
}

let override: TranscriptionProvider | null = null;
export function setTranscriptionOverride(p: TranscriptionProvider | null): void { override = p; }

export function transcriptionProvider(): TranscriptionProvider | null {
  if (override) return override;
  if (env.transcriptionUrl && env.transcriptionKey) return new HttpTranscription(env.transcriptionUrl, env.transcriptionKey, env.transcriptionModel);
  return null;
}
