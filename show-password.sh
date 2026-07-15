#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"

run_local_json() {
  (
    cd "$BACKEND_DIR"
    node scripts/show-access-password.js --json
  )
}

run_docker_exec_json() {
  (
    cd "$PROJECT_DIR"
    docker compose exec -T backend npm run password:current --silent -- --json
  )
}

run_docker_run_json() {
  (
    cd "$PROJECT_DIR"
    docker compose run --rm --no-deps backend npm run password:current --silent -- --json
  )
}

copy_password_if_possible() {
  local password_value="$1"
  if [[ -z "$password_value" ]]; then
    return 1
  fi

  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$password_value" | pbcopy
    echo
    echo "Le mot de passe a ete copie dans le presse-papiers."
    return 0
  fi

  return 1
}

format_remaining() {
  local total_seconds="$1"
  local minutes
  local seconds

  if (( total_seconds < 0 )); then
    total_seconds=0
  fi

  minutes=$(( total_seconds / 60 ))
  seconds=$(( total_seconds % 60 ))
  printf "%02d:%02d" "$minutes" "$seconds"
}

render_output() {
  local json="$1"
  PASSWORD_VALUE="$(printf '%s' "$json" | python3 -c "import json,sys; print(json.load(sys.stdin)['password'])")"
  VALID_FROM_LABEL="$(printf '%s' "$json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['validFromLabel'] + ' (' + d['timeZone'] + ')')")"
  VALID_UNTIL_LABEL="$(printf '%s' "$json" | python3 -c "import json,sys; print(json.load(sys.stdin)['validUntilLabel'])")"
  VALID_UNTIL_EPOCH_MS="$(printf '%s' "$json" | python3 -c "import json,sys; print(json.load(sys.stdin)['validUntilEpochMs'])")"

  printf 'Mot de passe actuel : %s\n' "$PASSWORD_VALUE"
  printf 'Valable a partir de : %s\n' "$VALID_FROM_LABEL"
  printf 'Rotation suivante : %s\n' "$VALID_UNTIL_LABEL"
}

watch_remaining_time() {
  local valid_until_epoch_ms="$1"
  local line_prefix="Temps restant : "
  local now_epoch
  local remaining_seconds

  while true; do
    now_epoch="$(python3 -c 'import time; print(int(time.time() * 1000))')"
    remaining_seconds=$(( (valid_until_epoch_ms - now_epoch + 999) / 1000 ))

    if (( remaining_seconds <= 0 )); then
      printf '\r%s00:00            \n' "$line_prefix"
      break
    fi

    printf '\r%s%s' "$line_prefix" "$(format_remaining "$remaining_seconds")"
    sleep 1
  done
}

run_and_print() {
  local output=""
  local password_value=""

  if ! output="$("$@" 2>&1)"; then
    printf '%s\n' "$output" >&2
    return 1
  fi

  render_output "$output"
  password_value="${PASSWORD_VALUE:-}"
  copy_password_if_possible "$password_value" || true

  if [[ -t 1 ]]; then
    watch_remaining_time "${VALID_UNTIL_EPOCH_MS:-0}"
  else
    local now_epoch
    local remaining_seconds
    now_epoch="$(python3 -c 'import time; print(int(time.time() * 1000))')"
    remaining_seconds=$(( (${VALID_UNTIL_EPOCH_MS:-0} - now_epoch + 999) / 1000 ))
    printf 'Temps restant : %s\n' "$(format_remaining "$remaining_seconds")"
  fi

  return 0
}

if [[ -d "$BACKEND_DIR/node_modules" ]]; then
  if run_and_print run_local_json; then
    exit 0
  fi
fi

if command -v docker >/dev/null 2>&1; then
  if run_and_print run_docker_exec_json; then
    exit 0
  fi

  if run_and_print run_docker_run_json; then
    exit 0
  fi
fi

echo "Impossible d'afficher le mot de passe admin." >&2
echo "Installez les dependances du backend avec 'cd \"$BACKEND_DIR\" && npm install' ou demarrez Docker Compose." >&2
exit 1
