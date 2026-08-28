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

Les **assets** d'une release contiennent uniquement le **code source** :

- `assistant-ia-v<version>.tar.gz`
- `assistant-ia-v<version>.zip`

Le tag est de la forme `v<version>` (semver, identique à `version.json`). Le **SHA-256** de
l'archive `.tar.gz` est publié **dans le corps (description) de la release**, sous la forme :

```
sha256 (assistant-ia-v<version>.tar.gz): <64 caractères hexadécimaux>
```

Il n'y a **pas** de fichier `.manifest.json` ni `.notes.md` en asset.

Le préfixe `assistant-ia` provient de la variable `UPDATE_PROJECT_NAME` et **non** du nom du
dossier. Il doit rester aligné avec `packageFileTemplate` de `update.config.json`.

Le service de mise à jour **ignore** une release si :

- le tag n'est pas de la forme `vX.Y.Z` ; ou
- c'est un brouillon ou une prérelease ; ou
- l'archive `.tar.gz` du code source est absente des assets ; ou
- `requireSha256` est `true` (par défaut) et aucune empreinte `sha256` de 64 hexadécimaux n'est
  trouvée dans le corps de la release.

À l'application, le SHA-256 de l'archive téléchargée est recalculé et comparé à celui publié
dans la release : toute divergence annule la mise à jour.

## Publier une version

1. Mettez à jour `version.json` (`vX.X.X`) et `release-notes.txt`.
2. Validez les changements dans un commit (l'arbre de travail doit être propre).
3. Lancez `./publish-release.sh` (ou `./publish-release.sh --dry-run` pour vérifier sans taguer).

Le script construit les archives, vérifie le SHA-256, puis crée et pousse le tag `v<version>`.
Le workflow `.github/workflows/release.yml` crée alors la GitHub Release, calcule le SHA-256,
l'écrit dans le corps de la release et joint les deux archives du code source. Le workflow fixe
`UPDATE_PROJECT_NAME: assistant-ia` : c'est indispensable car `actions/checkout` extrait le
dépôt dans un dossier portant le nom du dépôt, et sans cette variable `export.sh` nommerait
l'archive d'après ce nom.

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

### Plafond quotidien intégré

Le conteneur `updater` **plafonne lui-même** ses appels à l'API GitHub :

- au plus **`UPDATE_GITHUB_MAX_CALLS_PER_DAY`** appels réels par période de 24 h (UTC), défaut **10** ;
- le résultat est mis en cache sur disque (`.update-release-cache.json`, préservé lors des mises à
  jour) et **resservi** à toutes les sources — polling de l'admin, page publique `/release`,
  vérification planifiée — sans nouvel appel réseau ;
- entre deux appels réels, un intervalle minimal de `24 h ÷ plafond` (~2,4 h pour 10) est respecté ;
- quand le plafond est atteint ou que GitHub est injoignable, la dernière liste connue est servie
  telle quelle (marquée « périmée » dans l'état de l'updater) au lieu de réessayer en boucle.

Pour relever franchement la limite (déploiements multiples derrière la même IP), définissez
**`UPDATE_GITHUB_TOKEN`** dans `.env` (scope `public_repo` suffit) puis `./restart.sh` : le quota
GitHub passe de 60 à 5000 requêtes/heure.

## Diagnostic

```bash
./update.sh --check-only        # état du canal ; code de sortie ≠ 0 si la vérification a échoué
./test-update-source.sh         # télécharge l'archive du code source et vérifie le SHA-256 du corps de release
./doctor.sh --check-only        # rsync/curl/tar/sha256, accès au dépôt, releases publiées, fichiers root
```

`update.config.json` accepte un champ optionnel `server.apiBaseUrl` (vide par défaut) pour
pointer l'API vers un miroir ou un environnement de test.
