FROM node:24-bookworm-slim

WORKDIR /app

ARG TARGETARCH
ARG DOCKER_COMPOSE_VERSION=2.35.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io ca-certificates curl tar gzip \
  && case "$TARGETARCH" in \
       arm64) compose_arch="aarch64" ;; \
       amd64) compose_arch="x86_64" ;; \
       *) echo "Architecture non prise en charge: $TARGETARCH" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${compose_arch}" \
       -o /usr/local/bin/docker-compose \
  && chmod +x /usr/local/bin/docker-compose \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3010

CMD ["npm", "start"]
