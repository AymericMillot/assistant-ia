# FablabAI

Assistant IA local pour un atelier, fablab ou tout environnement technique, sous licence MIT.

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
fablab-ai/
├── docker-compose.yml
├── .env.example
├── install.sh
├── export.sh
├── update.sh
├── restart.sh
├── stop.sh
├── password.sh
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

### Windows, en une commande

Depuis un terminal PowerShell, sans avoir a cloner le depot au prealable :

```powershell
irm https://maj.aymericmillot.com/iutlab/web-install.ps1 | iex
```

Cette commande telecharge le projet dans `%USERPROFILE%\fablab-ai`, l'extrait, puis lance
l'installation. Comme elle s'execute par evaluation de chaine (`iex`), elle n'est jamais bloquee
par la politique d'execution de scripts de Windows.

Depuis le dossier du projet :

```bash
cd "/chemin/vers/fablab-ai"
chmod +x install.sh
chmod +x update.sh
chmod +x restart.sh
chmod +x stop.sh
./install.sh
```

Une fois le depot publie, la meme installation est possible en une commande depuis un dossier
vide (remplacer `<url-du-depot>` par l'URL git de votre fork) :

```bash
git clone <url-du-depot> fablab-ai && cd fablab-ai && ./install.sh
```

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
9. genere et affiche le mot de passe enseignant initial (changement impose a la premiere
   connexion)

Une fois termine, tu peux ouvrir :

- application : [http://localhost:3000](http://localhost:3000)
- admin : [http://localhost:3000/admin](http://localhost:3000/admin)

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

- verifie d'abord s'il existe une mise a jour distante
- l'applique si elle existe
- sinon, reconstruit simplement le projet avec les fichiers locaux actuels

Tu peux aussi seulement verifier s'il y a une mise a jour :

```bash
./update.sh --check-only
```

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

## Comment récupérer les accès admin

Pour afficher le mot de passe administratif temporaire :

```bash
cd "/chemin/vers/fablab-ai"
./password.sh
```

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

### Reafficher le mot de passe admin

```bash
./password.sh
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
cd "/chemin/vers/fablab-ai"
chmod +x install.sh
./install.sh
./password.sh
```

Puis :

- ouvre [http://localhost:3000](http://localhost:3000)
- ouvre [http://localhost:3000/admin](http://localhost:3000/admin) pour l'administration

## Publier une mise à jour distante (développeur)

Le serveur de mise à jour configuré pour cette instance (`update.config.json`) sert de dossier par
version, contenant l'archive `fablab-ai-v<version>.tar.gz`, le manifest `version.json` (version +
SHA256) et `release-notes.txt`. Si vous forkez ce projet pour votre propre déploiement, remplacez
cette URL par votre propre serveur avant de publier des mises à jour (voir
[docs/CONFIGURATION.md](docs/CONFIGURATION.md)) — sinon vos instances tenteraient de lire le
serveur du projet d'origine.

Les instances lisent ce serveur en HTTPS public : elles n'ont besoin d'aucun identifiant.
Les identifiants FTP ne servent qu'à publier, depuis le poste développeur.

Pour publier une nouvelle version :

1. mettre à jour la version dans `version.json` (ex. `1.013`)
2. écrire les notes dans `release-notes.txt` à la racine
3. copier `.env.publish.example` vers `.env.publish` et renseigner le mot de passe FTP
   (fichier ignoré par git, à ne jamais commiter)
4. lancer :

```bash
./publish-release.sh            # construit, hash, téléverse en FTPS, vérifie l'URL publique
./publish-release.sh --dry-run  # prépare tout sans téléverser
```

Côté instance, la mise à jour s'installe depuis l'admin (onglet « Mise à jour »)
ou avec `./update.sh`. Chaque installation :

- vérifie le manifest et la somme SHA256 (obligatoire),
- contrôle l'archive (rejet des chemins absolus, des `..` et des liens symboliques),
- crée une sauvegarde de rollback automatique (3 conservées, restaurables depuis l'admin),
- remplace intégralement le code applicatif en préservant `.env`, les documents,
  les données et les logs.

## Documentation complémentaire

- [docs/INSTALL.md](docs/INSTALL.md) — installation détaillée, dépannage, déploiement distant
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — variables d'environnement, branding, secrets
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribuer au projet
- [SECURITY.md](SECURITY.md) — signaler une vulnérabilité

## Licence

Ce projet est distribué sous licence [MIT](LICENSE).
