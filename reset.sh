#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/.project-tools.sh"

FORCE=0

show_help() {
  cat <<EOF
Usage:
  ./reset.sh [--yes]

Reinitialise entierement l'instance : supprime TOUS les parametres et
donnees (base de donnees, identite/branding, comptes admin, documents,
conversations, feedback, index de recherche) et redemarre les services.
La premiere configuration (assistant /setup) sera redemandee au prochain
acces.

Ce qui N'EST PAS touche :
  - .env (secrets, cle de chiffrement, mot de passe hash genere a l'install)
  - Les modeles Ollama deja telecharges

Options:
  --yes         Ne demande pas de confirmation interactive (scripts/CI).
  -h, --help    Affiche cette aide.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --yes)
      FORCE=1
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      echo "Argument non reconnu : $arg" >&2
      show_help
      exit 1
      ;;
  esac
done

require_docker
ensure_env_file

if [[ "$FORCE" -ne 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "Confirmation interactive impossible (pas de terminal) : relancez avec --yes si voulu." >&2
    exit 1
  fi

  echo "ATTENTION : cette action supprime definitivement toutes les donnees et"
  echo "tous les parametres de cette instance (documents, conversations, comptes"
  echo "admin, identite/branding, index de recherche). Irreversible."
  echo
  read -r -p "Pour confirmer, ecrivez exactement RESET : " CONFIRMATION || true
  echo

  if [[ "$CONFIRMATION" != "RESET" ]]; then
    echo "Confirmation invalide, reinitialisation annulee." >&2
    exit 1
  fi
fi

echo "Preparation de la reinitialisation..."
stop_indexing_if_possible

# Vide les collections ChromaDB via le code applicatif existant (coherent
# avec le nettoyage manuel depuis l'administration), avant d'arreter les
# services et de repartir sur une base de donnees vierge.
echo "Suppression des index de recherche (ChromaDB)..."
docker_compose up -d chromadb >/dev/null 2>&1 || true
docker_compose run --rm --no-deps backend \
  node --input-type=module -e "
    import('./services/ragService.js').then(({ clearAllIndexes }) => clearAllIndexes());
  " >/dev/null 2>&1 || echo "Nettoyage de ChromaDB ignore (service indisponible)." >&2

echo "Arret des services..."
docker_compose down

# Emplacement de la base SQLite : par defaut backend/data/fablab.sqlite,
# ajustable via SQLITE_PATH dans .env (chemin resolu comme cote backend,
# relatif au dossier backend/).
SQLITE_PATH_VALUE="$(get_env_value "SQLITE_PATH")"
SQLITE_RELATIVE_PATH="${SQLITE_PATH_VALUE:-./data/fablab.sqlite}"
if [[ "$SQLITE_RELATIVE_PATH" = /* ]]; then
  SQLITE_HOST_PATH="$SQLITE_RELATIVE_PATH"
else
  SQLITE_HOST_PATH="$ROOT_DIR/backend/${SQLITE_RELATIVE_PATH#./}"
fi

echo "Suppression des donnees et parametres..."
rm -f "$SQLITE_HOST_PATH" "$SQLITE_HOST_PATH-wal" "$SQLITE_HOST_PATH-shm"
rm -f "$ROOT_DIR/backend/data/branding.json"
rm -f "$ROOT_DIR/backend/data/setup-token"
rm -f "$ROOT_DIR/backend/data/deployment.json"
rm -f "$ROOT_DIR/fablab-admin-cookie.txt"

if [[ -d "$ROOT_DIR/backend/uploads" ]]; then
  find "$ROOT_DIR/backend/uploads" -mindepth 1 -delete
fi

echo "Redemarrage des services..."
docker_compose up -d ollama chromadb redis backend

echo "Demarrage du service de mise a jour..."
if ! docker_compose_up_required updater; then
  echo "Le service de mise a jour n'a pas pu demarrer : le projet ne peut pas fonctionner correctement sans lui." >&2
  exit 1
fi

wait_for_backend_ready

echo "Generation d'un nouveau mot de passe référent..."
GENERATED_TEACHER_PASSWORD="$(
  docker_compose exec -T backend node scripts/reset-teacher-password.js 2>/dev/null | tail -n 2 | head -n 1 || true
)"

print_access_summary "Reinitialisation terminee. Toutes les donnees et parametres ont ete supprimes."
if [[ -n "$GENERATED_TEACHER_PASSWORD" ]]; then
  echo "Nouveau mot de passe référent : ${GENERATED_TEACHER_PASSWORD} (changement impose a la premiere connexion)"
  echo
fi
