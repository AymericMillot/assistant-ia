# Assistant IA

Assistant IA local pour un atelier, makerspace ou tout environnement technique, sous licence MIT.

Ce projet permet de poser des questions a une IA locale, d'ajouter des documents internes, puis d'obtenir des reponses orientees par ces documents et par les consignes definies dans l'administration. Le nom du projet, les textes affiches et le perimetre thematique sont personnalisables (voir [docs/CONFIGURATION.md](docs/CONFIGURATION.md)) — l'exemple ci-dessous reste generique, chaque instance peut se presenter sous son propre nom.

## A quoi sert le projet

Le projet sert a :

- discuter avec un assistant IA en francais
- ajouter des documents internes propres a votre structure
- retrouver rapidement des consignes, procedures, cours ou ressources
- personnaliser le comportement, le nom et le perimetre de l'assistant depuis l'admin
- garder toutes les donnees en local sur votre machine ou votre serveur

L'assistant utilise :

- Ollama pour faire tourner le modele IA en local
- ChromaDB pour stocker les donnees vectorielles
- SQLite pour la configuration et les informations du projet
- Docker pour lancer facilement tous les services

## Avant de deployer

Avant de lancer le projet, il faut verifier que les outils suivants sont installes.

### 1. Docker

Docker est obligatoire.

Il sert a lancer :

- le backend
- Ollama
- ChromaDB
- Redis
- les services internes du projet

Pour verifier :

```bash
docker --version
```

### 2. Docker Compose

Le projet utilise `docker compose`.

Pour verifier :

```bash
docker compose version
```

### 3. npm / Node.js

`npm` n'est pas obligatoire pour utiliser le projet une fois Docker installe.

En revanche, c'est utile si tu veux :

- developper le projet
- lancer des builds manuels
- verifier certains fichiers localement

Pour verifier :

```bash
node -v
npm -v
```

### 4. Connexion internet au premier demarrage

Une connexion internet est necessaire au premier lancement pour :

- telecharger les images Docker
- telecharger les modeles Ollama

Ensuite, le projet peut fonctionner localement.

### 5. Machine recommandee

Configuration conseillee :

- 16 Go de RAM ou plus
- processeur correct recent
- assez d'espace disque pour les modeles Ollama et les documents

## Structure rapide du projet

```text
assistant-ia/
├── docker-compose.yml
├── .env.example
├── install.sh
├── export.sh
├── update.sh
├── restart.sh
├── stop.sh
├── README.md
├── backend/
└── frontend/
```

Les dossiers importants sont :

- `backend/uploads` : documents importes
- `backend/data` : base SQLite et donnees internes
- `backend/logs` : logs

## Demarrage rapide avec install.sh

Si tu veux la methode la plus simple, utilise `install.sh`.

### Linux / macOS, depuis GitHub

```bash
sudo apt-get update && sudo apt-get install -y git rsync   # rsync : requis par update.sh
git clone https://github.com/AymericMillot/assistant-ia.git
cd assistant-ia
chmod +x *.sh
./install.sh
```

`rsync` est **absent des images cloud Debian/Ubuntu minimales et d'Alpine** : sans lui,
l'installation de base fonctionne mais `./update.sh` échoue. `./doctor.sh --check-only` vérifie
ce prérequis. Détails et méthode par archive `wget` : [docs/INSTALL.md](docs/INSTALL.md).

### Linux, installer la dernière version depuis les Releases GitHub

Page de la dernière version : <https://github.com/AymericMillot/assistant-ia/releases/latest>

Chaque release attache `assistant-ia-vX.X.X.tar.gz` et écrit son SHA-256 dans la description.
Pour installer sur un serveur Linux sans cloner le dépôt (remplacer `vX.X.X` par la version
affichée sur la page ci-dessus) :

```bash
VERSION=v1.1.0
curl -fL -o assistant-ia-$VERSION.tar.gz \
  https://github.com/AymericMillot/assistant-ia/releases/download/$VERSION/assistant-ia-$VERSION.tar.gz
# vérifier l'intégrité avec le SHA-256 publié dans la description de la release :
# echo "<sha256 de la release>  assistant-ia-$VERSION.tar.gz" | sha256sum -c
tar xzf assistant-ia-$VERSION.tar.gz
cd assistant-ia-$VERSION
chmod +x *.sh
./install.sh
```

