// Fonctions pures de l'indexation visuelle des PDF (sans Ollama, base ni
// binaire natif) : analyse de `pdfimages -list`, choix des pages, prompt et
// nettoyage des descriptions. Voir pdfVisionService.js.

// A incrementer quand le prompt change : les descriptions en cache produites
// avec l'ancien prompt seront alors regenerees.
export const VISION_PROMPT_VERSION = "v1";
export const NO_VISUAL_CONTENT_MARKER = "AUCUN_CONTENU_VISUEL";

/**
 * Analyse la sortie de `pdfimages -list` :
 * page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio
 */
export function parsePdfImagesList(output) {
  const lines = String(output || "").split("\n");
  const separatorIndex = lines.findIndex((line) => /^-{10,}/.test(line.trim()));
  const images = [];

  for (const line of lines.slice(separatorIndex + 1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 12) {
      continue;
    }

    const pageNumber = Number(columns[0]);
    const width = Number(columns[3]);
    const height = Number(columns[4]);
    if (!Number.isInteger(pageNumber) || !Number.isFinite(width) || !Number.isFinite(height)) {
      continue;
    }

    images.push({
      pageNumber,
      type: columns[2],
      width,
      height,
      objectId: `${columns[10]} ${columns[11]}`
    });
  }

  return images;
}

/**
 * Choisit les pages a confier au modele de vision.
 *   - images significatives (hors masques, vignettes et elements repetes sur
 *     de nombreuses pages comme les logos ou fonds de page) ;
 *   - pages quasiment sans texte (scans, plans ou schemas vectoriels).
 * Au-dela de `maxPages`, les pages les plus illustrees sont privilegiees.
 */
export function selectPagesForVision(
  pages = [],
  images = [],
  { maxPages = 40, minImagePixels = 80, lowTextThreshold = 40, analyzeAllPages = false } = {}
) {
  const totalPages = pages.length;
  const pagesPerObject = new Map();
  for (const image of images) {
    if (!pagesPerObject.has(image.objectId)) {
      pagesPerObject.set(image.objectId, new Set());
    }
    pagesPerObject.get(image.objectId).add(image.pageNumber);
  }

  const isRepeatedDecoration = (image) => {
    const pageCount = pagesPerObject.get(image.objectId)?.size || 0;
    return totalPages >= 3 && pageCount >= 3 && pageCount / totalPages >= 0.4;
  };

  const meaningfulAreaByPage = new Map();
  for (const image of images) {
    if (image.type !== "image") {
      continue;
    }
    if (Math.min(image.width, image.height) < minImagePixels || image.width * image.height < minImagePixels * minImagePixels * 2) {
      continue;
    }
    if (isRepeatedDecoration(image)) {
      continue;
    }
    meaningfulAreaByPage.set(image.pageNumber, (meaningfulAreaByPage.get(image.pageNumber) || 0) + image.width * image.height);
  }

  const candidates = [];
  for (const page of pages) {
    const textLength = String(page.text || "").replace(/\s+/g, "").length;
    const imageArea = meaningfulAreaByPage.get(page.pageNumber) || 0;
    const isLowText = textLength < lowTextThreshold;

    if (analyzeAllPages || imageArea > 0 || isLowText) {
      candidates.push({
        pageNumber: page.pageNumber,
        reason: isLowText ? "low-text" : imageArea > 0 ? "images" : "all-pages",
        // Une page scannee porte tout son contenu dans l'image : priorite haute.
        score: (isLowText ? 1e12 : 0) + imageArea
      });
    }
  }

  const selected = [...candidates]
    .sort((left, right) => right.score - left.score)
    .slice(0, maxPages)
    .sort((left, right) => left.pageNumber - right.pageNumber);

  return {
    selected,
    skipped: Math.max(0, candidates.length - selected.length)
  };
}

export const VISION_SYSTEM_PROMPT =
  "Tu es un assistant d'indexation documentaire. Tu analyses l'image d'une page de document " +
  "pour rendre son contenu visuel retrouvable par un moteur de recherche. Tu es factuel et precis, " +
  "tu n'inventes jamais un detail que tu ne vois pas, et tu ecris en francais avec les accents.";

export function buildVisionPrompt({ documentLabel, pageNumber, totalPages, pageText, reason }) {
  const excerpt = String(pageText || "").replace(/\s+/g, " ").trim().slice(0, 1500);
  const isLowText = reason === "low-text" || !excerpt;

  return [
    `Page ${pageNumber}${totalPages ? ` sur ${totalPages}` : ""} du document « ${documentLabel} ».`,
    excerpt
      ? `Texte deja extrait de cette page (ne le recopie pas, sers-t'en pour comprendre les images) :\n"""\n${excerpt}\n"""`
      : "Aucun texte n'a pu etre extrait de cette page : elle est probablement scannee ou purement graphique.",
    "",
    isLowText
      ? "Transcris d'abord fidelement tout le texte lisible de la page, dans l'ordre de lecture (titres, paragraphes, listes, tableaux en lignes \"colonne | colonne\"). Decris ensuite les elements visuels."
      : "Decris uniquement le contenu visuel utile de la page.",
    "Pour chaque element visuel (photo, schema, plan, graphique, tableau en image, capture d'ecran, pictogramme de securite) :",
    "- ce qu'il represente (machine, outil, piece, montage, etape, interface...) ;",
    "- les textes, legendes, numeros, valeurs, cotes et unites lisibles dans l'image, recopies exactement ;",
    "- les relations utiles : ordre des etapes, fleches, reperes, emplacement des elements les uns par rapport aux autres ;",
    "- pour un graphique : axes, unites et tendance principale.",
    "Ignore les logos, en-tetes, pieds de page et elements purement decoratifs.",
    "Si un detail est illisible, dis-le plutot que de deviner. Pas d'introduction ni de conclusion.",
    `Si la page ne contient aucun contenu visuel utile${isLowText ? " ni texte lisible" : ""}, reponds uniquement : ${NO_VISUAL_CONTENT_MARKER}`
  ].join("\n");
}

/**
 * Nettoie la reponse du modele de vision pour l'indexation : les titres
 * markdown deviennent du texte en gras (ils couperaient l'extrait en sections
 * sans contexte), les blocs de code et formules d'introduction sont retires.
 * Renvoie "" si la page n'a pas de contenu visuel utile.
 */
export function cleanVisionDescription(text) {
  let value = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/\r/g, "")
    .trim();

  if (!value || value.toUpperCase().includes(NO_VISUAL_CONTENT_MARKER)) {
    // Le marqueur peut accompagner une description partielle : on ne jette la
    // reponse que si elle se resume au marqueur.
    const withoutMarker = value.replace(new RegExp(NO_VISUAL_CONTENT_MARKER, "gi"), "").replace(/[\s.:*_-]+/g, " ").trim();
    if (withoutMarker.length < 25) {
      return "";
    }
    value = value.replace(new RegExp(NO_VISUAL_CONTENT_MARKER, "gi"), "").trim();
  }

  value = value
    .split("\n")
    .map((line) => {
      const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
      return heading ? `**${heading[1].trim()}**` : line.replace(/\s+$/, "");
    })
    .join("\n")
    .replace(/^(voici|ci-dessous)[^\n]{0,80}:\s*\n/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return value;
}
