/**
 * Couche centrale de présentation des erreurs.
 *
 * Règle : l'interface n'affiche jamais un message technique brut
 * (« Failed to fetch », stack trace, texte HTML d'un proxy...).
 * Le détail technique part en console pour le diagnostic, l'utilisateur
 * reçoit un message français clair et orienté action.
 */

const technicalPatterns = [
  /failed to fetch/i,
  /load failed/i,
  /networkerror/i,
  /fetch/i,
  /timeout/i,
  /aborted/i,
  /unexpected token/i,
  /json/i,
  /<\s*html/i,
  /ECONN/,
  /socket/i
];

function looksTechnical(message) {
  if (!message) {
    return true;
  }

  return technicalPatterns.some((pattern) => pattern.test(message));
}

export function toUserMessage(error, fallback = "Une erreur est survenue. Réessayez dans un instant.") {
  const statusCode = error?.statusCode;

  if (statusCode === 401) {
    return "Votre session a expiré. Reconnectez-vous pour continuer.";
  }
  if (statusCode === 403) {
    return "Cette action n'est pas autorisée.";
  }
  if (statusCode === 404) {
    return "L'élément demandé est introuvable. Il a peut-être été supprimé.";
  }
  if (statusCode === 400 || statusCode === 422) {
    // Les messages de validation du backend sont écrits en français et sûrs à afficher.
    return looksTechnical(error?.message) ? "La demande est invalide. Vérifiez les champs saisis." : error.message;
  }
  if (statusCode === 409) {
    return looksTechnical(error?.message) ? "Cette action entre en conflit avec l'état actuel." : error.message;
  }
  if (statusCode === 429) {
    return "Trop de demandes en peu de temps. Patientez quelques secondes puis réessayez.";
  }
  if (statusCode >= 500) {
    return "Le serveur rencontre un problème temporaire. Réessayez dans un instant.";
  }

  if (!looksTechnical(error?.message)) {
    return error.message;
  }

  return fallback;
}

/** Journalise le détail technique côté console développeur, retourne le message présentable. */
export function reportError(scope, error, fallback) {
  // eslint-disable-next-line no-console
  console.error(`[${scope}]`, error);
  return toUserMessage(error, fallback);
}
