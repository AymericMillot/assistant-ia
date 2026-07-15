#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
DEPLOYMENT_INFO_FILE="$ROOT_DIR/backend/data/deployment.json"
BACKEND_IMAGE_NAME="fablab-ai-backend"
UPDATER_IMAGE_NAME="fablab-ai-updater"

SCRIPT_ARGS=("$@")

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

os_release_field() {
  local field="$1"
  [[ -f /etc/os-release ]] || return 0
  grep -E "^${field}=" /etc/os-release | head -n 1 | cut -d= -f2- | tr -d '"'
}

# Relance le script avec le groupe docker actif immediatement, sans exiger
# une deconnexion de session. Essaie newgrp puis sg (binaires pas toujours
# presents sur des images minimales/cloud) et se rabat sur "sudo -g docker"
# qui ne depend d'aucun des deux et fonctionne partout ou sudo est deja utilise.
reexec_under_docker_group() {
  local reexec_cmd
  reexec_cmd="$(printf '%q ' "$0" "${SCRIPT_ARGS[@]}")"
  export FABLAB_NEWGRP_RETRY=1

  if command -v newgrp >/dev/null 2>&1; then
    exec newgrp docker <<EOF
$reexec_cmd
EOF
  fi

  if command -v sg >/dev/null 2>&1; then
    exec sg docker -c "$reexec_cmd"
  fi

  exec sudo -u "$USER" -g docker "$0" "${SCRIPT_ARGS[@]}"
}

