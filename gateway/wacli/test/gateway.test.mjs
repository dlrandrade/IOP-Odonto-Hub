// Testa o gateway contra um wacli falso (o WhatsApp de verdade exige um celular para parear).
// Rodar: node --test gateway/wacli/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "gw-"));
const fake = join(dir, "wacli");
// wacli falso: `auth` emite um QR e "pareia"; `auth status` lê o marcador; `sync` fica rodando e grava os argumentos.
writeFileSync(fake, `#!/usr/bin/env node
const a = process.argv.slice(2); const fs = require("fs");
const store = a[a.indexOf("--store") + 1]; const mark = store + "/paired";
const cmd = a.filter((x, i) => !x.startsWith("--") && a[i - 1] !== "--store").join(" ");
if (cmd.startsWith("auth status")) { console.log(JSON.stringify({ success: true, data: { authenticated: fs.existsSync(mark) }, error: null })); process.exit(0); }
if (cmd.startsWith("auth logout")) { console.log(JSON.stringify({ success: true, data: {}, error: null })); process.exit(0); }
if (cmd.startsWith("auth")) {
  console.error(JSON.stringify({ event: "qr_code", data: { code: "2@QR-DE-TESTE" }, ts: 1 }));
  setTimeout(() => { fs.mkdirSync(store, { recursive: true }); fs.writeFileSync(mark, "1"); process.exit(0); }, 600);
  return;
}
if (cmd.startsWith("sync")) { fs.writeFileSync(store + "/sync-args.json", JSON.stringify(a)); setInterval(() => {}, 1000); return; }
if (cmd.startsWith("send text")) { if (!a.some((x) => x === "--message=--help")) { console.log(JSON.stringify({ success: false, data: null, error: "texto virou opção" })); process.exit(1); } console.log(JSON.stringify({ success: true, data: { sent: true, to: "x", id: "3EB0TESTE" }, error: null })); process.exit(0); }
console.log(JSON.stringify({ success: false, data: null, error: "desconhecido" })); process.exit(1);
`);
chmodSync(fake, 0o755);

const TOKEN = "t".repeat(40);
const PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
const call = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) } });

test("pareia por QR, liga o sync com webhook assinado, envia e desconecta", async (t) => {
  const data = join(dir, "data");
  const server = spawn(process.execPath, [join(here, "..", "server.mjs")], { env: { ...process.env, PORT: String(PORT), GATEWAY_TOKEN: TOKEN, DATA_DIR: data, WACLI_BIN: fake }, stdio: "ignore" });
  t.after(() => server.kill());
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + "/healthz")).ok) break; } catch { /* subindo */ } await new Promise((r) => setTimeout(r, 100)); }

  assert.equal((await fetch(base + "/v1/accounts/clinica-a")).status, 401, "sem token é recusado");
  assert.equal((await call("/v1/accounts/../etc")).status, 404, "id inválido é recusado");
  assert.equal((await call("/v1/accounts/clinica-a/connect", { method: "POST", body: JSON.stringify({ webhookUrl: "http://inseguro", webhookSecret: "s".repeat(40) }) })).status, 400);

  const secret = "s".repeat(40);
  const r = await call("/v1/accounts/clinica-a/connect", { method: "POST", body: JSON.stringify({ webhookUrl: "https://hub.exemplo/api/webhooks/wacli/abc", webhookSecret: secret }) });
  assert.equal(r.status, 202);
  await new Promise((res) => setTimeout(res, 250));
  const pairing = await (await call("/v1/accounts/clinica-a")).json();
  assert.equal(pairing.state, "pairing");
  assert.equal(pairing.qr, "2@QR-DE-TESTE");

  assert.equal((await call("/v1/accounts/clinica-a/send", { method: "POST", body: JSON.stringify({ to: "5511999990000", text: "oi" }) })).status, 409, "não envia antes de parear");

  await new Promise((res) => setTimeout(res, 1500));
  const connected = await (await call("/v1/accounts/clinica-a")).json();
  assert.equal(connected.state, "connected");
  assert.equal(connected.qr, null);
  const syncArgs = JSON.parse(readFileSync(join(data, "clinica-a", "sync-args.json"), "utf8"));
  assert.ok(syncArgs.includes("--follow"));
  assert.equal(syncArgs[syncArgs.indexOf("--webhook") + 1], "https://hub.exemplo/api/webhooks/wacli/abc");
  assert.equal(syncArgs[syncArgs.indexOf("--webhook-secret") + 1], secret);

  const sent = await call("/v1/accounts/clinica-a/send", { method: "POST", body: JSON.stringify({ to: "+55 (11) 99999-0000", text: "--help" }) });
  assert.equal(sent.status, 200);
  assert.deepEqual(await sent.json(), { id: "3EB0TESTE" });

  assert.equal((await call("/v1/accounts/clinica-a/logout", { method: "POST" })).status, 200);
  assert.equal(existsSync(join(data, "clinica-a")), false, "sessão apagada no logout");
});
