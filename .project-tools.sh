#!/usr/bin/env bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
COOKIE_FILE="$ROOT_DIR/assistant-ia-admin-cookie.txt"

os_release_field() {
  local field="$1"
  [[ -f /etc/os-release ]] || return 0
  grep -E "^${field}=" /etc/os-release | head -n 1 | cut -d= -f2- | tr -d '"'
}

# Installe Docker Engine via le depot apt officiel (Debian/Ubuntu). Essaie
# d'abord le depot correspondant a la distribution detectee, puis se rabat
# sur l'autre famille (Debian <-> Ubuntu) en cas d'echec (cle/depot invalide,
# codename non supporte, etc.). Version courte, reutilisable, de la logique
# d'install.sh : ne fait pas exit sur echec (appelant = doctor.sh, qui doit
# pouvoir continuer les autres verifications), retourne juste 0/1.
_install_docker_apt_repo() {
  local distro="$1"
  local codename="$2"
  local keyring="/etc/apt/keyrings/docker.gpg"
  local list_file="/etc/apt/sources.list.d/docker.list"

  sudo rm -f "$list_file" "$keyring"
  sudo apt-get update -y || return 1
  sudo apt-get install -y ca-certificates curl gnupg || return 1
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${distro}/gpg" | sudo gpg --dearmor -o "$keyring" || return 1
  sudo chmod a+r "$keyring"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=${keyring}] https://download.docker.com/linux/${distro} ${codename} stable" \
    | sudo tee "$list_file" >/dev/null
  sudo apt-get update -y || return 1
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_docker_engine_via_apt() {
  if ! command -v apt-get >/dev/null 2>&1; then
    return 1
  fi

  local os_id os_id_like os_codename primary_distro fallback_distro
  os_id="$(os_release_field ID)"
  os_id_like="$(os_release_field ID_LIKE)"
  os_codename="$(os_release_field VERSION_CODENAME)"

  primary_distro="debian"
  if [[ "$os_id" == "ubuntu" || "$os_id_like" == *ubuntu* ]]; then
    primary_distro="ubuntu"
  fi
  fallback_distro="ubuntu"
  [[ "$primary_distro" == "ubuntu" ]] && fallback_distro="debian"

  if ! _install_docker_apt_repo "$primary_distro" "${os_codename:-stable}"; then
    echo "Echec de l'installation via le depot ${primary_distro}, nouvelle tentative via le depot ${fallback_distro}..." >&2
    if ! _install_docker_apt_repo "$fallback_distro" "${os_codename:-stable}"; then
      return 1
    fi
  fi

  command -v docker >/dev/null 2>&1
}

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

generate_random_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import secrets; print(secrets.token_hex(32))"
    return
  fi
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
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

