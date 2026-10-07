# Rôles

| Rôle | Accès |
|---|---|
| Utilisateur | Conversation et fonctions publiques uniquement. |
| Référent | Administration courante : tableau de bord, documents, contenus, skills, accueil du chat, identité, retours, analytics et exports CSV. |
| Administrateur | Toutes les fonctions du référent, ainsi que les sauvegardes et restaurations, la suppression des données et des index, les mises à jour, le journal d'audit, le déploiement et la gestion des comptes. |

Seuls les rôles **Référent** et **Administrateur** sont proposés dans la gestion des comptes.

## Premier accès

Lors d'une installation neuve, `install.sh` génère un compte administrateur initial et affiche ses
identifiants une seule fois. Créez ensuite les comptes nommés depuis l'onglet « Comptes admin ».

Les utilisateurs n'ont aucun compte à créer pour utiliser l'assistant.

## Sessions

Une session d'administration est refusée dès que le compte est supprimé, que son rôle change ou que
son mot de passe est modifié (y compris le mot de passe référent partagé). Tant que le mot de passe
référent généré à l'installation n'a pas été changé, l'API d'administration reste fermée.
