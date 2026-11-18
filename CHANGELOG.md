# Historique des versions

Version 1.1.9 — test du circuit de mise à jour (18 novembre 2026).

- Aucun changement fonctionnel : version publiée pour vérifier la détection et
  l'installation d'une mise à jour de bout en bout.

---

Version 1.1.8 — test du circuit de mise à jour (17 novembre 2026).

- Aucun changement fonctionnel : version publiée pour vérifier la détection et
  l'installation d'une mise à jour de bout en bout.

---

Version 1.1.7 — nouveaux modèles et mises à jour plus fiables (13 octobre 2026).

- Modèles par défaut : gemma4:e4b (conversation) et embeddinggemma-2:740m
  (embedding). Au premier démarrage après la mise à jour, les deux modèles sont
  téléchargés puis tous les autres modèles Ollama sont supprimés ; les
  documents sont réindexés automatiquement (MODEL_MIGRATION_DISABLED=true
  désactive la migration).
- Le modèle d'embedding actif s'affiche sur le tableau de bord de l'administration.
- Mise à jour automatique de minuit plus robuste : nouvelles tentatives pendant
  22 h en cas d'échec de la vérification, et message d'indisponibilité remplacé
  par une information claire.

---

Version 1.1.6 — fiabilité et performances (7 octobre 2026).

- Chat plus fluide et plus léger : ~91 Ko chargés au lieu de ~643 Ko, un seul
  appel d'embedding par question, affichage des réponses plus régulier.
- Fiabilité : arrêt propre du serveur, recherche et réindexation qui ne restent
  plus bloquées après une erreur, Stop/nouvelle question corrigé, Ollama sans
  blocage quand le service est arrêté.
- Indexation et base de données plus rapides ; rotation automatique des journaux.
- Dans un .env existant, remplacer OLLAMA_MAX_LOADED_MODELS=1 par 2.

---

Version 1.1.5 — pièces jointes rétablies, mises à jour sans sudo (23 septembre 2026).

- Pièces jointes du chat rétablies : txt, md, csv, PDF, Word, Excel (5 Mo,
  3 fichiers par question), contenu vérifié, triage par le référent
  (Conserver / Détruire).
- Le backend ne tourne plus en root ; les fichiers sont rendus au propriétaire
  du projet, donc plus besoin de sudo pour les mises à jour.
- Mises à jour plus sûres : retour automatique à la version précédente en cas
  d'échec, téléchargement réessayé, services ajoutés par une version démarrés.
- Installation : erreur « failed to get console » corrigée, installation macOS
  facilitée.
- Si cette version est installée depuis l'administration, lancer ensuite une
  fois ./updater.sh pour redémarrer le service de mise à jour.

---

Version 1.1.4 — correctif d'installation (21 septembre 2026).

- Échec du build backend (« failed to get console ») sur Docker Desktop corrigé.

---

Version 1.1.3 — signalement de bug / suggestion (16 septembre 2026).

- Bouton flottant sur le chat public : bug ou suggestion envoyés vers Discord
  (webhooks DISCORD_WEBHOOK_BUG_URL et DISCORD_WEBHOOK_SUGGESTION_URL).

---

Version 1.1.2 — installation et mises à jour fiabilisées (31 août 2026).

- Pièces jointes du chat suspendues temporairement (maintenance et sécurité).
- install.sh, update.sh et doctor.sh : erreurs plus claires, téléchargement
  réessayé, nouveaux diagnostics et réparations automatiques.

---

Version 1.1.1 — mise à jour automatique quotidienne (28 août 2026).

- Mise à jour automatique toujours active : chaque jour à minuit, reportée si
  une conversation est en cours, avec sauvegarde de retour arrière.

---

Version 1.1.0 — meilleures réponses (28 août 2026).

- Reformulations automatiques des questions pour mieux retrouver les extraits.
- Boucle de correction : les réponses corrigées par un référent sont reservies
  en priorité sur les questions similaires.
- Page d'aide en ligne (/help) et plafond d'appels à l'API GitHub.

---

Version 1.0.0 — première version publique (28 août 2026).

- Assistant IA local (RAG) configurable pour toute organisation, 100 % Docker.
- Installation guidée, mises à jour GitHub Releases avec contrôle SHA-256 et
  retour arrière, comptes nommés et administration protégée.