# Installation automatique de Docker Engine via le depot apt officiel
# (Debian/Ubuntu uniquement). Essaie d'abord le depot correspondant a la
# distribution detectee, puis se rabat sur l'autre famille (Debian <-> Ubuntu)
# en cas d'echec (cle/depot invalide, codename non supporte, etc.).
install_docker_apt_repo() {
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

install_docker_linux() {
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Installation automatique non prise en charge sur cette distribution (apt-get introuvable)." >&2
    echo "-> Installez Docker Engine manuellement : https://docs.docker.com/engine/install/" >&2
    exit 1
  fi

  echo "Docker n'est pas installe : installation automatique en cours..." >&2

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

  if ! install_docker_apt_repo "$primary_distro" "${os_codename:-stable}"; then
    echo "Echec de l'installation via le depot ${primary_distro}, nouvelle tentative via le depot ${fallback_distro}..." >&2
    if ! install_docker_apt_repo "$fallback_distro" "${os_codename:-stable}"; then
      echo "Impossible d'installer Docker automatiquement." >&2
      echo "-> Installez-le manuellement : https://docs.docker.com/engine/install/" >&2
      exit 1
    fi
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "L'installation de Docker a echoue de maniere inattendue." >&2
    echo "-> Installez-le manuellement : https://docs.docker.com/engine/install/" >&2
    exit 1
  fi

  echo "Docker installe avec succes." >&2
  sudo usermod -aG docker "$USER"
  echo "-> Activation du groupe docker pour cette session (newgrp docker)..." >&2
  reexec_under_docker_group
}

# Verifie que Docker est present ET que le daemon repond. Sur Debian/Ubuntu,
# installe Docker automatiquement s'il est absent ; sur les autres OS on
# prefere orienter plutot que modifier le systeme (installeurs graphiques).
check_docker() {
  local os_label
  os_label="$(detect_os_label)"

  if ! command -v docker >/dev/null 2>&1; then
    case "$os_label" in
      macOS|Windows)
        echo "Docker n'est pas installe sur cette machine (${os_label})." >&2
        echo "-> Installez Docker Desktop : https://www.docker.com/products/docker-desktop/" >&2
        exit 1
        ;;
      Linux)
        install_docker_linux
        ;;
      *)
        echo "Docker n'est pas installe sur cette machine (${os_label})." >&2
        echo "-> Consultez https://docs.docker.com/get-docker/" >&2
        exit 1
        ;;
    esac
  fi

  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker est installe mais le plugin \"docker compose\" (v2) est absent." >&2
    case "$os_label" in
      macOS|Windows)
        echo "-> Mettez a jour Docker Desktop (il inclut docker compose par defaut) : https://www.docker.com/products/docker-desktop/" >&2
        ;;
      Linux)
        echo "-> Installez le plugin : https://docs.docker.com/compose/install/linux/" >&2
        ;;
    esac
    exit 1
  fi

  local docker_info_output
  if docker_info_output="$(docker info 2>&1)"; then
    return 0
  fi

  # "permission denied" sur le socket (Linux, utilisateur pas dans le groupe
  # docker) est une cause tres frequente et differente de "daemon arrete" :
  # relancer le service ne resout rien tant que l'utilisateur n'a pas les
  # droits sur /var/run/docker.sock (necessite une reconnexion de session).
  if [[ "$os_label" == "Linux" ]] && printf '%s' "$docker_info_output" | grep -qi "permission denied"; then
    # Cas frequent : l'utilisateur vient d'etre ajoute au groupe docker (via
    # usermod) mais la session en cours ne l'a pas encore pris en compte.
    # Plutot que d'exiger une deconnexion, on relance le script sous
    # "newgrp docker" pour activer le groupe immediatement.
    if [[ -z "${FABLAB_NEWGRP_RETRY:-}" ]] && getent group docker >/dev/null 2>&1 \
      && id -nG "$USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
      echo "Cet utilisateur appartient au groupe docker, mais la session actuelle ne l'a pas encore pris en compte." >&2
      echo "-> Reactivation du groupe docker pour cette session (newgrp docker)..." >&2
      reexec_under_docker_group
    fi

    echo "Docker tourne, mais cet utilisateur n'a pas le droit d'y acceder (permission refusee sur le socket)." >&2
    echo "-> Ajoutez votre utilisateur au groupe docker puis reconnectez-vous (ou redemarrez) :" >&2
    echo "   sudo usermod -aG docker \$USER" >&2
    echo "   puis fermez et rouvrez votre session (ou : newgrp docker) et relancez ./install.sh" >&2
    exit 1
  fi

  echo "Docker est installe mais le daemon ne repond pas." >&2

  if [[ "$os_label" == "Linux" ]]; then
    echo "-> Tentative de demarrage automatique du service Docker..." >&2
    if command -v systemctl >/dev/null 2>&1; then
      sudo systemctl enable --now docker >/dev/null 2>&1 || true
    elif command -v service >/dev/null 2>&1; then
      sudo service docker start >/dev/null 2>&1 || true
    fi

    local start_attempt
    for start_attempt in $(seq 1 15); do
      if docker info >/dev/null 2>&1; then
        echo "Service Docker demarre avec succes." >&2
        return 0
      fi
      sleep 1
    done

    echo "Impossible de demarrer le service Docker automatiquement." >&2
    echo "-> Demarrez-le manuellement : sudo systemctl start docker" >&2
    exit 1
  fi

  echo "-> Demarrez l'application Docker Desktop puis relancez ce script." >&2
  exit 1
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
  # Les modeles Ollama sont stockes dans le volume Docker, pas forcement sur
  # le meme point de montage que ROOT_DIR : on verifie l'espace la ou Docker
  # stocke reellement ses donnees quand c'est possible.
  local docker_root
  docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  local check_path="$ROOT_DIR"
  if [[ -n "$docker_root" && -d "$docker_root" ]]; then
    check_path="$docker_root"
  fi

  local available_kb
  available_kb="$(df -Pk "$check_path" 2>/dev/null | tail -1 | awk '{print $4}')"

  # En dessous de 3 Go, tente un nettoyage automatique avant de conclure :
  # apres plusieurs tentatives d'installation ratees, le cache BuildKit et
  # les images intermediaires peuvent a eux seuls occuper plusieurs Go.
  if [[ -n "$available_kb" && "$available_kb" -lt 3000000 ]]; then
    echo "Espace disque faible sur ${check_path} : nettoyage du cache Docker (builds et images inutilises)..." >&2
    docker builder prune -af >/dev/null 2>&1 || true
    docker system prune -af >/dev/null 2>&1 || true
    available_kb="$(df -Pk "$check_path" 2>/dev/null | tail -1 | awk '{print $4}')"
  fi

  [[ -z "$available_kb" ]] && return 0
  local available_gb=$((available_kb / 1024 / 1024))

  # En dessous de 2 Go, la construction des images et le telechargement des
  # modeles sont voues a l'echec (plusieurs Go necessaires) : on arrete tout
  # de suite avec un diagnostic exploitable plutot que de laisser un build
  # de plusieurs minutes echouer avec une erreur bas niveau (overlayfs, etc.).
  if [[ "$available_kb" -lt 2000000 ]]; then
    echo "Erreur : seulement environ ${available_gb} Go d'espace disque disponible sur ${check_path} (apres nettoyage)." >&2
    echo "C'est insuffisant pour construire les images et telecharger les modeles Ollama (plusieurs Go necessaires)." >&2
    echo "-> Verifiez l'espace disque reel de la machine : df -h" >&2
    echo "-> Verifiez si un disque/volume plus grand existe mais n'est pas utilise : lsblk" >&2
    echo "-> Si oui : agrandissez la partition/le systeme de fichiers (ex : growpart puis resize2fs sur un VPS/cloud), ou deplacez le stockage Docker vers ce disque (\"data-root\" dans /etc/docker/daemon.json, puis sudo systemctl restart docker)." >&2
    exit 1
  fi

  if [[ "$available_kb" -lt 5000000 ]]; then
    echo "Attention : environ ${available_gb} Go d'espace disque disponible sur ${check_path}. Le telechargement des modeles Ollama peut echouer." >&2
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

