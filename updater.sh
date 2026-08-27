#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/.project-tools.sh"

show_help() {
  cat <<EOF
Usage:
  ./updater.sh

Demarre (ou redemarre) le service de mise a jour s'il est arrete ou en
echec. A utiliser en depannage si ./update.sh, ./install.sh, ./restart.sh
ou ./reset.sh ont signale que le service de mise a jour n'a pas pu
demarrer (par exemple une erreur docker code 125).

Reessaie plusieurs fois avec un delai croissant et affiche un diagnostic
si le probleme persiste.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  show_help
  exit 0
fi

require_docker
ensure_env_file

echo "Demarrage du service de mise a jour..."
if ! ensure_updater_running; then
  echo "Le service de mise a jour n'a pas pu demarrer. Voir le diagnostic ci-dessus." >&2
  exit 1
fi

echo "Le service de mise a jour est actif."
