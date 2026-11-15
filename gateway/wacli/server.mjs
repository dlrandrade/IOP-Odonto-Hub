// Gateway wacli do IOP Odonto Hub.
//
// Roda um WhatsApp (wacli, protocolo do WhatsApp Web) isolado por clínica e expõe uma API HTTP pequena para o Hub:
//   POST /v1/accounts/:id/connect   { webhookUrl, webhookSecret, phone? }  → inicia o pareamento (QR ou código)
//   GET  /v1/accounts/:id           → { state, qr, pairCode, error }
//   POST /v1/accounts/:id/send      { to, text }                          → { id }
//   GET  /v1/accounts/:id/media?chat=JID&id=MSG                          → arquivo
//   POST /v1/accounts/:id/logout    → desconecta e apaga a sessão
//   GET  /healthz
// Toda chamada (menos /healthz) exige "Authorization: Bearer $GATEWAY_TOKEN".
// As mensagens recebidas saem pelo webhook do próprio wacli (`sync --follow --webhook`), assinadas com HMAC por clínica.
//
// Sem dependências: só Node 20+ e o binário `wacli`. Precisa de disco persistente em DATA_DIR.

import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.GATEWAY_TOKEN ?? "";
const DATA_DIR = process.env.DATA_DIR ?? "/data/clinics";
const WACLI = process.env.WACLI_BIN ?? "wacli";
// Limites de histórico local: a clínica não precisa do arquivo inteiro do celular, só do que chega daqui em diante.
const MAX_MESSAGES = process.env.WACLI_MAX_MESSAGES ?? "200000";
const MAX_DB_SIZE = process.env.WACLI_MAX_DB_SIZE ?? "1GB";

if (TOKEN.length < 32) {
  console.error("GATEWAY_TOKEN ausente ou curto (mínimo 32 caracteres).");
  process.exit(1);
}
mkdirSync(DATA_DIR, { recursive: true });

/** @typedef {{ state: "idle"|"pairing"|"connected"|"disconnected"|"error", qr: string|null, pairCode: string|null, error: string|null, auth: import("node:child_process").ChildProcess|null, sync: import("node:child_process").ChildProcess|null, restarts: number, stopping: boolean }} Account */
/** @type {Map<string, Account>} */
const accounts = new Map();

const ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const storeOf = (id) => join(DATA_DIR, id);
const configOf = (id) => join(storeOf(id), "gateway.json");
const log = (id, msg) => console.log(`[${new Date().toISOString()}] ${id ?? "-"} ${msg}`);

function account(id) {
  let a = accounts.get(id);
  if (!a) {
    a = { state: "idle", qr: null, pairCode: null, error: null, auth: null, sync: null, restarts: 0, stopping: false };
    accounts.set(id, a);
  }
  return a;
}

function readConfig(id) {
  try { return JSON.parse(readFileSync(configOf(id), "utf8")); } catch { return null; }
}

/** Executa um comando curto do wacli e devolve o envelope JSON ({ success, data, error }). */
function wacliJson(id, args, timeoutMs = 45_000) {
  return new Promise((resolve) => {
    execFile(WACLI, ["--store", storeOf(id), "--json", ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const line = String(stdout).trim().split("\n").filter(Boolean).pop() ?? "";
      try { return resolve(JSON.parse(line)); } catch { /* sem JSON */ }
      resolve({ success: false, data: null, error: (String(stderr).trim().split("\n").pop() || err?.message || "falha no wacli").slice(0, 300) });
    });
  });
}

async function isAuthenticated(id) {
  if (!existsSync(storeOf(id))) return false;
  const r = await wacliJson(id, ["auth", "status"], 20_000);
  return !!(r?.success && r.data?.authenticated);
}

