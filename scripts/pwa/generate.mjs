// Gera ícones e telas de abertura do PWA a partir de scripts/pwa/icon.svg.
// Rodar (uma vez, ou quando o ícone mudar): node scripts/pwa/generate.mjs
// Usa o Chromium do Playwright para rasterizar o SVG; os PNGs gerados ficam versionados em public/pwa.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = createRequire("/opt/node22/lib/node_modules/")("playwright")); }

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "public", "pwa");
mkdirSync(out, { recursive: true });
const svg = readFileSync(join(here, "icon.svg"), "utf8");
const svgUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

// iPhones e iPads (retrato): largura × altura em pontos e densidade. Mantém em sincronia com src/lib/pwa.ts.
import { SPLASH } from "./devices.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();

async function shot(html, w, h, file, omitBackground = false) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<!doctype html><html><body style="margin:0">${html}</body></html>`);
  await page.waitForTimeout(50);
  await page.screenshot({ path: join(out, file), omitBackground, clip: { x: 0, y: 0, width: w, height: h } });
}

const icon = (size, pad = 0, bg = "") =>
  `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;${bg}"><img src="${svgUrl}" style="width:${size - pad * 2}px;height:${size - pad * 2}px"></div>`;

for (const s of [1024, 512, 192, 180, 167, 152, 96, 48, 32]) await shot(icon(s), s, s, s === 180 ? "apple-touch-icon.png" : `icon-${s}.png`);
// Maskable (Android): o desenho já fica dentro da zona segura de 80%.
await shot(icon(512), 512, 512, "icon-maskable-512.png");

// Telas de abertura: ícone com cantos de app (22,5%) e o nome, no tema escuro e no claro.
for (const d of SPLASH) {
  const W = d.w * d.r, H = d.h * d.r, size = Math.round(Math.min(W, H) * 0.24);
  for (const theme of ["dark", "light"]) {
    const bg = theme === "dark" ? "#0a0e13" : "#f5f3ee";
    const fg = theme === "dark" ? "#f2efe9" : "#15191e";
    const html = `<div style="width:${W}px;height:${H}px;background:${bg};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${Math.round(size * 0.22)}px;font-family:-apple-system,'SF Pro Display','Helvetica Neue',Arial,sans-serif">
      <img src="${svgUrl}" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.225)}px;box-shadow:0 ${Math.round(size * 0.08)}px ${Math.round(size * 0.25)}px rgba(0,0,0,${theme === "dark" ? 0.5 : 0.18})">
      <div style="color:${fg};font-size:${Math.round(size * 0.16)}px;font-weight:800;letter-spacing:-0.01em;text-transform:uppercase">Odonto Hub</div>
    </div>`;
    await shot(html, W, H, `splash-${d.w}x${d.h}@${d.r}-${theme}.png`);
  }
}
await browser.close();
writeFileSync(join(out, "README.txt"), "Gerado por scripts/pwa/generate.mjs a partir de scripts/pwa/icon.svg. Não edite à mão.\n");
console.log("PWA: ícones e telas de abertura gerados em public/pwa");
