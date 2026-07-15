#!/usr/bin/env bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
COOKIE_FILE="$ROOT_DIR/fablab-admin-cookie.txt"

decode_env_value() {
  local value="$1"
  value="${value//\$\$/\$}"
  printf '%s' "$value"
}

normalize_env_value() {
  local value
  value="$(decode_env_value "$1")"
  value="${value//\$/\$\$}"
  printf '%s' "$value"
}

get_env_raw() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    printf ''
    return 0
  fi

  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  printf '%s' "${line#*=}"
}

get_env_value() {
  local key="$1"
  decode_env_value "$(get_env_raw "$key")"
}

update_env_value() {
  local key="$1"
  local value="$2"
  local normalized_value
  local tmp_file

  normalized_value="$(normalize_env_value "$value")"
  tmp_file="$(mktemp)"

  if [[ -f "$ENV_FILE" ]]; then
    grep -v "^${key}=" "$ENV_FILE" > "$tmp_file" || true
  fi

  printf '%s=%s\n' "$key" "$normalized_value" >> "$tmp_file"
  mv "$tmp_file" "$ENV_FILE"
}

ensure_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    echo "Fichier .env cree a partir de .env.example"
  fi

  update_env_value "PROJECT_WORKSPACE_DIR" "$ROOT_DIR"
}

get_server_port() {
  local port_value
  port_value="$(get_env_value "PORT")"
  printf '%s' "${port_value:-3000}"
}

get_server_host_bind() {
  local host_value
  host_value="$(get_env_value "SERVER_BIND_HOST")"
  printf '%s' "${host_value:-0.0.0.0}"
}

get_local_base_url() {
  printf 'http://127.0.0.1:%s' "$(get_server_port)"
}

detect_local_ip() {
  hostname -I 2>/dev/null | awk '{print $1}' && return 0
  ipconfig getifaddr en0 2>/dev/null && return 0
  ipconfig getifaddr en1 2>/dev/null && return 0
  return 1
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker est requis pour utiliser ce script." >&2
    exit 1
  fi
}

docker_compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

wait_for_http() {
  local url="$1"
  local label="${2:-service}"
  local attempts="${3:-60}"
  local delay_seconds="${4:-2}"

  for attempt in $(seq 1 "$attempts"); do
    if curl -sf "$url" >/dev/null 2>&1; then
      return 0
    fi

    if [[ "$attempt" -eq "$attempts" ]]; then
      echo "${label} n'a pas repondu dans le delai imparti." >&2
      return 1
    fi

    sleep "$delay_seconds"
  done
}

wait_for_backend_ready() {
  wait_for_http "$(get_local_base_url)/api/health" "Le serveur web"
}

is_project_running() {
  docker_compose ps --status running --services 2>/dev/null | grep -q .
}

is_backend_running() {
  docker_compose ps --status running --services 2>/dev/null | grep -qx "backend"
}

stop_indexing_if_possible() {
  local base_url
  base_url="$(get_local_base_url)"

  if [[ ! -f "$COOKIE_FILE" ]]; then
    echo "Aucun cookie admin detecte, arret des indexations ignore."
    return 0
  fi

  if ! curl -sf "${base_url}/api/health" >/dev/null 2>&1; then
    echo "Le serveur n'est pas joignable, arret des indexations ignore."
    return 0
  fi

  local response
  response="$(
    curl -s \
      -X POST "${base_url}/api/admin/index/stop-all" \
      -H "Content-Type: application/json" \
      --cookie "$COOKIE_FILE" \
      --cookie-jar "$COOKIE_FILE" || true
  )"

  if [[ "$response" == *"Authentification requise"* ]]; then
    echo "Session admin expirée, arret des indexations ignore."
    return 0
  fi

  if [[ -n "$response" ]]; then
    echo "Arret des indexations : $response"
  fi
}

print_access_summary() {
  local intro_message="${1:-Operation terminee.}"
  local server_port
  local local_ip

  server_port="$(get_server_port)"
  local_ip="$(detect_local_ip || true)"

  cat <<EOF

${intro_message}
- Application : http://localhost:${server_port}
- Application reseau local : ${local_ip:+http://${local_ip}:${server_port}}
- Admin : http://localhost:${server_port}/admin
- Mot de passe admin : cd "${ROOT_DIR}" && ./password

Scripts utiles :
- Installer : ./install.sh
- Mettre a jour : ./update.sh
- Redemarrer : ./restart.sh
- Arreter : ./stop.sh

EOF
}

json_field() {
  local field="$1"

  docker exec -i fablab-updater node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => {
      const path = String(process.argv[1] || "").split(".").filter(Boolean);
      let value = JSON.parse(input || "{}");
      for (const key of path) {
        value = value?.[key];
      }

      if (value === undefined || value === null) {
        return;
      }

      if (typeof value === "object") {
        process.stdout.write(JSON.stringify(value));
        return;
      }

      process.stdout.write(String(value));
    });
  ' "$field"
}

ensure_updater_running() {
  docker_compose up -d updater >/dev/null

  for attempt in $(seq 1 30); do
    if docker exec fablab-updater curl -sf http://127.0.0.1:3010/health >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
  done

  echo "Le service de mise a jour n'est pas joignable." >&2
  return 1
}

fetch_updater_status() {
  docker exec fablab-updater curl -sf http://127.0.0.1:3010/status 2>/dev/null || true
}