DEFAULT_MODEL="${DEFAULT_MODEL_VALUE:-gemma2:2b}"
EMBEDDING_MODEL="${EMBEDDING_MODEL_VALUE:-nomic-embed-text}"
FALLBACK_MODELS_RAW="${FALLBACK_MODELS_VALUE:-${FALLBACK_MODEL_VALUE:-}}"
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
  if docker exec fablab-ollama ollama list >/dev/null 2>&1; then
    break
  fi

  if [[ "$attempt" -eq 60 ]]; then
    echo "Ollama n'a pas repondu dans le delai imparti." >&2
    exit 1
  fi

  sleep 2
done

# Espace libre (en Ko) dans le volume ou Ollama stocke ses modeles.
ollama_free_kb() {
  docker exec fablab-ollama df -Pk /root/.ollama 2>/dev/null | tail -1 | awk '{print $4}'
}

# Un pull interrompu par manque d'espace laisse des blobs "*-partial" qui
# occupent l'espace sans etre reutilisables tels quels : on les purge pour
# recuperer de la place avant la tentative suivante.
cleanup_ollama_partial_downloads() {
  docker exec fablab-ollama sh -c 'rm -f /root/.ollama/models/blobs/*-partial' >/dev/null 2>&1 || true
}

# Telecharge un modele Ollama. Distingue explicitement le manque d'espace
# disque (message actionnable + nettoyage des blobs partiels) d'un nom de
# modele invalide ou indisponible, au lieu d'un message generique trompeur.
pull_ollama_model() {
  local model="$1"
  local min_free_kb=$((2 * 1024 * 1024))
  local free_kb
  free_kb="$(ollama_free_kb)"

  if [[ -n "$free_kb" && "$free_kb" -lt "$min_free_kb" ]]; then
    echo "Espace disque insuffisant pour telecharger ${model} (moins de 2 Go libres pour Ollama). Liberez de l'espace disque et relancez ./install.sh." >&2
    return 1
  fi

  local pull_output
  if pull_output="$(docker exec fablab-ollama ollama pull "$model" 2>&1)"; then
    return 0
  fi

  if printf '%s' "$pull_output" | grep -qi "no space left on device"; then
    echo "Echec du telechargement de ${model} : plus assez d'espace disque disponible." >&2
    cleanup_ollama_partial_downloads
  else
    echo "Echec du telechargement de ${model} (nom invalide ou modele indisponible)." >&2
  fi
  return 1
}

