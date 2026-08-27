# Mises à jour via GitHub Releases

Les mises à jour sont lues depuis les [GitHub Releases](https://github.com/AymericMillot/assistant-ia/releases/latest)
du dépôt défini dans `update.config.json`. Une release valide contient :

- le tag `v<version>` ;
- l'archive `fablab-ai-v<version>.tar.gz` ;
- le manifest `fablab-ai-v<version>.manifest.json`, qui contient le SHA-256 ;
- les notes `fablab-ai-v<version>.notes.md`.

Le service de mise à jour refuse toute archive absente du manifest ou dont le SHA-256 ne correspond
pas. Les brouillons et préreleases GitHub sont ignorés.

## Publier une version

1. Mettez à jour `version.json` et `release-notes.txt`.
2. Validez les changements dans un commit.
3. Lancez `./publish-release.sh`.

Le script pousse le tag `v<version>`. Le workflow GitHub Actions crée alors automatiquement la
release et joint les quatre fichiers requis.

Le dépôt qui héberge les releases doit être **public** : les installations téléchargent les
archives directement et ne reçoivent aucun jeton GitHub.
