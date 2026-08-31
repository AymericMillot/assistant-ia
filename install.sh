#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# $USER n'est pas toujours exporte (ex: session via "docker exec", certains
# environnements SSH/cloud minimalistes) : sans repli, set -u fait planter le
# script des la premiere utilisation. "id -un" est disponible partout.
USER="${USER:-$(id -un)}"

ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
DEPLOYMENT_INFO_FILE="$ROOT_DIR/backend/data/deployment.json"
BACKEND_IMAGE_NAME="assistant-ia-backend"
UPDATER_IMAGE_NAME="assistant-ia-updater"

SCRIPT_ARGS=("$@")

# Filet de securite : quelle que soit l'etape qui echoue, l'operateur repart
# avec une consigne unique (./doctor.sh repare la majorite des cas) plutot
# qu'avec un code de sortie brut. N'altere pas le code de sortie reel.
install_error_hint() {
  local exit_code=$?
  local line_no="${1:-?}"
  echo >&2
  echo "L'installation s'est interrompue (etape ligne ${line_no}, code ${exit_code})." >&2
  echo "  -> Diagnostic et reparation automatique : ./doctor.sh" >&2
  echo "  -> Puis relancez : ./install.sh" >&2
}
install_interrupt_hint() {
  echo >&2
  echo "Installation interrompue (Ctrl-C). Relancez ./install.sh : l'etat deja" >&2
  echo "cree (images, modeles telecharges) est reutilise, rien n'est recommence a zero." >&2
  exit 130
}
trap 'install_error_hint "$LINENO"' ERR
trap install_interrupt_hint INT

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

