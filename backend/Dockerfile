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

RUN mkdir -p /app/uploads /app/logs /app/data

EXPOSE 3000

CMD ["npm", "start"]