# Outils systeme utilises par l'application d'un package distant
# (apply_remote_package_from_host dans update.sh, install_requested_version
# dans install.sh) : tar/gzip pour l'archive, curl pour le telechargement,
# rsync pour la synchronisation atomique de l'arborescence, et un outil de
# hachage SHA-256 (sha256sum OU shasum) pour verifier l'integrite du package.
# Les images cloud Debian/Ubuntu minimales et Alpine n'embarquent PAS rsync
# par defaut ; certaines images tres reduites n'ont ni sha256sum ni shasum,
# et sans controle explicite la verification echouerait avec un message
# trompeur ("SHA256 verification failed") au lieu d'un diagnostic clair.
require_host_update_tools() {
  local missing=()
  local tool
  for tool in curl tar gzip rsync; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    missing+=("sha256sum (ou shasum)")
  fi
  if [[ ${#missing[@]} -eq 0 ]]; then
    return 0
  fi

  echo "Outils systeme manquants pour la mise a jour : ${missing[*]}" >&2
  local hint="${missing[*]}"
  hint="${hint/sha256sum (ou shasum)/coreutils}"
  if command -v apt-get >/dev/null 2>&1; then
    echo "  -> Installez-les : sudo apt-get update && sudo apt-get install -y ${hint}" >&2
  elif command -v dnf >/dev/null 2>&1; then
    echo "  -> Installez-les : sudo dnf install -y ${hint}" >&2
  elif command -v apk >/dev/null 2>&1; then
    echo "  -> Installez-les : sudo apk add ${hint}" >&2
  elif command -v brew >/dev/null 2>&1; then
    echo "  -> Installez-les : brew install ${hint}" >&2
  fi
  exit 1
}

docker_compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

# "docker compose up" peut echouer avec le code 125 (echec de la commande
# docker/compose elle-meme, pas du conteneur) pour des raisons tres variees :
# daemon Docker pas pleinement pret juste apres un demarrage/redemarrage,
# cache de build corrompu, ressources epuisees. On retente jusqu'a 3 fois avec
# un delai croissant (le cas le plus frequent se resout tout seul), et sinon
# on affiche un diagnostic actionnable au lieu de laisser set -e tuer le
# script sur un code de sortie brut sans explication.
_docker_compose_up_with_retry() {
  local -a up_args=("$@")
  local attempt exit_code delay
  local max_attempts=3

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    # Ne pas tester la commande directement dans le if : un "if" dont la
    # condition echoue sans "else" remet $? a 0 une fois le bloc referme, ce
    # qui rendrait le vrai code de sortie (125, etc.) illisible juste apres,
    # et ferait retourner 0 (succes) a la fin malgre l'echec reel.
    if docker_compose up -d "${up_args[@]}"; then
      exit_code=0
    else
      exit_code=$?
    fi

    if [[ "$exit_code" -eq 0 ]]; then
      return 0
    fi

    if [[ "$attempt" -lt "$max_attempts" ]]; then
      delay=$((attempt * 5))
      echo "« docker compose up » a echoue (code ${exit_code}), nouvelle tentative dans ${delay}s (${attempt}/${max_attempts})..." >&2
      sleep "$delay"
      continue
    fi

    echo "« docker compose up » a echoue (code ${exit_code}) apres ${max_attempts} tentatives." >&2
    if [[ "$exit_code" -eq 125 ]]; then
      echo "Code 125 : la commande docker/compose elle-meme a echoue (pas le conteneur)." >&2
      echo "Causes frequentes et verifications :" >&2
      echo "  - Le daemon Docker n'est pas demarre ou pas encore pret : systemctl status docker (ou relancez Docker Desktop)." >&2
      echo "  - Utilisateur non membre du groupe docker : sudo usermod -aG docker \$USER puis reconnectez-vous." >&2
      echo "  - Espace disque insuffisant pour construire les images : df -h" >&2
      echo "  - Cache de build corrompu : docker builder prune" >&2
      echo "  - Conflit de port ou de conteneur existant : docker ps -a" >&2
    fi
    return "$exit_code"
  done
}

docker_compose_up_build() {
  _docker_compose_up_with_retry --build "$@"
}

docker_compose_up_required() {
  _docker_compose_up_with_retry "$@"
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
- Mot de passe admin : cd "${ROOT_DIR}" && ./password.sh

Scripts utiles :
- Installer : ./install.sh
- Mot de passe temporaire admin : ./password.sh
- Mettre a jour : ./update.sh
- Depanner le service de mise a jour : ./updater.sh
- Diagnostiquer et reparer l'installation : ./doctor.sh
- Voir la version installee : ./version.sh
- Redemarrer : ./restart.sh
- Arreter : ./stop.sh
- Reinitialiser (efface tout, redemande la configuration) : ./reset.sh
- Aide / documentation : ./help.sh

EOF
}

json_field() {
  local field="$1"

  docker exec -i assistant-ia-updater node -e '
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
  if ! docker_compose_up_required updater; then
    echo "Le service de mise a jour n'a pas pu demarrer." >&2
    return 1
  fi

  for attempt in $(seq 1 30); do
    if docker exec assistant-ia-updater curl -sf http://127.0.0.1:3010/health >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
  done

  echo "Le service de mise a jour n'est pas joignable." >&2
  return 1
}

fetch_updater_status() {
  docker exec assistant-ia-updater curl -sf http://127.0.0.1:3010/status 2>/dev/null || true
}
