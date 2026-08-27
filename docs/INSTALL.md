# Guide d'installation

## Prérequis

- **Docker** + **Docker Compose** (`docker --version`, `docker compose version`).
- Une connexion internet au premier démarrage (téléchargement des images Docker et des modèles
  Ollama).
- Machine recommandée : 16 Go de RAM ou plus, processeur récent, espace disque suffisant pour les
  modèles Ollama et les documents indexés (compter plusieurs Go par modèle).

## Installation en une commande

Depuis le dossier du projet :

```bash
cd chemin/vers/fablab-ai
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
6. affiche l'URL de l'application et le mot de passe d'accès initial.

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
- Mot de passe d'accès temporaire rotatif : `./password.sh`.
- Mot de passe enseignant généré automatiquement : affiché une seule fois à la fin de
  l'installation. Le changement est imposé à la première connexion enseignant.

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

## Déploiement sur un serveur distant

Le projet est Docker-first et fonctionne de la même façon sur un VPS Linux, un Mac ou une machine
auto-hébergée : cloner/copier le dossier, ajuster `.env` (notamment `SERVER_BIND_HOST`,
`FRONTEND_ORIGIN`, `COOKIE_SECURE=true` derrière HTTPS), puis `./install.sh`. Placer un reverse
proxy TLS (Caddy, Nginx, Traefik...) devant le port applicatif est recommandé pour toute exposition
publique.