/** Mantém `sync --follow` vivo enquanto a conta estiver conectada; reinicia com espera crescente. */
function startSync(id) {
  const a = account(id);
  const cfg = readConfig(id);
  if (!cfg || a.sync) return;
  const args = ["--store", storeOf(id), "sync", "--follow", "--events",
    "--webhook", cfg.webhookUrl, "--webhook-secret", cfg.webhookSecret, "--webhook-events", "message,receipt",
    "--max-messages", MAX_MESSAGES, "--max-db-size", MAX_DB_SIZE, "--presence-mode", "quiet"];
  const child = spawn(WACLI, args, { stdio: ["ignore", "ignore", "pipe"] });
  a.sync = child;
  a.state = "connected";
  a.qr = null;
  a.pairCode = null;
  a.error = null;
  log(id, "sync iniciado");
  createInterface({ input: child.stderr }).on("line", (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.event === "warning" && typeof ev.data?.code === "string" && /logged_out|logout/.test(ev.data.code)) {
      a.state = "disconnected";
      a.error = "O celular desconectou este aparelho. Conecte de novo pelo Hub.";
    }
  });
  child.on("exit", (code) => {
    a.sync = null;
    if (a.stopping) return;
    log(id, `sync saiu (código ${code})`);
    void isAuthenticated(id).then((ok) => {
      if (!ok) {
        a.state = "disconnected";
        a.error = a.error ?? "Sessão encerrada. Conecte o WhatsApp de novo pelo Hub.";
        return;
      }
      a.restarts++;
      const wait = Math.min(60_000, 2_000 * 2 ** Math.min(a.restarts, 5));
      setTimeout(() => startSync(id), wait);
    });
  });
}

/** Pareamento: roda `auth` e captura o QR (ou o código de 8 caracteres) dos eventos; ao terminar, liga o sync. */
function startPairing(id, phone) {
  const a = account(id);
  if (a.auth) return;
  mkdirSync(storeOf(id), { recursive: true });
  const args = ["--store", storeOf(id), "auth", "--events", "--qr-format", "text", "--idle-exit", "20s"];
  if (phone) args.push("--phone", phone);
  const child = spawn(WACLI, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, WACLI_SYNC_MAX_MESSAGES: MAX_MESSAGES, WACLI_SYNC_MAX_DB_SIZE: MAX_DB_SIZE } });
  a.auth = child;
  a.state = "pairing";
  a.error = null;
  log(id, `pareamento iniciado (${phone ? "código por telefone" : "QR"})`);
  createInterface({ input: child.stderr }).on("line", (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.event === "qr_code" && typeof ev.data?.code === "string") a.qr = ev.data.code;
    if (ev.event === "pair_code" && typeof ev.data?.code === "string") a.pairCode = ev.data.code;
    if (ev.event === "error" && ev.data?.message) a.error = String(ev.data.message).slice(0, 300);
  });
  child.on("exit", async (code) => {
    a.auth = null;
    if (a.stopping) return;
    if (code === 0 && (await isAuthenticated(id))) {
      log(id, "pareado");
      a.restarts = 0;
      startSync(id);
    } else {
      log(id, `pareamento não concluído (código ${code})`);
      a.state = "error";
      a.qr = null;
      a.pairCode = null;
      a.error = a.error ?? "O QR Code expirou sem leitura. Tente de novo.";
    }
  });
}

async function stopAll(id) {
  const a = account(id);
  a.stopping = true;
  for (const child of [a.auth, a.sync]) if (child && child.exitCode === null) child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  a.auth = null;
  a.sync = null;
  a.stopping = false;
}

