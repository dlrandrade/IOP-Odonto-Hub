#!/usr/bin/env bash
# Instalador do gateway wacli do IOP Odonto Hub (Ubuntu/Debian, ex.: VPS da Hostinger).
#
#   curl -fsSL https://raw.githubusercontent.com/dlrandrade/IOP-Odonto-Hub/claude/zen-knuth-faaxij/gateway/wacli/install.sh | sudo bash -s -- wa.seudominio.com.br
#
# O que faz: instala o Docker (se faltar), baixa o código, gera a chave do gateway, sobe gateway + HTTPS (Caddy)
# e mostra os dois valores para cadastrar na Vercel. Pode rodar de novo para atualizar: mantém a chave e as sessões.
set -euo pipefail

DOMAIN="${1:-}"
BRANCH="${IOP_BRANCH:-claude/zen-knuth-faaxij}"
DIR="/opt/iop-odonto-hub"
REPO="https://github.com/dlrandrade/IOP-Odonto-Hub.git"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mERRO: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "rode como root (use: ... | sudo bash -s -- seu.dominio)"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || fail "informe o domínio do gateway, ex.: wa.seudominio.com.br"

say "Conferindo o DNS de $DOMAIN"
MY_IP="$(curl -fsS4 https://api.ipify.org || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
echo "IP desta VPS: ${MY_IP:-desconhecido} · $DOMAIN aponta para: ${DNS_IP:-nada}"
if [ -z "$DNS_IP" ] || { [ -n "$MY_IP" ] && [ "$DNS_IP" != "$MY_IP" ]; }; then
  fail "crie um registro A de $DOMAIN para ${MY_IP:-o IP desta VPS} e rode de novo (a propagação pode levar alguns minutos)."
fi

say "Conferindo as portas 80 e 443"
BUSY="$(ss -ltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -v caddy || true)"
if [ -n "$BUSY" ] && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'wacli.*caddy'; then
  echo "$BUSY"
  fail "as portas 80/443 já estão em uso por outro programa nesta VPS (site, painel ou proxy). Me avise o que roda aí para eu ajustar a instalação."
fi

if ! command -v docker >/dev/null 2>&1; then
  say "Instalando o Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || fail "Docker Compose não encontrado após a instalação."
command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }

say "Baixando o código ($BRANCH)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q --depth 1 origin "$BRANCH" && git -C "$DIR" checkout -q -B "$BRANCH" FETCH_HEAD
else
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR/gateway/wacli"

if [ -f .env ] && grep -q '^GATEWAY_TOKEN=.\{32,\}' .env; then
  TOKEN="$(grep '^GATEWAY_TOKEN=' .env | cut -d= -f2-)"
  echo "Mantendo a chave já existente."
else
  TOKEN="$(openssl rand -hex 32)"
fi
umask 077
printf 'GATEWAY_DOMAIN=%s\nGATEWAY_TOKEN=%s\n' "$DOMAIN" "$TOKEN" > .env

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q 'Status: active'; then
  say "Liberando 80/443 no firewall"
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
fi

say "Construindo e subindo (a primeira vez leva alguns minutos: compila o wacli)"
docker compose -p wacli up -d --build

say "Esperando o HTTPS ficar pronto"
for i in $(seq 1 40); do
  if curl -fsS "https://$DOMAIN/healthz" >/dev/null 2>&1; then OK=1; break; fi
  sleep 6
done
[ "${OK:-0}" = 1 ] || fail "o gateway subiu, mas https://$DOMAIN ainda não responde. Veja: docker compose -p wacli logs --tail 50"

cat <<EOF

========================================================================
 Gateway no ar: https://$DOMAIN/healthz  →  $(curl -fsS "https://$DOMAIN/healthz")

 Cadastre na Vercel (projeto iopodontohub → Settings → Environment Variables),
 marcando como Sensitive, e faça um Redeploy:

   WACLI_GATEWAY_URL   = https://$DOMAIN
   WACLI_GATEWAY_TOKEN = $TOKEN

 Não compartilhe a chave por chat ou e-mail. Ela fica salva em $DIR/gateway/wacli/.env
 Para atualizar depois, rode este mesmo comando de novo.
========================================================================
EOF
