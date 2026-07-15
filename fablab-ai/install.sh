#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
DEPLOYMENT_INFO_FILE="$ROOT_DIR/backend/data/deployment.json"
BACKEND_IMAGE_NAME="fablab-ai-backend"
UPDATER_IMAGE_NAME="fablab-ai-updater"

# Mode non interactif : force via --non-interactive, ou detecte automatiquement
# si aucun terminal n'est attache (CI, script lance en arriere-plan...).
NON_INTERACTIVE=0
for arg in "$@"; do
  if [[ "$arg" == "--non-interactive" ]]; then
    NON_INTERACTIVE=1
  fi
done
if [[ ! -t 0 ]]; then
  NON_INTERACTIVE=1
fi

detect_os_label() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin) echo "macOS" ;;
    Linux) echo "Linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "Windows" ;;
    *) echo "inconnu" ;;
  esac
}

# Verifie que Docker est present ET que le daemon repond, avec un guidage
# adapte a l'OS si ce n'est pas le cas (pas d'installation automatique sans
# confirmation explicite : on prefere orienter plutot que modifier le systeme).
check_docker() {
  local os_label
  os_label="$(detect_os_label)"

  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker n'est pas installe sur cette machine (${os_label})." >&2
    case "$os_label" in
      macOS|Windows)
        echo "-> Installez Docker Desktop : https://www.docker.com/products/docker-desktop/" >&2
        ;;
      Linux)
        echo "-> Installez Docker Engine : https://docs.docker.com/engine/install/" >&2
        ;;
      *)
        echo "-> Consultez https://docs.docker.com/get-docker/" >&2
        ;;
    esac
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "Docker est installe mais le daemon ne repond pas." >&2
    case "$os_label" in
      macOS|Windows)
        echo "-> Demarrez l'application Docker Desktop puis relancez ce script." >&2
        ;;
      Linux)
        echo "-> Demarrez le service : sudo systemctl start docker" >&2
        ;;
    esac
    exit 1
  fi
}

# Detection d'erreurs courantes avant de lancer quoi que ce soit : port deja
# utilise, espace disque insuffisant pour les modeles.
check_port_available() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1 && lsof -i ":${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Le port ${port} est deja utilise par un autre processus." >&2
    echo "-> Changez PORT dans .env, ou arretez le processus qui occupe ce port." >&2
    exit 1
  fi
}

