FROM node:24-bookworm-slim

WORKDIR /app

ARG TARGETARCH
ARG DOCKER_COMPOSE_VERSION=2.35.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io ca-certificates curl tar gzip zip \
  && case "$TARGETARCH" in \
       arm64) compose_arch="aarch64" ;; \
       amd64) compose_arch="x86_64" ;; \
       *) echo "Architecture non prise en charge: $TARGETARCH" >&2; exit 1 ;; \
     esac \
  # Installe le binaire dans un repertoire de plugins CLI Docker standard
  # (/usr/local/lib/docker/cli-plugins) : c'est necessaire pour que "docker
  # compose ..." (sous-commande) soit reconnu par le CLI. Un simple depot dans
  # /usr/local/bin ne suffit pas a la decouverte de plugins et fait echouer
  # "docker compose" avec une erreur de flag inattendue ("-p"). Un lien
  # symbolique vers /usr/local/bin conserve aussi la compatibilite avec un
  # appel direct au binaire "docker-compose" (invocation historique).
  && mkdir -p /usr/local/lib/docker/cli-plugins \
  && curl -fsSL "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${compose_arch}" \
       -o /usr/local/lib/docker/cli-plugins/docker-compose \
  && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
  && ln -s /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3010

CMD ["npm", "start"]
