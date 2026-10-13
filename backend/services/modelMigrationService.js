import { logger } from "../config/logger.js";
import { getSetting, insertAuditLogEntry, resetAllDocumentIndexing, setSetting } from "../config/db.js";
import * as ollamaService from "./ollamaService.js";
import { clearAllIndexes } from "./ragService.js";
import { enqueueFullReindex, stopAllIndexing } from "./queueService.js";

// Migration unique : a la premiere mise a jour embarquant ce service, tous les
// modeles Ollama installes sont remplaces par le couple de reference
// (conversation + embedding). Changer le modele d'embedding invalide les index :
// ils sont donc reconstruits automatiquement.
export const TARGET_CHAT_MODEL = "gemma4:e4b";
export const TARGET_EMBEDDING_MODEL = "embeddinggemma-2:740m";
const MIGRATION_ID = "chat-gemma4-e4b+embedding-embeddinggemma-2-740m";
const MIGRATION_SETTING_KEY = "modelMigrationApplied";
const retryDelayMs = Math.max(5000, Number(process.env.MODEL_MIGRATION_RETRY_MS || 10 * 60 * 1000));

let migrationTimer = null;
let migrationRunning = false;

const normalizeName = (name) => {
  const value = String(name || "").trim().toLowerCase();
  return value.endsWith(":latest") ? value.slice(0, -":latest".length) : value;
};

export function isModelMigrationPending() {
  return (
    process.env.MODEL_MIGRATION_DISABLED !== "true" &&
    getSetting(MIGRATION_SETTING_KEY, "") !== MIGRATION_ID
  );
}

async function installedNames() {
  return new Set((await ollamaService.listModels()).map((model) => normalizeName(model.name)));
}

async function ensureModelInstalled(modelName) {
  if ((await installedNames()).has(normalizeName(modelName))) {
    return;
  }
  logger.info("Migration des modeles : telechargement.", { model: modelName });
  await ollamaService.pullModel(modelName);
  if (!(await installedNames()).has(normalizeName(modelName))) {
    throw new Error(`Le modele ${modelName} n'est pas disponible apres telechargement.`);
  }
}

export async function runModelMigration() {
  // Telechargements d'abord : rien n'est supprime tant que les deux modeles
  // cibles ne sont pas presents, pour ne jamais laisser l'assistant sans modele.
  await ensureModelInstalled(TARGET_CHAT_MODEL);
  await ensureModelInstalled(TARGET_EMBEDDING_MODEL);

  const previousEmbedding = getSetting("embeddingModel", "");
  const embeddingChanged = normalizeName(previousEmbedding) !== normalizeName(TARGET_EMBEDDING_MODEL);

  ollamaService.setActiveModel(TARGET_CHAT_MODEL);
  ollamaService.setActiveModelByRole("image", "");
  ollamaService.setActiveModelByRole("reasoning", "");
  setSetting("embeddingModel", TARGET_EMBEDDING_MODEL);

  const keep = new Set([normalizeName(TARGET_CHAT_MODEL), normalizeName(TARGET_EMBEDDING_MODEL)]);
  const removed = [];
  for (const model of await ollamaService.listModels()) {
    if (keep.has(normalizeName(model.name))) {
      continue;
    }
    try {
      await ollamaService.deleteModel(model.name);
      removed.push(model.name);
    } catch (error) {
      logger.warn("Migration des modeles : suppression impossible.", {
        model: model.name,
        message: error.message
      });
    }
  }

  if (embeddingChanged) {
    try {
      await stopAllIndexing();
    } catch {
      // Aucune indexation a arreter.
    }
    await clearAllIndexes();
    resetAllDocumentIndexing();
    await enqueueFullReindex({ trigger: "embedding-model-change" });
  }

  setSetting(MIGRATION_SETTING_KEY, MIGRATION_ID);
  insertAuditLogEntry({
    actorRole: "system",
    action: "models.migration",
    targetType: "model",
    targetId: TARGET_CHAT_MODEL,
    details: { embeddingModel: TARGET_EMBEDDING_MODEL, removed, reindexed: embeddingChanged }
  });
  logger.info("Migration des modeles terminee.", { removed, reindexed: embeddingChanged });
}

async function attempt() {
  if (migrationRunning || !isModelMigrationPending()) {
    return;
  }
  migrationRunning = true;
  try {
    await runModelMigration();
  } catch (error) {
    logger.warn("Migration des modeles reportee (Ollama indisponible ou telechargement echoue).", {
      message: error.message,
      retryInMs: retryDelayMs
    });
    migrationTimer = setTimeout(attempt, retryDelayMs);
    migrationTimer.unref?.();
  } finally {
    migrationRunning = false;
  }
}

export function initializeModelMigration() {
  if (!isModelMigrationPending()) {
    return;
  }
  // Laisse Ollama/ChromaDB finir de demarrer avant le premier essai.
  migrationTimer = setTimeout(attempt, 20000);
  migrationTimer.unref?.();
}

export function shutdownModelMigration() {
  clearTimeout(migrationTimer);
}
