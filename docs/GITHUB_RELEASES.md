# Mises à jour via GitHub Releases

Les mises à jour sont lues depuis les [GitHub Releases](https://github.com/AymericMillot/assistant-ia/releases/latest)
du dépôt défini dans `update.config.json` (`server.repository`).

## Prérequis côté dépôt

- Le dépôt **doit exister, être public et porter exactement le nom** configuré dans
  `update.config.json`. Les installations téléchargent les archives sans jeton GitHub ; un dépôt
  privé ou mal nommé renvoie `404` et **aucune mise à jour n'est possible** (le service se rabat
  silencieusement sur une reconstruction locale — `./update.sh --check-only` sort alors en erreur
  et `./doctor.sh --check-only` signale le problème).
- Après un renommage du dépôt sur GitHub, mettez à jour `repository` **et** `latestReleaseUrl`
  dans `update.config.json`.

## Contenu d'une release valide

Une release valide contient :

- le tag `v<version>` (identique à `version.json`) ;
- l'archive `fablab-ai-v<version>.tar.gz` ;
- le manifest `fablab-ai-v<version>.manifest.json`, qui contient le `sha256` (64 hexadécimaux)
  et `packageFile` ;
- les notes `fablab-ai-v<version>.notes.md`.

Le préfixe `fablab-ai` provient de la variable `UPDATE_PROJECT_NAME` (voir plus bas) et **non**
du nom du dossier. Il doit rester aligné avec `packageFileTemplate` / `manifestFileTemplate` de
`update.config.json`.

Le service de mise à jour **ignore** une release si :

- le tag n'est pas de la forme `vX.Y` ; ou
- c'est un brouillon ou une prérelease ; ou
- le manifest est absent, ou son `version` ne correspond pas au tag ; ou
- le `sha256` du manifest n'a pas le format attendu (64 hexadécimaux) ; ou
- l'archive nommée par le manifest est absente des assets.

À l'application, le SHA-256 de l'archive téléchargée est recalculé et comparé au manifest : toute
divergence annule la mise à jour.

## Publier une version

1. Mettez à jour `version.json` et `release-notes.txt`.
2. Validez les changements dans un commit (l'arbre de travail doit être propre).
3. Lancez `./publish-release.sh` (ou `./publish-release.sh --dry-run` pour vérifier sans taguer).

Le script construit les archives, vérifie le SHA-256, puis crée et pousse le tag `v<version>`.
Le workflow `.github/workflows/release.yml` crée alors la GitHub Release et y joint les quatre
fichiers. Le workflow fixe `UPDATE_PROJECT_NAME: fablab-ai` : c'est indispensable car
`actions/checkout` extrait le dépôt dans un dossier portant le nom du dépôt, et sans cette
variable `export.sh` nommerait l'archive d'après ce nom.

## Appliquer une mise à jour

- En ligne de commande : `./update.sh` (nécessite `rsync`, `curl`, `tar` sur l'hôte).
- Depuis l'interface d'administration : onglet **Mises à jour**. Le conteneur `updater` écrit
  alors dans l'arborescence du projet ; **sur un hôte Linux natif, les fichiers de code
  deviennent la propriété de `root`**. Si vous utilisez ensuite `git` ou `./update.sh` en tant
  qu'utilisateur normal et que cela échoue :
  `sudo chown -R $USER:$USER .` (ou laissez `./doctor.sh` le proposer).

Dans tous les cas, `.env`, `update.config.json`, `backend/uploads`, `backend/logs` et
`backend/data` sont préservés (`apply.preservePaths`).

## Limite de l'API GitHub

Le service de mise à jour interroge `api.github.com` **sans authentification** : ~60 requêtes par
heure et par adresse IP. Derrière un NAT partagé (plusieurs installations sur la même sortie
Internet), la vérification peut être temporairement refusée (`403 rate limit`). C'est sans
conséquence : la vérification reprend automatiquement, et `./update.sh` continue de fonctionner
avec les fichiers locaux entre-temps.

## Diagnostic

```bash
./update.sh --check-only        # état du canal ; code de sortie ≠ 0 si la vérification a échoué
./test-update-source.sh         # télécharge l'archive distante et vérifie son SHA-256, sans appliquer
./doctor.sh --check-only        # rsync/curl/tar, accès au dépôt, releases publiées, fichiers root
```

`update.config.json` accepte un champ optionnel `server.apiBaseUrl` (vide par défaut) pour
pointer l'API vers un miroir ou un environnement de test.
