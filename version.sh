#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/.project-tools.sh"

show_help() {
  cat <<EOF
Usage:
  ./version.sh

Affiche la version actuellement installee. Si les services tournent,
verifie egalement si une mise a jour est disponible sur le serveur distant.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  show_help
  exit 0
fi

VERSION_FILE="$ROOT_DIR/version.json"
CURRENT_VERSION="inconnue"
if [[ -f "$VERSION_FILE" ]]; then
  CURRENT_VERSION="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$VERSION_FILE" | sed -E 's/.*"([^"]+)"$/\1/')"
  CURRENT_VERSION="${CURRENT_VERSION:-inconnue}"
fi

echo "Version installee : ${CURRENT_VERSION}"

if ! command -v docker >/dev/null 2>&1; then
  exit 0
fi

if ! docker_compose ps --status running --services 2>/dev/null | grep -qx "updater"; then
  echo "(Service de mise a jour non demarre : impossible de verifier une version plus recente. Lancez ./restart.sh puis reessayez.)"
  exit 0
fi

status_json="$(fetch_updater_status)"
if [[ -z "$status_json" ]]; then
  echo "(Impossible de contacter le service de mise a jour pour verifier une version plus recente.)"
  exit 0
fi

latest_version="$(printf '%s' "$status_json" | json_field latestVersion)"
update_available="$(printf '%s' "$status_json" | json_field updateAvailable)"

if [[ -n "$latest_version" ]]; then
  echo "Derniere version disponible : ${latest_version}"
  if [[ "$update_available" == "true" ]]; then
    echo "-> Une mise a jour est disponible : ./update.sh"
  else
    echo "-> Vous etes a jour."
  fi
fi