# Une flotte peut injecter une valeur locale sans la placer dans le depot ni
# dans la ligne de commande. Le fichier la contient sur sa première ligne.
OWNER_PASSWORD_FILE="${ASSISTANT_IA_OWNER_PASSWORD_FILE:-}"
for ((arg_index = 0; arg_index < ${#SCRIPT_ARGS[@]}; arg_index++)); do
  if [[ "${SCRIPT_ARGS[$arg_index]}" == "--owner-password-file" ]]; then
    next_index=$((arg_index + 1))
    if [[ "$next_index" -ge "${#SCRIPT_ARGS[@]}" || -z "${SCRIPT_ARGS[$next_index]}" ]]; then
      echo "L'option de fichier de secret attend un chemin." >&2
      exit 1
    fi
    OWNER_PASSWORD_FILE="${SCRIPT_ARGS[$next_index]}"
  fi
done

# Installation d'une version specifique : ./install.sh --v1.000 recupere cette
# version precise depuis le serveur de mise a jour (update.config.json) avant
# de poursuivre l'installation normale, plutot que d'utiliser les fichiers
# locaux courants.
REQUESTED_VERSION=""
for arg in "$@"; do
  if [[ "$arg" =~ ^--v([0-9][0-9A-Za-z.]*)$ ]]; then
    REQUESTED_VERSION="${BASH_REMATCH[1]}"
  fi
done

json_string_field_from_file() {
  local file="$1"
  local field="$2"
  [[ -f "$file" ]] || return 1
  grep -o "\"${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$file" \
    | head -n 1 \
    | sed -E "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\"/\1/"
}

compute_sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Reessaie une operation dependante d'Internet (telechargement, pull d'image Docker,
# telechargement de modele Ollama...) en cas de coupure reseau temporaire pendant
# l'installation, plutot que d'abandonner immediatement. Jusqu'a 10 tentatives, avec
# une attente entre chacune pour laisser le temps a la connexion de revenir.
# Si la commande retourne un code 2, l'echec n'est PAS lie au reseau (ex: espace
# disque insuffisant) : reessayer ne changerait rien, on abandonne tout de suite.
retry_on_network_failure() {
  local description="$1"
  shift
  local max_attempts=10
  local delay_seconds=15
  local attempt status

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    # Ne pas tester "$@" directement dans le if : un "if" dont la condition
    # echoue sans "else" remet $? a 0 une fois le bloc referme, ce qui rendrait
    # le code de sortie reel (ex: 2 pour "pas la peine de reessayer") illisible
    # juste apres.
    if "$@"; then
      status=0
    else
      status=$?
    fi

    if [[ "$status" -eq 0 ]]; then
      return 0
    fi

    if [[ "$status" -eq 2 ]]; then
      return 2
    fi

    if [[ "$attempt" -ge "$max_attempts" ]]; then
      break
    fi

    echo "${description} a echoue (tentative ${attempt}/${max_attempts}), coupure Internet possible. Nouvelle tentative dans ${delay_seconds}s..." >&2
    sleep "$delay_seconds"
  done

  echo "${description} a echoue apres ${max_attempts} tentatives. Verifiez votre connexion Internet et relancez ./install.sh." >&2
  return 1
}

# Affiche les dernieres lignes de log d'un service (best effort, sur stderr),
# apres un timeout de demarrage : donne la cause probable tout de suite au lieu
# d'un simple « n'a pas repondu dans le delai imparti ».
dump_recent_service_logs() {
  local service="$1"
  local lines="${2:-40}"
  command -v docker >/dev/null 2>&1 || return 0
  echo "---- Derniers logs de ${service} (${lines} lignes) ----" >&2
  docker compose -f "$ROOT_DIR/docker-compose.yml" logs --tail "$lines" "$service" 2>&1 \
    | sed 's/^/  /' >&2 || true
  echo "----------------------------------------------------" >&2
}

# Noms fixes des conteneurs du projet (container_name dans docker-compose.yml)
# et reseau Compose par defaut (derive de "name:" dans ce meme fichier).
PROJECT_CONTAINER_NAMES=(
  assistant-ia-backend
  assistant-ia-updater
  assistant-ia-ollama
  assistant-ia-chromadb
  assistant-ia-redis
  assistant-ia-frontend
)
PROJECT_COMPOSE_NETWORK="${COMPOSE_PROJECT_NAME:-assistant-ia}_default"

# Nettoie l'etat Docker residuel qui fait le plus souvent echouer une commande
# "docker compose ..." avec le code 125 lors d'une primo-installation (ou d'une
# reprise apres un premier essai interrompu par un manque d'espace disque, une
# coupure reseau, un Ctrl-C...) :
#   - conteneur orphelin d'une tentative precedente ("The container name ... is
#     already in use") ;
#   - reseau Compose par defaut a moitie cree ;
#   - sous-systeme reseau du daemon en defaut, frequent sur Ubuntu juste apres
#     l'installation de Docker : un redemarrage du daemon suffit a le reamorcer.
# Ne touche jamais aux volumes de donnees (modeles Ollama, base SQLite, uploads).
# $1 = sortie combinee de la commande compose qui vient d'echouer.
# Retourne 0 si une action de recuperation a ete tentee, 1 sinon.
recover_docker_125() {
  local failure_output="${1:-}"

  if printf '%s' "$failure_output" \
    | grep -qiE 'is already in use by container|container name .* is already in use|Conflict\. The container name'; then
    echo "-> Code 125 : suppression des conteneurs orphelins d'une tentative precedente..." >&2
    docker rm -f "${PROJECT_CONTAINER_NAMES[@]}" >/dev/null 2>&1 || true
    docker compose -f "$ROOT_DIR/docker-compose.yml" down --remove-orphans >/dev/null 2>&1 || true
    return 0
  fi

  if printf '%s' "$failure_output" \
    | grep -qiE 'iptables|failed to (set ?up|create|program).*(network|endpoint|ip ?tables)|network [-_a-z0-9]+ not found|Failed to Setup IP tables|could not find an available, non-overlapping'; then
    echo "-> Code 125 : redemarrage du daemon Docker (sous-systeme reseau en defaut)..." >&2
    if command -v systemctl >/dev/null 2>&1; then
      sudo systemctl restart docker >/dev/null 2>&1 || true
    elif command -v service >/dev/null 2>&1; then
      sudo service docker restart >/dev/null 2>&1 || true
    fi
    local wait_attempt
    for wait_attempt in $(seq 1 20); do
      docker info >/dev/null 2>&1 && break
      sleep 1
    done
    docker network rm "$PROJECT_COMPOSE_NETWORK" >/dev/null 2>&1 || true
    return 0
  fi

  return 1
}

# Supprime, AVANT la premiere commande Compose, les conteneurs/reseau laisses
# par une installation precedente interrompue quand aucun service du projet ne
# tourne : sinon "docker compose up" echoue directement en code 125 ("name is
# already in use") sans que la boucle de reprise ait la moindre chance.
preflight_clear_stale_stack() {
  docker info >/dev/null 2>&1 || return 0

  local running_count
  running_count="$(docker compose -f "$ROOT_DIR/docker-compose.yml" ps --status running --services 2>/dev/null | grep -c . || true)"
  [[ "${running_count:-0}" -gt 0 ]] && return 0

  local stale=""
  local name status
  for name in "${PROJECT_CONTAINER_NAMES[@]}"; do
    status="$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || true)"
    [[ -n "$status" ]] && stale+=" $name"
  done

  if [[ -n "$stale" ]]; then
    echo "Conteneurs d'une installation precedente interrompue detectes (${stale# }) : nettoyage avant de repartir..." >&2
    docker compose -f "$ROOT_DIR/docker-compose.yml" down --remove-orphans >/dev/null 2>&1 || true
    docker rm -f $stale >/dev/null 2>&1 || true
    docker network rm "$PROJECT_COMPOSE_NETWORK" >/dev/null 2>&1 || true
  fi
}

# Execute « docker compose run --rm ... » en capturant sa sortie standard (que
# l'appelant recupere : hash bcrypt, JSON de recommandation materielle...) et
# en reessayant sur code 125 (conteneur orphelin, reseau du daemon pas encore
# pret juste apres son demarrage). La sortie standard part sur stdout, tous les
# diagnostics sur stderr.
compose_run_capture() {
  local attempt=1 max_attempts=3 out exit_code err_file
  err_file="$(mktemp)"

  while (( attempt <= max_attempts )); do
    if out="$(docker compose -f "$ROOT_DIR/docker-compose.yml" run --rm --no-deps "$@" 2>"$err_file")"; then
      cat "$err_file" >&2
      rm -f "$err_file"
      printf '%s' "$out"
      return 0
    fi
    exit_code=$?
    cat "$err_file" >&2

    if (( attempt < max_attempts )); then
      if [[ "$exit_code" -eq 125 ]]; then
        recover_docker_125 "$(cat "$err_file" 2>/dev/null || true)" || true
      fi
      sleep $((attempt * 5))
    fi
    attempt=$((attempt + 1))
  done

  rm -f "$err_file"
  return "${exit_code:-1}"
}

# Telecharge, verifie (SHA256) et applique une version precise depuis le
# serveur de mise a jour distant, puis relance install.sh (desormais a jour)
# pour poursuivre l'installation normalement avec ces fichiers.
install_requested_version() {
  local version="$1"

  if [[ -n "${ASSISTANT_IA_VERSION_APPLIED:-}" ]]; then
    return 0
  fi

  # tar/curl/rsync + un outil SHA-256 sont indispensables pour recuperer et
  # deployer un package distant. rsync est absent des images cloud
  # Debian/Ubuntu minimales et d'Alpine ; sans ce controle l'echec surviendrait
  # apres le telechargement avec un message obscur ("rsync: command not found"
  # ou "SHA256 verification failed" alors que l'archive est saine).
  local missing_tools=()
  local required_tool
  for required_tool in curl tar rsync; do
    command -v "$required_tool" >/dev/null 2>&1 || missing_tools+=("$required_tool")
  done
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    missing_tools+=("coreutils")
  fi
  if [[ ${#missing_tools[@]} -gt 0 ]]; then
    echo "Outils systeme manquants pour installer une version distante : ${missing_tools[*]}" >&2
    if command -v apt-get >/dev/null 2>&1; then
      echo "  -> sudo apt-get update && sudo apt-get install -y ${missing_tools[*]}" >&2
    elif command -v dnf >/dev/null 2>&1; then
      echo "  -> sudo dnf install -y ${missing_tools[*]}" >&2
    elif command -v apk >/dev/null 2>&1; then
      echo "  -> sudo apk add ${missing_tools[*]}" >&2
    fi
    exit 1
  fi

  echo "==> Recuperation de la version ${version} depuis le serveur de mise a jour..." >&2

  local update_config_file="$ROOT_DIR/update.config.json"
  if [[ ! -f "$update_config_file" ]]; then
    echo "update.config.json introuvable : impossible de recuperer une version specifique." >&2
    exit 1
  fi

  local update_type base_url version_file_name package_template repository api_base_url require_sha256
  update_type="$(json_string_field_from_file "$update_config_file" "type")"
  base_url="$(json_string_field_from_file "$update_config_file" "baseUrl")"
  version_file_name="$(json_string_field_from_file "$update_config_file" "versionFile")"
  package_template="$(json_string_field_from_file "$update_config_file" "packageFileTemplate")"
  repository="$(json_string_field_from_file "$update_config_file" "repository")"
  api_base_url="$(json_string_field_from_file "$update_config_file" "apiBaseUrl")"
  require_sha256="$(grep -o '"requireSha256"[[:space:]]*:[[:space:]]*[a-z]*' "$update_config_file" | head -n1 | grep -o '[a-z]*$')"
  version_file_name="${version_file_name:-version.json}"
  api_base_url="${api_base_url:-https://api.github.com}"
  api_base_url="${api_base_url%/}"

  if [[ -z "$package_template" ]]; then
    echo "Configuration du serveur de mise a jour incomplete (update.config.json)." >&2
    exit 1
  fi

  local version_url package_name package_url
  package_name="${package_template//\{version\}/$version}"
  if [[ "$update_type" == "github-releases" ]]; then
    if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
      echo "Le depot GitHub configure pour les mises a jour est invalide." >&2
      exit 1
    fi
    # Assets de release = uniquement le code source ; le SHA-256 est publie
    # dans le corps de la release, lu ici via l'API GitHub.
    version_url="${api_base_url}/repos/${repository}/releases/tags/v${version}"
    package_url="https://github.com/${repository}/releases/download/v${version}/${package_name}"
  else
    if [[ -z "$base_url" ]]; then
      echo "Configuration du serveur de mise a jour incomplete (update.config.json)." >&2
      exit 1
    fi
    version_url="${base_url%/}/${version}/${version_file_name}"
    package_url="${base_url%/}/${version}/${package_name}"
  fi

  local temp_root
  temp_root="$(mktemp -d)"
  trap 'rm -rf "$temp_root"' EXIT

  echo "    Verification de la version distante..." >&2
  local manifest_path="$temp_root/version.json"
  if ! retry_on_network_failure "Verification de la version distante" \
    curl -fsSL -H "Accept: application/vnd.github+json" "$version_url" -o "$manifest_path"; then
    echo "Version ${version} introuvable sur le serveur de mise a jour (${version_url})." >&2
    exit 1
  fi

  local remote_sha256
  if [[ "$update_type" == "github-releases" ]]; then
    # Extrait le premier "sha256 ... <64 hex>" du corps de la release (champ JSON "body").
    remote_sha256="$(grep -oiE 'sha-?256[^0-9a-f]{0,40}[0-9a-f]{64}' "$manifest_path" | grep -oiE '[0-9a-f]{64}' | head -n1)"
    [[ -z "$remote_sha256" ]] && remote_sha256="$(grep -oiE '[0-9a-f]{64}' "$manifest_path" | head -n1)"
  else
    local remote_version
    remote_version="$(json_string_field_from_file "$manifest_path" "version")"
    remote_sha256="$(json_string_field_from_file "$manifest_path" "sha256")"
    if [[ "$remote_version" != "$version" ]]; then
      echo "La version distante annoncee (${remote_version:-inconnue}) ne correspond pas a ${version} demandee." >&2
      exit 1
    fi
  fi

  if [[ ! "$remote_sha256" =~ ^[A-Fa-f0-9]{64}$ ]]; then
    if [[ "$require_sha256" == "false" ]]; then
      echo "    (aucune empreinte SHA256 publiee ; verification ignoree car requireSha256=false)" >&2
      remote_sha256=""
    else
      echo "Aucune empreinte SHA256 valide pour la version ${version} (corps de release)." >&2
      exit 1
    fi
  fi

  echo "    Telechargement de ${package_name}..." >&2
  local archive_path="$temp_root/package.tar.gz"
  if ! retry_on_network_failure "Telechargement de ${package_name}" \
    curl -fsSL "$package_url" -o "$archive_path"; then
    echo "Impossible de telecharger le package : ${package_url}" >&2
    exit 1
  fi

  if [[ -n "$remote_sha256" ]]; then
    echo "    Verification de l'integrite (SHA256)..." >&2
    local computed_sha computed_sha_lower remote_sha256_lower
    computed_sha="$(compute_sha256_file "$archive_path")"
    # tr plutot que ${var,,} : bash 3.2 (defaut sur macOS) ne supporte pas
    # cette syntaxe de minification introduite en bash 4.
    computed_sha_lower="$(printf '%s' "$computed_sha" | tr '[:upper:]' '[:lower:]')"
    remote_sha256_lower="$(printf '%s' "$remote_sha256" | tr '[:upper:]' '[:lower:]')"
    if [[ "$computed_sha_lower" != "$remote_sha256_lower" ]]; then
      echo "La verification SHA256 du package a echoue : version corrompue ou incidente." >&2
      exit 1
    fi
  fi

  echo "    Preparation des fichiers..." >&2
  local extract_root="$temp_root/extract"
  mkdir -p "$extract_root"
  tar -xzf "$archive_path" -C "$extract_root"

  local package_root="$extract_root"
  if [[ ! -f "$package_root/docker-compose.yml" ]]; then
    local candidate
    for candidate in "$extract_root"/*; do
      if [[ -d "$candidate" && -f "$candidate/docker-compose.yml" ]]; then
        package_root="$candidate"
        break
      fi
    done
  fi

  if [[ ! -f "$package_root/docker-compose.yml" ]]; then
    echo "Le package telecharge est incomplet (docker-compose.yml introuvable)." >&2
    exit 1
  fi

  echo "    Application des fichiers de la version ${version}..." >&2
  local rsync_args=(-a --delete)
  local preserve_path
  for preserve_path in .env update.config.json backend/uploads backend/logs backend/data .git .update-backups assistant-ia-admin-cookie.txt export release .claude; do
    rsync_args+=("--exclude=/${preserve_path}")
  done
  rsync "${rsync_args[@]}" "$package_root"/ "$ROOT_DIR"/

  rm -rf "$temp_root"
  trap - EXIT

  echo "==> Version ${version} installee. Poursuite de l'installation..." >&2
  export ASSISTANT_IA_VERSION_APPLIED=1
  exec "$0" "${SCRIPT_ARGS[@]}"
}

if [[ -n "$REQUESTED_VERSION" ]]; then
  install_requested_version "$REQUESTED_VERSION"
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
  export ASSISTANT_IA_NEWGRP_RETRY=1

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
    if [[ -z "${ASSISTANT_IA_NEWGRP_RETRY:-}" ]] && getent group docker >/dev/null 2>&1 \
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
    if docker inspect --format '{{.State.Status}}' assistant-ia-backend 2>/dev/null | grep -qx running \
      && docker port assistant-ia-backend "${port}/tcp" 2>/dev/null | grep -Eq ":${port}$"; then
      echo "Le port ${port} est deja utilise par l'installation Assistant IA en cours : reutilisation normale."
      return 0
    fi
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
preflight_clear_stale_stack

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo "Fichier .env cree a partir de .env.example"
fi
chmod 600 "$ENV_FILE" 2>/dev/null || true

current_encryption_key="$(get_env_value "CONFIG_ENCRYPTION_KEY")"
if [[ -z "$current_encryption_key" ]]; then
  echo "Generation de CONFIG_ENCRYPTION_KEY (chiffrement des secrets au repos)..."
  update_env "CONFIG_ENCRYPTION_KEY" "$(generate_random_key)"
fi

# JWT_SECRET est fourni avec une valeur d'exemple non vide dans .env.example :
# sans cette regeneration, une installation fraiche demarrerait avec un secret
# de signature previsible et identique a d'autres installations.
current_jwt_secret="$(get_env_value "JWT_SECRET")"
if [[ -z "$current_jwt_secret" || "$current_jwt_secret" == "changeme_secret_jwt_tres_long" ]]; then
  echo "Generation de JWT_SECRET (signature des sessions)..."
  update_env "JWT_SECRET" "$(generate_random_key)"
fi

# Jeton partage backend <-> updater : authentifie les operations privilegiees
# de mise a jour sur le reseau Docker interne (voir requireSharedToken).
current_updater_token="$(get_env_value "UPDATER_SHARED_TOKEN")"
if [[ -z "$current_updater_token" ]]; then
  echo "Generation de UPDATER_SHARED_TOKEN (authentification du service de mise a jour)..."
  update_env "UPDATER_SHARED_TOKEN" "$(generate_random_key)"
fi

current_owner_password="$(get_env_value "OWNER_BOOTSTRAP_PASSWORD")"
if [[ -n "$OWNER_PASSWORD_FILE" ]]; then
  if [[ ! -r "$OWNER_PASSWORD_FILE" ]]; then
    echo "Fichier de configuration illisible : $OWNER_PASSWORD_FILE" >&2
    exit 1
  fi
  IFS= read -r current_owner_password < "$OWNER_PASSWORD_FILE" || true
  current_owner_password="${current_owner_password%$'\r'}"
  if [[ ${#current_owner_password} -lt 16 ]]; then
    echo "Le secret fourni doit contenir au moins 16 caracteres." >&2
    exit 1
  fi
  update_env "OWNER_BOOTSTRAP_PASSWORD" "$current_owner_password"
elif [[ -z "$current_owner_password" ]]; then
  echo "Generation de la configuration locale securisee..."
  current_owner_password="$(generate_random_key)"
  update_env "OWNER_BOOTSTRAP_PASSWORD" "$current_owner_password"
elif [[ ${#current_owner_password} -lt 16 ]]; then
  echo "La valeur de configuration doit contenir au moins 16 caracteres." >&2
  exit 1
fi

DEFAULT_MODEL_VALUE="$(get_env_value "DEFAULT_MODEL")"
EMBEDDING_MODEL_VALUE="$(get_env_value "EMBEDDING_MODEL")"
FALLBACK_MODELS_VALUE="$(get_env_value "OLLAMA_FALLBACK_MODELS")"
FALLBACK_MODEL_VALUE="$(get_env_value "OLLAMA_FALLBACK_MODEL")"

DEFAULT_MODEL="${DEFAULT_MODEL_VALUE:-gemma2:2b}"
EMBEDDING_MODEL="${EMBEDDING_MODEL_VALUE:-nomic-embed-text-v2-moe:latest}"
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

# "docker compose up" peut echouer avec le code 125 (echec de la commande
# docker/compose elle-meme, pas du conteneur) pour des raisons variees :
# daemon Docker pas encore pret, cache de build corrompu, ressources
# epuisees. On retente avec un delai croissant avant d'abandonner.
docker_compose_up_service_required() {
  local -a services=("$@")
  local services_label="${services[*]}"
  local attempt exit_code delay log_file
  local max_attempts=3
  log_file="$(mktemp)"

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    # Ne pas tester la commande directement dans le if : un "if" dont la
    # condition echoue sans "else" remet $? a 0 une fois le bloc referme, ce
    # qui rendrait le vrai code de sortie (125, etc.) illisible juste apres,
    # et ferait retourner 0 (succes) a la fin malgre l'echec reel. La sortie
    # est dupliquee (tee) pour rester visible tout en etant analysable par
    # recover_docker_125.
    if docker compose -f "$ROOT_DIR/docker-compose.yml" up -d "${services[@]}" 2>&1 | tee "$log_file"; then
      exit_code=0
    else
      exit_code=${PIPESTATUS[0]}
    fi

    if [[ "$exit_code" -eq 0 ]]; then
      rm -f "$log_file"
      return 0
    fi

    if [[ "$attempt" -lt "$max_attempts" ]]; then
      if [[ "$exit_code" -eq 125 ]]; then
        recover_docker_125 "$(cat "$log_file" 2>/dev/null || true)" || true
      fi
      delay=$((attempt * 5))
      echo "« docker compose up ${services_label} » a echoue (code ${exit_code}), nouvelle tentative dans ${delay}s (${attempt}/${max_attempts})..." >&2
      sleep "$delay"
      continue
    fi

    rm -f "$log_file"
    echo "« docker compose up ${services_label} » a echoue (code ${exit_code}) apres ${max_attempts} tentatives." >&2
    if [[ "$exit_code" -eq 125 ]]; then
      echo "Code 125 : la commande docker/compose elle-meme a echoue (pas le conteneur)." >&2
      echo "Causes frequentes et verifications :" >&2
      echo "  - Le daemon Docker n'est pas demarre ou pas encore pret : systemctl status docker (ou relancez Docker Desktop)." >&2
      echo "  - Utilisateur non membre du groupe docker : sudo usermod -aG docker \$USER puis reconnectez-vous." >&2
      echo "  - Espace disque insuffisant pour construire les images : df -h" >&2
      echo "  - Cache de build corrompu : docker builder prune" >&2
      echo "  - Conflit de port ou de conteneur existant : docker ps -a" >&2
      echo "  - Le nettoyage automatique n'a pas suffi : ./doctor.sh (diagnostic + reparation)." >&2
    fi
    return "$exit_code"
  done
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
retry_on_network_failure "Construction de l'image backend" \
  build_service_or_reuse_local "backend" "$BACKEND_IMAGE_NAME"

current_admin_hash="$(get_env_value "ADMIN_PASSWORD_HASH")"
administrator_password_message=""
if [[ -z "$current_admin_hash" ]]; then
  echo "Generation du mot de passe initial administrateur..."
  initial_admin_password="$(generate_random_key)"
  generated_hash="$(compose_run_capture \
    -e "ADMIN_INITIAL_PASSWORD=$initial_admin_password" backend \
    node --input-type=module -e "import bcrypt from 'bcrypt'; console.log(await bcrypt.hash(process.env.ADMIN_INITIAL_PASSWORD, 12));")"
  if [[ "$generated_hash" != \$2* ]]; then
    echo "Echec de generation du hash du mot de passe administrateur (Docker a renvoye une erreur, souvent code 125)." >&2
    echo "-> Diagnostic et reparation : ./doctor.sh   puis relancez ./install.sh" >&2
    exit 1
  fi
  update_env "ADMIN_PASSWORD_HASH" "$generated_hash"
  administrator_password_message="Identifiant administrateur : ${ADMIN_EMAIL:-admin@assistant-ia.local} — mot de passe initial : ${initial_admin_password} (affiche une seule fois)"
fi

# Lit une reponse interactive avec un delai maximum de 10 minutes : au-dela,
# on considere qu'il n'y a plus personne devant l'ecran (installation lancee a
# distance, coupure...) et on bascule sur les valeurs par defaut pour tout le
# reste de l'installation, plutot que de rester bloque sur chaque question
# suivante encore 10 minutes de plus.
INSTALL_PROMPTS_TIMED_OUT=0
timed_read() {
  local prompt="$1"
  local var_name="$2"

  if [[ "$INSTALL_PROMPTS_TIMED_OUT" -eq 1 ]]; then
    printf -v "$var_name" '%s' ""
    return 0
  fi

  if ! read -r -t 600 -p "$prompt" "$var_name"; then
    echo
    echo "Aucune reponse apres 10 minutes : la suite de l'installation utilisera les valeurs par defaut." >&2
    INSTALL_PROMPTS_TIMED_OUT=1
    printf -v "$var_name" '%s' ""
  fi

  return 0
}

# Personnalisation interactive (nom du projet, modele Ollama). Sautee en mode
# non interactif : les valeurs par defaut de .env.example / branding.default.json
# restent utilisees.
if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
  echo
  echo "--- Personnalisation (laisser vide pour garder les valeurs par defaut) ---"
  timed_read "Nom complet du projet (ex: Atelier de mon-etablissement) : " INSTALL_PROJECT_NAME_INPUT
  timed_read "Nom court du projet (ex: L'Atelier) : " INSTALL_SHORT_NAME_INPUT

  if [[ -n "${INSTALL_PROJECT_NAME_INPUT:-}" || -n "${INSTALL_SHORT_NAME_INPUT:-}" ]]; then
    docker compose -f "$ROOT_DIR/docker-compose.yml" run --rm --no-deps \
      -e "INSTALL_PROJECT_NAME=${INSTALL_PROJECT_NAME_INPUT:-}" \
      -e "INSTALL_SHORT_NAME=${INSTALL_SHORT_NAME_INPUT:-}" \
      backend node scripts/apply-install-branding.js || echo "Personnalisation ignoree (erreur non bloquante)." >&2
  fi

  echo
  timed_read "Modele Ollama souhaite (nom exact, ex: mistral:latest), ou vide si vous ne savez pas : " INSTALL_MODEL_CHOICE

  if [[ -n "${INSTALL_MODEL_CHOICE:-}" ]]; then
    update_env "DEFAULT_MODEL" "$INSTALL_MODEL_CHOICE"
    DEFAULT_MODEL="$INSTALL_MODEL_CHOICE"
  else
    echo
    echo "--- Questionnaire materiel (pour suggerer un modele adapte) ---"
    timed_read "Nombre de coeurs CPU : " INSTALL_CPU_CORES
    timed_read "RAM disponible (Go) : " INSTALL_RAM_GB
    timed_read "GPU dedie disponible ? (o/N) : " INSTALL_HAS_GPU_INPUT
    INSTALL_HAS_GPU="0"
    INSTALL_GPU_MODEL=""
    if [[ "${INSTALL_HAS_GPU_INPUT:-}" =~ ^[oOyY] ]]; then
      INSTALL_HAS_GPU="1"
      timed_read "Modele du GPU (optionnel) : " INSTALL_GPU_MODEL
    fi
    timed_read "Stockage disponible (Go, optionnel) : " INSTALL_DISK_GB

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
retry_on_network_failure "Démarrage d'Ollama/ChromaDB/Redis (récupération des images Docker)" \
  docker_compose_up_service_required ollama chromadb redis

echo "Attente du démarrage d'Ollama..."
for attempt in $(seq 1 60); do
  if docker exec assistant-ia-ollama ollama list >/dev/null 2>&1; then
    break
  fi

  if [[ "$attempt" -eq 60 ]]; then
    echo "Ollama n'a pas repondu dans le delai imparti." >&2
    dump_recent_service_logs ollama 50
    echo "-> Diagnostic : ./doctor.sh" >&2
    exit 1
  fi

  sleep 2
done

# Espace libre (en Ko) dans le volume ou Ollama stocke ses modeles.
ollama_free_kb() {
  docker exec assistant-ia-ollama df -Pk /root/.ollama 2>/dev/null | tail -1 | awk '{print $4}'
}

# Un pull interrompu par manque d'espace laisse des blobs "*-partial" qui
# occupent l'espace sans etre reutilisables tels quels : on les purge pour
# recuperer de la place avant la tentative suivante.
cleanup_ollama_partial_downloads() {
  docker exec assistant-ia-ollama sh -c 'rm -f /root/.ollama/models/blobs/*-partial' >/dev/null 2>&1 || true
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
    # Code 2 : echec non lie au reseau, inutile de reessayer (voir retry_on_network_failure).
    return 2
  fi

  # Le telechargement s'affiche en direct (barre de progression d'Ollama) tout en
  # etant capture dans un fichier temporaire, pour detecter une erreur connue
  # (espace disque...) sans avoir a la reafficher a la main en cas d'echec.
  local pull_log pull_status pull_output
  pull_log="$(mktemp)"
  if docker exec assistant-ia-ollama ollama pull "$model" 2>&1 | tee "$pull_log"; then
    pull_status=0
  else
    pull_status=$?
  fi
  pull_output="$(cat "$pull_log")"
  rm -f "$pull_log"

  if [[ "$pull_status" -eq 0 ]]; then
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
if retry_on_network_failure "Telechargement du modele ${DEFAULT_MODEL}" pull_ollama_model "${DEFAULT_MODEL}"; then
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
    if retry_on_network_failure "Telechargement du modele ${fallback_model}" pull_ollama_model "$fallback_model"; then
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
if ! retry_on_network_failure "Telechargement du modele d'embedding ${EMBEDDING_MODEL}" pull_ollama_model "${EMBEDDING_MODEL}"; then
  echo "Impossible de telecharger le modele d'embedding ${EMBEDDING_MODEL}." >&2
  exit 1
fi

echo "Demarrage complet de la plateforme..."
if image_exists_locally "$BACKEND_IMAGE_NAME"; then
  retry_on_network_failure "Demarrage du backend" \
    docker_compose_up_service_required backend
else
  retry_on_network_failure "Construction et demarrage du backend" \
    docker_compose_up_service_required --build backend
fi

echo "Demarrage du service de mise a jour..."
if ! retry_on_network_failure "Construction de l'image du service de mise a jour" \
  build_service_or_reuse_local "updater" "$UPDATER_IMAGE_NAME"; then
  echo "Le service de mise a jour n'a pas pu etre construit : il est necessaire au bon fonctionnement du projet." >&2
  exit 1
fi
if ! docker_compose_up_service_required "updater"; then
  echo "Le service de mise a jour n'a pas pu demarrer : il est necessaire au bon fonctionnement du projet." >&2
  exit 1
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
    dump_recent_service_logs backend 60
    echo "-> Diagnostic : ./doctor.sh" >&2
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
  echo "Generation du mot de passe initial référent..."
  generated_teacher_password="$(
    docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T backend \
      node scripts/reset-teacher-password.js 2>/dev/null | tail -n 2 | head -n 1 || true
  )"
  if [[ -n "$generated_teacher_password" ]]; then
    teacher_password_message="Mot de passe initial référent : ${generated_teacher_password} (changement impose à la première connexion)"
  fi
fi


cat <<EOF

Initialisation terminee.
- Application : http://localhost:$SERVER_PORT
- Application reseau local : ${LOCAL_IP:+http://$LOCAL_IP:$SERVER_PORT}
- Admin    : http://localhost:$SERVER_PORT/admin
${teacher_password_message:+- $teacher_password_message}
${administrator_password_message:+- $administrator_password_message}
${FIREWALL_NOTE:+
Attention : $FIREWALL_NOTE}

Scripts utiles :
- Installer : ./install.sh
- Mettre a jour : ./update.sh
- Voir la version installee : ./version.sh
- Redemarrer : ./restart.sh
- Arreter : ./stop.sh
- Reinitialiser (efface tout, redemande la configuration) : ./reset.sh
- Aide / documentation : ./help.sh

EOF
