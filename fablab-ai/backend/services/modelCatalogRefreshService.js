import fs from "fs";
import path from "path";
import cron from "node-cron";
import { logger } from "../config/logger.js";
import { staticModelCatalog } from "../config/modelCatalog.js";
import { fetchOllamaLibraryCatalog } from "./ollamaLibraryService.js";

const cachePath = path.resolve(process.cwd(), "data/model-catalog-cache.json");
const requestTimeoutMs = Number(process.env.MODEL_CATALOG_REFRESH_TIMEOUT_MS || 10000);

// Par defaut, l'actualisation va chercher directement les modeles disponibles
// sur ollama.com/library (voir ollamaLibraryService.js). Un depot peut
// remplacer cette source par un fichier JSON prive/curatoriale (meme forme que
// le catalogue statique) via MODEL_CATALOG_SOURCE_URL si prefere.
function getSourceUrl() {
  return process.env.MODEL_CATALOG_SOURCE_URL || "";
}

function isValidCatalogShape(candidate) {
  return (
    Array.isArray(candidate) &&
    candidate.length > 0 &&
    candidate.every(
      (category) =>
        category &&
        typeof category.id === "string" &&
        Array.isArray(category.models) &&
        category.models.every((model) => model && typeof model.name === "string")
    )
  );
}

async function fetchCatalogFromCustomSource(sourceUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("timeout")), requestTimeoutMs);

  try {
    const response = await fetch(sourceUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Reponse HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function refreshModelCatalogFromSource() {
  const sourceUrl = getSourceUrl();

  try {
    const payload = sourceUrl
      ? await fetchCatalogFromCustomSource(sourceUrl)
      : await fetchOllamaLibraryCatalog();

    if (!isValidCatalogShape(payload)) {
      throw new Error("Format de catalogue invalide.");
    }

    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), "utf8");

    logger.info("Catalogue de modeles actualise.", {
      source: sourceUrl ? "source personnalisee" : "ollama.com/library",
      categories: payload.length
    });

    return { refreshed: true };
  } catch (error) {
    // On ne touche jamais au cache existant en cas d'echec : le catalogue
    // precedent (ou le catalogue statique en dernier recours) reste disponible.
    logger.warn("Actualisation du catalogue de modeles echouee, cache conserve.", {
      message: error.message
    });
    return { refreshed: false, reason: "fetch_failed", message: error.message };
  }
}

export function getModelCatalogCacheInfo() {
  try {
    const stat = fs.statSync(cachePath);
    return { cached: true, updatedAt: stat.mtime.toISOString() };
  } catch {
    return { cached: false, updatedAt: null };
  }
}

// Filet de securite explicite : si jamais le cache et la source distante sont
// tous deux indisponibles, le catalogue statique reste exporte et utilisable.
export function getFallbackCatalog() {
  return staticModelCatalog;
}

let scheduledTask = null;

// Le 1er de chaque mois a 3h locale : hors heures d'usage typiques d'un atelier.
export function scheduleModelCatalogRefresh() {
  if (scheduledTask) {
    return scheduledTask;
  }

  scheduledTask = cron.schedule(
    "0 3 1 * *",
    () => {
      refreshModelCatalogFromSource().catch((error) => {
        logger.warn("Actualisation mensuelle du catalogue de modeles echouee.", {
          message: error.message
        });
      });
    },
    { timezone: process.env.ACCESS_PASSWORD_TIMEZONE || "Europe/Paris" }
  );

  return scheduledTask;
}
