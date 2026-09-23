FROM node:24-alpine AS frontend-build

WORKDIR /workspace/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ curl poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
# @langchain/community déclare des peer dependencies optionnelles incompatibles
# entre elles (Stagehand/Zod). Elles ne sont pas utilisées par cette application,
# mais npm 11 les bloque tout de même sans ce mode de résolution déterministe.
RUN npm ci --omit=dev --legacy-peer-deps

COPY backend/ ./
COPY --from=frontend-build /workspace/frontend/dist /app/public
# Page d'aide/documentation servie sur /help (source unique : docs/help.html,
# egalement utilisee hors-ligne par ./help.sh).
COPY docs/help.html /app/docs/help.html

RUN mkdir -p /app/uploads /app/logs /app/data \
  && chmod +x /app/docker-entrypoint.sh \
  && command -v setpriv >/dev/null

EXPOSE 3000

# Demarre en root, rend uploads/logs/data a l'utilisateur du serveur puis
# abandonne les droits root (voir docker-entrypoint.sh) : aucun sudo n'est
# ensuite necessaire cote serveur pour mettre a jour ou nettoyer le projet.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
# node directement (et non npm start) : npm a besoin d'un HOME inscriptible et
# relaie mal les signaux d'arret une fois les droits abandonnes.
CMD ["node", "server.js"]
