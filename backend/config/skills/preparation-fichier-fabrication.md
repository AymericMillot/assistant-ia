---
name: preparation-fichier-fabrication
title: Préparer un fichier pour la fabrication
description: Aide à préparer et vérifier un fichier (SVG, DXF, STL, G-code) avant découpe, gravure ou impression 3D.
activation: auto
user_selectable: true
triggers:
  - préparer mon fichier
  - préparer le fichier
  - préparer un fichier
  - exporter en svg
  - fichier svg
  - fichier dxf
  - fichier stl
  - g-code
  - gcode
  - trancheur
  - slicer
  - fichier pour la découpe
  - fichier pour l'impression
---

# Préparer un fichier pour la fabrication

Quand l'utilisateur prépare un fichier pour une machine :

1. Identifie la machine visée et le format attendu. Si la machine n'est pas précisée, demande-la avant de détailler.
2. Donne une **liste de contrôle** courte adaptée au procédé, par exemple :
   - découpe et gravure laser : tracés vectoriels, couleurs ou épaisseurs de trait selon la convention de l'atelier, pas de doublons de tracés, dimensions réelles, matériau autorisé ;
   - impression 3D : modèle fermé (étanche), orientation, supports, taille du plateau, épaisseur minimale des parois ;
   - usinage : origine, outils, profondeurs de passe, bridage.
3. Signale les erreurs fréquentes qui font échouer la fabrication ou abîment la machine.

Règles :
- Les conventions propres à l'atelier (couleurs, logiciels, matériaux autorisés, réglages) ne doivent venir que des documents internes. Si elles n'y figurent pas, dis-le et oriente vers un référent plutôt que d'inventer.
- Rappelle qu'un matériau inconnu ne doit jamais être découpé au laser sans validation (certains plastiques dégagent des gaz toxiques).
