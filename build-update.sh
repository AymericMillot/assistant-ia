#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${1:-$PROJECT_DIR/release}"
TMP_DIR="$(mktemp -d)"

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
  local required_entries=(
    "backend/"
    "frontend/"
    "docker-compose.yml"
  )

  local archive_listing
  archive_listing="$(tar -tzf "$archive_path" | sed 's#^\./##')"

  for entry in "${required_entries[@]}"; do
    if ! printf "%s\n" "$archive_listing" | grep -Fqx "$entry"; then
      echo "Archive de mise à jour invalide : entrée manquante ${entry}" >&2
      exit 1
    fi
  done
}

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

read_json_value() {
  local file_path="$1"
  local key_path="$2"
  python3 - "$file_path" "$key_path" <<'PY'
import json
import sys

file_path = sys.argv[1]
key_path = sys.argv[2].split(".")

with open(file_path, "r", encoding="utf-8") as fh:
    payload = json.load(fh)

value = payload
for key in key_path:
    value = value[key]

print(value)
PY
}

resolve_package_file_name() {
  local package_file="$1"
  local package_template="$2"
  local version="$3"

  if [[ -n "$package_template" ]]; then
    printf "%s" "${package_template//\{version\}/$version}"
    return
  fi

  if [[ "$package_file" == *"{version}"* ]]; then
    printf "%s" "${package_file//\{version\}/$version}"
    return
  fi

  if [[ -n "$package_file" ]]; then
    printf "%s" "$package_file"
    return
  fi

  printf "assistant-ia-v%s.tar.gz" "$version"
}

sha256_file() {
  local file_path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{print $1}'
    return
  fi

  sha256sum "$file_path" | awk '{print $1}'
}

VERSION_FILE="$PROJECT_DIR/version.json"
UPDATE_CONFIG_FILE="$PROJECT_DIR/update.config.json"

require_directory "$PROJECT_DIR/backend" "backend"
require_directory "$PROJECT_DIR/frontend" "frontend"

if [[ ! -f "$VERSION_FILE" ]]; then
  echo "version.json introuvable."
  exit 1
fi

if [[ ! -f "$UPDATE_CONFIG_FILE" ]]; then
  echo "update.config.json introuvable."
  exit 1
fi

VERSION="$(read_json_value "$VERSION_FILE" "version")"
PACKAGE_NAME_RAW="$(read_json_value "$UPDATE_CONFIG_FILE" "server.packageFile")"
PACKAGE_TEMPLATE="$(read_json_value "$UPDATE_CONFIG_FILE" "server.packageFileTemplate")"
REMOTE_VERSION_FILE_NAME="$(read_json_value "$UPDATE_CONFIG_FILE" "server.versionFile")"
NOTES_FILE_NAME="$(read_json_value "$UPDATE_CONFIG_FILE" "server.notesFile")"
PACKAGE_NAME="$(resolve_package_file_name "$PACKAGE_NAME_RAW" "$PACKAGE_TEMPLATE" "$VERSION")"
VERSION_OUTPUT_DIR="$OUTPUT_DIR/$VERSION"

mkdir -p "$OUTPUT_DIR"
mkdir -p "$VERSION_OUTPUT_DIR"

ARCHIVE_PATH="$TMP_DIR/$PACKAGE_NAME"

tar \
  --exclude='.git' \
  --exclude='.DS_Store' \
  --exclude='._*' \
  --exclude='release' \
  --exclude='backend/node_modules' \
  --exclude='frontend/node_modules' \
  --exclude='updater/node_modules' \
  --exclude='backend/data' \
  --exclude='backend/logs' \
  --exclude='backend/uploads' \
  --exclude='data' \
  --exclude='logs' \
  --exclude='uploads' \
  --exclude='.env' \
  --exclude='assistant-ia-admin-cookie.txt' \
  -czf "$ARCHIVE_PATH" \
  -C "$PROJECT_DIR" \
  .

validate_archive_contains "$ARCHIVE_PATH"

SHA256="$(sha256_file "$ARCHIVE_PATH")"

cp "$ARCHIVE_PATH" "$VERSION_OUTPUT_DIR/$PACKAGE_NAME"

cat > "$VERSION_OUTPUT_DIR/$REMOTE_VERSION_FILE_NAME" <<EOF
{
  "version": "$VERSION",
  "sha256": "$SHA256"
}
EOF

if [[ -f "$PROJECT_DIR/release-notes.txt" ]]; then
  cp "$PROJECT_DIR/release-notes.txt" "$VERSION_OUTPUT_DIR/$NOTES_FILE_NAME"
elif [[ -f "$PROJECT_DIR/release-notes.example.txt" ]]; then
  cp "$PROJECT_DIR/release-notes.example.txt" "$VERSION_OUTPUT_DIR/$NOTES_FILE_NAME"
else
  cat > "$VERSION_OUTPUT_DIR/$NOTES_FILE_NAME" <<EOF
Version $VERSION

- Mise à jour du projet
EOF
fi

echo
echo "Release préparée avec succès."
echo "Version           : $VERSION"
echo "Dossier           : $VERSION_OUTPUT_DIR"
echo "Archive           : $VERSION_OUTPUT_DIR/$PACKAGE_NAME"
echo "Manifeste version : $VERSION_OUTPUT_DIR/$REMOTE_VERSION_FILE_NAME"
echo "Notes             : $VERSION_OUTPUT_DIR/$NOTES_FILE_NAME"
echo "SHA256            : $SHA256"
echo
echo "Tu peux maintenant envoyer le contenu de ce dossier sur ton serveur de mise à jour."
