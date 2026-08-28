#!/usr/bin/env bash

# Diagnostic et reparation complets de l'installation. Contrairement aux
# autres scripts (set -e), doctor.sh continue toujours jusqu'au bout meme si
# une verification echoue, afin d'afficher un bilan complet en une seule
# passe plutot que de s'arreter au premier probleme.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/.project-tools.sh"

# $USER n'est pas toujours exporte (ex: session via "docker exec", certains
# environnements SSH/cloud minimalistes) : sans repli, set -u fait planter le
# script des la premiere utilisation. "id -un" est disponible partout.
USER="${USER:-$(id -un)}"

ASSUME_YES=0
CHECK_ONLY=0

show_help() {
  cat <<EOF
Usage:
  ./doctor.sh [--yes] [--check-only]

Diagnostique l'installation de bout en bout (Docker, .env, conteneurs,
sante de chaque service, modeles Ollama, base de donnees, espace disque...)
et corrige automatiquement ce qui peut l'etre sans risque.

Options:
  --yes          Ne demande aucune confirmation avant d'appliquer une
                 correction (y compris celles necessitant sudo). A utiliser
                 pour un depannage non interactif (ex: script distant/CI).
  --check-only   N'applique aucune correction, affiche seulement le bilan.
                 Sort avec un code d'erreur si un probleme est detecte.
  -h, --help     Affiche cette aide.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    -h|--help) show_help; exit 0 ;;
    *)
      echo "Argument non reconnu : $arg" >&2
      show_help
      exit 1
      ;;
  esac
done

OK_COUNT=0
FIXED_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
declare -a FAIL_MESSAGES=()
declare -a WARN_MESSAGES=()

