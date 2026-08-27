#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/.project-tools.sh"

CHECK_ONLY=0

download_remote_package() {
  local package_url="$1"
  local archive_path="$2"

  curl -fsSL "$package_url" -o "$archive_path"
}

compute_sha256() {
  local target_file="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target_file" | awk '{print $1}'
    return 0
  fi

  shasum -a 256 "$target_file" | awk '{print $1}'
}

detect_package_root() {
  local extract_root="$1"

  if [[ -f "$extract_root/docker-compose.yml" ]]; then
    printf '%s' "$extract_root"
    return 0
  fi

  local candidate
  for candidate in "$extract_root"/*; do
    if [[ -d "$candidate" && -f "$candidate/docker-compose.yml" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  return 1
}

validate_package_root() {
  local package_root="$1"
  local required_entry

  for required_entry in docker-compose.yml backend frontend; do
    if [[ ! -e "$package_root/$required_entry" ]]; then
      echo "Le package de mise à jour est incomplet : ${required_entry} est introuvable." >&2
      return 1
    fi
  done
}

apply_remote_package_from_host() {
  local package_url="$1"
  local package_sha="$2"
  local target_version="$3"
  local temp_root archive_path extract_root package_root
  local -a rsync_args
  local -a preserve_paths
  local preserve_path

  temp_root="$(mktemp -d)"
  archive_path="$temp_root/release.tar.gz"
  extract_root="$temp_root/extract"
  mkdir -p "$extract_root"

  cleanup_temp_root() {
    rm -rf "$temp_root"
  }
  trap cleanup_temp_root RETURN

  echo "[18%] Téléchargement du package de mise à jour..."
  download_remote_package "$package_url" "$archive_path"

  # La somme SHA256 est obligatoire : une release sans empreinte est refusée
  # (UPDATE_ALLOW_UNSIGNED=1 permet un dépannage exceptionnel en connaissance de cause).
  if [[ -z "${package_sha:-}" && "${UPDATE_ALLOW_UNSIGNED:-0}" != "1" ]]; then
    echo "La release distante ne fournit pas de somme SHA256 : installation refusée." >&2
    echo "Publiez la version avec publish-release.sh pour générer le manifest complet." >&2
    return 1
  fi

  if [[ -n "${package_sha:-}" ]]; then
    echo "[32%] Vérification du package..."
    local computed_sha computed_sha_lower package_sha_lower
    computed_sha="$(compute_sha256 "$archive_path")"
    # tr plutot que ${var,,} : bash 3.2 (defaut sur macOS) ne supporte pas
    # cette syntaxe de minification introduite en bash 4.
    computed_sha_lower="$(printf '%s' "$computed_sha" | tr '[:upper:]' '[:lower:]')"
    package_sha_lower="$(printf '%s' "$package_sha" | tr '[:upper:]' '[:lower:]')"
    if [[ "$computed_sha_lower" != "$package_sha_lower" ]]; then
      echo "La vérification SHA256 du package a échoué." >&2
      return 1
    fi
  fi

  echo "[46%] Préparation des fichiers..."
  tar -xzf "$archive_path" -C "$extract_root"
  if ! package_root="$(detect_package_root "$extract_root")"; then
    echo "Le package de mise à jour ne contient pas docker-compose.yml." >&2
    return 1
  fi

  validate_package_root "$package_root"

  echo "[58%] Application des nouveaux fichiers..."
  preserve_paths=(
    ".env"
    "update.config.json"
    "backend/uploads"
    "backend/logs"
    "backend/data"
    ".git"
    ".update-backups"
    "fablab-admin-cookie.txt"
    "export"
    "release"
  )

  rsync_args=(-a --delete)
  for preserve_path in "${preserve_paths[@]}"; do
    rsync_args+=("--exclude=/${preserve_path}")
  done

  rsync "${rsync_args[@]}" "$package_root"/ "$ROOT_DIR"/

  echo "[78%] Redémarrage du backend avec le frontend embarqué..."
  docker_compose_up_build backend updater
  wait_for_backend_ready

  echo "[100%] Mise à jour terminée."
  print_access_summary "Mise à jour distante terminée. Version active : ${target_version}"
}

format_warning_message() {
  local raw_message="$1"

  case "$raw_message" in
    "fetch failed")
      printf '%s' "Le serveur de mise à jour n'est pas joignable pour le moment."
      ;;
    "")
      printf ''
      ;;
    *)
      printf '%s' "$raw_message"
      ;;
  esac
}

show_help() {
  cat <<EOF
Usage:
  ./update.sh
  ./update.sh --check-only

Sans option :
- vérifie si une mise à jour distante est disponible
- l'applique si elle existe
- sinon reconstruit le projet avec les fichiers locaux actuels

Avec --check-only :
- affiche seulement l'état de la mise à jour distante
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      show_help
      exit 0
      ;;
    --check-only)
      CHECK_ONLY=1
      shift
      ;;
    *)
      echo "Argument non reconnu : $1" >&2
      show_help
      exit 1
      ;;
  esac
done

require_docker
ensure_env_file

echo "Vérification du service de mise à jour..."
if ! ensure_updater_running; then
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    echo "Impossible de vérifier une mise à jour distante."
    exit 1
  fi

  echo "Vérification distante indisponible. Reconstruction locale du projet..."
  stop_indexing_if_possible
  docker_compose_up_build
  wait_for_backend_ready
  print_access_summary "Mise a jour locale terminee."
  exit 0
fi

status_json="$(fetch_updater_status)"
current_version="$(printf '%s' "$status_json" | json_field currentVersion)"
latest_version="$(printf '%s' "$status_json" | json_field latestVersion)"
update_available="$(printf '%s' "$status_json" | json_field updateAvailable)"
warning_message="$(printf '%s' "$status_json" | json_field warning)"
warning_message="$(format_warning_message "$warning_message")"

echo "Version actuelle : ${current_version:-inconnue}"
if [[ -n "${latest_version:-}" ]]; then
  echo "Version distante : ${latest_version}"
fi
if [[ -n "${warning_message:-}" ]]; then
  echo "Information : ${warning_message}"
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  if [[ "$update_available" == "true" ]]; then
    echo "Une mise à jour distante est disponible."
  else
    echo "Aucune mise à jour distante disponible."
  fi
  exit 0
fi

if [[ "$update_available" == "true" ]]; then
  echo "Mise à jour distante détectée."
  stop_indexing_if_possible

  target_version="$(printf '%s' "$status_json" | json_field release.version)"
  target_package_url="$(printf '%s' "$status_json" | json_field release.packageUrl)"
  target_package_sha="$(printf '%s' "$status_json" | json_field release.sha256)"

  if [[ -z "${target_package_url:-}" ]]; then
    echo "Aucune archive de mise à jour n'est disponible pour cette version." >&2
    exit 1
  fi

  if ! apply_remote_package_from_host "$target_package_url" "$target_package_sha" "${target_version:-$latest_version}"; then
    echo "La mise à jour distante a échoué." >&2
    exit 1
  fi

  exit 0
fi

echo "Aucune mise à jour distante disponible. Reconstruction locale du projet..."
stop_indexing_if_possible
docker_compose_up_build
wait_for_backend_ready
print_access_summary "Mise à jour locale terminée."
