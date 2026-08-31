// Verrous temporaires de fonctionnalites, decides au niveau du code (et non par
// un reglage d'administration). Ils priment sur les reglages de l'interface :
// tant qu'un verrou est actif, la fonctionnalite est indisponible meme si un
// referent tente de la reactiver. Pour lever un verrou : repasser la constante
// a false et publier une nouvelle version.

// v1.1.2 : l'ajout de pieces jointes cote chat est suspendu (incident technique
// sur la chaine d'indexation + renforcement des controles de securite sur les
// fichiers deposes par les utilisateurs).
export const ATTACHMENTS_TEMPORARILY_DISABLED = true;

// Message unique affiche aux utilisateurs (chat) comme aux referents
// (administration) quand le verrou ci-dessus est actif.
export const ATTACHMENTS_DISABLED_REASON =
  "L'ajout de pieces jointes est temporairement indisponible : maintenance " +
  "technique et renforcement de la securite en cours. La fonctionnalite sera " +
  "retablie dans une prochaine mise a jour.";

// true si la fonctionnalite « pieces jointes » est utilisable, verrou de code
// ET reglage d'administration pris en compte.
export function areAttachmentsAvailable(adminEnabled) {
  return !ATTACHMENTS_TEMPORARILY_DISABLED && adminEnabled === true;
}
