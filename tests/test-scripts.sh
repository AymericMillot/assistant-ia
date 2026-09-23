#!/usr/bin/env bash

# Tests des scripts d'exploitation (install / update / doctor / .project-tools).
# Volontairement sans dependance : bash + coreutils suffisent. Un « docker »
# factice est place en tete de PATH pour que les helpers qui l'appellent
# n'aient besoin ni d'un vrai daemon ni du reseau.
#
#   ./tests/test-scripts.sh
#
# Code de sortie 0 si tout passe, 1 sinon.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0

ok()   { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then ok "$label"; else
    bad "$label (attendu='${expected}' obtenu='${actual}')"
  fi
}
assert_rc() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then ok "$label"; else
    bad "$label (code attendu=${expected} obtenu=${actual})"
  fi
}
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then ok "$label"; else
    bad "$label (« ${needle} » absent)"
  fi
}

# --------------------------------------------------------------------------
# 1. bash -n sur tous les scripts .sh du depot
# --------------------------------------------------------------------------
echo "== Syntaxe (bash -n) =="
for f in "$ROOT_DIR"/*.sh "$ROOT_DIR"/tests/*.sh; do
  [[ -f "$f" ]] || continue
  if bash -n "$f" 2>/dev/null; then ok "$(basename "$f")"; else bad "$(basename "$f")"; fi
done

# --------------------------------------------------------------------------
# 2. « docker » factice + sourcing de .project-tools.sh
# --------------------------------------------------------------------------
echo "== .project-tools.sh (helpers) =="
FAKE_BIN="$(mktemp -d)"
cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
# Enregistre l'appel et repond de facon inoffensive.
echo "docker $*" >> "${FAKE_DOCKER_LOG:-/dev/null}"
case "$1" in
  info) exit 0 ;;
  inspect) exit 1 ;;
  compose) exit 0 ;;
  network) exit 0 ;;
  rm) exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKE_BIN/docker"
export PATH="$FAKE_BIN:$PATH"
export FAKE_DOCKER_LOG="$FAKE_BIN/calls.log"

# .project-tools.sh redefinit ROOT_DIR : on le laisse pointer sur le depot reel.
# shellcheck disable=SC1091
source "$ROOT_DIR/.project-tools.sh"

# decode/normalize : round-trip des '$' (echappes '$$' dans .env facon compose)
assert_eq 'a$b'   "$(decode_env_value 'a$$b')"        "decode_env_value dé-échappe \$\$"
assert_eq 'a$$b'  "$(normalize_env_value 'a$b')"      "normalize_env_value échappe \$"
assert_eq 'x$y'   "$(decode_env_value "$(normalize_env_value 'x$y')")" "round-trip \$ stable"

# _recover_compose_125 : reconnaissance des motifs d'erreur du code 125.
_recover_compose_125 "Error response from daemon: Conflict. The container name \"/assistant-ia-backend\" is already in use by container abc123" >/dev/null 2>&1
assert_rc 0 $? "_recover_compose_125 détecte un conteneur orphelin"

_recover_compose_125 "failed to set up container networking: Failed to Setup IP tables: iptables failed" >/dev/null 2>&1
assert_rc 0 $? "_recover_compose_125 détecte une panne réseau/iptables"

_recover_compose_125 "no such image: assistant-ia-backend:latest" >/dev/null 2>&1
assert_rc 1 $? "_recover_compose_125 ignore une erreur non liée au code 125"

# --------------------------------------------------------------------------
# 3. missing_env_keys / append_missing_env_keys sur des fichiers temporaires
# --------------------------------------------------------------------------
echo "== Dérive .env <-> .env.example =="
TMP_ENV_DIR="$(mktemp -d)"
ENV_EXAMPLE="$TMP_ENV_DIR/.env.example"
ENV_FILE="$TMP_ENV_DIR/.env"
cat > "$ENV_EXAMPLE" <<'EOF'
# Exemple
JWT_SECRET=changeme
PORT=3000
UPDATER_SHARED_TOKEN=changeme
NEW_FLAG=default_value
EOF
cat > "$ENV_FILE" <<'EOF'
JWT_SECRET=abcdef
PORT=3000
EOF

missing="$(missing_env_keys | tr '\n' ' ')"
assert_contains "$missing" "UPDATER_SHARED_TOKEN" "missing_env_keys repère UPDATER_SHARED_TOKEN"
assert_contains "$missing" "NEW_FLAG"             "missing_env_keys repère NEW_FLAG"
if [[ "$missing" != *"JWT_SECRET"* && "$missing" != *"PORT"* ]]; then
  ok "missing_env_keys ignore les clés déjà présentes"
else
  bad "missing_env_keys ignore les clés déjà présentes (a listé une clé existante)"
fi

append_missing_env_keys
after="$(missing_env_keys | tr '\n' ' ')"
assert_eq "" "${after// }" "append_missing_env_keys comble toutes les clés manquantes"
assert_eq "abcdef" "$(grep '^JWT_SECRET=' "$ENV_FILE" | cut -d= -f2)" "append_missing_env_keys ne touche pas une clé existante"
assert_eq "default_value" "$(grep '^NEW_FLAG=' "$ENV_FILE" | cut -d= -f2)" "append_missing_env_keys reprend la valeur d'exemple"

# --------------------------------------------------------------------------
# 4. Câblage du verrou « pièces jointes » dans le backend et le frontend
# --------------------------------------------------------------------------
echo "== Verrou pièces jointes (v1.1.2) =="
grep -q "ATTACHMENTS_TEMPORARILY_DISABLED" "$ROOT_DIR/backend/config/featureFlags.js" \
  && ok "featureFlags.js définit le verrou" || bad "featureFlags.js définit le verrou"
grep -q "ATTACHMENTS_TEMPORARILY_DISABLED" "$ROOT_DIR/backend/routes/chat.js" \
  && ok "chat.js applique le verrou (503)" || bad "chat.js applique le verrou"
grep -q "ATTACHMENTS_TEMPORARILY_DISABLED" "$ROOT_DIR/backend/routes/admin.js" \
  && ok "admin.js refuse la réactivation (423)" || bad "admin.js refuse la réactivation"
grep -q "attachmentsLocked" "$ROOT_DIR/backend/server.js" \
  && ok "/api/branding expose attachmentsLocked" || bad "/api/branding expose attachmentsLocked"
grep -q "attachmentsLocked" "$ROOT_DIR/frontend/src/pages/UserChat.jsx" \
  && ok "UserChat.jsx gère l'état verrouillé" || bad "UserChat.jsx gère l'état verrouillé"
grep -q "ATTACHMENTS_TEMPORARILY_DISABLED" "$ROOT_DIR/doctor.sh" \
  && ok "doctor.sh signale le verrou" || bad "doctor.sh signale le verrou"

# --------------------------------------------------------------------------
# 5. Cohérence des versions
# --------------------------------------------------------------------------
echo "== Cohérence des numéros de version =="
v_root="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$ROOT_DIR/version.json" | sed -E 's/.*"([^"]+)"$/\1/')"
v_back="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$ROOT_DIR/backend/package.json" | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')"
v_front="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$ROOT_DIR/frontend/package.json" | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')"
assert_eq "$v_root" "$v_back"  "backend/package.json aligné sur version.json ($v_root)"
assert_eq "$v_root" "$v_front" "frontend/package.json aligné sur version.json ($v_root)"

# --------------------------------------------------------------------------
# 6. Droits des fichiers (aucun sudo cote serveur) et pieces jointes
# --------------------------------------------------------------------------
echo "== Droits des fichiers et pièces jointes =="
entrypoint="$ROOT_DIR/backend/docker-entrypoint.sh"
[[ -x "$entrypoint" ]] && ok "docker-entrypoint.sh présent et exécutable" || bad "docker-entrypoint.sh absent ou non exécutable"
sh -n "$entrypoint" && ok "docker-entrypoint.sh : syntaxe sh valide" || bad "docker-entrypoint.sh : erreur de syntaxe"
assert_contains "$(cat "$entrypoint")" "setpriv" "l'entrypoint abandonne les droits root (setpriv)"
assert_contains "$(cat "$ROOT_DIR/backend/Dockerfile")" 'ENTRYPOINT ["/app/docker-entrypoint.sh"]' "Dockerfile backend utilise l'entrypoint"
assert_contains "$(cat "$ROOT_DIR/.env.example")" "APP_UID=" ".env.example déclare APP_UID"
assert_contains "$(cat "$ROOT_DIR/install.sh")" 'update_env "APP_UID"' "install.sh renseigne APP_UID"
assert_contains "$(cat "$ROOT_DIR/updater/server.js")" "restoreWorkspaceOwnership" "l'updater rend le projet à son propriétaire"

owner_tmp="$(mktemp -d)"
touch "$owner_tmp/a" "$owner_tmp/b"
owner_ids="$(ROOT_DIR="$owner_tmp" project_owner_ids)"
assert_eq "$(id -u):$(id -g)" "$owner_ids" "project_owner_ids lit le propriétaire du dossier"
assert_eq "0" "$(ROOT_DIR="$owner_tmp" count_foreign_owned_files)" "count_foreign_owned_files : 0 fichier étranger"
rm -rf "$owner_tmp"

assert_contains "$(cat "$ROOT_DIR/backend/config/featureFlags.js")" "ATTACHMENTS_TEMPORARILY_DISABLED = false" "pièces jointes réactivées (verrou levé)"

# --------------------------------------------------------------------------
# 7. Affichage des builds Docker : "failed to get console"
# --------------------------------------------------------------------------
# Docker Compose recent ignore BUILDKIT_PROGRESS : sans COMPOSE_PROGRESS=plain,
# un build dont stdout est redirige depuis un vrai terminal echoue avec
# "failed to get console: provided file is not a console".
echo "== Affichage des builds Docker (failed to get console) =="
for f in install.sh .project-tools.sh; do
  for inherited in "" tty auto plain quiet; do
    got="$(env -u COMPOSE_PROGRESS -u BUILDKIT_PROGRESS ${inherited:+COMPOSE_PROGRESS=$inherited} \
      bash -c "$(grep -E '^case "\$\{(COMPOSE|BUILDKIT)_PROGRESS' "$ROOT_DIR/$f"); echo \"\$COMPOSE_PROGRESS/\$BUILDKIT_PROGRESS\"")"
    case "$inherited" in quiet) want="quiet/plain" ;; *) want="plain/plain" ;; esac
    assert_eq "$want" "$got" "$f : COMPOSE_PROGRESS hérité='${inherited:-vide}' -> $want"
  done
done
assert_contains "$(cat "$ROOT_DIR/updater/server.js")" 'COMPOSE_PROGRESS: process.env.COMPOSE_PROGRESS || "plain"' "l'updater force COMPOSE_PROGRESS"
assert_contains "$(cat "$ROOT_DIR/updater/server.js")" '"COMPOSE_PROGRESS=plain"' "le conteneur auxiliaire de l'updater force COMPOSE_PROGRESS"

# Test reel (optionnel, si Docker Compose et "script" sont disponibles) : build
# sous un pseudo-terminal avec stdout redirige, exactement comme install.sh.
if [[ "${RUN_DOCKER_TESTS:-0}" == "1" ]] && command -v script >/dev/null 2>&1 \
  && PATH="${PATH#"$FAKE_BIN":}" docker compose version >/dev/null 2>&1; then
  ctx="$(mktemp -d)"
  printf 'FROM busybox\nRUN true\n' > "$ctx/Dockerfile"
  printf 'services:\n  t:\n    build: .\n    image: assistant-ia-console-test\n' > "$ctx/docker-compose.yml"
  if [[ "$(uname)" == "Darwin" ]]; then
    tty_run() { script -q /dev/null bash -c "$1"; }
  else
    tty_run() { script -qec "$1" /dev/null; }
  fi
  out="$(PATH="${PATH#"$FAKE_BIN":}" tty_run "source '$ROOT_DIR/.project-tools.sh'; docker compose -f '$ctx/docker-compose.yml' build t >/dev/null; echo rc=\$?" 2>&1)"
  assert_contains "$out" "rc=0" "build réel sous terminal avec stdout redirigé"
  PATH="${PATH#"$FAKE_BIN":}" docker image rm assistant-ia-console-test >/dev/null 2>&1 || true
  rm -rf "$ctx"
fi

# --------------------------------------------------------------------------
rm -rf "$FAKE_BIN" "$TMP_ENV_DIR"
echo
echo "Résultat : ${PASS} ok, ${FAIL} échec(s)."
[[ "$FAIL" -eq 0 ]]
