#!/usr/bin/env bash

# Publication d'une release sur le serveur de mise à jour distant.
#
# Chaîne complète :
#   1. Construit l'archive versionnée via ./export.sh (sans données locales).
#   2. Calcule le SHA256 de l'archive (obligatoire : l'updater refuse les
#      packages non vérifiables).
#   3. Génère le manifest version.json { version, sha256, publishedAt }.
#   4. Téléverse le dossier de version en FTPS (TLS exigé) vers le serveur.
#   5. Téléverse aussi fablab-ai.zip (dernière version, nom fixe) pour
#      l'installation web en une commande (irm ... | iex, voir web-install.ps1).
#   6. Vérifie que la release est bien accessible via l'URL publique HTTPS.
#
# Les identifiants FTP sont lus depuis .env.publish (non versionné).
# L'application consommatrice n'utilise jamais ces identifiants : elle lit
# les mises à jour en HTTPS public.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env.publish"
VERSION_FILE="$ROOT_DIR/version.json"
NOTES_SOURCE="$ROOT_DIR/release-notes.txt"
DRY_RUN=0

show_help() {
  cat <<EOF
Usage:
  ./publish-release.sh [--dry-run]

Prépare et publie la version courante (lue dans version.json) sur le serveur
de mise à jour distant défini dans .env.publish.

Avant de lancer :
  1. Mettre à jour la version dans version.json
  2. (Optionnel) Écrire les notes de version dans release-notes.txt (racine du
     projet) - à défaut, une note minimale (version + date) est générée
     automatiquement.

Options:
  --dry-run     Construit et prépare tout, sans téléverser.
  -h, --help    Affiche cette aide.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      echo "Argument non reconnu : $1" >&2
      show_help
      exit 1
      ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Fichier .env.publish introuvable." >&2
  echo "Copiez .env.publish.example vers .env.publish puis renseignez les identifiants FTP." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

for required_var in FTP_HOST FTP_USER FTP_PASSWORD FTP_REMOTE_DIR; do
  if [[ -z "${!required_var:-}" ]]; then
    echo "Variable ${required_var} manquante dans .env.publish." >&2
    exit 1
  fi
done

read_project_version() {
  node -e '
    const fs = require("fs");
    try {
      const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(payload.version || "").trim());
    } catch {
      process.stdout.write("");
    }
  ' "$VERSION_FILE"
}

compute_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

VERSION="$(read_project_version)"
if [[ -z "$VERSION" ]]; then
  echo "Impossible de lire la version dans version.json." >&2
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
  echo "Version invalide : ${VERSION}. Format attendu : chiffres séparés par des points (ex. 1.013)." >&2
  exit 1
fi

echo "==> Publication de la version ${VERSION}"

echo "==> Construction de l'archive (export.sh)..."
"$ROOT_DIR/export.sh" >/dev/null

STAGING_DIR="$ROOT_DIR/export/$VERSION"
ARCHIVE_NAME="fablab-ai-v${VERSION}.tar.gz"
ARCHIVE_PATH="$STAGING_DIR/$ARCHIVE_NAME"
LATEST_ZIP_NAME="fablab-ai-v${VERSION}.zip"
LATEST_ZIP_PATH="$STAGING_DIR/$LATEST_ZIP_NAME"

if [[ ! -f "$ARCHIVE_PATH" ]]; then
  echo "Archive attendue introuvable : $ARCHIVE_PATH" >&2
  exit 1
fi

echo "==> Calcul du SHA256..."
SHA256="$(compute_sha256 "$ARCHIVE_PATH")"
echo "    ${SHA256}"

PUBLISHED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

cat > "$STAGING_DIR/version.json" <<EOF
{
  "version": "${VERSION}",
  "sha256": "${SHA256}",
  "packageFile": "${ARCHIVE_NAME}",
  "publishedAt": "${PUBLISHED_AT}"
}
EOF