Sur une instance **déjà installée**, ne pas repartir de l'archive : lancer `./update.sh` dans le
dossier existant (ou le bouton « Mise à jour » de l'admin), ce qui préserve `.env`, la base et
les documents.

Depuis un dossier déjà présent (archive extraite, copie manuelle) :

```bash
cd "/chemin/vers/assistant-ia"
chmod +x *.sh
./install.sh
```

### Windows

> ⚠️ Il n'y a pas d'installeur PowerShell natif dans ce dépôt. Sous Windows, installez depuis
> WSL2 en suivant la procédure Linux ci-dessus.

En environnement sans terminal interactif (CI, provisionnement automatise) :

```bash
./install.sh --non-interactive
```

Pour installer une version precise (ex. revenir a une version anterieure) plutot que les
fichiers locaux actuels, recuperee directement depuis le serveur de mise a jour :

```bash
./install.sh --v1.000
```

Le script telecharge cette version, verifie son integrite (SHA256), remplace les fichiers du
projet par ceux de cette version, puis poursuit l'installation normalement avec ces fichiers.

## Ce que fait install.sh

Le script prepare automatiquement le projet :

1. verifie que Docker est installe et que le daemon tourne (guidage adapte a l'OS sinon)
2. cree le fichier `.env`, génère les secrets absents et le protège avec des permissions restrictives
3. verifie qu'aucun probleme courant ne bloquera l'installation (port deja utilise, espace disque)
4. cree les dossiers par defaut pour les documents
5. propose une personnalisation interactive (nom du projet, modele Ollama ou questionnaire
   materiel pour en suggerer un) — sautee automatiquement en mode non interactif ou avec
   `./install.sh --non-interactive`
6. lance les services Docker necessaires et attend qu'Ollama soit pret
7. telecharge le modele principal choisi (ou par defaut) et le modele d'embedding
8. demarre toute la plateforme
9. genere et affiche les identifiants du compte administrateur initial

Une fois termine, tu peux ouvrir :

- application : [http://localhost:3000](http://localhost:3000)
- admin : [http://localhost:3000/admin](http://localhost:3000/admin)

## Installation manuelle avec Docker Compose

`install.sh` reste la méthode recommandée (génération des secrets, hash du compte
administrateur, téléchargement des modèles, garde-fous). Cette section décrit l'équivalent
manuel pour qui veut piloter chaque étape.

Il n'y a **pas d'image pré-construite publiée** sur un registre : l'image `backend` est
construite localement à partir des sources. Il faut donc d'abord récupérer le dépôt (clone ou
archive de release, voir plus haut).

### 1. Préparer `.env`

```bash
cp .env.example .env
```

Puis générer les secrets absents (sinon le projet démarre avec des valeurs d'exemple non
sûres) :

```bash
for key in JWT_SECRET CONFIG_ENCRYPTION_KEY UPDATER_SHARED_TOKEN OWNER_BOOTSTRAP_PASSWORD; do
  sed -i "s|^${key}=.*|${key}=$(openssl rand -hex 32)|" .env
done
```

Laisser `PROJECT_WORKSPACE_DIR` vide fait pointer les montages sur le dossier courant. Sur
certains hôtes (chemins montés, `docker compose` lancé depuis ailleurs), renseigner le chemin
absolu du dépôt.

### 2. Démarrer l'infrastructure et le backend

```bash
docker compose up -d --build ollama chromadb redis backend updater
```

Le service `frontend` n'est **pas** lancé : en production le backend sert lui-même l'interface
sur son port. Il n'existe que pour le développement, derrière le profil `frontend-dev`
(`docker compose --profile frontend-dev up -d frontend`).

### 3. Télécharger les modèles Ollama

Le conteneur Ollama démarre vide. Télécharger le modèle de conversation et celui d'embedding
définis dans `.env` (`DEFAULT_MODEL`, `EMBEDDING_MODEL`) :

```bash
docker exec assistant-ia-ollama ollama pull gemma2:2b
docker exec assistant-ia-ollama ollama pull nomic-embed-text-v2-moe:latest
```

### 4. Créer le compte administrateur initial

```bash
ADMIN_PW="$(openssl rand -hex 16)"
HASH="$(docker compose run --rm --no-deps \
  -e "ADMIN_INITIAL_PASSWORD=$ADMIN_PW" backend \
  node --input-type=module -e "import bcrypt from 'bcrypt'; console.log(await bcrypt.hash(process.env.ADMIN_INITIAL_PASSWORD, 12));")"
sed -i "s|^ADMIN_PASSWORD_HASH=.*|ADMIN_PASSWORD_HASH=${HASH}|" .env
grep -q '^ADMIN_PASSWORD_HASH=' .env || echo "ADMIN_PASSWORD_HASH=${HASH}" >> .env
echo "Mot de passe administrateur : $ADMIN_PW"
docker compose up -d backend   # recharge .env
```

Identifiant par défaut : `admin@assistant-ia.local`. Noter le mot de passe affiché (non
rejouable).

### 5. Vérifier

```bash
docker compose ps
curl -fsS http://localhost:3000/api/health
```

Application sur [http://localhost:3000](http://localhost:3000), admin sur
[http://localhost:3000/admin](http://localhost:3000/admin). Les commandes usuelles
(`docker compose logs -f backend`, `down`, `up -d --build`) restent valables ; `./update.sh`
et l'onglet « Mise à jour » de l'admin fonctionnent aussi sur une pile démarrée à la main.

## Scripts simples a connaitre

Pour rendre l'utilisation du projet la plus simple possible, tu peux tout piloter avec ces scripts :

```bash
./install.sh
./doctor.sh
./export.sh
./update.sh
./restart.sh
./stop.sh
```

### 1. Installer le projet

```bash
./install.sh
```

Ce script :

- prepare le fichier `.env`
- telecharge les modeles necessaires
- construit les images Docker
- demarre toute la plateforme

### 2. Diagnostiquer et réparer

```bash
./doctor.sh
```

Utilise `./doctor.sh --check-only` pour un audit sans modification, ou `./doctor.sh --yes` pour
appliquer automatiquement les réparations sûres sur un serveur sans terminal.

### 3. Mettre a jour le projet

```bash
./update.sh
```

Ce script :

- verifie d'abord s'il existe une mise a jour distante (GitHub Releases du depot defini dans
  `update.config.json`)
- l'applique si elle existe (verification SHA-256 ; `.env`, `backend/data`, `backend/uploads`,
  `backend/logs` preserves)
- sinon, reconstruit simplement le projet avec les fichiers locaux actuels

Necessite `rsync`, `curl` et `tar` sur l'hote. Voir [docs/GITHUB_RELEASES.md](docs/GITHUB_RELEASES.md).

Tu peux aussi seulement verifier l'etat du canal distant :

```bash
./update.sh --check-only
```

Cette commande sort avec un **code d'erreur** si la verification distante a echoue (depot
introuvable/prive, quota API GitHub, reseau) — a distinguer de « aucune mise a jour disponible ».
`./doctor.sh --check-only` detaille la cause.

### 4. Exporter le projet pour une autre machine

```bash
./export.sh
```

Ce script :

- crée un dossier nommé avec la version du projet
- crée une archive `.tar.gz` du projet
- nomme l'archive avec la version définie dans `version.json`
- exclut les dépendances inutiles et les fichiers temporaires
- prépare un export propre pour un autre serveur ou un autre PC
- ouvre automatiquement l'emplacement de l'archive à la fin sur macOS

Pour changer la version utilisée dans le nom de l'archive, modifie :

```bash
version.json
```

Si tu veux cloner aussi les données actuelles :

```bash
./export.sh --with-data
```

### 5. Redemarrer le projet

```bash
./restart.sh
```

Ce script :

- tente d'arreter les indexations si possible
- redemarre les services
- ou les lance si le projet etait eteint

### 6. Arreter le projet

```bash
./stop.sh
```

Ce script :

- tente d'arreter les indexations
- arrete ensuite toute la plateforme Docker

## Gestion des comptes d'administration

Le compte administrateur initial est affiché à la fin de la première installation. Il permet de
créer ensuite des comptes Référent et Administrateur depuis l'onglet « Comptes admin ».

## Comment utiliser le projet

### Cote utilisateur

Ouvre :

- [http://localhost:3000](http://localhost:3000)

Tu peux ensuite :

- poser une question
- demander une explication
- demander un document si l'assistant y a acces

### Cote administration

Ouvre :

- [http://localhost:3000/admin](http://localhost:3000/admin)

Connectez-vous avec les identifiants administratifs qui vous ont été attribués. Les fonctions
sensibles sont accessibles uniquement aux comptes autorisés.

Dans l'admin, tu peux :

- ajouter des documents
- creer des dossiers
- choisir si un document est public ou prive
- personnaliser le comportement de l'assistant
- changer le modele IA
- lancer des recherches dans les documents indexes
- gerer les donnees du projet

## Ajouter des documents

La methode la plus simple :

1. ouvrir l'admin
2. aller dans l'onglet documents
3. choisir un dossier
4. deposer les fichiers

L'indexation se fait ensuite automatiquement.

Formats notamment acceptes :

- PDF
- TXT
- MD
- DOCX
- HTML
- CSV
- JSON
- XML
- YAML
- LOG
- SQL
- et plusieurs autres formats textuels

## Documents publics et prives

Chaque document peut etre :

- `Public` : l'assistant peut proposer le fichier dans une reponse
- `Prive` : l'assistant peut s'en servir pour repondre, mais ne peut jamais le donner au telechargement

## Fonctionnement simple de l'assistant

Le comportement general est le suivant :

1. l'utilisateur pose une question
2. l'assistant cherche d'abord dans les personnalisations actives
3. il regarde ensuite les documents indexes, les liens documentaires analyses et les pieces jointes deposees
4. si ces sources aident, il s'appuie dessus en priorite et cite les documents ou liens utilises
5. s'il manque des informations, il repond avec ses connaissances generales en le precisant clairement
6. si la reponse n'est pas fondee sur une source interne, il propose un lien de recherche Internet pour verifier ou completer
7. si la question est hors du perimetre configure de l'assistant, il le dit clairement (voir la bride de perimetre dans [docs/CONFIGURATION.md](docs/CONFIGURATION.md))

Les sources (documents ou liens) ne sont affichees que lorsque la reponse s'appuie
reellement sur les contenus indexes.

## Evaluation des reponses (pouces)

Sous chaque reponse de l'assistant, l'utilisateur peut cliquer sur 👍 ou 👎.

- les reponses appreciees servent d'exemples a suivre pour les questions similaires
- les reponses signalees servent d'anti-exemples : l'assistant evite de les reproduire
- l'administrateur retrouve ces avis dans l'onglet Feedback et peut transformer
  une reponse signalee en correction definitive

## Pieces jointes des utilisateurs

Dans le chat, le bouton trombone permet de joindre un fichier texte ou PDF
(`.txt`, `.md`, `.csv`, `.log`, `.pdf`, 2 Mo maximum) a une question.
Les images et les videos ne sont pas prises en charge :

- le contenu du fichier est utilise immediatement pour repondre
- il est aussi indexe pour aider l'assistant sur les prochaines questions
- l'administrateur trie les pieces jointes dans l'onglet "Pieces jointes" :
  - "Pertinente, conserver" : le fichier est garde definitivement
  - "Non pertinente, supprimer" : le fichier et son indexation sont supprimes
  - sans action : suppression automatique apres 30 jours

## Liens documentaires avec analyse du site

Dans l'admin (onglet Documents), un lien documentaire ajoute avec un titre,
une description et une URL declenche automatiquement :

1. la recuperation du contenu texte de la page (scraping securise)
2. son indexation dans la base vectorielle
3. son utilisation par l'assistant, avec citation du lien comme source cliquable

Le bouton "Reanalyser" permet de rafraichir le contenu si le site a change.

## Utilisation sur le reseau local

Le projet peut aussi etre utilise depuis d'autres appareils du meme reseau local.

Depuis la machine qui heberge le projet :

- [http://localhost:3000](http://localhost:3000)

Depuis un autre appareil du meme reseau :

- `http://IP_DE_LA_MACHINE:3000`

Exemples pour recuperer l'IP locale :

### macOS

```bash
ipconfig getifaddr en0
```

### Linux

```bash
hostname -I
```

### Windows

```bash
ipconfig
```

Important :

- `localhost` fonctionne uniquement sur la machine elle-meme
- les autres appareils doivent utiliser l'IP de la machine serveur
- si besoin, autorise le port `3000` dans le pare-feu
- l'administration est disponible sur la meme URL avec `/admin`
- pour re-bloquer l'admin au reseau local uniquement, definir `ADMIN_ACCESS_MODE=local`

## Commandes utiles

### Lancer ou relancer les services

```bash
docker compose up -d --build
```

### Arreter les services

```bash
docker compose down
```

### Voir les logs

```bash
docker compose logs -f backend
```

## Si quelque chose ne marche pas

Verifie dans cet ordre :

1. Docker est bien installe
2. Docker est bien demarre
3. `docker compose version` fonctionne
4. `./install.sh` s'est termine sans erreur
5. les services tournent avec :

```bash
docker compose ps
```

6. l'application repond sur :

- [http://localhost:3000](http://localhost:3000)

## Resume tres court

Pour un debutant, la procedure la plus simple est :

```bash
cd "/chemin/vers/assistant-ia"
chmod +x install.sh
./install.sh
```

Puis :

- ouvre [http://localhost:3000](http://localhost:3000)
- ouvre [http://localhost:3000/admin](http://localhost:3000/admin) pour l'administration

## Publier une version (développeur)

Les mises à jour sont distribuées via les **GitHub Releases** du dépôt indiqué dans
`update.config.json` (`server.repository`). Ce dépôt doit être **public**.

Chaque release `vX.X.X` porte **uniquement le code source** en pièces jointes :

| Asset | Rôle |
|---|---|
| `assistant-ia-vX.X.X.tar.gz` | archive utilisée pour les mises à jour Linux |
| `assistant-ia-vX.X.X.zip` | même contenu, format ZIP |

Le **SHA-256** de l'archive `.tar.gz` est écrit **dans la description de la release** (aucun
fichier `.manifest.json` ni `.notes.md`) :

```
sha256 (assistant-ia-vX.X.X.tar.gz): <64 hexadécimaux>
```

Pour publier :

1. mettre à jour `version.json` (`vX.X.X`, semver) ;
2. écrire les notes dans `release-notes.txt` à la racine ;
3. commiter (l'arbre de travail doit être propre) ;
4. lancer :

```bash
./publish-release.sh            # construit les archives, calcule le SHA-256, pousse le tag vX.X.X
./publish-release.sh --dry-run  # vérifie sans créer ni pousser de tag
```

Le workflow `.github/workflows/release.yml` crée alors la GitHub Release, y écrit le SHA-256 et
attache les deux archives.

Côté instance, la mise à jour s'installe depuis l'admin (onglet « Mise à jour ») ou avec
`./update.sh`. Chaque installation :

- résout la dernière release `vX.X.X` (brouillons et préreleases ignorés) ;
- télécharge `assistant-ia-vX.X.X.tar.gz` et vérifie son SHA-256 contre celui de la description
  de la release (obligatoire par défaut, `requireSha256`) ;
- contrôle l'archive (rejet des chemins absolus, des `..` et des liens symboliques) ;
- crée une sauvegarde de rollback automatique (3 conservées, restaurables depuis l'admin) ;
- remplace intégralement le code applicatif en préservant `.env`, `update.config.json`, les
  documents, les données et les logs.

Détails : [docs/GITHUB_RELEASES.md](docs/GITHUB_RELEASES.md).

## Documentation complémentaire

- [docs/INSTALL.md](docs/INSTALL.md) — installation détaillée, dépannage, déploiement distant
- [docs/ROLES.md](docs/ROLES.md) — droits des utilisateurs, référents et administrateurs
- [docs/GITHUB_RELEASES.md](docs/GITHUB_RELEASES.md) — publication et vérification des mises à jour
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — variables d'environnement, branding, secrets
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribuer au projet
- [SECURITY.md](SECURITY.md) — signaler une vulnérabilité

## Licence

Ce projet est distribué sous licence [MIT](LICENSE).
