#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/.project-tools.sh"

show_help() {
  cat <<EOF
Usage:
  ./restart.sh

Redemarre les services du projet.
Si le projet n'est pas encore lance, le script le demarre simplement.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  show_help
  exit 0
fi

require_docker
ensure_env_file

echo "Preparation du redemarrage..."
stop_indexing_if_possible

if is_backend_running; then
  echo "Redemarrage des services en cours..."
  docker_compose restart ollama chromadb redis backend
else
  echo "Le backend n'est pas actif. Demarrage complet des services..."
  docker_compose up -d ollama chromadb redis backend
fi

docker_compose up -d updater >/dev/null 2>&1 || true

wait_for_backend_ready
print_access_summary "Redemarrage termine."
