# Guide de configuration

## Fichiers de configuration

| Fichier | Rôle | Versionné dans git ? |
|---|---|---|
| `.env` | Variables d'environnement (ports, URLs des services, secrets) | Non (`.gitignore`) — copier depuis `.env.example` |
| `.env.example` | Modèle documenté de `.env`, valeurs par défaut génériques | Oui |
| `backend/config/branding.default.json` | Branding générique par défaut (nom, textes, périmètre) | Oui |
| `backend/data/branding.json` | Branding effectif de cette instance (écrase les valeurs par défaut) | Non — généré à l'installation ou via l'admin |
| `backend/config/modelCatalog.js` | Catalogue statique de modèles suggérés (filet de sécurité) | Oui |
| `backend/data/model-catalog-cache.json` | Catalogue actualisé automatiquement (si une source distante est configurée) | Non |

## Variables d'environnement principales

Voir `.env.example` pour la liste complète et à jour, commentée par section. Points clés :

- **Secrets** (`JWT_SECRET`, `APP_PASSWORD_SEED`, `CONFIG_ENCRYPTION_KEY`) : générer des valeurs
  uniques et privées, ne jamais réutiliser les exemples.
- **Secrets locaux** : générés localement à l'installation, hachés avec bcrypt en base
  lorsqu'ils servent à l'authentification et jamais inclus dans un export.
- **Services** (`OLLAMA_URL`, `CHROMA_URL`, `REDIS_URL`) : par défaut pointent vers les noms de
  service Docker Compose (`ollama`, `chromadb`, `redis`) — à ajuster seulement en dehors de Docker.
- **`MODEL_CATALOG_SOURCE_URL`** : URL optionnelle d'un catalogue JSON distant (même forme que
  `backend/config/modelCatalog.js`) pour l'actualisation hebdomadaire automatique. Vide par défaut :
  le catalogue statique embarqué fait foi.
- **`DEPLOY_FTP_*`** : identifiants de secours pour la publication de mises à jour ; préférer les
  configurer depuis l'admin (page "Export et déploiement"), où ils sont chiffrés en base.

## Branding

`backend/config/branding.js` fusionne `branding.default.json` (générique, versionné) avec
`backend/data/branding.json` (spécifique à l'instance, généré à l'installation ou modifiable
depuis l'admin, onglet "Identité"). Champs disponibles :

| Champ | Effet |
|---|---|
| `projectName` | Nom affiché dans l'en-tête |
| `shortName` | Utilisé dans "Posez une question. {shortName} répond." |
| `welcomeMessage` | Texte de présentation sur la page d'accueil du chat |
| `supportEmail` | Adresse affichée dans le bloc de contact — service informatique (vide = pas de lien mailto) |
| `supportEmailUrgent` | Adresse affichée dans le bloc de contact — soucis majeur (vide = pas de lien mailto) |
| `repositoryUrl` | Lien vers le dépôt du projet (optionnel) |

La réponse à « qui t'a créé ? » est fixe (`backend/services/ragService.js`) et ne dépend pas du
branding : elle mentionne toujours Aymeric Millot et aymericmillot.com, quelle que soit
l'organisation qui déploie l'assistant.

Ces valeurs peuvent être éditées sans redémarrage depuis l'admin (`/admin`, onglet "Identité"),
ou en modifiant directement `backend/data/branding.json`.

## Multi-modèles

Trois rôles de modèle sont configurables indépendamment depuis l'admin (onglet "Modèles") :
texte (principal), image (optionnel) et raisonnement (optionnel). Chaque modèle du catalogue est
tagué avec un `provider` (affiché avec un drapeau français pour Mistral) et un `roleHint`. Le
routage automatique d'une question vers le modèle le plus adapté n'est pas implémenté : le modèle
"texte" reste utilisé pour toutes les réponses du chat tant qu'un routage n'est pas ajouté.

## Sécurité des secrets

`CONFIG_ENCRYPTION_KEY` chiffre (AES-256-GCM) les valeurs sensibles stockées en base (identifiants
FTP de déploiement). Sans cette variable, ces champs ne peuvent pas être enregistrés depuis
l'admin — les variables `DEPLOY_FTP_*` de `.env` restent alors le seul moyen de les configurer.

Le backend refuse désormais de démarrer avec un secret principal absent, prévisible ou inférieur à
32 caractères. `install.sh` les génère automatiquement et `doctor.sh` sait détecter/réparer les
configurations anciennes. Sauvegardez `.env` de manière sécurisée : changer
`CONFIG_ENCRYPTION_KEY` rendrait les secrets déjà chiffrés illisibles.

## Publier ses propres mises à jour (fork)

`update.config.json` contient l'URL du serveur de mise à jour utilisé par `./update.sh` et
l'admin. Cette valeur est volontairement fixe (pas de prompt à l'installation) : si vous forkez ce
projet pour votre propre déploiement, remplacez-la par votre propre serveur avant de publier des
mises à jour, sinon les instances de votre fork tenteraient de lire le serveur du projet d'origine.