if [[ -f "$NOTES_SOURCE" ]]; then
  cp "$NOTES_SOURCE" "$STAGING_DIR/release-notes.txt"
else
  echo "==> release-notes.txt absent : note minimale generee automatiquement."
  cat > "$STAGING_DIR/release-notes.txt" <<EOF
Version ${VERSION}
Date de publication : ${PUBLISHED_AT}
EOF
fi

echo "==> Dossier de release prêt : $STAGING_DIR"
ls -lh "$STAGING_DIR"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo "Mode --dry-run : aucun téléversement effectué."
  exit 0
fi

REMOTE_BASE="ftp://${FTP_HOST}/${FTP_REMOTE_DIR%/}/${VERSION}"

# Dossier distant ou est deposee la derniere version en .zip (installation
# web en une commande, irm ... | iex - voir web-install.ps1), separement du
# dossier versionne utilise par le mecanisme de mise a jour automatique.
# Par defaut, un niveau au-dessus de FTP_REMOTE_DIR (ex: si FTP_REMOTE_DIR
# pointe vers ".../iutlab/maj", la racine ".../iutlab" recoit fablab-ai.zip) ;
# surchargeable via FTP_LATEST_ZIP_DIR dans .env.publish si l'arborescence
# distante est differente.
LATEST_ZIP_REMOTE_DIR="${FTP_LATEST_ZIP_DIR:-$(dirname "$FTP_REMOTE_DIR")}"

upload_file() {
  local local_path="$1"
  local remote_url="$2"

  # --ssl-reqd : refuse toute connexion si le serveur n'accepte pas TLS.
  # --ftp-create-dirs : crée le dossier distant si besoin.
  curl --fail --silent --show-error \
    --ssl-reqd \
    --ftp-create-dirs \
    --user "${FTP_USER}:${FTP_PASSWORD}" \
    --upload-file "$local_path" \
    "$remote_url"
}

echo "==> Téléversement FTPS vers ${FTP_HOST}/${FTP_REMOTE_DIR%/}/${VERSION}/ ..."
upload_file "$ARCHIVE_PATH" "${REMOTE_BASE}/${ARCHIVE_NAME}"
echo "    Archive envoyée."
upload_file "$STAGING_DIR/version.json" "${REMOTE_BASE}/version.json"
echo "    Manifest envoyé."
upload_file "$STAGING_DIR/release-notes.txt" "${REMOTE_BASE}/release-notes.txt"
echo "    Notes envoyées."

if [[ -f "$LATEST_ZIP_PATH" ]]; then
  echo "==> Téléversement de fablab-ai.zip (installation web) vers ${FTP_HOST}/${LATEST_ZIP_REMOTE_DIR%/}/ ..."
  upload_file "$LATEST_ZIP_PATH" "ftp://${FTP_HOST}/${LATEST_ZIP_REMOTE_DIR%/}/fablab-ai.zip"
  echo "    fablab-ai.zip mis à jour (toujours la dernière version)."
else
  echo "Attention : ${LATEST_ZIP_NAME} introuvable, fablab-ai.zip non mis à jour." >&2
fi

if [[ -n "${PUBLIC_BASE_URL:-}" ]]; then
  echo "==> Vérification de l'accès public HTTPS..."
  PUBLIC_MANIFEST_URL="${PUBLIC_BASE_URL%/}/${VERSION}/version.json"
  if curl --fail --silent --max-time 20 "$PUBLIC_MANIFEST_URL" | grep -q "\"${VERSION}\""; then
    echo "    OK : ${PUBLIC_MANIFEST_URL}"
  else
    echo "    Attention : la release ne semble pas (encore) accessible sur ${PUBLIC_MANIFEST_URL}." >&2
    echo "    Vérifiez la propagation ou la configuration du sous-domaine." >&2
  fi
fi

echo
echo "Publication terminée : version ${VERSION} disponible pour les instances."
echo "Les instances la verront via leur onglet « Mise à jour » ou ./update.sh."
