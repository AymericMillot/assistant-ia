#!/usr/bin/env bash

# Prépare une release GitHub. La publication est réalisée par le workflow
# .github/workflows/release.yml après le push du tag v<version>.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION_FILE="$ROOT_DIR/version.json"
DRY_RUN=0

show_help() {
  cat <<'EOF'
Usage: ./publish-release.sh [--dry-run]

Construit et vérifie les archives, puis crée et pousse le tag Git v<version>.
GitHub Actions crée ensuite la GitHub Release et joint les archives, le manifest
SHA256 et les notes de version.

Options:
  --dry-run  Vérifie la préparation sans créer ni pousser de tag.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) show_help; exit 0 ;;
    *) echo "Argument non reconnu : $arg" >&2; show_help; exit 1 ;;
  esac
done

VERSION="$(node -e 'const fs=require("fs"); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version||""))' "$VERSION_FILE")"
if [[ ! "$VERSION" =~ ^[0-9]+(\.[0-9]+)*(-beta\.[0-9]+)?$ ]]; then
  echo "Version invalide dans version.json." >&2
  exit 1
fi
TAG="v$VERSION"
# Une version "X.Y.Z-beta.N" est publiee comme prerelease GitHub : exclue par
# defaut du canal stable (voir isBetaChannelEnabled cote backend et le filtre
# includeBeta cote updater/server.js).
IS_BETA=0
[[ "$VERSION" == *-beta.* ]] && IS_BETA=1

echo "==> Construction des archives $VERSION"
"$ROOT_DIR/export.sh" >/dev/null

# Doit rester aligne avec PACKAGE_BASENAME de export.sh et packageFileTemplate
# de update.config.json.
PACKAGE_BASENAME="${UPDATE_PROJECT_NAME:-assistant-ia}"
ARCHIVE="$ROOT_DIR/export/$VERSION/${PACKAGE_BASENAME}-v$VERSION.tar.gz"
if [[ ! -f "$ARCHIVE" ]]; then
  echo "Archive attendue introuvable : $ARCHIVE" >&2
  exit 1
fi
SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
echo "==> SHA256 vérifié : $SHA256"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Mode test terminé : le tag $TAG et la release GitHub n'ont pas été créés."
  exit 0
fi

if ! git -C "$ROOT_DIR" diff --quiet || ! git -C "$ROOT_DIR" diff --cached --quiet; then
  echo "Le dépôt contient des modifications non validées. Créez d'abord un commit de release." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) est requis pour vérifier l'authentification et pousser la release." >&2
  exit 1
fi
gh auth status >/dev/null

REMOTE_URL="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || true)"
if [[ -z "$REMOTE_URL" ]]; then
  echo "Aucun remote Git 'origin' n'est configuré." >&2
  exit 1
fi
if git -C "$ROOT_DIR" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Le tag $TAG existe déjà."
else
  git -C "$ROOT_DIR" tag -a "$TAG" -m "Release $TAG"
  echo "==> Tag $TAG créé."
fi

git -C "$ROOT_DIR" push origin "$TAG"
if [[ "$IS_BETA" -eq 1 ]]; then
  echo "==> Tag envoyé. GitHub Actions publiera automatiquement la release $TAG en tant que prerelease (bêta)."
else
  echo "==> Tag envoyé. GitHub Actions publiera automatiquement la release $TAG."
fi
