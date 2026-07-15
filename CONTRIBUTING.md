# Contribuer

Merci de l'intérêt porté à ce projet. Ce guide résume comment proposer un changement.

## Développement local

```bash
cd backend && npm install && npm run dev     # API sur le port du .env (voir .env.example)
cd frontend && npm install && npm run dev    # Vite dev server avec rechargement à chaud
```

La stack complète (Ollama, ChromaDB, Redis) reste plus simple à lancer via Docker :

```bash
./install.sh
```

Voir [docs/INSTALL.md](docs/INSTALL.md) et [docs/CONFIGURATION.md](docs/CONFIGURATION.md) pour le détail.

## Style de code

- Backend : JavaScript ES modules (Node), pas de framework de test imposé pour l'instant — vérifier au minimum `node --check <fichier>` sur les fichiers modifiés.
- Frontend : React + Vite + Tailwind. Lancer `npm run build` avant de proposer un changement pour vérifier qu'il compile.
- Pas de commentaires superflus : n'en ajouter que pour expliquer un choix non évident (contrainte cachée, contournement, etc.).
- Respecter les conventions déjà en place dans le fichier modifié plutôt que d'en introduire de nouvelles.

## Commits et pull requests

- Des commits ciblés avec un message qui explique le *pourquoi* du changement.
- Décrire dans la pull request : le problème traité, l'approche choisie, comment le changement a été vérifié (build, test manuel, capture d'écran si pertinent pour l'UI).
- Éviter de mélanger plusieurs sujets sans rapport dans une même pull request.

## Signaler un bug ou proposer une fonctionnalité

Ouvrir une issue en décrivant :

- le comportement observé et celui attendu,
- les étapes pour reproduire (pour un bug),
- l'environnement (OS, version Docker, modèle Ollama utilisé) si pertinent.

## Sécurité

Ne pas ouvrir d'issue publique pour une vulnérabilité de sécurité : voir [SECURITY.md](SECURITY.md).
