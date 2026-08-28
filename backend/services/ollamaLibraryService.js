import { load as loadHtml } from "cheerio";
import { logger } from "../config/logger.js";

const libraryUrl = "https://ollama.com/library";
const requestTimeoutMs = Number(process.env.OLLAMA_LIBRARY_TIMEOUT_MS || 15000);
const userAgent = "Assistant IA-ModelCatalogRefresh/1.0 (+https://ollama.com/library)";

// Capacites annoncees par ollama.com qui ne correspondent pas a un modele de
// conversation general (embeddings, audio) : exclues du catalogue de chat.
const excludedCapabilities = new Set(["embedding", "audio"]);

function parseSizeToBillions(sizeLabel) {
  const normalized = String(sizeLabel || "").trim().toLowerCase();

  // Notation mixture-of-experts (ex. "128x17b") : on retient la taille du
  // sous-modele actif (le nombre juste avant le "b" final) comme approximation
  // du cout d'inference reel, plutot que le nombre total de parametres.
  const billionsMatch = normalized.match(/(\d+(?:\.\d+)?)b$/);
  if (billionsMatch) {
    return Number(billionsMatch[1]);
  }

  const millionsMatch = normalized.match(/(\d+(?:\.\d+)?)m$/);
  if (millionsMatch) {
    return Number(millionsMatch[1]) / 1000;
  }

  return null;
}

function chooseCategoryId({ capabilities, billions }) {
  if (capabilities.has("vision")) {
    return "vision";
  }
  if (capabilities.has("thinking")) {
    return "raisonnement";
  }
  if (billions === null) {
    return "classique";
  }
  if (billions <= 3) {
    return "vitesse";
  }
  if (billions <= 13) {
    return "classique";
  }
  return "raisonnement";
}

function parsePullCount(rawText) {
  const normalized = String(rawText || "").trim().toUpperCase();
  const match = normalized.match(/^([\d.]+)([KMB]?)$/);
  if (!match) {
    return 0;
  }

  const value = Number(match[1]) || 0;
  const multiplier = { "": 1, K: 1e3, M: 1e6, B: 1e9 }[match[2]] || 1;
  return value * multiplier;
}

/**
 * Scrape la page publique du catalogue Ollama (https://ollama.com/library) et
 * renvoie une liste plate de modeles telechargeables avec leurs variantes de
 * taille. Le HTML expose des attributs "x-test-*" stables (utilises par les
 * propres tests d'Ollama), ce qui rend le parsing raisonnablement robuste sans
 * dependre d'une API non documentee.
 */
export async function fetchOllamaLibraryModels() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("timeout")), requestTimeoutMs);

  let html;
  try {
    const response = await fetch(libraryUrl, {
      signal: controller.signal,
      headers: { "User-Agent": userAgent, Accept: "text/html" }
    });

    if (!response.ok) {
      throw new Error(`Reponse HTTP ${response.status}`);
    }

    html = await response.text();
  } finally {
    clearTimeout(timeoutId);
  }

  const $ = loadHtml(html);
  const models = [];

  $("li[x-test-model]").each((_index, element) => {
    const $entry = $(element);
    const name = $entry.find("[x-test-model-title]").attr("title")?.trim();
    if (!name) {
      return;
    }

    const description = $entry.find("[x-test-model-title] p").first().text().trim();
    const capabilities = new Set(
      $entry
        .find("[x-test-capability]")
        .map((_i, capabilityEl) => $(capabilityEl).text().trim().toLowerCase())
        .get()
    );
    const sizes = $entry
      .find("[x-test-size]")
      .map((_i, sizeEl) => $(sizeEl).text().trim().toLowerCase())
      .get();
    const pullCount = parsePullCount($entry.find("[x-test-pull-count]").first().text());

    if ([...capabilities].some((capability) => excludedCapabilities.has(capability))) {
      return;
    }

    models.push({
      name,
      description,
      capabilities: [...capabilities],
      sizes: sizes.length > 0 ? sizes : [null],
      pullCount
    });
  });

  return models;
}

/**
 * Convertit la liste plate scrapee en catalogue groupe par categorie,
 * compatible avec le format attendu par backend/config/modelCatalog.js
 * (memes ids/labels que le catalogue statique, pour rester interchangeable).
 */
export function buildCatalogFromLibraryModels(libraryModels, { maxEntriesPerCategory = 20 } = {}) {
  const categoryDefinitions = [
    { id: "vitesse", label: "Vitesse", description: "Modèles légers pour une réponse rapide sur CPU." },
    { id: "classique", label: "Classique", description: "Modèles polyvalents pour l'usage général et documentaire." },
    {
      id: "raisonnement",
      label: "Raisonnement",
      description: "Modèles plus adaptés aux explications structurées et au raisonnement."
    },
    { id: "vision", label: "Multimodal", description: "Modèles à garder sous la main pour l'image ou des usages hybrides." }
  ];

  const entriesByCategory = new Map(categoryDefinitions.map((category) => [category.id, []]));

  for (const model of libraryModels) {
    for (const sizeLabel of model.sizes) {
      const billions = parseSizeToBillions(sizeLabel);
      const categoryId = chooseCategoryId({ capabilities: new Set(model.capabilities), billions });
      const pullableName = sizeLabel ? `${model.name}:${sizeLabel}` : `${model.name}:latest`;

      entriesByCategory.get(categoryId).push({
        name: pullableName,
        label: `${model.name}${sizeLabel ? ` ${sizeLabel}` : ""}`,
        size: billions !== null ? `${billions}B` : "",
        description: model.description,
        pullCount: model.pullCount,
        billions
      });
    }
  }

  return categoryDefinitions.map((category) => ({
    ...category,
    models: (entriesByCategory.get(category.id) || [])
      // On ne garde que les modeles les plus populaires (evite un catalogue
      // trop long), puis on trie du plus leger au plus lourd : le premier
      // modele de chaque categorie sert de choix par defaut pour la
      // recommandation materielle (hardwareRecommendationService.js), qui
      // doit rester le plus sobre possible dans sa categorie.
      .sort((left, right) => right.pullCount - left.pullCount)
      .slice(0, maxEntriesPerCategory)
      .sort((left, right) => (left.billions ?? Infinity) - (right.billions ?? Infinity))
      .map(({ pullCount: _pullCount, billions: _billions, ...model }) => model)
  }));
}

export async function fetchOllamaLibraryCatalog(options = {}) {
  const libraryModels = await fetchOllamaLibraryModels();
  logger.info("Catalogue Ollama recupere depuis ollama.com/library.", {
    modelCount: libraryModels.length
  });
  return buildCatalogFromLibraryModels(libraryModels, options);
}
