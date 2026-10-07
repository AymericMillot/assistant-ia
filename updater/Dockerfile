# CLI Docker + plugins compose/buildx recuperes depuis l'image officielle
# "docker:cli" (binaires statiques, toutes architectures). Remplace le paquet
# Debian docker.io : son CLI 20.10 (API 1.41) est refuse par les moteurs Docker
# recents (API minimale 1.44 depuis Docker 29), ce qui rendait l'updater
# incapable de s'inspecter, de lancer sa reconstruction ou de piloter compose.
# Un CLI recent negocie toujours a la baisse avec un moteur plus ancien.
ARG DOCKER_CLI_IMAGE=docker:cli
FROM ${DOCKER_CLI_IMAGE} AS dockercli

FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tar gzip zip \
  && rm -rf /var/lib/apt/lists/*

# Repertoire de plugins CLI standard (/usr/local/lib/docker/cli-plugins) :
# necessaire pour que "docker compose" soit reconnu comme sous-commande. Le lien
# /usr/local/bin/docker-compose garde l'appel direct historique en secours.
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/ /usr/local/lib/docker/cli-plugins/
RUN ln -sf /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose \
  && docker --version \
  && docker compose version

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3010

CMD ["node", "server.js"]