/* ───────────── HTTP ───────────── */

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  const got = Buffer.from(String(req.headers.authorization ?? ""));
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error("corpo grande demais");
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://gateway");
    if (url.pathname === "/healthz") return send(res, 200, { ok: true, accounts: accounts.size });
    if (!authorized(req)) return send(res, 401, { error: "não autorizado" });
    const m = url.pathname.match(/^\/v1\/accounts\/([^/]+)(?:\/(connect|send|media|logout))?$/);
    if (!m || !ID.test(m[1])) return send(res, 404, { error: "rota desconhecida" });
    const id = m[1];
    const action = m[2] ?? "";
    const a = account(id);

    if (req.method === "GET" && action === "") {
      return send(res, 200, { state: a.state, qr: a.qr, pairCode: a.pairCode, error: a.error });
    }

    if (req.method === "POST" && action === "connect") {
      const body = await readJson(req);
      if (typeof body.webhookUrl !== "string" || !/^https:\/\//.test(body.webhookUrl)) return send(res, 400, { error: "webhookUrl precisa ser https" });
      if (typeof body.webhookSecret !== "string" || body.webhookSecret.length < 32) return send(res, 400, { error: "webhookSecret curto" });
      const digits = typeof body.phone === "string" ? body.phone.replace(/\D/g, "") : "";
      const phone = digits.length >= 10 && digits.length <= 15 ? digits : null;
      mkdirSync(storeOf(id), { recursive: true });
      writeFileSync(configOf(id), JSON.stringify({ webhookUrl: body.webhookUrl, webhookSecret: body.webhookSecret }), { mode: 0o600 });
      if (await isAuthenticated(id)) {
        if (a.sync) { await stopAll(id); }
        startSync(id);
        return send(res, 200, { state: "connected" });
      }
      if (a.auth) await stopAll(id);
      startPairing(id, phone);
      return send(res, 202, { state: "pairing" });
    }

    if (req.method === "POST" && action === "send") {
      const body = await readJson(req);
      const to = String(body.to ?? "").replace(/\D/g, "");
      const text = String(body.text ?? "");
      if (to.length < 10 || to.length > 15) return send(res, 400, { error: "destino inválido" });
      if (!text.trim() || text.length > 4096) return send(res, 400, { error: "texto inválido" });
      if (a.state !== "connected") return send(res, 409, { error: "WhatsApp desconectado" });
      // --message-escapes desligado: o texto vai literal. `sync --follow` recebe o envio pelo canal local (delegação).
      const r = await wacliJson(id, ["send", "text", "--to", to, "--message", text, "--no-preview"], 60_000);
      if (!r?.success || !r.data?.id) return send(res, 502, { error: r?.error ?? "envio não confirmado" });
      return send(res, 200, { id: r.data.id });
    }

    if (req.method === "GET" && action === "media") {
      const chat = url.searchParams.get("chat") ?? "";
      const msg = url.searchParams.get("id") ?? "";
      if (!/^[\w.:-]+@[\w.]+$/.test(chat) || !/^[\w-]{4,128}$/.test(msg)) return send(res, 400, { error: "parâmetros inválidos" });
      const out = join(tmpdir(), `wacli-${randomUUID()}`);
      const r = await wacliJson(id, ["--read-only", "media", "download", "--chat", chat, "--id", msg, "--output", out], 90_000);
      if (!r?.success || !existsSync(out)) return send(res, 404, { error: r?.error ?? "mídia indisponível" });
      res.writeHead(200, { "content-type": r.data?.mime_type ?? r.data?.mimeType ?? "application/octet-stream", "content-length": statSync(out).size, "cache-control": "no-store" });
      const stream = createReadStream(out);
      stream.pipe(res);
      stream.on("close", () => rmSync(out, { force: true }));
      return;
    }

    if (req.method === "POST" && action === "logout") {
      await stopAll(id);
      if (existsSync(storeOf(id))) await wacliJson(id, ["auth", "logout"], 30_000);
      rmSync(storeOf(id), { recursive: true, force: true });
      accounts.delete(id);
      return send(res, 200, { state: "idle" });
    }

    return send(res, 405, { error: "método não permitido" });
  } catch (e) {
    log(null, `erro: ${e instanceof Error ? e.message : "desconhecido"}`);
    return send(res, 500, { error: "erro interno" });
  }
});

// Na subida, religa todas as clínicas que já estavam pareadas.
for (const id of existsSync(DATA_DIR) ? readdirSync(DATA_DIR) : []) {
  if (!ID.test(id) || !readConfig(id)) continue;
  void isAuthenticated(id).then((ok) => { if (ok) startSync(id); else account(id).state = "disconnected"; });
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    await Promise.all([...accounts.keys()].map((id) => stopAll(id)));
    process.exit(0);
  });
}

server.listen(PORT, () => log(null, `gateway wacli ouvindo na porta ${PORT}`));
