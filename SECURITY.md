# Politique de sécurité

## Signaler une vulnérabilité

Merci de ne **pas** ouvrir d'issue publique pour signaler une faille de sécurité.

Ouvrez une [issue GitHub privée / advisory de sécurité](../../security/advisories/new) sur le
dépôt, ou contactez le mainteneur par l'adresse indiquée dans le profil GitHub du dépôt.

Merci d'inclure :

- une description du problème et de son impact potentiel,
- les étapes pour le reproduire,
- la version du projet concernée.

Une réponse initiale est visée sous quelques jours. Un correctif est publié dès que possible une
fois le problème confirmé, avec crédit au rapporteur si souhaité.

## Bonnes pratiques déjà en place

- Mots de passe de comptes stockés en bcrypt dans la base.
- Secrets locaux conservés uniquement dans le fichier `.env` local (mode `600`) et jamais
  inclus dans les exports.
- Secrets sensibles (identifiants FTP de déploiement, etc.) chiffrés au repos en base
  (AES-256-GCM) via `CONFIG_ENCRYPTION_KEY` plutôt que stockés en clair dans `.env`.
- Protection SSRF sur le scraping de liens documentaires (adresses privées/locales refusées par
  défaut, `WEB_SCRAPE_ALLOW_PRIVATE` à activer explicitement si nécessaire).
- Vérification obligatoire du SHA256 des archives de mise à jour avant application.
- En-têtes de sécurité HTTP (CSP, etc.) et limitation de débit sur les routes sensibles.

## Ce qui reste sous votre responsabilité en déploiement

- Générer des valeurs uniques et privées pour `JWT_SECRET` et `CONFIG_ENCRYPTION_KEY` (ne jamais
  réutiliser les exemples de `.env.example`).
- Protéger le fichier `.env`, faire tourner tout secret compromis et lancer `./doctor.sh --yes`
  après une réparation de configuration.
- Changer le mot de passe référent généré automatiquement à la première connexion (imposé par
  l'application, mais à ne pas contourner).
- Restreindre l'accès réseau au strict nécessaire (le port applicatif uniquement ; Ollama,
  ChromaDB et Redis ne doivent pas être exposés publiquement).