echo "Telechargement du modele par defaut (${DEFAULT_MODEL})..."
default_model_pulled=0
if pull_ollama_model "${DEFAULT_MODEL}"; then
  default_model_pulled=1
else
  echo "Passage aux modeles de secours." >&2
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
    if pull_ollama_model "$fallback_model"; then
      echo "Utilisation de ${fallback_model} comme modele actif (le modele par defaut n'a pas pu etre telecharge)."
      update_env "DEFAULT_MODEL" "$fallback_model"
      DEFAULT_MODEL="$fallback_model"
      default_model_pulled=1
      break
    fi
  done
fi

if [[ "$default_model_pulled" -eq 0 ]]; then
  echo "Aucun modele de conversation n'a pu etre telecharge. Verifiez DEFAULT_MODEL et OLLAMA_FALLBACK_MODELS dans .env, et l'espace disque disponible." >&2
  exit 1
fi

echo "Telechargement du modele d'embedding (${EMBEDDING_MODEL})..."
if ! pull_ollama_model "${EMBEDDING_MODEL}"; then
  echo "Impossible de telecharger le modele d'embedding ${EMBEDDING_MODEL}." >&2
  exit 1
fi

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

# Ouvre automatiquement le port de l'application dans UFW si ce pare-feu est
# actif (cas frequent sur des serveurs Ubuntu), pour que l'appli soit
# accessible depuis le reseau sans intervention manuelle.
FIREWALL_NOTE=""
if [[ "$(detect_os_label)" == "Linux" ]] && command -v ufw >/dev/null 2>&1; then
  if sudo ufw status 2>/dev/null | head -n 1 | grep -qi "active"; then
    echo "UFW est actif : ouverture du port ${SERVER_PORT}/tcp..."
    if sudo ufw allow "${SERVER_PORT}/tcp" >/dev/null 2>&1; then
      echo "Port ${SERVER_PORT}/tcp autorise dans UFW."
    else
      FIREWALL_NOTE="Si l'application n'est pas accessible depuis le reseau, ouvrez le port manuellement : sudo ufw allow ${SERVER_PORT}/tcp"
    fi
  fi
fi

has_teacher_password="$(
  docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T backend \
    node --input-type=module -e "import { getTeacherPasswordHash } from './services/accessPasswordService.js'; console.log(getTeacherPasswordHash() ? '1' : '0');" 2>/dev/null || echo "1"
)"

teacher_password_message=""
if [[ "$has_teacher_password" != "1" ]]; then
  echo "Generation du mot de passe administrateur initial..."
  generated_teacher_password="$(
    docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T backend \
      node scripts/reset-teacher-password.js 2>/dev/null | tail -n 2 | head -n 1 || true
  )"
  if [[ -n "$generated_teacher_password" ]]; then
    teacher_password_message="Mot de passe administrateur initial : ${generated_teacher_password} (changement impose a la premiere connexion administrateur)"
  fi
fi

cat <<EOF

Initialisation terminee.
- Application : http://localhost:$SERVER_PORT
- Application reseau local : ${LOCAL_IP:+http://$LOCAL_IP:$SERVER_PORT}
- Admin    : http://localhost:$SERVER_PORT/admin
- Pour obtenir le mot de passe temporaire admin : cd "$ROOT_DIR" && ./password
${teacher_password_message:+- $teacher_password_message}
${FIREWALL_NOTE:+
Attention : $FIREWALL_NOTE}

Scripts utiles :
- Installer : ./install.sh
- Mot de passe temporaire admin : ./password
- Mettre a jour : ./update.sh
- Voir la version installee : ./version.sh
- Redemarrer : ./restart.sh
- Arreter : ./stop.sh
- Reinitialiser (efface tout, redemande la configuration) : ./reset.sh
- Aide / documentation : ./help.sh

EOF
