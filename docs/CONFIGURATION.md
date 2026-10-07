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

- **Secrets** (`JWT_SECRET`, `CONFIG_ENCRYPTION_KEY`) : générer des valeurs
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
- **`OLLAMA_MAX_LOADED_MODELS`** (défaut 2) : garde le modèle de conversation et le modèle
  d'embedding chargés ensemble. Avec 1, chaque question décharge puis recharge le modèle de
  conversation (plusieurs secondes perdues). Ollama ne garde deux modèles que s'ils tiennent en
  mémoire.
- **`RAG_QUERY_EXPANSION_MAX_TOKENS` / `RAG_QUERY_EXPANSION_TIMEOUT_MS`** : bornent l'étape de
  reformulation de la question (un appel au modèle avant chaque réponse) ; au-delà du délai, la
  recherche continue avec la question d'origine.
- **`LOG_MAX_SIZE_MB` / `LOG_MAX_FILES`** : rotation de `app.log`, `error.log` et `indexation.log`.
- Réglages avancés, rarement utiles : `SQLITE_BUSY_TIMEOUT_MS` (attente du verrou SQLite, 5000),
  `SSE_HEARTBEAT_INTERVAL_MS` (commentaire envoyé pendant les longues attentes du chat pour que les
  proxys ne coupent pas le flux, 15000), `SHUTDOWN_GRACE_MS` (délai d'arrêt propre, 7000),
  `OLLAMA_METADATA_TIMEOUT_MS` (délai des appels `/api/tags` et `/api/show`, 15000),
  `RAG_EMBEDDING_MAX_RETRIES` (nouveaux essais d'embedding, 2), `INDEXING_PROGRESS_MIN_INTERVAL_MS`
  (fréquence maximale des notifications de progression d'indexation, 400).

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

### Modèle d'image : indexation visuelle des PDF

Le modèle "image" doit savoir lire les images (ex : `gemma3:4b`, `qwen2.5vl:7b`, `llava:7b`,
`mistral-small3.1`) ; l'admin refuse un modèle qui déclare ne pas en être capable. À l'indexation
d'un PDF, les pages contenant des images utiles (photos, schémas, plans, captures, pictogrammes) ou
quasiment sans texte (scans, plans vectoriels) sont rendues en image et décrites par ce modèle :
légendes, valeurs et cotes lisibles, étapes, relations entre éléments, transcription des pages
scannées. Chaque description devient un extrait du document (« Contenu visuel — page N »), retrouvé
par la recherche et cité comme source comme le reste du PDF.

- Sans modèle "image", le modèle de conversation est utilisé s'il sait lire les images ; sinon le
  PDF est indexé avec son seul texte, comme avant.
- Les logos et fonds répétés sur de nombreuses pages, les masques et les vignettes sont ignorés.
  `PDF_VISION_ALL_PAGES=true` force l'analyse de toutes les pages.
- Les descriptions sont mises en cache (contenu du fichier + modèle + page) : une réindexation
  complète ou un changement de modèle d'embedding ne relance pas la vision.
- Comptez de quelques secondes (GPU) à une ou deux minutes (CPU) par page analysée ; la progression
  « analyse des images » est visible dans l'onglet Index, et le chat reste prioritaire.

## Fenêtre de contexte et mémoire de conversation

Chaque modèle reçoit sa propre fenêtre de contexte (`num_ctx`), lue dans ses métadonnées Ollama :
son maximum, borné par la mémoire nécessaire à son cache KV (`OLLAMA_MEMORY_BUDGET_GB`, 60 % de la
RAM par défaut) et par `OLLAMA_AUTO_CTX_MAX` (32 768 par défaut). `OLLAMA_NUM_CTX` impose un plafond
explicite. L'onglet Modèles affiche le maximum et la fenêtre réellement utilisée.

À chaque question, le prompt est ajusté à la fenêtre du modèle qui répond (texte ou raisonnement) :
consignes et question intactes, dernier échange toujours conservé, extraits documentaires et
pièces jointes répartis dans la place restante, messages récents repris mot pour mot (jusqu'à
`CHAT_HISTORY_LIMIT`), échanges plus anciens résumés plutôt qu'oubliés. Les questions qui renvoient
à la conversation (« reprends l'étape 2 », « comment je m'appelle ? », « elle consomme combien ? »)
reçoivent l'historique complet ; un vrai changement de sujet ne reçoit que le résumé. La jauge sous
le chat affiche l'occupation réelle de la fenêtre.

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

## Skills, sauvegardes et signaux d'évaluation

| Variable | Rôle | Défaut |
|---|---|---|
| `SKILL_AUTO_MIN_SCORE` | Score minimal pour appliquer un skill automatique sans déclencheur | `0.6` |
| `SKILL_AUTO_MAX_PER_ANSWER` | Nombre maximal de skills automatiques par réponse | `2` |
| `SKILL_PROMPT_MAX_CHARS` / `SKILL_PROMPT_TOTAL_MAX_CHARS` | Taille des instructions de skills injectées (par skill / au total) | `6000` / `12000` |
| `BACKUP_DIR` | Dossier des sauvegardes | `data/backups` |
| `BACKUP_UPLOAD_MAX_BYTES` | Taille maximale d'une archive déposée pour restauration | 4 Go |
| `RATING_SIGNALS_ENABLED` | `false` pour ne plus utiliser les 👍/👎 anonymes comme exemples dans le prompt | `true` |
| `CHAT_SUGGESTION_MIN_CONVERSATIONS` | Nombre de conversations distinctes avant qu'une question soit suggérée automatiquement | `3` |
| `JSON_BODY_LIMIT` | Taille maximale d'un corps JSON | `2mb` |

Un skill est un fichier `SKILL.md` : en-tête entre deux lignes `---` (`title`, `description`,
`activation: auto|always|manual`, `user_selectable`, liste `triggers`), puis les instructions en
Markdown. Un `.zip` peut contenir plusieurs dossiers de skills ; les autres fichiers `.md` d'un dossier
sont ajoutés comme références. Les sauvegardes ne contiennent pas l'index vectoriel (reconstruit
après restauration) ; les secrets chiffrés ne se restaurent que sur une instance utilisant la même
`CONFIG_ENCRYPTION_KEY`.
