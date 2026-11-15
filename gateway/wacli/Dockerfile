# Gateway wacli do IOP Odonto Hub: wacli (WhatsApp Web, não oficial) + servidor HTTP em Node, uma sessão por clínica.
# Precisa de disco persistente montado em /data (sessões e histórico local de cada clínica).

FROM golang:1.27.4-alpine AS wacli
ARG WACLI_VERSION=v0.9.2
RUN apk add --no-cache build-base git ca-certificates
RUN git clone --depth 1 --branch "${WACLI_VERSION}" https://github.com/openclaw/wacli /src
WORKDIR /src
RUN CGO_ENABLED=1 CGO_CFLAGS="-Wno-error=missing-braces" GOOS=linux \
    go build -tags sqlite_fts5 -trimpath -ldflags="-s -w" -o /out/wacli ./cmd/wacli

FROM node:22-alpine
RUN apk add --no-cache ca-certificates tzdata ffmpeg \
    && mkdir -p /data/clinics && chown -R node:node /data
COPY --from=wacli /out/wacli /usr/local/bin/wacli
WORKDIR /app
COPY server.mjs ./
USER node
ENV DATA_DIR=/data/clinics PORT=8080 NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.mjs"]