say_ok()    { echo "  [OK]    $1"; OK_COUNT=$((OK_COUNT + 1)); }
say_fixed() { echo "  [REPARE] $1"; FIXED_COUNT=$((FIXED_COUNT + 1)); }
say_warn()  { echo "  [ATTENTION] $1"; WARN_COUNT=$((WARN_COUNT + 1)); WARN_MESSAGES+=("$1"); }
say_fail()  { echo "  [ECHEC] $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); FAIL_MESSAGES+=("$1"); }
# A appeler juste avant say_fixed quand la reparation resout un probleme deja
# signale par say_fail juste avant : sans ca, le bilan final listait un
# probleme comme "non resolu" alors qu'il vient d'etre corrige avec succes.
undo_last_fail() {
  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    FAIL_COUNT=$((FAIL_COUNT - 1))
    unset "FAIL_MESSAGES[${#FAIL_MESSAGES[@]}-1]"
  fi
}
# Meme principe que undo_last_fail, pour un say_warn resolu par une reparation.
undo_last_warn() {
  if [[ "$WARN_COUNT" -gt 0 ]]; then
    WARN_COUNT=$((WARN_COUNT - 1))
    unset "WARN_MESSAGES[${#WARN_MESSAGES[@]}-1]"
  fi
}
say_step()  { echo; echo "== $1 =="; }

confirm() {
  local prompt="$1"
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    return 1
  fi
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    return 1
  fi
  local reply
  read -r -p "${prompt} [o/N] " reply
  [[ "$reply" =~ ^[oOyY] ]]
}

# ---------------------------------------------------------------------------
say_step "Docker"

if ! command -v docker >/dev/null 2>&1; then
  say_fail "Docker n'est pas installe (commande 'docker' introuvable)."
  if [[ "$(uname -s)" == "Linux" ]] && command -v apt-get >/dev/null 2>&1; then
    if confirm "Installer Docker Engine maintenant via le depot officiel (apt) ?"; then
      if install_docker_engine_via_apt; then
        undo_last_fail
        say_fixed "Docker installe automatiquement."
        sudo usermod -aG docker "$USER" 2>/dev/null || true
        echo "  -> Deconnexion/reconnexion (ou 'newgrp docker') necessaire pour utiliser Docker sans sudo. Relancez ./doctor.sh apres."
      else
        say_fail "L'installation automatique de Docker a echoue."
        echo "  -> Installez manuellement : https://docs.docker.com/engine/install/ubuntu/"
      fi
    fi
  else
    echo "  -> Ubuntu : https://docs.docker.com/engine/install/ubuntu/"
    echo "  -> macOS/Windows : installez Docker Desktop."
  fi
else
  say_ok "Docker est installe ($(docker --version 2>/dev/null))."

  if docker info >/dev/null 2>&1; then
    say_ok "Le daemon Docker repond."
  else
    docker_error="$(docker info 2>&1 >/dev/null || true)"
    if printf '%s' "$docker_error" | grep -qi "permission denied"; then
      say_fail "Le daemon Docker refuse la connexion (permission denied)."
      if [[ "$(uname -s)" == "Linux" ]]; then
        if groups "$USER" 2>/dev/null | grep -qw docker; then
          echo "  -> L'utilisateur est deja dans le groupe docker : reconnectez-vous (ou 'newgrp docker') pour que ca prenne effet."
        else
          echo "  -> Ajoutez l'utilisateur au groupe docker : sudo usermod -aG docker \$USER puis deconnectez-vous/reconnectez-vous."
          if confirm "Executer 'sudo usermod -aG docker $USER' maintenant ?"; then
            if sudo usermod -aG docker "$USER"; then
              undo_last_fail
              say_fixed "Utilisateur ajoute au groupe docker (deconnexion/reconnexion necessaire pour que ca s'applique)."
            else
              say_fail "Impossible d'ajouter l'utilisateur au groupe docker."
            fi
          fi
        fi
      fi
    elif [[ "$(uname -s)" == "Linux" ]] && command -v systemctl >/dev/null 2>&1; then
      say_fail "Le daemon Docker ne repond pas (service probablement arrete)."
      if confirm "Executer 'sudo systemctl start docker' maintenant ?"; then
        if sudo systemctl start docker; then
          sleep 2
          if docker info >/dev/null 2>&1; then
            undo_last_fail
            say_fixed "Daemon Docker demarre."
          else
            say_fail "Le daemon Docker ne repond toujours pas apres redemarrage du service."
          fi
        else
          say_fail "Impossible de demarrer le service docker."
        fi
      fi
    elif [[ "$(uname -s)" == "Darwin" ]]; then
      say_fail "Le daemon Docker ne repond pas (Docker Desktop n'est probablement pas lance)."
      if command -v open >/dev/null 2>&1 && confirm "Lancer Docker Desktop maintenant ?"; then
        open -a Docker >/dev/null 2>&1 || true
        echo "  -> Attente du demarrage du daemon (jusqu'a 60s)..."
        docker_ready=0
        for _ in $(seq 1 30); do
          if docker info >/dev/null 2>&1; then
            docker_ready=1
            break
          fi
          sleep 2
        done
        if [[ "$docker_ready" -eq 1 ]]; then
          undo_last_fail
          say_fixed "Daemon Docker demarre (Docker Desktop)."
        else
          say_fail "Docker Desktop ne repond toujours pas apres 60s."
        fi
      fi
    else
      say_fail "Le daemon Docker ne repond pas : $docker_error"
    fi
  fi

  if docker compose version >/dev/null 2>&1; then
    say_ok "Le plugin 'docker compose' (v2) est disponible."
  else
    say_fail "Le plugin 'docker compose' (v2) est introuvable (docker-compose v1 seul ne suffit pas)."
    echo "  -> https://docs.docker.com/compose/install/linux/"
  fi
fi

# ---------------------------------------------------------------------------
say_step "Outils systeme (installation & mises a jour)"

# curl/tar/gzip : telechargement et extraction des packages. rsync : synchro
# atomique de l'arborescence par ./update.sh (apply distant) et ./install.sh
# --vX.XXX. rsync est ABSENT des images cloud Debian/Ubuntu minimales et
# d'Alpine : sans lui, une mise a jour distante echoue apres le telechargement.
UPDATE_TOOLS_OK=1
for host_tool in curl tar gzip; do
  if command -v "$host_tool" >/dev/null 2>&1; then
    say_ok "'${host_tool}' est disponible."
  else
    UPDATE_TOOLS_OK=0
    say_fail "'${host_tool}' est introuvable : ./install.sh et ./update.sh en ont besoin."
  fi
done
if command -v rsync >/dev/null 2>&1; then
  say_ok "'rsync' est disponible (synchronisation des mises a jour)."
else
  say_warn "'rsync' est introuvable : l'installation base fonctionne, mais ./update.sh (mise a jour distante) et ./install.sh --vX.XXX echoueront."
  if command -v apt-get >/dev/null 2>&1; then
    if confirm "Installer rsync maintenant (sudo apt-get install -y rsync) ?"; then
      if sudo apt-get update >/dev/null 2>&1 && sudo apt-get install -y rsync >/dev/null 2>&1; then
        undo_last_warn
        say_fixed "rsync installe."
      else
        say_warn "Installation automatique de rsync impossible : installez-le manuellement."
      fi
    fi
  elif command -v dnf >/dev/null 2>&1; then
    echo "  -> sudo dnf install -y rsync"
  elif command -v apk >/dev/null 2>&1; then
    echo "  -> sudo apk add rsync"
  fi
fi

# Outil de hachage SHA-256 : sans lui, update.sh/install.sh --vX ne peuvent pas
# verifier l'integrite du package et abandonnent avec un message trompeur.
if command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1; then
  say_ok "Un outil SHA-256 est disponible (sha256sum ou shasum)."
else
  say_fail "Ni 'sha256sum' ni 'shasum' : ./update.sh et ./install.sh --vX.XXX ne pourront pas verifier l'integrite des packages."
  command -v apt-get >/dev/null 2>&1 && echo "  -> sudo apt-get install -y coreutils"
  command -v apk    >/dev/null 2>&1 && echo "  -> sudo apk add coreutils"
fi

# 'git' : ./update.sh preserve .git et le flux recommande est 'git pull'.
if [[ -d "$ROOT_DIR/.git" ]] && ! command -v git >/dev/null 2>&1; then
  say_warn "Le projet est un depot git mais 'git' n'est pas installe : 'git pull' et la preservation propre de .git lors des mises a jour sont compromises."
fi

# Fins de ligne Windows (CRLF) : un checkout/dezippage sous Windows casse tous
# les scripts (shebang "bash\r", heredocs, set -e...).
crlf_hits="$(grep -rlU "$(printf '\r')" "$ROOT_DIR"/*.sh 2>/dev/null || true)"
if [[ -n "$crlf_hits" ]]; then
  say_fail "Des scripts .sh contiennent des fins de ligne Windows (CRLF) : ils echoueront de facon imprevisible."
  echo "  Fichiers : $(echo "$crlf_hits" | xargs -n1 basename 2>/dev/null | tr '\n' ' ')"
  if confirm "Convertir ces scripts en fins de ligne Unix (LF) ?"; then
    fixed_all=1
    while IFS= read -r crlf_file; do
      [[ -z "$crlf_file" ]] && continue
      if command -v sed >/dev/null 2>&1 && sed -i 's/\r$//' "$crlf_file" 2>/dev/null; then :; else fixed_all=0; fi
    done <<< "$crlf_hits"
    if [[ "$fixed_all" -eq 1 ]]; then
      undo_last_fail
      say_fixed "Scripts reconvertis en fins de ligne Unix."
    else
      say_fail "Conversion CRLF incomplete : lancez 'sed -i \"s/\\r\$//\" *.sh'."
    fi
  fi
fi

# Bit executable sur les scripts (un unzip le perd souvent).
non_exec_scripts=""
for s in "$ROOT_DIR"/*.sh; do
  [[ -f "$s" ]] || continue
  [[ -x "$s" ]] || non_exec_scripts="$non_exec_scripts $(basename "$s")"
done
if [[ -n "${non_exec_scripts// }" ]]; then
  say_warn "Scripts non executables :${non_exec_scripts}"
  if confirm "Ajouter le bit executable (chmod +x *.sh) ?"; then
    chmod +x "$ROOT_DIR"/*.sh 2>/dev/null && { undo_last_warn; say_fixed "Bit executable ajoute."; } || say_warn "chmod +x a echoue."
  fi
fi

# Validite JSON de update.config.json et version.json (+ BOM UTF-8, qui casse
# JSON.parse et 'node -p require').
json_is_valid() {
  local file="$1"
  [[ -f "$file" ]] || return 2
  if command -v node >/dev/null 2>&1; then
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$file" >/dev/null 2>&1
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$file" >/dev/null 2>&1
  else
    return 3
  fi
}
for jf in update.config.json version.json; do
  jpath="$ROOT_DIR/$jf"
  if [[ ! -f "$jpath" ]]; then
    [[ "$jf" == "version.json" ]] && say_warn "$jf absent (une version 1.000 sera supposee)." \
                                  || say_warn "$jf absent : ./update.sh ne verifiera pas de mise a jour distante."
    continue
  fi
  if [[ "$(head -c 3 "$jpath" | od -An -tx1 2>/dev/null | tr -d ' \n')" == "efbbbf" ]]; then
    say_fail "$jf commence par un BOM UTF-8 : JSON.parse echouera. Reenregistrez le fichier en UTF-8 sans BOM."
  fi
  json_is_valid "$jpath"
  case "$?" in
    0) say_ok "$jf est un JSON valide." ;;
    1) say_fail "$jf n'est pas un JSON valide : ./update.sh et le service de mise a jour ne fonctionneront pas. Corrigez la syntaxe." ;;
    3) say_warn "Impossible de valider $jf (ni node ni python3)." ;;
  esac
done

# Coherence de version.json (format X ou X.Y.Z...).
version_str="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$ROOT_DIR/version.json" 2>/dev/null | head -n1 | sed -E 's/.*"([^"]*)"$/\1/')"
if [[ -n "$version_str" && ! "$version_str" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
  say_warn "version.json annonce une version non numerique ('$version_str') : le tri des releases et la comparaison de versions peuvent se comporter de facon inattendue."
fi

# preservePaths de update.config.json : doit couvrir .env et backend/data.
# (Le service updater applique de toute facon un socle non negociable, mais un
# update.config.json incomplet reste un signal d'alerte.)
if [[ -f "$ROOT_DIR/update.config.json" ]]; then
  pp_line="$(tr -d '\n' < "$ROOT_DIR/update.config.json" | grep -o '"preservePaths"[[:space:]]*:[[:space:]]*\[[^]]*\]' || true)"
  if [[ -n "$pp_line" ]]; then
    for must in ".env" "backend/data"; do
      printf '%s' "$pp_line" | grep -q "\"$must\"" || \
        say_warn "update.config.json : apply.preservePaths ne mentionne pas \"$must\". Une mise a jour lancee en ligne de commande s'appuie sur cette liste ; completez-la."
    done
  else
    say_warn "update.config.json : apply.preservePaths est absent ou vide. ./update.sh utilise sa propre liste de securite, mais corrigez la configuration."
  fi
fi

# Proxy sortant : si HTTP(S)_PROXY est defini (site derriere un proxy), le
# conteneur updater doit router fetch() a travers (NODE_USE_ENV_PROXY=1, deja
# fixe dans docker-compose.yml). On le rappelle et on testera l'acces reel plus
# bas (section "Serveur de mise a jour distant").
proxy_env="$(get_env_value HTTPS_PROXY)$(get_env_value HTTP_PROXY)${HTTPS_PROXY:-}${HTTP_PROXY:-}"
if [[ -n "$proxy_env" ]]; then
  if grep -q 'NODE_USE_ENV_PROXY' "$ROOT_DIR/docker-compose.yml" 2>/dev/null; then
    say_ok "Proxy sortant configure et docker-compose.yml fixe NODE_USE_ENV_PROXY pour l'updater."
  else
    say_warn "Un proxy sortant est configure mais docker-compose.yml ne fixe pas NODE_USE_ENV_PROXY=1 pour l'updater : la verification des mises a jour risque d'echouer."
  fi
fi

# Fichiers du projet appartenant a root (Linux) : symptome d'une mise a jour
# lancee depuis l'interface web (le conteneur updater ecrit dans l'arborescence
# en tant que root). Les commandes git / ./update.sh de l'utilisateur echouent
# ensuite silencieusement.
if [[ "$(uname -s)" == "Linux" && -d "$ROOT_DIR/.git" ]]; then
  tree_owner_uid="$(stat -c '%u' "$ROOT_DIR" 2>/dev/null || echo 0)"
  root_owned_count="$(find "$ROOT_DIR" -not -path "$ROOT_DIR/backend/data/*" \
    -not -path "$ROOT_DIR/backend/uploads/*" -not -path "$ROOT_DIR/.update-backups/*" \
    -uid 0 -print 2>/dev/null | head -n 20 | wc -l | tr -d ' ')"
  if [[ "$tree_owner_uid" != "0" && "${root_owned_count:-0}" -gt 0 ]]; then
    say_warn "Des fichiers du projet appartiennent a root (mise a jour lancee depuis l'interface web ?) : git et ./update.sh peuvent echouer."
    current_user_uid="$(id -u)"
    current_user_gid="$(id -g)"
    if confirm "Rendre l'arborescence a l'utilisateur courant (sudo chown -R ${current_user_uid}:${current_user_gid} sur les fichiers de code) ?"; then
      if sudo chown -R "${current_user_uid}:${current_user_gid}" "$ROOT_DIR" 2>/dev/null; then
        undo_last_warn
        say_fixed "Proprietaire de l'arborescence retabli."
      else
        say_warn "chown impossible : corrigez manuellement (sudo chown -R \$USER:\$USER $ROOT_DIR)."
      fi
    fi
  fi
fi

DOCKER_READY=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  DOCKER_READY=1
fi

if [[ "$DOCKER_READY" -eq 0 ]]; then
  echo
  echo "Docker n'est pas pleinement operationnel : les verifications suivantes (conteneurs, sante des"
  echo "services, modeles Ollama) sont ignorees. Corrigez les points ci-dessus puis relancez ./doctor.sh."
else

# ---------------------------------------------------------------------------
say_step "Espace disque"

docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
disk_check_path="$ROOT_DIR"
[[ -n "$docker_root" && -d "$docker_root" ]] && disk_check_path="$docker_root"

available_kb="$(df -Pk "$disk_check_path" 2>/dev/null | tail -1 | awk '{print $4}')"
if [[ -z "${available_kb:-}" ]]; then
  say_warn "Impossible de determiner l'espace disque disponible sur ${disk_check_path}."
else
  available_gb=$((available_kb / 1024 / 1024))
  if [[ "$available_kb" -lt 2000000 ]]; then
    say_fail "Seulement environ ${available_gb} Go disponibles sur ${disk_check_path} (2 Go minimum requis)."
    if confirm "Nettoyer le cache Docker (images/builds inutilises) pour liberer de l'espace ?"; then
      docker builder prune -af >/dev/null 2>&1 || true
      docker system prune -af >/dev/null 2>&1 || true
      available_kb="$(df -Pk "$disk_check_path" 2>/dev/null | tail -1 | awk '{print $4}')"
      available_gb=$((available_kb / 1024 / 1024))
      if [[ "$available_kb" -ge 2000000 ]]; then
        undo_last_fail
        say_fixed "Nettoyage effectue, ${available_gb} Go disponibles maintenant."
      else
        say_fail "Toujours seulement ${available_gb} Go disponibles apres nettoyage. Liberez de l'espace manuellement (df -h, lsblk)."
      fi
    fi
  elif [[ "$available_kb" -lt 5000000 ]]; then
    say_warn "Seulement environ ${available_gb} Go disponibles sur ${disk_check_path} : le telechargement de nouveaux modeles Ollama peut echouer."
  else
    say_ok "Espace disque suffisant (~${available_gb} Go disponibles sur ${disk_check_path})."
  fi
fi

# ---------------------------------------------------------------------------
say_step "Fichier .env"

if [[ ! -f "$ENV_FILE" ]]; then
  if confirm "Le fichier .env est absent. Le creer a partir de .env.example ?"; then
    ensure_env_file
    say_fixed "Fichier .env cree a partir de .env.example."
  else
    say_fail "Fichier .env absent : le projet ne peut pas demarrer."
  fi
else
  configured_workspace="$(get_env_value "PROJECT_WORKSPACE_DIR")"
  if [[ "$configured_workspace" == "$ROOT_DIR" ]]; then
    say_ok "Fichier .env present (PROJECT_WORKSPACE_DIR correct)."
  else
    say_fail "PROJECT_WORKSPACE_DIR ne correspond pas au dossier courant."
    if confirm "Synchroniser PROJECT_WORKSPACE_DIR avec ${ROOT_DIR} ?"; then
      update_env_value "PROJECT_WORKSPACE_DIR" "$ROOT_DIR"
      undo_last_fail
      say_fixed "PROJECT_WORKSPACE_DIR synchronise."
    fi
  fi

  env_mode="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null || true)"
  if [[ -n "$env_mode" ]] && (( (8#$env_mode & 077) != 0 )); then
    say_fail ".env est lisible ou modifiable par d'autres utilisateurs (mode ${env_mode})."
    if confirm "Restreindre .env a l'utilisateur systeme (chmod 600) ?"; then
      if chmod 600 "$ENV_FILE"; then
        undo_last_fail
        say_fixed "Permissions de .env corrigees (600)."
      else
        say_fail "Impossible de proteger .env avec chmod 600."
      fi
    fi
  elif [[ -n "$env_mode" ]]; then
    say_ok "Permissions de .env restrictives (${env_mode})."
  else
    say_warn "Impossible de verifier les permissions de .env."
  fi
fi

for secret_key in JWT_SECRET CONFIG_ENCRYPTION_KEY; do
  secret_value="$(get_env_value "$secret_key")"
  if [[ ${#secret_value} -lt 32 || "$secret_value" == changeme* || "$secret_value" == change_me* ]]; then
    say_fail "${secret_key} est absent, trop court ou utilise encore une valeur d'exemple."
    if confirm "Generer une nouvelle valeur aleatoire pour ${secret_key} ?"; then
      update_env_value "$secret_key" "$(generate_random_key)"
      undo_last_fail
      say_fixed "${secret_key} regenere (un redemarrage du backend sera necessaire)."
    fi
  else
    say_ok "${secret_key} est configure avec une valeur robuste."
  fi
done

owner_password="$(get_env_value "OWNER_BOOTSTRAP_PASSWORD")"
if [[ ${#owner_password} -lt 16 ]]; then
  say_fail "Un parametre local de securite est absent ou trop court (16 caracteres minimum)."
  if confirm "Generer une valeur locale securisee pour cette installation ?"; then
    update_env_value "OWNER_BOOTSTRAP_PASSWORD" "$(generate_random_key)"
    undo_last_fail
    say_fixed "Valeur locale generee dans .env (non affichee)."
  fi
else
  say_ok "La configuration locale securisee est presente."
fi

compose_error_file="$(mktemp)"
if docker_compose config -q 2>"$compose_error_file"; then
  say_ok "docker-compose.yml est valide."
else
  say_fail "docker-compose.yml (ou .env) contient une erreur : $(cat "$compose_error_file" 2>/dev/null)"
fi
rm -f "$compose_error_file"

# ---------------------------------------------------------------------------
say_step "Port et repertoires"

SERVER_PORT="$(get_server_port)"
if command -v lsof >/dev/null 2>&1; then
  port_pid="$(lsof -i ":${SERVER_PORT}" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
  if [[ -n "$port_pid" ]]; then
    port_cmd="$(ps -p "$port_pid" -o comm= 2>/dev/null || true)"
    if [[ "$port_cmd" == *"docker"* || "$port_cmd" == *"com.docker"* ]]; then
      say_ok "Le port ${SERVER_PORT} est occupe par Docker (normal, c'est le service backend)."
    else
      say_fail "Le port ${SERVER_PORT} est deja utilise par un autre processus (${port_cmd:-pid $port_pid})."
      echo "  -> Changez PORT dans .env, ou arretez ce processus."
    fi
  else
    say_ok "Le port ${SERVER_PORT} est libre."
  fi
else
  say_warn "'lsof' indisponible : impossible de verifier si le port ${SERVER_PORT} est libre."
fi

for dir_rel in backend/uploads backend/logs backend/data; do
  dir_abs="$ROOT_DIR/$dir_rel"
  if [[ ! -d "$dir_abs" ]]; then
    if confirm "Le dossier ${dir_rel} est absent. Le creer ?"; then
      mkdir -p "$dir_abs" && say_fixed "Dossier ${dir_rel} cree." || say_fail "Impossible de creer ${dir_rel}."
    else
      say_fail "Dossier ${dir_rel} absent."
    fi
    continue
  fi
  if [[ -w "$dir_abs" ]]; then
    say_ok "Dossier ${dir_rel} present et inscriptible."
  else
    if confirm "Le dossier ${dir_rel} n'est pas inscriptible par l'utilisateur courant. Corriger les permissions (chmod/chown) ?"; then
      if chmod u+rwX "$dir_abs" 2>/dev/null || sudo chown -R "$(id -u):$(id -g)" "$dir_abs" 2>/dev/null; then
        say_fixed "Permissions corrigees sur ${dir_rel}."
      else
        say_fail "Impossible de corriger les permissions de ${dir_rel}."
      fi
    else
      say_fail "Dossier ${dir_rel} non inscriptible : le backend ne pourra pas ecrire dedans."
    fi
  fi
done

# ---------------------------------------------------------------------------
say_step "Base de donnees SQLite"

SQLITE_PATH_VALUE="$(get_env_value "SQLITE_PATH")"
SQLITE_RELATIVE_PATH="${SQLITE_PATH_VALUE:-./data/fablab.sqlite}"
if [[ "$SQLITE_RELATIVE_PATH" = /* ]]; then
  SQLITE_HOST_PATH="$SQLITE_RELATIVE_PATH"
else
  SQLITE_HOST_PATH="$ROOT_DIR/backend/${SQLITE_RELATIVE_PATH#./}"
fi

if [[ ! -f "$SQLITE_HOST_PATH" ]]; then
  say_warn "Base de donnees absente (${SQLITE_HOST_PATH}) : normal si le projet n'a jamais demarre, elle sera creee automatiquement."
else
  db_header="$(head -c 16 "$SQLITE_HOST_PATH" 2>/dev/null | tr -d '\0')"
  if [[ "$db_header" == "SQLite format 3" ]]; then
    say_ok "Base de donnees SQLite presente et valide."
  else
    say_fail "Le fichier ${SQLITE_HOST_PATH} n'a pas l'entete d'une base SQLite valide (corruption possible)."
    echo "  -> Sauvegardez-le puis envisagez ./reset.sh si le backend ne demarre plus (perte des donnees)."
  fi
fi

# ---------------------------------------------------------------------------
say_step "Conteneurs"

CORE_SERVICES=(ollama chromadb redis backend updater)

# Pas de tableau associatif (declare -A) : indisponible sur bash 3.2, present
# par defaut sur macOS.
container_name_for_service() {
  printf 'fablab-%s' "$1"
}

for service in "${CORE_SERVICES[@]}"; do
  container="$(container_name_for_service "$service")"
  status="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"

  if [[ -z "$status" ]]; then
    say_warn "${service} (${container}) n'existe pas encore (jamais demarre)."
    if confirm "Demarrer ${service} maintenant ?"; then
      if [[ "$service" == "backend" ]]; then
        started=1
        docker_compose_up_build backend >/dev/null 2>&1 || started=0
      elif [[ "$service" == "updater" ]]; then
        started=1
        ensure_updater_running >/dev/null 2>&1 || started=0
      else
        started=1
        docker_compose_up_required "$service" >/dev/null 2>&1 || started=0
      fi
      if [[ "$started" -eq 1 ]]; then
        undo_last_warn
        say_fixed "${service} demarre."
      else
        say_fail "${service} n'a pas pu demarrer."
      fi
    fi
    continue
  fi

  if [[ "$status" == "running" ]]; then
    restart_count="$(docker inspect --format '{{.RestartCount}}' "$container" 2>/dev/null || echo 0)"
    if [[ "${restart_count:-0}" -ge 3 ]]; then
      say_warn "${service} tourne mais a redemarre ${restart_count} fois (instabilite possible)."
      echo "  -> Derniers logs : docker logs --tail 30 ${container}"
    else
      say_ok "${service} (${container}) est en cours d'execution."
    fi
  else
    say_fail "${service} (${container}) n'est pas en cours d'execution (etat : ${status})."
    echo "  -> Derniers logs : docker logs --tail 30 ${container}"
    if confirm "Redemarrer ${service} maintenant ?"; then
      restarted=1
      if [[ "$service" == "updater" ]]; then
        ensure_updater_running >/dev/null 2>&1 || restarted=0
      else
        docker_compose_up_required "$service" >/dev/null 2>&1 || restarted=0
      fi
      if [[ "$restarted" -eq 1 ]]; then
        undo_last_fail
        say_fixed "${service} redemarre."
      else
        say_fail "${service} n'a pas pu redemarrer. Voir : docker logs --tail 50 ${container}"
      fi
    fi
  fi
done

# ---------------------------------------------------------------------------
say_step "Sante des services"

if docker inspect --format '{{.State.Status}}' fablab-redis 2>/dev/null | grep -q running; then
  if docker exec fablab-redis redis-cli ping 2>/dev/null | grep -q PONG; then
    say_ok "Redis repond (PING -> PONG)."
  else
    say_fail "Redis tourne mais ne repond pas a PING."
  fi
else
  say_fail "Redis n'est pas actif : impossible de verifier sa sante."
fi

if docker inspect --format '{{.State.Status}}' fablab-ollama 2>/dev/null | grep -q running; then
  if docker exec fablab-ollama ollama list >/dev/null 2>&1; then
    say_ok "Ollama repond (ollama list)."
  else
    say_fail "Ollama tourne mais ne repond pas."
  fi
else
  say_fail "Ollama n'est pas actif : impossible de verifier sa sante."
fi

if docker inspect --format '{{.State.Status}}' fablab-chromadb 2>/dev/null | grep -q running; then
  if docker inspect --format '{{.State.Status}}' fablab-backend 2>/dev/null | grep -q running; then
    if docker exec fablab-backend node -e "fetch('http://chromadb:8000/api/v2/heartbeat').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      say_ok "ChromaDB repond (heartbeat via le reseau interne)."
    else
      say_fail "ChromaDB tourne mais ne repond pas sur son endpoint heartbeat."
    fi
  else
    say_warn "ChromaDB tourne mais le backend est arrete : impossible de verifier la connectivite interne."
  fi
else
  say_fail "ChromaDB n'est pas actif : impossible de verifier sa sante."
fi

if docker inspect --format '{{.State.Status}}' fablab-backend 2>/dev/null | grep -q running; then
  if wait_for_http "$(get_local_base_url)/api/health" "Le backend" 5 1 >/dev/null 2>&1; then
    say_ok "Le backend repond sur /api/health."

    integrity_result="$(
      docker exec fablab-backend node --input-type=module -e \
        "import { getDb } from './config/db.js'; const rows=getDb().pragma('integrity_check'); console.log(rows.every((row)=>row.integrity_check==='ok')?'ok':'invalid');" \
        2>/dev/null || true
    )"
    if [[ "$integrity_result" == "ok" ]]; then
      say_ok "Le controle approfondi SQLite (PRAGMA integrity_check) est valide."
    else
      say_fail "Le controle approfondi SQLite a echoue ou n'a pas pu etre execute."
    fi

    default_owner_status="$(
      docker exec fablab-backend node --input-type=module -e \
        "import bcrypt from 'bcrypt'; import { findAdminUserByIdentifier } from './config/db.js'; const user=findAdminUserByIdentifier(process.env.ADMIN_EMAIL||'admin@fablab.local'); console.log(user && await bcrypt.compare('1234567890', user.passwordHash) ? 'insecure' : 'ok');" \
        2>/dev/null || true
    )"
    if [[ "$default_owner_status" == "insecure" ]]; then
      say_fail "Un compte initial utilise encore un ancien mot de passe previsible."
      if confirm "Synchroniser immediatement la configuration locale ?"; then
        if docker exec fablab-backend node --input-type=module -e \
          "import bcrypt from 'bcrypt'; import { findAdminUserByIdentifier, setSetting, updateAdminUserPasswordById } from './config/db.js'; const password=String(process.env.OWNER_BOOTSTRAP_PASSWORD||''); if(password.length<16) process.exit(2); const hash=await bcrypt.hash(password,12); setSetting('ownerPasswordHash',hash); const user=findAdminUserByIdentifier(process.env.ADMIN_EMAIL||'admin@fablab.local'); if(user) updateAdminUserPasswordById(user.id,hash);"; then
          undo_last_fail
          say_fixed "Configuration locale synchronisee."
        else
          say_fail "Impossible de synchroniser la configuration locale. Reconstruisez avec ./restart.sh."
        fi
      fi
    elif [[ "$default_owner_status" == "ok" ]]; then
      say_ok "Le compte initial n'utilise pas le mot de passe previsible historique."
    else
      say_warn "Impossible d'auditer le mot de passe du compte initial."
    fi
  else
    say_fail "Le backend tourne mais ne repond pas sur /api/health (port ${SERVER_PORT})."
    echo "  -> Logs : docker logs --tail 50 fablab-backend"
  fi
else
  say_fail "Le backend n'est pas actif."
fi

admin_access_mode="$(get_env_value "ADMIN_ACCESS_MODE")"
cookie_secure="$(get_env_value "COOKIE_SECURE")"
server_bind_host="$(get_server_host_bind)"
if [[ "${admin_access_mode:-any}" == "any" && "$server_bind_host" == "0.0.0.0" && "$cookie_secure" != "true" ]]; then
  say_warn "Administration exposee sur toutes les interfaces en HTTP. Pour Internet, utilisez HTTPS, COOKIE_SECURE=true et un pare-feu/reverse proxy."
fi

if docker exec fablab-updater curl -sf http://127.0.0.1:3010/health >/dev/null 2>&1; then
  say_ok "Le service de mise a jour repond sur /health."
else
  say_fail "Le service de mise a jour ne repond pas."
  echo "  -> Reparation dediee : ./updater.sh"
fi

# ---------------------------------------------------------------------------
say_step "Modeles Ollama"

if docker inspect --format '{{.State.Status}}' fablab-ollama 2>/dev/null | grep -q running; then
  ollama_models="$(docker exec fablab-ollama ollama list 2>/dev/null || true)"
  DEFAULT_MODEL_VALUE="$(get_env_value "DEFAULT_MODEL")"
  EMBEDDING_MODEL_VALUE="$(get_env_value "EMBEDDING_MODEL")"

  for model_var in DEFAULT_MODEL_VALUE EMBEDDING_MODEL_VALUE; do
    model_name="${!model_var}"
    [[ -z "$model_name" ]] && continue
    model_base="${model_name%%:*}"
    if printf '%s' "$ollama_models" | grep -q "^${model_base}"; then
      say_ok "Modele ${model_name} present."
    else
      say_warn "Modele ${model_name} absent d'Ollama."
      if confirm "Telecharger ${model_name} maintenant (peut prendre plusieurs minutes) ?"; then
        if docker exec fablab-ollama ollama pull "$model_name" 2>&1 | tail -5; then
          undo_last_warn
          say_fixed "Modele ${model_name} telecharge."
        else
          say_fail "Echec du telechargement de ${model_name} (espace disque ? nom invalide ?)."
        fi
      fi
    fi
  done
else
  say_warn "Ollama n'est pas actif : impossible de verifier les modeles installes."
fi

# ---------------------------------------------------------------------------
say_step "Coherence version <-> conteneurs"

# Si une mise a jour a synchronise les fichiers puis que "docker compose up
# --build" a echoue, version.json (monte en lecture seule dans le backend)
# annonce la nouvelle version alors que l'image backend contient encore
# l'ancien code. On compare la date de creation de l'image backend a la date
# de derniere modification de version.json.
version_file="$ROOT_DIR/version.json"
disk_version="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$version_file" 2>/dev/null | head -n 1 | sed -E 's/.*"([^"]*)"$/\1/')"
backend_image="$(docker inspect --format '{{.Image}}' fablab-backend 2>/dev/null || true)"
if [[ -z "$backend_image" ]]; then
  say_warn "Conteneur backend absent : impossible de verifier la coherence de version (demarrez le projet)."
else
  image_created_iso="$(docker image inspect "$backend_image" --format '{{.Created}}' 2>/dev/null || true)"
  # Epoch de l'image (GNU date sur Linux, BSD date sur macOS).
  image_epoch="$(date -d "$image_created_iso" +%s 2>/dev/null || date -j -f '%Y-%m-%dT%H:%M:%S' "${image_created_iso%%.*}" +%s 2>/dev/null || echo 0)"
  version_epoch="$(stat -c %Y "$version_file" 2>/dev/null || stat -f %m "$version_file" 2>/dev/null || echo 0)"
  # 120 s de marge : lors d'une mise a jour reussie, l'image est reconstruite
  # juste apres l'ecriture de version.json.
  if [[ "$image_epoch" -gt 0 && "$version_epoch" -gt 0 && $((version_epoch - image_epoch)) -gt 120 ]]; then
    say_fail "version.json (${disk_version:-?}) est plus recent que l'image backend : une mise a jour a ete appliquee sur disque sans reconstruction des conteneurs."
    echo "  -> Terminez la mise a jour : ./update.sh   (elle reconstruira le backend avec les fichiers actuels)"
    echo "  -> Ou revenez en arriere depuis l'onglet Mises a jour de l'administration."
  else
    say_ok "L'image backend correspond a la version presente sur disque (${disk_version:-inconnue})."
  fi
fi

# Etat residuel d'une mise a jour interrompue cote updater (si le conteneur
# n'a pas redemarre depuis).
updater_state="$(docker exec fablab-updater curl -sf http://127.0.0.1:3010/status 2>/dev/null || true)"
if [[ -n "$updater_state" ]]; then
  updater_status="$(printf '%s' "$updater_state" | grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\1/')"
  if [[ "$updater_status" == "error" ]]; then
    recover_id="$(printf '%s' "$updater_state" | grep -o '"recoverableBackupId"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\1/')"
    if [[ -n "$recover_id" ]]; then
      say_warn "La derniere mise a jour a echoue apres avoir synchronise les fichiers. Relancez ./update.sh, ou restaurez la sauvegarde ${recover_id} depuis l'administration."
    else
      say_warn "La derniere mise a jour signalee par l'updater s'est terminee en erreur. Consultez l'onglet Mises a jour de l'administration."
    fi
  fi
fi

# Le dossier des sauvegardes de rollback doit exister et etre inscriptible :
# sinon une mise a jour distante echoue au moment de creer le point de retour.
backups_dir="$ROOT_DIR/.update-backups"
if [[ -e "$backups_dir" && ! -w "$backups_dir" ]]; then
  say_fail ".update-backups n'est pas inscriptible : une mise a jour distante ne pourra pas creer de sauvegarde de rollback."
  echo "  -> sudo chown -R \$(id -u):\$(id -g) $backups_dir"
else
  say_ok "Le dossier de sauvegardes de rollback est utilisable."
fi

# Marge disque pour appliquer une mise a jour : il faut de la place pour
# l'archive + son extraction + une sauvegarde complete (~3x l'arborescence
# hors donnees). Reference approximative : 300 Mo.
update_fs_kb="$(df -Pk "$ROOT_DIR" 2>/dev/null | tail -1 | awk '{print $4}')"
if [[ -n "${update_fs_kb:-}" && "$update_fs_kb" -lt 300000 ]]; then
  say_warn "Moins de ~300 Mo libres sur la partition du projet : une mise a jour distante (archive + extraction + sauvegarde) peut echouer par manque d'espace."
fi

# ---------------------------------------------------------------------------
say_step "Serveur de mise a jour distant"

update_config_file="$ROOT_DIR/update.config.json"
if [[ ! -f "$update_config_file" ]]; then
  say_warn "update.config.json introuvable : ./update.sh ne pourra pas verifier de mise a jour distante (reconstruction locale seule)."
else
  update_type="$(grep -o '"type"[[:space:]]*:[[:space:]]*"[^"]*"' "$update_config_file" | head -n 1 | sed -E 's/.*"([^"]*)"$/\1/')"
  update_base_url="$(grep -o '"baseUrl"[[:space:]]*:[[:space:]]*"[^"]*"' "$update_config_file" | head -n 1 | sed -E 's/.*"([^"]*)"$/\1/')"
  if [[ "$update_type" == "github-releases" ]]; then
    update_repository="$(grep -o '"repository"[[:space:]]*:[[:space:]]*"[^"]*"' "$update_config_file" | head -n 1 | sed -E 's/.*"([^"]*)"$/\1/')"
    update_api_base="$(grep -o '"apiBaseUrl"[[:space:]]*:[[:space:]]*"[^"]*"' "$update_config_file" | head -n 1 | sed -E 's/.*"([^"]*)"$/\1/')"
    update_api_base="${update_api_base:-https://api.github.com}"
    update_api_base="${update_api_base%/}"
    if [[ ! "$update_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
      say_fail "update.config.json : le champ 'repository' est absent ou invalide (attendu : proprietaire/depot)."
    else
      # Interroge l'API exactement comme le service updater. Le code HTTP
      # distingue depot introuvable/prive (404) de "joignable mais vide".
      releases_body_file="$(mktemp)"
      releases_http="$(curl -s -o "$releases_body_file" -w '%{http_code}' --max-time 10 \
        -H 'Accept: application/vnd.github+json' \
        "${update_api_base}/repos/${update_repository}/releases?per_page=100" 2>/dev/null || echo "000")"
      case "$releases_http" in
        200)
          releases_total="$(grep -o '"tag_name"' "$releases_body_file" 2>/dev/null | wc -l | tr -d ' ')"
          if [[ "${releases_total:-0}" -gt 0 ]]; then
            say_ok "Canal de mise a jour operationnel : ${update_repository} (${releases_total} release(s) publiee(s))."
          else
            say_warn "Depot ${update_repository} accessible mais AUCUNE release publiee : ./update.sh ne pourra rien recuperer tant qu'une release n'est pas creee (voir docs/GITHUB_RELEASES.md)."
          fi
          ;;
        404)
          say_fail "Depot de mise a jour introuvable : ${update_repository} (404). Les mises a jour distantes ne fonctionneront pas."
          echo "  -> Le depot doit exister, etre PUBLIC et porter ce nom exact. Corrigez le nom sur GitHub (gh repo rename) ou le champ 'repository' de update.config.json."
          ;;
        403)
          if grep -qi 'rate limit' "$releases_body_file" 2>/dev/null; then
            say_warn "Quota API GitHub atteint pour cette adresse IP (403). Reessayez plus tard ; la verification reprendra automatiquement."
          else
            say_warn "Acces refuse par l'API GitHub (403) pour ${update_repository} : depot prive ? Rendez-le public."
          fi
          ;;
        000)
          say_warn "API GitHub injoignable (reseau/proxy) : ./update.sh se rabattra sur une reconstruction locale."
          ;;
        *)
          say_warn "Reponse inattendue de l'API GitHub (HTTP ${releases_http}) pour ${update_repository}."
          ;;
      esac
      rm -f "$releases_body_file"

      # Test de l'acces reel DEPUIS le conteneur updater (c'est lui qui fait la
      # requete en production, pas l'hote) : detecte un blocage reseau/proxy
      # propre au conteneur meme quand l'hote, lui, joint GitHub.
      if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx fablab-updater; then
        updater_gh_code="$(docker exec fablab-updater sh -c 'curl -s -o /dev/null -w "%{http_code}" --max-time 10 -H "Accept: application/vnd.github+json" '"${update_api_base}/repos/${update_repository}/releases?per_page=1"'' 2>/dev/null || echo "000")"
        if [[ "$updater_gh_code" == "200" ]]; then
          say_ok "Le conteneur updater atteint l'API GitHub."
        elif [[ "$releases_http" == "200" ]]; then
          say_fail "L'hote atteint GitHub mais PAS le conteneur updater (HTTP ${updater_gh_code}) : proxy/reseau Docker."
          echo "  -> Si un proxy est requis, renseignez HTTPS_PROXY/HTTP_PROXY/NO_PROXY dans .env puis ./restart.sh"
          echo "     (docker-compose.yml fixe deja NODE_USE_ENV_PROXY=1 pour l'updater)."
        else
          say_warn "Le conteneur updater n'atteint pas l'API GitHub (HTTP ${updater_gh_code})."
        fi
      fi
    fi
  elif curl -sf --max-time 5 -o /dev/null "$update_base_url" 2>/dev/null || curl -sf --max-time 5 -o /dev/null "${update_base_url%/}/version.json" 2>/dev/null; then
    say_ok "Serveur de mise a jour distant joignable (${update_base_url})."
  else
    if [[ -z "$update_base_url" ]]; then
      say_warn "update.config.json ne definit pas de source de mise a jour distante."
    else
      say_warn "Serveur de mise a jour distant injoignable (${update_base_url}) : ./update.sh se rabattra automatiquement sur une reconstruction locale."
    fi
  fi
fi

fi # DOCKER_READY

# ---------------------------------------------------------------------------
say_step "Bilan"

echo "  OK : ${OK_COUNT}    Repare(s) : ${FIXED_COUNT}    Avertissement(s) : ${WARN_COUNT}    Echec(s) : ${FAIL_COUNT}"

if [[ "$WARN_COUNT" -gt 0 ]]; then
  echo
  echo "Avertissements :"
  for msg in "${WARN_MESSAGES[@]}"; do
    echo "  - $msg"
  done
fi

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo
  echo "Problemes non resolus :"
  for msg in "${FAIL_MESSAGES[@]}"; do
    echo "  - $msg"
  done
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    echo
    echo "Relancez sans --check-only pour tenter des corrections automatiques : ./doctor.sh"
  fi
  exit 1
fi

echo
echo "Tout est en ordre."
exit 0
