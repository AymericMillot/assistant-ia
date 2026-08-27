#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="$(basename "$ROOT_DIR")"
OUTPUT_DIR="$ROOT_DIR/export"
VERSION_FILE="$ROOT_DIR/version.json"
INCLUDE_DATA=false
NOTES_FILE_NAME="release-notes.txt"

require_directory() {
  local target_dir="$1"
  local label="$2"
  if [[ ! -d "$target_dir" ]]; then
    echo "Dossier ${label} introuvable : $target_dir" >&2
    exit 1
  fi
}

validate_archive_contains() {
  local archive_path="$1"
  local root_prefix="$2"
  local required_entries=(
    "${root_prefix}/backend/"
    "${root_prefix}/frontend/"
    "${root_prefix}/docker-compose.yml"
  )

  local archive_listing
  archive_listing="$(tar -tzf "$archive_path" | sed 's#^\./##')"

  for entry in "${required_entries[@]}"; do
    if ! printf "%s\n" "$archive_listing" | grep -Fqx "$entry"; then
      echo "Archive invalide : entrée manquante ${entry}" >&2
      exit 1
    fi
  done
}

read_project_version() {
  if [[ ! -f "$VERSION_FILE" ]]; then
    echo "1.000"
    return
  fi

  node -e '
    const fs = require("fs");
    try {
      const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const version = String(payload.version || "1.000").trim();
      process.stdout.write(version || "1.000");
    } catch {
      process.stdout.write("1.000");
    }
  ' "$VERSION_FILE"
}

PROJECT_VERSION="$(read_project_version)"
SAFE_PROJECT_VERSION="$(printf "%s" "$PROJECT_VERSION" | tr -cs '[:alnum:]._-+' '-')"
ARCHIVE_NAME="${PROJECT_NAME}-v${SAFE_PROJECT_VERSION}.tar.gz"
ZIP_ARCHIVE_NAME="${PROJECT_NAME}-v${SAFE_PROJECT_VERSION}.zip"
VERSION_OUTPUT_DIR=""
RELEASE_DATETIME="$(TZ="Europe/Paris" date '+%d/%m/%Y %H:%M:%S')"

require_directory "$ROOT_DIR/backend" "backend"
require_directory "$ROOT_DIR/frontend" "frontend"

if ! command -v zip >/dev/null 2>&1; then
  echo "La commande 'zip' est introuvable : impossible de générer l'archive .zip." >&2
  exit 1
fi

show_help() {
  cat <<EOF
Usage:
  ./export.sh [--with-data] [output_dir]

Crée un dossier nommé avec la version du projet, puis y place l'archive .tar.gz
prête à être déplacée sur une autre machine.
La version utilisée est lue depuis version.json.

Options:
  --with-data   Inclut aussi les données locales (documents, base, logs).
  -h, --help    Affiche cette aide.

Exemples:
  ./export.sh
  ./export.sh /tmp/exports
  ./export.sh --with-data
  ./export.sh --with-data /tmp/exports
EOF
}

POSITIONAL_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-data)
      INCLUDE_DATA=true
      shift
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      POSITIONAL_ARGS+=("$1")
      shift
      ;;
  esac
done
if [[ ${#POSITIONAL_ARGS[@]} -gt 0 ]]; then
  set -- "${POSITIONAL_ARGS[@]}"
else
  set --
fi

if [[ $# -gt 1 ]]; then
  echo "Trop d'arguments." >&2
  echo
  show_help
  exit 1
fi

if [[ $# -eq 1 ]]; then
  OUTPUT_DIR="$1"
fi

mkdir -p "$OUTPUT_DIR"
VERSION_OUTPUT_DIR="$OUTPUT_DIR/$PROJECT_VERSION"
mkdir -p "$VERSION_OUTPUT_DIR"

TEMP_EXCLUDES_FILE="$(mktemp)"
cleanup() {
  rm -f "$TEMP_EXCLUDES_FILE"
}
trap cleanup EXIT

cat > "$TEMP_EXCLUDES_FILE" <<'EOF'
.git
.DS_Store
._*
export
release
backend/node_modules
frontend/node_modules
updater/node_modules
fablab-admin-cookie.txt
.env
.env.publish
.env.local
.env.development
.env.production
.env.test
.env.*.local
EOF

if [[ "$INCLUDE_DATA" == false ]]; then
  cat >> "$TEMP_EXCLUDES_FILE" <<'EOF'
backend/data
backend/logs
backend/uploads
data
logs
uploads
EOF
fi

ARCHIVE_PATH="$VERSION_OUTPUT_DIR/$ARCHIVE_NAME"
ZIP_ARCHIVE_PATH="$VERSION_OUTPUT_DIR/$ZIP_ARCHIVE_NAME"
NOTES_PATH="$VERSION_OUTPUT_DIR/$NOTES_FILE_NAME"

# L'archive contient un dossier "$PROJECT_NAME/" au sommet (ex: "fablab-ai/") :
# un "unzip fablab-ai.zip" ou "tar -xzf" cree directement ce dossier avec tout
# le projet dedans, plutot que d'eparpiller les fichiers dans le repertoire courant.
tar -czf "$ARCHIVE_PATH" \
  --exclude-from="$TEMP_EXCLUDES_FILE" \
  -C "$(dirname "$ROOT_DIR")" \
  "$PROJECT_NAME"

validate_archive_contains "$ARCHIVE_PATH" "$PROJECT_NAME"

# Le zip est reconstruit a partir du contenu deja filtre du tar.gz, pour
# garantir exactement les memes exclusions sans dupliquer la logique de tri.
ZIP_STAGING_DIR="$(mktemp -d)"
cleanup_zip_staging() {
  rm -rf "$ZIP_STAGING_DIR"
}
trap 'cleanup; cleanup_zip_staging' EXIT

tar -xzf "$ARCHIVE_PATH" -C "$ZIP_STAGING_DIR"
rm -f "$ZIP_ARCHIVE_PATH"
( cd "$ZIP_STAGING_DIR" && zip -rq -X "$ZIP_ARCHIVE_PATH" . )

cat > "$NOTES_PATH" <<EOF
Version $PROJECT_VERSION
Date de publication : $RELEASE_DATETIME (Europe/Paris)
EOF

echo
echo "Export terminé."
echo "Version : $PROJECT_VERSION"
echo "Dossier : $VERSION_OUTPUT_DIR"
echo "Archive (tar.gz) : $ARCHIVE_PATH"
echo "Archive (zip)    : $ZIP_ARCHIVE_PATH"
echo "Notes   : $NOTES_PATH"
if [[ "$INCLUDE_DATA" == true ]]; then
  echo "Mode    : avec données"
else
  echo "Mode    : sans données"
fi
echo
echo "Version du projet : $VERSION_FILE"
echo
echo "Pour déployer sur une autre machine :"
echo "1. Copier l'archive"
echo "2. L'extraire"
echo "3. Aller dans le dossier du projet"
echo "4. Lancer ./install.sh"
echo

if command -v open >/dev/null 2>&1; then
  open "$ROOT_DIR/export" >/dev/null 2>&1 || true
fi
