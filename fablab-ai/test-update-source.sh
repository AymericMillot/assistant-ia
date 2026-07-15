#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/.project-tools.sh"

show_help() {
  cat <<EOF
Usage:
  ./test-update-source.sh

Teste la source distante de mise a jour sans appliquer la mise a jour.
Le script :
- lit la configuration distante de mise a jour
- detecte la version la plus recente
- telecharge l'archive dans un dossier temporaire
- affiche la version detectee, la source et l'empreinte SHA256
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  show_help
  exit 0
fi

ensure_env_file

echo "Test du telechargement de l'archive distante..."
test_json="$(cd "$ROOT_DIR/updater" && node ./test-source.js "$ROOT_DIR")"

tested_version="$(printf '%s' "$test_json" | json_field version)"
package_source="$(printf '%s' "$test_json" | json_field packageSource)"
downloaded_bytes="$(printf '%s' "$test_json" | json_field downloadedBytes)"
sha256="$(printf '%s' "$test_json" | json_field sha256)"

echo
echo "Test reussi."
echo "Version testee     : ${tested_version:-inconnue}"
echo "Source archive     : ${package_source:-inconnue}"
echo "Taille telechargee : ${downloaded_bytes:-0} octets"
echo "SHA256             : ${sha256:-indisponible}"
echo
