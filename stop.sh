#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/.project-tools.sh"

show_help() {
  cat <<EOF
Usage:
  ./stop.sh

Arrete le projet et tente d'arreter les indexations avant la fermeture.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  show_help
  exit 0
fi

require_docker

stop_indexing_if_possible

echo "Arret du projet..."
docker_compose down

echo "Projet arrete."
echo "Pour le relancer : cd \"$ROOT_DIR\" && ./restart.sh"
