# Gateway wacli

Servidor que conecta o WhatsApp de cada clínica ao IOP Odonto Hub usando o [wacli](https://github.com/openclaw/wacli)
(protocolo do WhatsApp Web, **não oficial**). Cada clínica tem a sua sessão isolada em `/data/clinics/<id-da-clínica>`.

> Risco: o WhatsApp pode bloquear números que usam clientes não oficiais. Use um chip dedicado à clínica.
> O canal oficial (Cloud API da Meta) continua sendo o recomendado.

## Por que um servidor separado

O wacli é um programa que fica rodando o tempo todo, com a sessão e o histórico gravados em disco.
A Vercel só roda funções curtas e sem disco, então o gateway precisa de uma máquina sempre ligada com disco persistente
(VPS, Railway, Fly.io, Render com disco etc.). Um gateway atende todas as clínicas da plataforma.

## Subir num servidor (recomendado: Docker Compose + HTTPS automático)

Num VPS Linux com Docker (2 GB de RAM bastam para dezenas de clínicas):

```bash
git clone https://github.com/dlrandrade/IOP-Odonto-Hub.git && cd IOP-Odonto-Hub/gateway/wacli
cp .env.example .env   # preencha GATEWAY_DOMAIN e GATEWAY_TOKEN (openssl rand -hex 32)
docker compose up -d --build
curl https://SEU_DOMINIO/healthz   # deve responder {"ok":true,...}
```

O Caddy emite o certificado HTTPS sozinho; o domínio precisa apontar para o servidor e as portas 80/443 precisam estar abertas.

## Subir só o container

```bash
docker build -t iop-wacli-gateway gateway/wacli
docker run -d --name iop-wacli --restart unless-stopped \
  -p 8080:8080 -v iop-wacli-data:/data \
  -e GATEWAY_TOKEN="$(openssl rand -hex 32)" \
  iop-wacli-gateway
```

Coloque o gateway atrás de HTTPS (proxy reverso ou o domínio do provedor).

## Ligar ao Hub

Na Vercel (projeto do Hub), cadastre como **Sensitive**:

- `WACLI_GATEWAY_URL`: endereço HTTPS do gateway, ex.: `https://wa.suaplataforma.com.br`
- `WACLI_GATEWAY_TOKEN`: o mesmo `GATEWAY_TOKEN` do container

Depois disso, em **Configurações → WhatsApp**, cada clínica escolhe **WhatsApp por QR Code (wacli)**, clica em
**Gerar QR Code** e lê com o celular (WhatsApp → Aparelhos conectados). Também dá para parear pelo código de 8 letras,
informando o número.

As mensagens chegam ao Hub por webhook assinado (HMAC-SHA256 com um segredo por clínica) e passam pelo mesmo
atendimento da assistente, inbox e automações dos outros canais.

## API (uso interno do Hub)

Todas as rotas exigem `Authorization: Bearer $GATEWAY_TOKEN`.

| Rota | O que faz |
|---|---|
| `POST /v1/accounts/:id/connect` `{ webhookUrl, webhookSecret, phone? }` | Inicia o pareamento (ou religa se já pareado) |
| `GET /v1/accounts/:id` | `{ state, qr, pairCode, error }` — `state`: idle, pairing, connected, disconnected, error |
| `POST /v1/accounts/:id/send` `{ to, text }` | Envia texto; devolve `{ id }` |
| `GET /v1/accounts/:id/media?chat=&id=` | Baixa a mídia de uma mensagem recebida |
| `POST /v1/accounts/:id/logout` | Desconecta e apaga a sessão da clínica |
| `GET /healthz` | Saúde (sem token) |

## Testar

```bash
node --test gateway/wacli/test/gateway.test.mjs
```

O teste usa um wacli simulado: o pareamento real exige um celular.
