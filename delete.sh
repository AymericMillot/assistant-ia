#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/.project-tools.sh"

FORCE=0

show_help() {
  cat <<EOF
Usage:
  ./delete.sh [--yes]

Supprime TOUT ce que le projet a cree sur cette machine : conteneurs,
volumes Docker (y compris les modeles Ollama deja telecharges et l'index
ChromaDB), images construites (backend, updater), donnees locales
(backend/data, backend/uploads, backend/logs), dependances installees
(node_modules) et fichiers generes (.env, dist, exports, sauvegardes de
mise a jour). Le dossier revient a l'etat d'un depot fraichement clone.

Ce qui N'EST PAS touche :
  - Le code source du projet lui-meme (aucun fichier suivi par git n'est
    supprime, hormis les fichiers generes listes ci-dessus)
  - Docker, et les images tierces (Ollama, ChromaDB, Redis) telechargees
    depuis leurs registres officiels

Pour reinstaller ensuite : ./install.sh

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

if [[ "$FORCE" -ne 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "Confirmation interactive impossible (pas de terminal) : relancez avec --yes si voulu." >&2
    exit 1
  fi

  echo "ATTENTION : cette action supprime DEFINITIVEMENT et IRREVERSIBLEMENT :"
  echo "  - tous les conteneurs et volumes Docker du projet"
  echo "  - les modeles Ollama deja telecharges (a retelecharger, plusieurs Go)"
  echo "  - les images Docker construites (backend, updater)"
  echo "  - toutes les donnees locales (documents, base de donnees, logs)"
  echo "  - node_modules (backend, frontend, updater) et le build frontend"
  echo "  - .env et .env.publish (secrets, cle de chiffrement : a regenerer)"
  echo
  echo "Le code source du projet (fichiers suivis par git) n'est PAS supprime."
  echo
  read -r -p "Pour confirmer, ecrivez exactement SUPPRIMER : " CONFIRMATION || true
  echo

  if [[ "$CONFIRMATION" != "SUPPRIMER" ]]; then
    echo "Confirmation invalide, suppression annulee." >&2
    exit 1
  fi
fi

echo "Preparation..."
stop_indexing_if_possible || true

echo "Arret des services et suppression des conteneurs, volumes et images du projet..."
docker_compose down -v --rmi local --remove-orphans 2>&1 || true

echo "Suppression des donnees et fichiers generes..."
rm -rf "$ROOT_DIR/backend/data"
rm -rf "$ROOT_DIR/backend/uploads"
rm -rf "$ROOT_DIR/backend/logs"
rm -rf "$ROOT_DIR/backend/node_modules"
rm -rf "$ROOT_DIR/frontend/node_modules"
rm -rf "$ROOT_DIR/frontend/dist"
rm -rf "$ROOT_DIR/updater/node_modules"
rm -rf "$ROOT_DIR/.update-backups"
rm -rf "$ROOT_DIR/export"
rm -rf "$ROOT_DIR/release"
rm -f "$ROOT_DIR/fablab-admin-cookie.txt"
rm -f "$ROOT_DIR/.env"
rm -f "$ROOT_DIR/.env.publish"
find "$ROOT_DIR" -maxdepth 3 -name ".DS_Store" -delete 2>/dev/null || true

echo
echo "Suppression terminee. Le dossier du projet est revenu a un etat proche"
echo "d'un depot fraichement clone."
echo
echo "Pour reinstaller : ./install.sh"
