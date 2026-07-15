#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_HELP_FILE="$ROOT_DIR/docs/help.html"
REMOTE_HELP_URL="https://maj.aymericmillot.com/iutlab/help.html"

show_help() {
  cat <<EOF
Usage:
  ./help.sh

Ouvre la page d'aide du projet (documentation, dépannage, problèmes connus).
Essaie dans l'ordre :
  1. La version en ligne (toujours à jour) si un navigateur est disponible.
  2. La copie locale embarquée (docs/help.html) si hors-ligne.
  3. Un affichage texte dans le terminal si aucun navigateur n'est disponible
     (connexion distante sans interface graphique).
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  show_help
  exit 0
fi

can_open_browser() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin)
      command -v open >/dev/null 2>&1
      ;;
    Linux)
      [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]] && command -v xdg-open >/dev/null 2>&1
      ;;
    MINGW*|MSYS*|CYGWIN*)
      command -v cmd.exe >/dev/null 2>&1
      ;;
    *)
      return 1
      ;;
  esac
}

open_url() {
  local url="$1"
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin) open "$url" >/dev/null 2>&1 || return 1 ;;
    Linux) xdg-open "$url" >/dev/null 2>&1 || return 1 ;;
    MINGW*|MSYS*|CYGWIN*) cmd.exe /c start "" "$url" >/dev/null 2>&1 || return 1 ;;
    *) return 1 ;;
  esac
}

# Convertit la page d'aide (HTML) en texte lisible pour un terminal, quand
# aucun navigateur n'est disponible (session SSH sans interface graphique).
print_terminal_fallback() {
  echo "Aucun navigateur disponible sur cette machine (session distante/sans affichage)."
  echo
  echo "-> Consultez la documentation depuis un autre appareil :"
  echo "   $REMOTE_HELP_URL"
  echo

  if [[ ! -f "$LOCAL_HELP_FILE" ]]; then
    return 0
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    echo "(python3 indisponible : ouvrez $LOCAL_HELP_FILE directement dans un navigateur.)"
    return 0
  fi

  echo "Aperçu texte de l'aide embarquée :"
  echo "-------------------------------------------------------------"

  local rendered
  rendered="$(python3 - "$LOCAL_HELP_FILE" <<'PYEOF'
import html as htmlmod
import re
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    content = f.read()

content = re.sub(r"(?is)<(script|style).*?>.*?</\1>", "", content)
content = re.sub(r"(?is)<br\s*/?>", "\n", content)
content = re.sub(r"(?is)</(p|div|li|h[1-6]|section|tr|details)>", "\n", content)
content = re.sub(r"(?is)<li[^>]*>", "  - ", content)
content = re.sub(r"(?is)<h([1-3])[^>]*>", lambda m: "\n" + "#" * int(m.group(1)) + " ", content)
content = re.sub(r"(?is)<summary[^>]*>", "\n### ", content)
content = re.sub(r"(?is)<[^>]+>", "", content)

text = htmlmod.unescape(content)
lines = [line.rstrip() for line in text.splitlines()]

out = []
blank = False
for line in lines:
    stripped = line.strip()
    if not stripped:
        if not blank:
            out.append("")
        blank = True
    else:
        out.append(stripped)
        blank = False

print("\n".join(out).strip())
PYEOF
)"

  if command -v less >/dev/null 2>&1; then
    printf '%s\n' "$rendered" | less -R
  else
    printf '%s\n' "$rendered"
  fi
}

# 1. Version en ligne (toujours a jour) si un navigateur est disponible.
if can_open_browser; then
  if command -v curl >/dev/null 2>&1 && curl -sf --max-time 4 -o /dev/null "$REMOTE_HELP_URL" 2>/dev/null; then
    echo "Ouverture de la documentation en ligne : $REMOTE_HELP_URL"
    if open_url "$REMOTE_HELP_URL"; then
      exit 0
    fi
  fi

  # 2. Copie locale embarquee si la version en ligne est injoignable.
  if [[ -f "$LOCAL_HELP_FILE" ]]; then
    echo "Documentation en ligne injoignable : ouverture de la copie locale."
    if open_url "file://$LOCAL_HELP_FILE"; then
      exit 0
    fi
  fi

  echo "Impossible d'ouvrir un navigateur, et aucune copie locale disponible." >&2
  exit 1
fi

# 3. Aucun navigateur : affichage terminal.
print_terminal_fallback
