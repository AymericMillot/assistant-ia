# Guide d'installation

## Prérequis

- **Docker** + **Docker Compose v2** (`docker --version`, `docker compose version`).
- **`git`, `curl`, `tar`, `gzip`** — présents par défaut sur la plupart des systèmes.
- **`rsync`** — requis par `./update.sh` (mise à jour distante) et par `./install.sh --vX.XXX`
  (installation d'une version précise). **Absent des images cloud Debian/Ubuntu minimales et
  d'Alpine** : installez-le explicitement (`sudo apt-get install -y rsync`). L'installation de
  base fonctionne sans, mais les mises à jour non.
- Une connexion internet au premier démarrage (téléchargement des images Docker et des modèles
  Ollama).
- Machine recommandée : 16 Go de RAM ou plus, processeur récent, espace disque suffisant pour les
  modèles Ollama et les documents indexés (compter plusieurs Go par modèle).

`./doctor.sh --check-only` vérifie tous ces prérequis (dont `rsync` et l'accès au dépôt de
mises à jour) sans rien modifier.

## Récupérer le projet sur une machine Linux

Le projet **n'a pas d'installateur `curl | bash`** : il faut d'abord poser les fichiers, puis
lancer `./install.sh`.

### Option A — `git clone` (recommandé)

`./update.sh` conserve le dossier `.git` : cloner permet aussi de suivre les correctifs avec
`git pull`.

```bash
sudo apt-get update && sudo apt-get install -y git rsync
git clone https://github.com/AymericMillot/assistant-ia.git
cd assistant-ia
chmod +x *.sh
./install.sh                 # ou ./install.sh --non-interactive
```

### Option B — archive d'une release (`wget`)

Les archives de release portent la version dans leur nom (`assistant-ia-v<version>.tar.gz`) : il
n'existe **pas** d'URL « latest » stable pour `wget`. Récupérez d'abord le numéro de version,
puis l'archive correspondante :

```bash
sudo apt-get update && sudo apt-get install -y curl tar rsync
repo=AymericMillot/assistant-ia
ver=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | grep -o '"tag_name": *"[^"]*"' | sed 's/.*"v\{0,1\}\([^"]*\)"$/\1/')
wget "https://github.com/$repo/releases/download/v$ver/assistant-ia-v$ver.tar.gz"
tar -xzf "assistant-ia-v$ver.tar.gz"
cd assistant-ia
chmod +x *.sh
./install.sh --non-interactive
```

L'archive ne contient ni `.env`, ni `backend/data`, ni les `node_modules` : `install.sh` génère
le `.env` et les secrets au premier lancement.

## Installation en une commande

Depuis le dossier du projet :

```bash
chmod +x install.sh doctor.sh update.sh restart.sh stop.sh
./install.sh
```

`install.sh` :

1. crée `.env` à partir de `.env.example` si absent,
2. vérifie que Docker est installé et que le daemon tourne (sinon affiche comment l'installer/le
   démarrer selon l'OS détecté),
3. génère les secrets de sécurité nécessaires lorsqu'ils sont absents,
4. protège `.env` avec des permissions `600`, construit les images et démarre tous les services,
5. attend qu'Ollama soit prêt, télécharge le modèle par défaut (`DEFAULT_MODEL`) et le modèle
   d'embedding (`EMBEDDING_MODEL`),
6. affiche l'URL de l'application et les identifiants du compte administrateur initial.

En environnement non interactif (CI, serveur sans terminal attaché), utilisez :

```bash
./install.sh --non-interactive
```

Toutes les questions sont alors sautées. Les valeurs fonctionnelles par défaut sont utilisées et
les secrets manquants sont générés localement et enregistrés uniquement dans le fichier `.env`
protégé. Ne placez jamais de secret dans le dépôt ou dans une archive.

## Après l'installation

- Application : `http://localhost:3000` (ou l'IP de la machine sur le réseau local, voir plus
  bas).
- Administration : `http://localhost:3000/admin`.
- Compte administrateur initial : ses identifiants sont affichés une seule fois à la fin de
  l'installation. Créez ensuite les comptes Référent et Administrateur depuis l'administration.

## Personnalisation

Voir [CONFIGURATION.md](CONFIGURATION.md) pour le détail des variables d'environnement et du
fichier de branding (`backend/data/branding.json`) qui pilote le nom du projet, les textes
affichés et le périmètre de la bride thématique.

## Accès depuis le réseau local

Depuis un autre appareil du même réseau : `http://IP_DE_LA_MACHINE:3000`. Récupérer l'IP locale :

```bash
# macOS
ipconfig getifaddr en0
# Linux
hostname -I
# Windows
ipconfig
```

Autorisez le port `3000` dans le pare-feu si besoin. Pour restreindre l'administration au réseau
local uniquement : `ADMIN_ACCESS_MODE=local` dans `.env`.

## Ports exposés

Seul le port applicatif (`PORT`, `3000` par défaut) est publié sur l'hôte. Ollama, ChromaDB et
Redis ne communiquent que via le réseau Docker interne — ne les exposez pas publiquement.

## Problèmes courants

Commencez toujours par `./doctor.sh --check-only` pour un diagnostic sans modification, ou
`./doctor.sh` pour proposer les réparations sûres. Le mode `./doctor.sh --yes` est réservé aux
interventions non interactives car il accepte les corrections proposées.

| Symptôme | Cause probable | Solution |
|---|---|---|
| `docker: command not found` | Docker non installé | Installer Docker Desktop (Mac/Windows) ou Docker Engine (Linux) |
| `Cannot connect to the Docker daemon` | Docker installé mais pas démarré | Démarrer Docker Desktop ou `sudo systemctl start docker` |
| Port `3000` déjà utilisé | Un autre service occupe le port | Changer `PORT` dans `.env` puis relancer `docker compose up -d` |
| Ollama ne répond pas après l'installation | Modèle encore en cours de téléchargement | Vérifier `docker compose logs -f ollama` |
| Page admin bloquée en local uniquement | `ADMIN_ACCESS_MODE=local` actif alors qu'on accède depuis un autre poste | Repasser à `ADMIN_ACCESS_MODE=any` si l'accès distant est voulu |
| `rsync: command not found` pendant `./update.sh` | `rsync` absent (image Linux minimale) | `sudo apt-get install -y rsync` puis relancer |
| `./update.sh` dit « à jour » alors qu'une release existe | Canal de mise à jour cassé (dépôt renommé/privé, quota API) | `./update.sh --check-only` (sort en erreur si la vérification a échoué) puis `./doctor.sh --check-only` |
| Après une mise à jour via l'interface web, `git`/`./update.sh` échouent | Fichiers du projet devenus la propriété de `root` | `sudo chown -R $USER:$USER .` (ou laisser `./doctor.sh` le proposer) |

## Mettre à jour

```bash
./update.sh --check-only   # état du canal distant ; code de sortie ≠ 0 si la vérification échoue
./update.sh                # applique la mise à jour distante, ou reconstruit localement à défaut
```

Le mécanisme complet (GitHub Releases, SHA-256 dans la description de la release, `preservePaths`) est décrit dans
[GITHUB_RELEASES.md](GITHUB_RELEASES.md). Points clés :

- le dépôt de `update.config.json` (`repository`) doit **exister, être public et porter ce nom
  exact** ; sinon chaque vérification renvoie `404` et `./update.sh` se rabat sur une
  reconstruction locale ;
- `.env`, `backend/data`, `backend/uploads`, `backend/logs` sont toujours préservés ;
- l'API GitHub non authentifiée est limitée à ~60 requêtes/heure et par IP : derrière un NAT
  partagé, la vérification peut être temporairement refusée (`403`), sans conséquence — elle
  reprend d'elle-même.

## Déploiement sur un serveur distant

Le projet est Docker-first et fonctionne de la même façon sur un VPS Linux, un Mac ou une machine
auto-hébergée : cloner/copier le dossier, ajuster `.env` (notamment `SERVER_BIND_HOST`,
`FRONTEND_ORIGIN`, `COOKIE_SECURE=true` derrière HTTPS), puis `./install.sh`. Placer un reverse
proxy TLS (Caddy, Nginx, Traefik...) devant le port applicatif est recommandé pour toute exposition
publique.
