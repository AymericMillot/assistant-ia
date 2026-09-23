#!/bin/sh
# Point d'entree du backend : le conteneur demarre en root uniquement pour
# rendre les dossiers montes (uploads, logs, data) a l'utilisateur du serveur,
# puis le processus Node abandonne ses droits root.
#
# Sans cela, les fichiers crees par l'application (pieces jointes, base SQLite,
# logs) appartiennent a root sur l'hote : ./update.sh, git pull ou une simple
# suppression exigeraient alors sudo.
#
# Identite cible : APP_UID/APP_GID (ecrits dans .env par install.sh), sinon le
# proprietaire du dossier /app/data monte depuis l'hote. Si elle vaut 0 (projet
# installe en root), le comportement historique est conserve.
set -e

TARGET_UID="${APP_UID:-}"
TARGET_GID="${APP_GID:-}"
if [ -z "$TARGET_UID" ]; then
  TARGET_UID="$(stat -c %u /app/data 2>/dev/null || echo 0)"
fi
if [ -z "$TARGET_GID" ]; then
  TARGET_GID="$(stat -c %g /app/data 2>/dev/null || echo 0)"
fi

if [ "$(id -u)" = "0" ] && [ "$TARGET_UID" != "0" ]; then
  for dir in /app/uploads /app/logs /app/data; do
    mkdir -p "$dir"
    # Seuls les fichiers qui n'appartiennent pas deja a la bonne identite sont
    # modifies (rapide meme avec beaucoup de documents). Non bloquant : certains
    # montages (macOS) refusent chown sans que cela gene l'ecriture.
    find "$dir" \( ! -user "$TARGET_UID" -o ! -group "$TARGET_GID" \) \
      -exec chown -h "$TARGET_UID:$TARGET_GID" {} + 2>/dev/null || true
  done
  export HOME=/tmp
  exec setpriv --reuid="$TARGET_UID" --regid="$TARGET_GID" --clear-groups -- "$@"
fi

exec "$@"