check_disk_space() {
  local available_kb
  available_kb="$(df -Pk "$ROOT_DIR" 2>/dev/null | tail -1 | awk '{print $4}')"
  if [[ -n "$available_kb" && "$available_kb" -lt 5000000 ]]; then
    echo "Attention : moins de 5 Go d'espace disque disponible. Le telechargement des modeles Ollama peut echouer." >&2
  fi
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

resolve_host_url() {
  local service_url="$1"
  if [[ "$service_url" =~ ^http://ollama(:[0-9]+)?(/.*)?$ ]]; then
    printf 'http://localhost%s' "${BASH_REMATCH[1]}"
    return
  fi

  if [[ "$service_url" =~ ^https://ollama(:[0-9]+)?(/.*)?$ ]]; then
    printf 'https://localhost%s' "${BASH_REMATCH[1]}"
    return
  fi

  printf '%s' "$service_url"
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
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  printf '%s' "${line#*=}"
}

get_env_value() {
  local key="$1"
  decode_env_value "$(get_env_raw "$key")"
}

update_env() {
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

check_docker

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo "Fichier .env cree a partir de .env.example"
fi

current_encryption_key="$(get_env_value "CONFIG_ENCRYPTION_KEY")"
if [[ -z "$current_encryption_key" ]]; then
  echo "Generation de CONFIG_ENCRYPTION_KEY (chiffrement des secrets au repos)..."
  update_env "CONFIG_ENCRYPTION_KEY" "$(generate_random_key)"
fi

current_hash="$(get_env_value "ADMIN_PASSWORD_HASH")"
current_hash_raw="$(get_env_raw "ADMIN_PASSWORD_HASH")"

if [[ -n "$current_hash" ]]; then
  normalized_hash="$(normalize_env_value "$current_hash")"
  if [[ "$current_hash_raw" != "$normalized_hash" ]]; then
    update_env "ADMIN_PASSWORD_HASH" "$current_hash"
  fi
fi

DEFAULT_MODEL_VALUE="$(get_env_value "DEFAULT_MODEL")"
EMBEDDING_MODEL_VALUE="$(get_env_value "EMBEDDING_MODEL")"
FALLBACK_MODELS_VALUE="$(get_env_value "OLLAMA_FALLBACK_MODELS")"
FALLBACK_MODEL_VALUE="$(get_env_value "OLLAMA_FALLBACK_MODEL")"
OLLAMA_URL_VALUE="$(get_env_value "OLLAMA_URL")"

DEFAULT_MODEL="${DEFAULT_MODEL_VALUE:-Gemini4:e2b}"
EMBEDDING_MODEL="${EMBEDDING_MODEL_VALUE:-nomic-embed-text}"
FALLBACK_MODELS_RAW="${FALLBACK_MODELS_VALUE:-${FALLBACK_MODEL_VALUE:-}}"
OLLAMA_URL="${OLLAMA_URL_VALUE:-http://ollama:11434}"
HOST_OLLAMA_URL="$(resolve_host_url "$OLLAMA_URL")"
PORT_VALUE="$(get_env_value "PORT")"
SERVER_PORT="${PORT_VALUE:-3000}"

detect_local_ip() {
  hostname -I 2>/dev/null | awk '{print $1}' && return 0
  ipconfig getifaddr en0 2>/dev/null && return 0
  ipconfig getifaddr en1 2>/dev/null && return 0
  return 1
}

image_exists_locally() {
  local image_name="$1"
  docker image inspect "$image_name" >/dev/null 2>&1
}

build_service_or_reuse_local() {
  local service_name="$1"
  local image_name="$2"

  if docker compose -f "$ROOT_DIR/docker-compose.yml" build "$service_name" >/dev/null; then
    return 0
  fi

  if image_exists_locally "$image_name"; then
    echo "Impossible de reconstruire ${service_name} pour le moment. Utilisation de l'image locale existante (${image_name})."
    return 0
  fi

  echo "Echec de construction pour ${service_name} et aucune image locale n'est disponible." >&2
  return 1
}

mkdir -p \
  "$ROOT_DIR/backend/uploads/machines" \
  "$ROOT_DIR/backend/uploads/securite" \
  "$ROOT_DIR/backend/uploads/formations" \
  "$ROOT_DIR/backend/uploads/projets" \
  "$ROOT_DIR/backend/logs" \
  "$ROOT_DIR/backend/data"

check_port_available "$SERVER_PORT"
check_disk_space

echo "Construction de l'image backend pour generer le hash bcrypt..."
build_service_or_reuse_local "backend" "$BACKEND_IMAGE_NAME"

if [[ -z "$current_hash" ]]; then
  echo "Generation du hash bcrypt du mot de passe admin initial..."
  generated_hash="$(
    docker compose -f "$ROOT_DIR/docker-compose.yml" run --rm --no-deps backend \
      node --input-type=module -e "import bcrypt from 'bcrypt'; const hash = await bcrypt.hash('1234567890', 12); console.log(hash);"
  )"
  update_env "ADMIN_PASSWORD_HASH" "$generated_hash"
else
  echo "ADMIN_PASSWORD_HASH deja defini, conservation de la valeur existante."
fi

# Personnalisation interactive (nom du projet, modele Ollama). Sautee en mode
# non interactif : les valeurs par defaut de .env.example / branding.default.json
# restent utilisees.
if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
  echo
  echo "--- Personnalisation (laisser vide pour garder les valeurs par defaut) ---"
  read -r -p "Nom complet du projet (ex: Atelier de mon-etablissement) : " INSTALL_PROJECT_NAME_INPUT || true
  read -r -p "Nom court du projet (ex: L'Atelier) : " INSTALL_SHORT_NAME_INPUT || true

  if [[ -n "${INSTALL_PROJECT_NAME_INPUT:-}" || -n "${INSTALL_SHORT_NAME_INPUT:-}" ]]; then
    docker compose -f "$ROOT_DIR/docker-compose.yml" run --rm --no-deps \
      -e "INSTALL_PROJECT_NAME=${INSTALL_PROJECT_NAME_INPUT:-}" \
      -e "INSTALL_SHORT_NAME=${INSTALL_SHORT_NAME_INPUT:-}" \
      backend node scripts/apply-install-branding.js || echo "Personnalisation ignoree (erreur non bloquante)." >&2
  fi

  echo
  read -r -p "Modele Ollama souhaite (nom exact, ex: mistral:latest), ou vide si vous ne savez pas : " INSTALL_MODEL_CHOICE || true

  if [[ -n "${INSTALL_MODEL_CHOICE:-}" ]]; then
    update_env "DEFAULT_MODEL" "$INSTALL_MODEL_CHOICE"
    DEFAULT_MODEL="$INSTALL_MODEL_CHOICE"
  else
    echo
    echo "--- Questionnaire materiel (pour suggerer un modele adapte) ---"
    read -r -p "Nombre de coeurs CPU : " INSTALL_CPU_CORES || true
    read -r -p "RAM disponible (Go) : " INSTALL_RAM_GB || true
    read -r -p "GPU dedie disponible ? (o/N) : " INSTALL_HAS_GPU_INPUT || true
    INSTALL_HAS_GPU="0"
    INSTALL_GPU_MODEL=""
    if [[ "${INSTALL_HAS_GPU_INPUT:-}" =~ ^[oOyY] ]]; then
      INSTALL_HAS_GPU="1"
      read -r -p "Modele du GPU (optionnel) : " INSTALL_GPU_MODEL || true
    fi
    read -r -p "Stockage disponible (Go, optionnel) : " INSTALL_DISK_GB || true

    if [[ -n "${INSTALL_CPU_CORES:-}" && -n "${INSTALL_RAM_GB:-}" ]]; then
      recommendation_json="$(
        docker compose -f "$ROOT_DIR/docker-compose.yml" run --rm --no-deps \
          -e "INSTALL_CPU_CORES=${INSTALL_CPU_CORES}" \
          -e "INSTALL_RAM_GB=${INSTALL_RAM_GB}" \
          -e "INSTALL_HAS_GPU=${INSTALL_HAS_GPU}" \
          -e "INSTALL_GPU_MODEL=${INSTALL_GPU_MODEL:-}" \
          -e "INSTALL_DISK_GB=${INSTALL_DISK_GB:-0}" \
          backend node scripts/recommend-model-for-hardware.js 2>/dev/null || true
      )"

      recommended_model="$(printf '%s' "$recommendation_json" | grep -o '"recommendedModelName":"[^"]*"' | cut -d'"' -f4 || true)"
      if [[ -n "$recommended_model" ]]; then
        echo "Modele suggere pour cette machine : ${recommended_model}"
        update_env "DEFAULT_MODEL" "$recommended_model"
        DEFAULT_MODEL="$recommended_model"
      else
        echo "Impossible de calculer une suggestion, le modele par defaut (${DEFAULT_MODEL}) sera utilise." >&2
      fi
    fi
  fi
  echo
fi

echo "Démarrage des services Ollama, ChromaDB et Redis..."
docker compose -f "$ROOT_DIR/docker-compose.yml" up -d ollama chromadb redis

echo "Attente du démarrage d'Ollama..."
for attempt in $(seq 1 60); do
  if curl -sf "${HOST_OLLAMA_URL}/api/tags" >/dev/null 2>&1; then
    break
  fi

  if [[ "$attempt" -eq 60 ]]; then
    echo "Ollama n'a pas repondu dans le delai imparti." >&2
    exit 1
  fi

  sleep 2
done

echo "Telechargement du modele par defaut (${DEFAULT_MODEL})..."
default_model_pulled=0
if curl -sf "${HOST_OLLAMA_URL}/api/pull" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"${DEFAULT_MODEL}\",\"stream\":false}" >/dev/null; then
  default_model_pulled=1
else
  echo "Echec du telechargement de ${DEFAULT_MODEL} (nom invalide ou modele indisponible). Passage aux modeles de secours." >&2
fi

# Un seul modele de conversation est telecharge : les modeles de secours ne
# sont essayes que si le modele par defaut a echoue, et on s'arrete au premier
# qui reussit (pas de telechargement cumulatif de plusieurs modeles).
if [[ "$default_model_pulled" -eq 0 ]]; then
  IFS=',' read -r -a FALLBACK_MODELS <<< "$FALLBACK_MODELS_RAW"
  for fallback_model in "${FALLBACK_MODELS[@]:-}"; do
    fallback_model="$(printf '%s' "$fallback_model" | xargs)"
    if [[ -z "$fallback_model" || "$fallback_model" == "$DEFAULT_MODEL" ]]; then
      continue
    fi

    echo "Telechargement du modele de secours (${fallback_model})..."
    if curl -sf "${HOST_OLLAMA_URL}/api/pull" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"${fallback_model}\",\"stream\":false}" >/dev/null; then
      echo "Utilisation de ${fallback_model} comme modele actif (le modele par defaut n'a pas pu etre telecharge)."
      update_env "DEFAULT_MODEL" "$fallback_model"
      DEFAULT_MODEL="$fallback_model"
      default_model_pulled=1
      break
    else
      echo "Echec du telechargement du modele de secours ${fallback_model}." >&2
    fi
  done
fi

if [[ "$default_model_pulled" -eq 0 ]]; then
  echo "Aucun modele de conversation n'a pu etre telecharge. Verifiez DEFAULT_MODEL et OLLAMA_FALLBACK_MODELS dans .env." >&2
  exit 1
fi

echo "Telechargement du modele d'embedding (${EMBEDDING_MODEL})..."
curl -sf "${HOST_OLLAMA_URL}/api/pull" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"${EMBEDDING_MODEL}\",\"stream\":false}" >/dev/null

echo "Demarrage complet de la plateforme..."
if image_exists_locally "$BACKEND_IMAGE_NAME"; then
  docker compose -f "$ROOT_DIR/docker-compose.yml" up -d backend
else
  docker compose -f "$ROOT_DIR/docker-compose.yml" up -d --build backend
fi

echo "Demarrage optionnel du service de mise a jour..."
if build_service_or_reuse_local "updater" "$UPDATER_IMAGE_NAME"; then
  docker compose -f "$ROOT_DIR/docker-compose.yml" up -d updater >/dev/null 2>&1 || true
else
  echo "Le service de mise a jour n'a pas pu demarrer pour le moment. L'application principale reste disponible."
fi

LOCAL_IP="$(detect_local_ip || true)"

cat > "$DEPLOYMENT_INFO_FILE" <<EOF
{
  "deployedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "deployedBy": "install.sh",
  "localIp": "${LOCAL_IP}",
  "localAccessUrl": "${LOCAL_IP:+http://$LOCAL_IP:$SERVER_PORT}",
  "localhostAccessUrl": "http://localhost:$SERVER_PORT"
}
EOF

echo "Attente du demarrage du serveur web..."
for attempt in $(seq 1 60); do
  if curl -sf "http://localhost:${SERVER_PORT}/api/health" >/dev/null 2>&1; then
    break
  fi

  if [[ "$attempt" -eq 60 ]]; then
    echo "Le serveur web n'a pas repondu dans le delai imparti." >&2
    exit 1
  fi

  sleep 2
done
has_teacher_password="$(
  docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T backend \
    node --input-type=module -e "import { getTeacherPasswordHash } from './services/accessPasswordService.js'; console.log(getTeacherPasswordHash() ? '1' : '0');" 2>/dev/null || echo "1"
)"

teacher_password_message=""
if [[ "$has_teacher_password" != "1" ]]; then
  echo "Generation du mot de passe enseignant initial..."
  generated_teacher_password="$(
    docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T backend \
      node scripts/reset-teacher-password.js 2>/dev/null | tail -n 2 | head -n 1 || true
  )"
  if [[ -n "$generated_teacher_password" ]]; then
    teacher_password_message="Mot de passe enseignant initial : ${generated_teacher_password} (changement impose a la premiere connexion enseignant)"
  fi
fi

cat <<EOF

Initialisation terminee.
- Application : http://localhost:$SERVER_PORT
- Application reseau local : ${LOCAL_IP:+http://$LOCAL_IP:$SERVER_PORT}
- Admin    : http://localhost:$SERVER_PORT/admin
- Pour obtenir le mot de passe temporaire admin : cd "$ROOT_DIR" && ./password
${teacher_password_message:+- $teacher_password_message}

Scripts utiles :
- Installer : ./install.sh
- Mettre a jour : ./update.sh
- Redemarrer : ./restart.sh
- Arreter : ./stop.sh

EOF
