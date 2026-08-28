import express from "express";
import bcrypt from "bcrypt";
import multer from "multer";
import {
  countAdminUsersByRole,
  createAdminUser,
  createManualResource,
  deleteAdminUser,
  deleteManualResource,
  getAdminUserById,
  getDocumentById,
  getDocuments,
  getDocumentStats,
  getManualResources,
  getRetrievalScoreSummary,
  getTopQuestions,
  getUnansweredQuestions,
  insertAuditLogEntry,
  listAdminUsers,
  listAuditLogEntries,
  listManualResourceScrapePages,
  purgeAllProjectData,
  purgeConversationFeedbackData,
  resetAllDocumentIndexing,
  getSetting,
  getSettingDecrypted,
  setSetting,
  setSettingEncrypted,
  updateAdminUserPasswordById,
  updateAdminUserRoleById,
  updateManualResource
} from "../config/db.js";
import { clearIndexationLogs, getRecentIndexationLogs, logger } from "../config/logger.js";
import { detectProvider, getModelCatalog } from "../config/modelCatalog.js";
import {
  getModelCatalogCacheInfo,
  refreshModelCatalogFromSource
} from "../services/modelCatalogRefreshService.js";
import { getBranding, writeBranding } from "../config/branding.js";
import { recommendModel } from "../services/hardwareRecommendationService.js";
import { isSecretsEncryptionAvailable } from "../utils/secretsCrypto.js";
import { authMiddleware, requireRole } from "../middleware/authMiddleware.js";
import * as fileService from "../services/fileService.js";
import {
  getConversationDetail,
  listConversations,
  updateConversationState
} from "../services/conversationService.js";
import {
  createFeedback,
  getFeedbackInstructionsPayload,
  getImprovementRules,
  listFeedback,
  softDeleteFeedback,
  updateFeedback
} from "../services/feedbackService.js";
import * as ollamaService from "../services/ollamaService.js";
import * as updateService from "../services/updateService.js";
import { getPerformanceSnapshot } from "../services/performanceService.js";
import {
  cancelDocumentIndex,
  cancelFullReindex,
  enqueueDocumentIndex,
  enqueueFullReindex,
  getActiveDocumentIndexIds,
  getIndexingStatus,
  pauseAllIndexing,
  stopAllIndexing,
  resumeAllIndexing
} from "../services/queueService.js";
import {
  clearAllIndexes,
  clearFolderIndex,
  deleteDocumentFromIndex,
  previewDocumentChunks,
  searchIndexedChunks
} from "../services/ragService.js";
import {
  deleteAttachment,
  getAttachment,
  keepAttachment,
  listAttachments,
  readAttachmentText
} from "../services/attachmentService.js";
import { getRatingsOverview } from "../services/ratingService.js";
import {
  removeLinkFromIndex,
  scheduleLinkScrape,
  scrapeAndIndexLinkResource
} from "../services/webScrapeService.js";
import { markActivity } from "../services/schedulerService.js";
import {
  createRateLimiter,
  ensureSafeFolderName,
  ensureSafeHttpUrl,
  ensureSafeIdentifier,
  ensureSafeText,
  parsePositiveInt
} from "../utils/security.js";

const router = express.Router();
const adminMutationRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ADMIN_MUTATION_RATE_LIMIT || 180),
  keyPrefix: "admin-mutation",
  message: "Trop d'actions d'administration en peu de temps. Reessayez plus tard."
});
const adminUploadRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ADMIN_UPLOAD_RATE_LIMIT || 40),
  keyPrefix: "admin-upload",
  message: "Trop de televersements en peu de temps. Reessayez plus tard."
});

function logAudit(req, action, { targetType = null, targetId = null, details = null } = {}) {
  try {
    insertAuditLogEntry({
      actorRole: req.user?.role || "unknown",
      action,
      targetType,
      targetId,
      details
    });
  } catch (error) {
    // Le journal d'audit ne doit jamais faire echouer l'action elle-meme.
    logger.warn("Journalisation d'audit ignoree.", { message: error.message, action });
  }
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (value === true || value === "true" || value === 1 || value === "1") {
    return true;
  }

  if (value === false || value === "false" || value === 0 || value === "0") {
    return false;
  }

  const error = new Error("Valeur booleenne invalide.");
  error.statusCode = 400;
  throw error;
}

router.use(authMiddleware);
router.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return adminMutationRateLimiter(req, res, next);
  }

  return next();
});

router.get("/summary", async (_req, res, next) => {
  try {
    const conversations = listConversations({ page: 1, pageSize: 1, isDeleted: false });
    const resolvedConversations = listConversations({
      page: 1,
      pageSize: 1,
      isResolved: true,
      isDeleted: false
    });
    const models = await ollamaService.listVisibleModels();
    res.json({
      stats: getDocumentStats(),
      activeModel: ollamaService.getActiveModel(),
      availableModels: models.length,
      autoIndexEnabled: getSetting("autoIndexEnabled", "true") === "true",
      indexing: getIndexingStatus(),
      feedback: {
        conversationCount: conversations.total,
        resolvedConversationCount: resolvedConversations.total
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get("/performance", async (_req, res, next) => {
  try {
    res.json(await getPerformanceSnapshot());
  } catch (error) {
    next(error);
  }
});

router.get("/conversations", async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query?.page || 1));
    const pageSize = Math.max(1, Math.min(Number(req.query?.pageSize || 20), 100));
    const order = String(req.query?.order || "desc").toLowerCase() === "asc" ? "asc" : "desc";

    const payload = listConversations({
      page,
      pageSize,
      order,
      isResolved: parseOptionalBoolean(req.query?.isResolved),
      isDeleted:
        req.query?.isDeleted === undefined ? false : parseOptionalBoolean(req.query?.isDeleted)
    });

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.get("/conversations/:id", async (req, res, next) => {
  try {
    const conversationId = parsePositiveInt(req.params.id, "Conversation");
    const payload = getConversationDetail(conversationId);

    if (!payload) {
      return res.status(404).json({ message: "Conversation introuvable." });
    }

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.put("/conversations/:id", async (req, res, next) => {
  try {
    const conversationId = parsePositiveInt(req.params.id, "Conversation");
    const updates = {};

    if (req.body?.is_resolved !== undefined) {
      const parsed = parseOptionalBoolean(req.body.is_resolved);
      if (parsed === null) {
        return res.status(400).json({ message: "is_resolved doit être un booléen." });
      }
      updates.isResolved = parsed;
    }

    if (req.body?.is_deleted !== undefined) {
      const parsed = parseOptionalBoolean(req.body.is_deleted);
      if (parsed === null) {
        return res.status(400).json({ message: "is_deleted doit être un booléen." });
      }
      updates.isDeleted = parsed;
    }

    const conversation = updateConversationState(conversationId, updates);
    if (!conversation) {
      return res.status(404).json({ message: "Conversation introuvable." });
    }

    res.json({
      message: "Conversation mise à jour.",
      conversation
    });
  } catch (error) {
    next(error);
  }
});

router.post("/feedback", async (req, res, next) => {
  try {
    const conversationId = parsePositiveInt(req.body?.conversation_id, "Conversation");
    const exchangeId =
      req.body?.exchange_id === undefined || req.body?.exchange_id === null || req.body?.exchange_id === ""
        ? null
        : parsePositiveInt(req.body.exchange_id, "Échange");
    const correctedResponse = ensureSafeText(req.body?.corrected_response, "Réponse corrigée", {
      min: 1,
      max: 12000
    });
    const instructions = ensureSafeText(req.body?.instructions, "Instructions", {
      min: 1,
      max: 12000
    });
    const feedbackStatus = req.body?.feedback_status
      ? ensureSafeIdentifier(req.body.feedback_status, "Statut du feedback", { max: 40 })
      : "pending";

    const feedback = createFeedback({
      conversationId,
      exchangeId,
      adminUserId: req.user?.adminUserId || req.user?.role || "admin",
      correctedResponse,
      instructions,
      feedbackStatus
    });

    res.status(201).json({
      message:
        feedbackStatus === "resolved"
          ? "Retour positif enregistré."
          : "Correction enregistrée.",
      feedback
    });
  } catch (error) {
    next(error);
  }
});

router.get("/feedback", async (req, res, next) => {
  try {
    const status = req.query?.status ? ensureSafeIdentifier(req.query.status, "Statut", { max: 40 }) : null;
    const includeDeleted = req.query?.includeDeleted === "true";

    res.json({
      feedback: listFeedback({
        status,
        includeDeleted
      })
    });
  } catch (error) {
    next(error);
  }
});

router.put("/feedback/:id", async (req, res, next) => {
  try {
    const feedbackId = parsePositiveInt(req.params.id, "Feedback");
    const updates = {};

    if (req.body?.corrected_response !== undefined) {
      updates.correctedResponse = ensureSafeText(req.body.corrected_response, "Réponse corrigée", {
        min: 1,
        max: 12000
      });
    }

    if (req.body?.instructions !== undefined) {
      updates.instructions = ensureSafeText(req.body.instructions, "Instructions", {
        min: 1,
        max: 12000
      });
    }

    if (req.body?.feedback_status !== undefined) {
      updates.feedbackStatus = ensureSafeIdentifier(req.body.feedback_status, "Statut du feedback", {
        max: 40
      });
    }

    if (req.body?.is_deleted !== undefined) {
      const parsed = parseOptionalBoolean(req.body.is_deleted);
      if (parsed === null) {
        return res.status(400).json({ message: "is_deleted doit être un booléen." });
      }
      updates.isDeleted = parsed;
    }

    const feedback = updateFeedback(feedbackId, updates);

    res.json({
      message: "Feedback mis à jour.",
      feedback
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/feedback/:id", async (req, res, next) => {
  try {
    const feedback = softDeleteFeedback(parsePositiveInt(req.params.id, "Feedback"));
    res.json({
      message: "Feedback masqué.",
      feedback
    });
  } catch (error) {
    next(error);
  }
});

router.get("/improvement-rules", async (_req, res, next) => {
  try {
    res.json({
      rules: getImprovementRules()
    });
  } catch (error) {
    next(error);
  }
});

router.get("/feedback-instructions", async (req, res, next) => {
  try {
    const question = req.query?.question
      ? ensureSafeText(req.query.question, "Question", { min: 1, max: 4000 })
      : "";

    res.json(getFeedbackInstructionsPayload(question));
  } catch (error) {
    next(error);
  }
});

router.get("/folders", async (_req, res, next) => {
  try {
    await fileService.syncFilesystemToDatabase();
    const folders = await fileService.listFolders();
    res.json({ folders });
  } catch (error) {
    next(error);
  }
});

router.post("/folders", async (req, res, next) => {
  try {
    const name = ensureSafeFolderName(req.body?.name, "Nom du dossier");

    markActivity();
    const folderName = await fileService.createFolder(name);
    res.status(201).json({
      message: "Dossier cree avec succes.",
      folderName
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/folders/:name", async (req, res, next) => {
  try {
    const folderName = ensureSafeFolderName(
      decodeURIComponent(req.params.name),
      "Nom du dossier"
    );
    const confirmation = String(req.body?.confirmation || "").trim().toLowerCase();

    if (confirmation !== "oui") {
      return res.status(400).json({
        message:
          "Confirmation invalide. Ecrivez exactement 'oui' pour supprimer ce dossier. Cette action est irreversible."
      });
    }

    if (getIndexingStatus().isRunning) {
      return res.status(409).json({
        message: "Une indexation est en cours. Attendez sa fin avant de supprimer un dossier."
      });
    }

    markActivity();
    await clearFolderIndex(folderName);
    const result = await fileService.deleteFolder(folderName);

    logAudit(req, "folder.delete", {
      targetType: "folder",
      targetId: folderName,
      details: { deletedDocumentsCount: result.deletedDocuments.length }
    });

    res.json({
      message:
        "Dossier et documents supprimes definitivement. Cette action est irreversible.",
      folderName: result.folderName,
      deletedDocumentsCount: result.deletedDocuments.length
    });
  } catch (error) {
    next(error);
  }
});

router.get("/documents", async (_req, res, next) => {
  try {
    await fileService.syncFilesystemToDatabase();
    const tree = await fileService.getFolderTree();
    const activeDocumentIndexIds = await getActiveDocumentIndexIds();
    res.json({ folders: tree, activeDocumentIndexIds });
  } catch (error) {
    next(error);
  }
});

router.post("/search/indexed", async (req, res, next) => {
  try {
    const query = ensureSafeText(req.body?.query, "Recherche", { min: 1, max: 200 });
    const rawFolderName = String(req.body?.folderName || "all").trim();
    const folderName =
      rawFolderName === "all"
        ? "all"
        : ensureSafeFolderName(rawFolderName, "Dossier de recherche");

    const payload = await searchIndexedChunks(query, {
      folderName,
      limit: 40
    });

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.get("/manual-resources", async (_req, res, next) => {
  try {
    res.json({
      // Seules les personnalisations sont renvoyees ici : les liens documentaires
      // ont leur propre gestion et ne doivent pas apparaitre dans cet onglet.
      resources: getManualResources({ resourceType: "instruction" }).map((resource) => ({
        id: resource.id,
        title: resource.title,
        content: resource.content,
        isEnabled: Boolean(resource.is_enabled),
        createdAt: resource.created_at,
        updatedAt: resource.updated_at
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.post("/manual-resources", async (req, res, next) => {
  try {
    const title = ensureSafeText(req.body?.title, "Titre", { min: 1, max: 160 });
    const content = ensureSafeText(req.body?.content, "Contenu", { min: 1, max: 12000 });
    const isEnabled = typeof req.body?.isEnabled === "boolean" ? req.body.isEnabled : true;

    const resource = createManualResource({
      title,
      content,
      isEnabled
    });

    res.status(201).json({
      message: "Ressource de personnalisation ajoutee.",
      resource: {
        id: resource.id,
        title: resource.title,
        content: resource.content,
        isEnabled: Boolean(resource.is_enabled),
        createdAt: resource.created_at,
        updatedAt: resource.updated_at
      }
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/manual-resources/:id", async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, "Ressource");
    const updates = {};

    if (req.body?.title !== undefined) {
      updates.title = ensureSafeText(req.body.title, "Titre", { min: 1, max: 160 });
    }

    if (req.body?.content !== undefined) {
      updates.content = ensureSafeText(req.body.content, "Contenu", { min: 1, max: 12000 });
    }

    if (req.body?.isEnabled !== undefined) {
      if (typeof req.body.isEnabled !== "boolean") {
        return res.status(400).json({ message: "La valeur isEnabled doit etre booleenne." });
      }
      updates.isEnabled = req.body.isEnabled;
    }

    const resource = updateManualResource(id, updates);
    res.json({
      message: "Ressource de personnalisation mise a jour.",
      resource: {
        id: resource.id,
        title: resource.title,
        content: resource.content,
        isEnabled: Boolean(resource.is_enabled),
        createdAt: resource.created_at,
        updatedAt: resource.updated_at
      }
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/manual-resources/:id", async (req, res, next) => {
  try {
    deleteManualResource(parsePositiveInt(req.params.id, "Ressource"));
    res.json({
      message: "Ressource de personnalisation supprimee."
    });
  } catch (error) {
    next(error);
  }
});

function toDocumentLinkDto(resource) {
  return {
    id: resource.id,
    title: resource.title,
    description: resource.content,
    url: resource.link_url || "",
    isEnabled: Boolean(resource.is_enabled),
    scrapeStatus: resource.scrape_status || "idle",
    scrapedAt: resource.scraped_at || null,
    scrapeError: resource.scrape_error || null,
    scrapedChars: Number(resource.scraped_chars || 0),
    createdAt: resource.created_at,
    updatedAt: resource.updated_at
  };
}

router.get("/document-links", async (_req, res, next) => {
  try {
    res.json({
      links: getManualResources({ resourceType: "document_link" }).map(toDocumentLinkDto)
    });
  } catch (error) {
    next(error);
  }
});

router.post("/document-links", async (req, res, next) => {
  try {
    const title = ensureSafeText(req.body?.title, "Titre", { min: 1, max: 160 });
    const description = ensureSafeText(req.body?.description, "Description", { min: 1, max: 4000 });
    const url = ensureSafeHttpUrl(req.body?.url, "Lien", { max: 2000 });
    const isEnabled = typeof req.body?.isEnabled === "boolean" ? req.body.isEnabled : true;

    const resource = createManualResource({
      title,
      content: description,
      resourceType: "document_link",
      linkUrl: url,
      isEnabled
    });

    // Le contenu de la page est recupere et indexe en arriere-plan pour que
    // l'assistant puisse s'appuyer sur le site, pas seulement sur la description.
    scheduleLinkScrape(resource.id);

    res.status(201).json({
      message: "Lien documentaire ajouté. Le contenu du site est en cours d'analyse.",
      link: toDocumentLinkDto(getManualResources({ resourceType: "document_link" }).find(
        (entry) => entry.id === resource.id
      ) || resource)
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/document-links/:id", async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, "Lien documentaire");
    const updates = {};
    let urlChanged = false;

    if (req.body?.title !== undefined) {
      updates.title = ensureSafeText(req.body.title, "Titre", { min: 1, max: 160 });
    }

    if (req.body?.description !== undefined) {
      updates.content = ensureSafeText(req.body.description, "Description", {
        min: 1,
        max: 4000
      });
    }

    if (req.body?.url !== undefined) {
      updates.linkUrl = ensureSafeHttpUrl(req.body.url, "Lien", { max: 2000 });
      urlChanged = true;
    }

    if (req.body?.isEnabled !== undefined) {
      if (typeof req.body.isEnabled !== "boolean") {
        return res.status(400).json({ message: "La valeur isEnabled doit être booléenne." });
      }
      updates.isEnabled = req.body.isEnabled;
    }

    updates.resourceType = "document_link";

    const resource = updateManualResource(id, updates);

    if (urlChanged) {
      scheduleLinkScrape(resource.id);
    }

    res.json({
      message: urlChanged
        ? "Lien documentaire mis à jour. Le nouveau contenu est en cours d'analyse."
        : "Lien documentaire mis à jour.",
      link: toDocumentLinkDto(resource)
    });
  } catch (error) {
    next(error);
  }
});

router.post("/document-links/:id/refresh", async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, "Lien documentaire");
    markActivity();

    const result = await scrapeAndIndexLinkResource(id);

    if (result?.alreadyRunning) {
      return res.status(409).json({
        message: "L'analyse de ce lien est déjà en cours."
      });
    }

    res.json({
      message: `Contenu du lien analysé et indexé (${result.chunkCount} extrait(s)).`,
      link: toDocumentLinkDto(
        getManualResources({ resourceType: "document_link" }).find((entry) => entry.id === id)
      )
    });
  } catch (error) {
    next(error);
  }
});

router.get("/document-links/:id/pages", (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, "Lien documentaire");
    const pages = listManualResourceScrapePages(id).map((page) => ({
      id: page.id,
      url: page.url,
      status: page.status,
      fetchedAt: page.fetched_at,
      errorMessage: page.error_message,
      characters: page.characters,
      createdAt: page.created_at
    }));

    res.json({ pages });
  } catch (error) {
    next(error);
  }
});

router.delete("/document-links/:id", async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, "Lien documentaire");
    await removeLinkFromIndex(id);
    deleteManualResource(id);
    res.json({
      message: "Lien documentaire supprimé."
    });
  } catch (error) {
    next(error);
  }
});

router.get("/attachments", async (_req, res, next) => {
  try {
    res.json({
      attachments: listAttachments(),
      retentionDays: Number(process.env.USER_ATTACHMENT_RETENTION_DAYS || 30),
      attachmentsEnabled: getSetting("attachmentsEnabled", "true") === "true"
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/attachments/toggle", (req, res, next) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ message: "La valeur enabled doit etre booleenne." });
    }

    markActivity();
    setSetting("attachmentsEnabled", String(enabled));
    res.json({
      message: enabled
        ? "Les pièces jointes sont maintenant autorisées dans le chat."
        : "Les pièces jointes sont désormais désactivées dans le chat.",
      enabled
    });
  } catch (error) {
    next(error);
  }
});

router.get("/attachments/:id", async (req, res, next) => {
  try {
    const attachmentId = parsePositiveInt(req.params.id, "Pièce jointe");
    const attachment = getAttachment(attachmentId);

    if (!attachment) {
      return res.status(404).json({ message: "Pièce jointe introuvable." });
    }

    const content = await readAttachmentText(attachmentId);

    res.json({
      attachment,
      content: content ? content.slice(0, 20000) : null
    });
  } catch (error) {
    next(error);
  }
});

router.post("/attachments/:id/keep", async (req, res, next) => {
  try {
    const attachmentId = parsePositiveInt(req.params.id, "Pièce jointe");
    markActivity();
    const attachment = keepAttachment(attachmentId);

    res.json({
      message: "Pièce jointe conservée. Elle restera disponible pour l'assistant.",
      attachment
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/attachments/:id", async (req, res, next) => {
  try {
    const attachmentId = parsePositiveInt(req.params.id, "Pièce jointe");
    markActivity();
    const attachment = await deleteAttachment(attachmentId);

    res.json({
      message: "Pièce jointe supprimée définitivement.",
      attachment
    });
  } catch (error) {
    next(error);
  }
});

router.get("/ratings", async (_req, res, next) => {
  try {
    res.json(getRatingsOverview({ limit: 30 }));
  } catch (error) {
    next(error);
  }
});

router.post(
  "/documents/upload",
  adminUploadRateLimiter,
  fileService.uploadMiddleware.array("files"),
  async (req, res, next) => {
    try {
      const folderName = ensureSafeFolderName(req.body?.folderName, "Dossier de destination");
      const duplicateStrategy = String(req.body?.duplicateStrategy || "reject").trim().toLowerCase();

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: "Aucun fichier n'a ete envoye." });
      }

      if (!["reject", "ignore", "replace", "rename"].includes(duplicateStrategy)) {
        return res.status(400).json({
          message: "Strategie de doublon invalide."
        });
      }

      markActivity();
      const documents = await fileService.saveUploadedFilesWithStrategy(req.files, folderName, {
        duplicateStrategy,
        onBeforeReplace: async (existingDocument) => {
          await cancelDocumentIndex(existingDocument.id).catch(() => undefined);
          await deleteDocumentFromIndex(existingDocument).catch(() => undefined);
        }
      });
      await Promise.all(documents.map((document) => enqueueDocumentIndex(document.id, "upload")));

      res.status(201).json({
        message:
          duplicateStrategy === "replace"
            ? "Fichiers televerses. Les doublons choisis ont ete remplaces et reindexes."
            : duplicateStrategy === "ignore"
              ? "Fichiers televerses. Les doublons detectes ont ete ignores."
              : duplicateStrategy === "rename"
                ? "Fichiers televerses. Les doublons detectes ont ete renommes automatiquement."
              : "Fichiers televerses et indexes immediatement dans la file d'attente.",
        documents
      });
    } catch (error) {
      if (error instanceof fileService.DuplicateDocumentsError) {
        return res.status(409).json({
          message:
            "Des doublons ont ete detectes. Choisissez d'ignorer, de remplacer ou de renommer les fichiers existants.",
          duplicates: error.duplicates
        });
      }

      next(error);
    }
  }
);

router.patch("/documents/:id/move", async (req, res, next) => {
  try {
    const folderName = ensureSafeFolderName(req.body?.folderName, "Dossier cible");

    markActivity();
    const document = await fileService.moveDocument(parsePositiveInt(req.params.id, "Document"), folderName);
    await enqueueDocumentIndex(document.id, "move");

    logAudit(req, "document.move", {
      targetType: "document",
      targetId: document.id,
      details: { folderName }
    });

    res.json({
      message: "Document deplace avec succes.",
      document
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/documents/:id/visibility", async (req, res, next) => {
  try {
    const { visibility } = req.body || {};
    if (visibility !== "private" && visibility !== "public") {
      return res
        .status(400)
        .json({ message: "La visibilite doit etre 'private' ou 'public'." });
    }

    const documentId = parsePositiveInt(req.params.id, "Document");
    const document = getDocumentById(documentId);
    if (!document) {
      return res.status(404).json({ message: "Document introuvable." });
    }

    const updated = await fileService.updateDocumentMetadata(documentId, {
      visibility
    });

    logAudit(req, "document.visibility", {
      targetType: "document",
      targetId: documentId,
      details: { visibility }
    });

    res.json({
      message:
        visibility === "public"
          ? "Le document est maintenant telechargeable depuis les reponses."
          : "Le document est maintenant prive.",
      document: updated
    });
  } catch (error) {
    next(error);
  }
});

router.get("/documents/:id/preview-chunks", async (req, res, next) => {
  try {
    const documentId = parsePositiveInt(req.params.id, "Document");
    const documentRecord = fileService.getDocumentRecord(documentId);

    if (!documentRecord) {
      return res.status(404).json({ message: "Document introuvable." });
    }

    const preview = await previewDocumentChunks(documentRecord);
    res.json(preview);
  } catch (error) {
    next(error);
  }
});

router.post("/documents/:id/reindex", async (req, res, next) => {
  try {
    const documentId = parsePositiveInt(req.params.id, "Document");
    const document = getDocumentById(documentId);

    if (!document) {
      return res.status(404).json({ message: "Document introuvable." });
    }

    markActivity();
    await fileService.updateDocumentMetadata(documentId, {
      indexing_status: "pending",
      last_error: null,
      chunk_count: 0
    });
    await enqueueDocumentIndex(documentId, "manual-single");

    res.json({
      message: "Réindexation du document ajoutée à la file d'attente.",
      documentId
    });
  } catch (error) {
    next(error);
  }
});

router.post("/documents/:id/reindex/cancel", async (req, res, next) => {
  try {
    const documentId = parsePositiveInt(req.params.id, "Document");
    const document = getDocumentById(documentId);

    if (!document) {
      return res.status(404).json({ message: "Document introuvable." });
    }

    markActivity();
    const result = await cancelDocumentIndex(documentId);

    if (!result.stopped) {
      return res.status(409).json({
        message: result.message
      });
    }

    res.json({
      message: result.message,
      documentId
    });
  } catch (error) {
    next(error);
  }
});

router.post("/index/continue-missing", async (_req, res, next) => {
  try {
    markActivity();

    const activeDocumentIndexIds = new Set(await getActiveDocumentIndexIds());
    const candidateDocuments = getDocuments().filter((document) => {
      const status = String(document.indexing_status || "").toLowerCase();
      return (
        (status === "pending" || status === "error") &&
        !activeDocumentIndexIds.has(Number(document.id))
      );
    });

    if (candidateDocuments.length === 0) {
      return res.json({
        message: "Aucun fichier restant a reprendre.",
        queuedDocuments: 0
      });
    }

    for (const document of candidateDocuments) {
      const status = String(document.indexing_status || "").toLowerCase();
      await fileService.updateDocumentMetadata(document.id, {
        indexing_status: "pending",
        last_error: null,
        chunk_count: status === "error" ? 0 : document.chunk_count ?? 0
      });
      await enqueueDocumentIndex(document.id, "manual-continue-missing");
    }

    res.json({
      message: `${candidateDocuments.length} fichier(s) restant(s) ajoute(s) a la file d'attente.`,
      queuedDocuments: candidateDocuments.length
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/documents/:id", async (req, res, next) => {
  try {
    const documentId = parsePositiveInt(req.params.id, "Document");
    const documentRecord = fileService.getDocumentRecord(documentId);

    if (!documentRecord) {
      return res.status(404).json({ message: "Document introuvable." });
    }

    markActivity();
    await deleteDocumentFromIndex(documentRecord);
    const document = await fileService.deleteDocument(documentId);

    logAudit(req, "document.delete", {
      targetType: "document",
      targetId: documentId,
      details: { originalName: documentRecord.originalName }
    });

    res.json({
      message: "Document supprime avec succes.",
      document
    });
  } catch (error) {
    next(error);
  }
});

router.post("/documents/bulk", async (req, res, next) => {
  try {
    const action = String(req.body?.action || "").trim().toLowerCase();
    const rawIds = Array.isArray(req.body?.documentIds) ? req.body.documentIds : [];

    if (!["delete", "move", "reindex", "visibility"].includes(action)) {
      return res.status(400).json({ message: "Action groupee invalide." });
    }

    if (rawIds.length === 0) {
      return res.status(400).json({ message: "Aucun document selectionne." });
    }

    if (rawIds.length > 200) {
      return res.status(400).json({ message: "Trop de documents selectionnes (200 maximum par action)." });
    }

    const documentIds = rawIds.map((value) => parsePositiveInt(value, "Document"));

    let folderName = null;
    if (action === "move") {
      folderName = ensureSafeFolderName(req.body?.folderName, "Dossier cible");
    }

    let visibility = null;
    if (action === "visibility") {
      visibility = req.body?.visibility;
      if (visibility !== "private" && visibility !== "public") {
        return res.status(400).json({ message: "La visibilite doit etre 'private' ou 'public'." });
      }
    }

    markActivity();

    const succeeded = [];
    const failed = [];

    for (const documentId of documentIds) {
      try {
        const documentRecord =
          action === "delete" ? fileService.getDocumentRecord(documentId) : getDocumentById(documentId);

        if (!documentRecord) {
          failed.push({ documentId, message: "Document introuvable." });
          continue;
        }

        if (action === "delete") {
          await cancelDocumentIndex(documentId).catch(() => undefined);
          await deleteDocumentFromIndex(documentRecord);
          await fileService.deleteDocument(documentId);
        } else if (action === "move") {
          const moved = await fileService.moveDocument(documentId, folderName);
          await enqueueDocumentIndex(moved.id, "bulk-move");
        } else if (action === "reindex") {
          await fileService.updateDocumentMetadata(documentId, {
            indexing_status: "pending",
            last_error: null,
            chunk_count: 0
          });
          await enqueueDocumentIndex(documentId, "bulk-reindex");
        } else if (action === "visibility") {
          await fileService.updateDocumentMetadata(documentId, { visibility });
        }

        succeeded.push(documentId);
      } catch (itemError) {
        failed.push({
          documentId,
          message: itemError?.statusCode ? itemError.message : "Operation impossible sur ce document."
        });
      }
    }

    const actionLabels = {
      delete: "supprime(s)",
      move: "deplace(s)",
      reindex: "ajoute(s) a la file d'indexation",
      visibility: visibility === "public" ? "rendu(s) publics" : "rendu(s) prives"
    };

    const summary =
      failed.length === 0
        ? `${succeeded.length} document(s) ${actionLabels[action]}.`
        : `${succeeded.length} document(s) ${actionLabels[action]}, ${failed.length} en echec.`;

    logAudit(req, `document.bulk-${action}`, {
      targetType: "document",
      targetId: null,
      details: { documentIds: succeeded, failedCount: failed.length, folderName, visibility }
    });

    res.status(failed.length > 0 && succeeded.length === 0 ? 400 : 200).json({
      message: summary,
      succeeded,
      failed
    });
  } catch (error) {
    next(error);
  }
});

router.get("/branding", (_req, res) => {
  res.json(getBranding());
});

router.patch("/branding", (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = {};

    if (body.projectName !== undefined) {
      updates.projectName = ensureSafeText(body.projectName, "Nom du projet", { min: 1, max: 120 });
    }
    if (body.shortName !== undefined) {
      updates.shortName = ensureSafeText(body.shortName, "Nom court", { min: 1, max: 40 });
    }
    if (body.welcomeMessage !== undefined) {
      updates.welcomeMessage = ensureSafeText(body.welcomeMessage, "Message d'accueil", {
        min: 1,
        max: 600
      });
    }
    if (body.supportEmail !== undefined) {
      updates.supportEmail = ensureSafeText(body.supportEmail, "Email de support", {
        min: 0,
        max: 200
      });
    }
    if (body.tabTitle !== undefined) {
      updates.tabTitle = ensureSafeText(body.tabTitle, "Titre de l'onglet", { min: 0, max: 70 });
    }

    const branding = writeBranding(updates);
    res.json(branding);
  } catch (error) {
    next(error);
  }
});

const faviconMaxBytes = 512 * 1024;
const faviconAllowedMimeTypes = new Set(["image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml", "image/jpeg"]);
const faviconUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: faviconMaxBytes }
});

router.post("/branding/favicon", faviconUploadMiddleware.single("favicon"), (req, res, next) => {
  try {
    const file = req.file;
    if (!file) {
      const error = new Error("Aucun fichier recu.");
      error.statusCode = 400;
      throw error;
    }

    if (!faviconAllowedMimeTypes.has(file.mimetype)) {
      const error = new Error("Format non supporte. Utilisez PNG, ICO, SVG ou JPEG.");
      error.statusCode = 400;
      throw error;
    }

    const faviconDataUrl = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
    const branding = writeBranding({ faviconDataUrl });
    logAudit(req, "branding.favicon-update", {});
    res.json(branding);
  } catch (error) {
    next(error);
  }
});

router.delete("/branding/favicon", (req, res, next) => {
  try {
    const branding = writeBranding({ faviconDataUrl: "" });
    logAudit(req, "branding.favicon-remove", {});
    res.json(branding);
  } catch (error) {
    next(error);
  }
});

router.post("/models/recommend", (req, res, next) => {
  try {
    const body = req.body || {};
    const cpuCores = parsePositiveInt(body.cpuCores, "Nombre de coeurs CPU");
    const ramGb = parsePositiveInt(body.ramGb, "RAM (Go)");
    const diskGb = Number(body.diskGb) > 0 ? parsePositiveInt(body.diskGb, "Stockage (Go)") : 0;
    const hasGpu = Boolean(body.hasGpu);
    const gpuModel = body.gpuModel
      ? ensureSafeText(body.gpuModel, "Modele de GPU", { min: 0, max: 120 })
      : "";

    const recommendation = recommendModel({ cpuCores, hasGpu, gpuModel, ramGb, diskGb });
    res.json(recommendation);
  } catch (error) {
    next(error);
  }
});

router.get("/models", async (_req, res) => {
  const embeddingModel = getSetting("embeddingModel", process.env.EMBEDDING_MODEL || "nomic-embed-text-v2-moe:latest");

  try {
    const models = await ollamaService.listVisibleModels();
    // Le modele d'embedding est masque de "models" (usage interne, pas pour le chat) :
    // on l'expose separement, avec la liste complete (non filtree), pour permettre
    // d'en choisir un autre parmi tous les modeles installes.
    const allModels = await ollamaService.listModels();
    const withProvider = (list) => list.map((model) => ({ ...model, provider: detectProvider(model.name) }));
    // Taille de contexte reelle par modele (via /api/show, mise en cache cote service) : affichee
    // dans l'admin pour que chaque modele indique sa capacite exacte plutot qu'une valeur generique.
    const withContextLength = async (list) =>
      Promise.all(
        list.map(async (model) => ({
          ...model,
          contextLength: await ollamaService.getModelContextLength(model.name)
        }))
      );
    res.json({
      activeModel: ollamaService.getActiveModel(),
      activeTextModel: ollamaService.getActiveModelByRole("text"),
      activeImageModel: ollamaService.getActiveModelByRole("image"),
      activeReasoningModel: ollamaService.getActiveModelByRole("reasoning"),
      embeddingModel,
      models: await withContextLength(withProvider(models)),
      allModels: withProvider(allModels),
      ollamaAvailable: true
    });
  } catch {
    // Ollama injoignable : on repond quand meme pour que l'admin affiche un etat clair
    // au lieu d'une erreur generique.
    res.json({
      activeModel: ollamaService.getActiveModel(),
      activeTextModel: ollamaService.getActiveModelByRole("text"),
      activeImageModel: ollamaService.getActiveModelByRole("image"),
      activeReasoningModel: ollamaService.getActiveModelByRole("reasoning"),
      embeddingModel,
      models: [],
      allModels: [],
      ollamaAvailable: false,
      message: "Le service Ollama est injoignable pour le moment."
    });
  }
});

router.get("/models/catalog", (_req, res) => {
  res.json({ catalog: getModelCatalog(), ...getModelCatalogCacheInfo() });
});

router.post("/models/catalog/refresh", async (req, res, next) => {
  try {
    markActivity();
    const result = await refreshModelCatalogFromSource();
    logAudit(req, "model_catalog.refresh", { details: result });
    res.json({
      message: result.refreshed
        ? "Catalogue de modeles actualise."
        : "Actualisation impossible pour le moment, catalogue precedent conserve.",
      ...result,
      ...getModelCatalogCacheInfo()
    });
  } catch (error) {
    next(error);
  }
});

const activatableModelRoles = new Set(["text", "image", "reasoning"]);

router.post("/models/activate", async (req, res, next) => {
  try {
    const modelName = ensureSafeIdentifier(req.body?.modelName, "Nom du modele", { max: 120 });
    const role = req.body?.role !== undefined
      ? ensureSafeIdentifier(req.body.role, "Role du modele", { max: 20 })
      : "text";
    if (!activatableModelRoles.has(role)) {
      return res.status(400).json({ message: "Role de modele invalide." });
    }

    const installedModels = await ollamaService.listVisibleModels().catch(() => null);
    if (installedModels === null) {
      return res.status(503).json({
        message: "Le service Ollama est injoignable. Impossible de changer de modele pour le moment."
      });
    }

    const isInstalled = installedModels.some(
      (model) => String(model.name || "").toLowerCase() === modelName.toLowerCase()
    );
    if (!isInstalled) {
      return res.status(400).json({
        message: "Ce modele n'est pas installe. Telechargez-le avant de l'activer."
      });
    }

    markActivity();
    ollamaService.setActiveModelByRole(role, modelName);
    logAudit(req, "model.activate", { targetType: "model", targetId: modelName, details: { role } });
    res.json({
      message: "Modele actif mis a jour.",
      role,
      activeModel: ollamaService.getActiveModel(),
      activeTextModel: ollamaService.getActiveModelByRole("text"),
      activeImageModel: ollamaService.getActiveModelByRole("image"),
      activeReasoningModel: ollamaService.getActiveModelByRole("reasoning")
    });
  } catch (error) {
    next(error);
  }
});

// Le modele d'embedding n'est pas un "role" au meme titre que text/image/reasoning :
// il n'est pas utilise pour generer des reponses mais pour indexer les documents,
// et changer de modele change la dimension des vecteurs. Toute collection Chroma
// existante devient donc incompatible et doit etre recalculee integralement.
router.put("/models/embedding", requireRole(["administrator", "owner"]), async (req, res, next) => {
  try {
    const modelName = ensureSafeIdentifier(req.body?.modelName, "Nom du modele d'embedding", { max: 120 });

    const installedModels = await ollamaService.listModels().catch(() => null);
    if (installedModels === null) {
      return res.status(503).json({
        message: "Le service Ollama est injoignable. Impossible de changer le modele d'embedding pour le moment."
      });
    }

    const isInstalled = installedModels.some(
      (model) => String(model.name || "").toLowerCase() === modelName.toLowerCase()
    );
    if (!isInstalled) {
      return res.status(400).json({
        message: "Ce modele n'est pas installe. Telechargez-le avant de l'utiliser pour l'indexation."
      });
    }

    if (getIndexingStatus().isRunning) {
      return res.status(409).json({
        message: "Une indexation est en cours. Attendez sa fin avant de changer le modele d'embedding."
      });
    }

    const previousModel = getSetting("embeddingModel", process.env.EMBEDDING_MODEL || "nomic-embed-text-v2-moe:latest");
    if (previousModel === modelName) {
      return res.json({
        message: "Ce modele d'embedding est deja actif.",
        embeddingModel: modelName,
        clearedCollections: 0,
        reindexQueued: false
      });
    }

    markActivity();
    setSetting("embeddingModel", modelName);

    const { clearedCollections } = await clearAllIndexes();
    resetAllDocumentIndexing();
    const job = await enqueueFullReindex({ trigger: "embedding-model-change" });

    logAudit(req, "model.embedding-change", {
      targetType: "model",
      targetId: modelName,
      details: { previousModel, clearedCollections }
    });

    res.json({
      message:
        "Modele d'embedding mis a jour. Tous les documents vont etre reindexes automatiquement avec ce nouveau modele.",
      embeddingModel: modelName,
      clearedCollections,
      reindexQueued: Boolean(job)
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/models/:name", async (req, res, next) => {
  try {
    const modelName = ensureSafeIdentifier(
      decodeURIComponent(req.params.name),
      "Nom du modele",
      { max: 120 }
    );

    if (ollamaService.isHiddenModel(modelName)) {
      return res.status(403).json({
        message: "Ce modele est reserve au fonctionnement interne et ne peut pas etre supprime."
      });
    }

    const models = await ollamaService.listVisibleModels();
    const installedModelNames = models.map((model) => model.name);
    if (!installedModelNames.includes(modelName)) {
      return res.status(404).json({
        message: "Modele introuvable."
      });
    }

    if (installedModelNames.length <= 1) {
      return res.status(400).json({
        message: "Impossible de supprimer le dernier modele disponible."
      });
    }

    const currentActiveModel = ollamaService.getActiveModel();
    let nextActiveModel = currentActiveModel;

    if (modelName === currentActiveModel) {
      nextActiveModel =
        installedModelNames.find((candidate) => candidate !== modelName) || currentActiveModel;
      ollamaService.setActiveModel(nextActiveModel);
    }

    markActivity();
    await ollamaService.deleteModel(modelName);
    logAudit(req, "model.delete", { targetType: "model", targetId: modelName });
    res.json({
      message:
        modelName === currentActiveModel
          ? "Modele supprime. Un autre modele a ete active automatiquement."
          : "Modele supprime avec succes.",
      activeModel: nextActiveModel
    });
  } catch (error) {
    next(error);
  }
});

router.post("/models/pull", async (req, res, next) => {
  try {
    const modelName = ensureSafeIdentifier(req.body?.modelName, "Nom du modele", { max: 120 });

    markActivity();

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache"
    });

    await ollamaService.pullModel(modelName, {
      onProgress: (payload) => {
        res.write(`${JSON.stringify(payload)}\n`);
      }
    });

    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.write(`${JSON.stringify({ error: true, message: error.message })}\n`);
      res.end();
      return;
    }

    next(error);
  }
});

router.use((req, _res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return adminMutationRateLimiter(req, _res, next);
  }

  return next();
});

router.get("/update/status", async (_req, res, next) => {
  try {
    const payload = await updateService.getUpdateStatus();
    res.json(payload);
  } catch (error) {
    if (error?.code === "UPDATER_UNAVAILABLE") {
      return res.json({
        currentVersion: null,
        latestVersion: null,
        updateAvailable: false,
        release: null,
        state: {
          busy: false,
          status: "unavailable",
          progress: 0,
          message: "Le service de mise a jour est temporairement indisponible.",
          logs: []
        }
      });
    }
    next(error);
  }
});

router.get("/update/backups", requireRole(["referent", "administrator", "owner"]), async (_req, res, next) => {
  try {
    const payload = await updateService.getUpdateBackups();
    res.json(payload);
  } catch (error) {
    if (error?.code === "UPDATER_UNAVAILABLE") {
      return res.json({
        backups: [],
        retention: 0,
        state: {
          busy: false,
          status: "unavailable",
          progress: 0,
          message: "Le service de mise a jour est temporairement indisponible.",
          logs: []
        }
      });
    }
    next(error);
  }
});

router.post("/update/apply", requireRole(["referent", "administrator", "owner"]), async (req, res, next) => {
  try {
    markActivity();
    const targetVersionRaw = String(req.body?.targetVersion || "").trim();
    const targetVersion = targetVersionRaw
      ? ensureSafeIdentifier(targetVersionRaw, "Version cible", { max: 40 })
      : "";
    const payload = await updateService.applyUpdate(targetVersion || undefined);
    logAudit(req, "update.apply", { targetType: "version", targetId: targetVersion || null });
    res.status(202).json(payload);
  } catch (error) {
    if (error?.code === "UPDATER_UNAVAILABLE") {
      return res.status(503).json({
        message: "Le service de mise a jour est temporairement indisponible."
      });
    }
    next(error);
  }
});

const AUTO_UPDATE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function ensureAutoUpdateTime(value) {
  const time = String(value || "").trim();
  if (!AUTO_UPDATE_TIME_PATTERN.test(time)) {
    const error = new Error("Heure invalide (format attendu HH:MM).");
    error.statusCode = 400;
    throw error;
  }
  return time;
}

router.get("/update/channel", requireRole(["referent", "administrator", "owner"]), (_req, res) => {
  res.json({ beta: getSetting("updateChannelBeta", "false") === "true" });
});

router.put("/update/channel", requireRole(["referent", "administrator", "owner"]), (req, res, next) => {
  try {
    const beta = parseOptionalBoolean(req.body?.beta);
    if (req.body?.beta !== undefined && beta === null) {
      const error = new Error("Valeur booleenne invalide pour 'beta'.");
      error.statusCode = 400;
      throw error;
    }

    if (beta !== null) {
      setSetting("updateChannelBeta", beta ? "true" : "false");
    }

    const payload = { beta: getSetting("updateChannelBeta", "false") === "true" };
    logAudit(req, "update.channel.update", { details: payload });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.get("/update/schedule", requireRole(["referent", "administrator", "owner"]), (_req, res) => {
  res.json({
    enabled: getSetting("autoUpdateEnabled", "false") === "true",
    time: getSetting("autoUpdateTime", "03:00")
  });
});

router.put("/update/schedule", requireRole(["referent", "administrator", "owner"]), (req, res, next) => {
  try {
    const enabled = parseOptionalBoolean(req.body?.enabled);
    const time = req.body?.time !== undefined ? ensureAutoUpdateTime(req.body.time) : null;

    if (enabled !== null) {
      setSetting("autoUpdateEnabled", enabled ? "true" : "false");
    }
    if (time !== null) {
      setSetting("autoUpdateTime", time);
    }

    const payload = {
      enabled: getSetting("autoUpdateEnabled", "false") === "true",
      time: getSetting("autoUpdateTime", "03:00")
    };
    logAudit(req, "update.schedule.update", { details: payload });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.post("/update/rollback", requireRole(["administrator", "owner"]), async (req, res, next) => {
  try {
    markActivity();
    const backupId = ensureSafeIdentifier(req.body?.backupId, "Sauvegarde", { max: 80 });
    const payload = await updateService.rollbackUpdate(backupId);
    logAudit(req, "update.rollback", { targetType: "backup", targetId: backupId });
    res.status(202).json(payload);
  } catch (error) {
    if (error?.code === "UPDATER_UNAVAILABLE") {
      return res.status(503).json({
        message: "Le service de mise a jour est temporairement indisponible."
      });
    }
    next(error);
  }
});

// Export et déploiement.
router.get("/deployment/ftp-config", requireRole(["administrator", "owner"]), (_req, res) => {
  const host = getSetting("deployFtpHost", "");
  const remoteDir = getSetting("deployFtpRemoteDir", "");
  const publicBaseUrl = getSetting("deployPublicBaseUrl", "");
  const hasUser = Boolean(getSetting("deployFtpUser", ""));
  const hasPassword = Boolean(getSetting("deployFtpPassword", ""));

  res.json({
    host,
    remoteDir,
    publicBaseUrl,
    hasUser,
    hasPassword,
    encryptionAvailable: isSecretsEncryptionAvailable(),
    configuredInDatabase: Boolean(host || hasUser || hasPassword || remoteDir)
  });
});

router.put("/deployment/ftp-config", requireRole(["administrator", "owner"]), (req, res, next) => {
  try {
    if (!isSecretsEncryptionAvailable()) {
      return res.status(400).json({
        message:
          "CONFIG_ENCRYPTION_KEY doit etre definie avant de stocker des identifiants FTP chiffres."
      });
    }

    const body = req.body || {};
    if (body.host !== undefined) {
      setSetting("deployFtpHost", ensureSafeText(body.host, "Hote FTP", { min: 0, max: 255 }));
    }
    if (body.remoteDir !== undefined) {
      setSetting(
        "deployFtpRemoteDir",
        ensureSafeText(body.remoteDir, "Dossier distant", { min: 0, max: 500 })
      );
    }
    if (body.publicBaseUrl !== undefined) {
      setSetting(
        "deployPublicBaseUrl",
        body.publicBaseUrl ? ensureSafeHttpUrl(body.publicBaseUrl, "URL publique") : ""
      );
    }
    if (body.user) {
      setSettingEncrypted("deployFtpUser", ensureSafeText(body.user, "Utilisateur FTP", { min: 1, max: 255 }));
    }
    if (body.password) {
      setSettingEncrypted(
        "deployFtpPassword",
        ensureSafeText(body.password, "Mot de passe FTP", { min: 1, max: 500 })
      );
    }

    logAudit(req, "deployment.ftp-config-update");
    res.json({ message: "Configuration FTP mise a jour et chiffree en base." });
  } catch (error) {
    next(error);
  }
});

router.get("/deployment/status", requireRole(["administrator", "owner"]), async (_req, res, next) => {
  try {
    const payload = await updateService.getDeploymentStatus();
    res.json(payload);
  } catch (error) {
    if (error?.code === "UPDATER_UNAVAILABLE") {
      return res.status(503).json({
        message: "Le service de mise a jour est temporairement indisponible."
      });
    }
    next(error);
  }
});

router.post("/deployment/publish", requireRole(["administrator", "owner"]), async (req, res, next) => {
  try {
    const version = req.body?.version
      ? ensureSafeIdentifier(req.body.version, "Version", { max: 40 })
      : "";
    const notes = ensureSafeText(req.body?.notes, "Note de version", { min: 1, max: 4000 });

    markActivity();
    const payload = await updateService.publishDeployment({ version, notes });
    logAudit(req, "deployment.publish", { targetType: "version", targetId: version || null });
    res.status(202).json(payload);
  } catch (error) {
    if (error?.code === "UPDATER_UNAVAILABLE") {
      return res.status(503).json({
        message: "Le service de mise a jour est temporairement indisponible."
      });
    }
    next(error);
  }
});

router.get("/index/status", async (_req, res, next) => {
  try {
    res.json(getIndexingStatus());
  } catch (error) {
    next(error);
  }
});

router.get("/index/logs", async (_req, res, next) => {
  try {
    res.json({
      logs: getRecentIndexationLogs()
    });
  } catch (error) {
    next(error);
  }
});

router.post("/index/reindex", async (_req, res, next) => {
  try {
    markActivity();
    const job = await enqueueFullReindex({ trigger: "manuel" });

    if (!job) {
      return res.status(409).json({
        message: "Une reindexation est deja en cours ou en attente."
      });
    }

    res.json({
      message: "Reindexation complete ajoutee a la file d'attente."
    });
  } catch (error) {
    next(error);
  }
});

router.post("/index/stop", async (_req, res, next) => {
  try {
    markActivity();
    const result = await cancelFullReindex();

    if (!result.stopped) {
      return res.status(409).json({
        message: result.message
      });
    }

    res.json({
      message: result.message
    });
  } catch (error) {
    next(error);
  }
});

router.post("/index/stop-all", async (_req, res, next) => {
  try {
    markActivity();
    const result = await stopAllIndexing();

    if (!result.stopped) {
      return res.status(409).json({
        message: result.message
      });
    }

    res.json({
      message: result.message
    });
  } catch (error) {
    next(error);
  }
});

router.post("/index/pause", async (_req, res, next) => {
  try {
    markActivity();
    const result = await pauseAllIndexing();
    res.json({
      message: result.message
    });
  } catch (error) {
    next(error);
  }
});

router.post("/index/resume", async (_req, res, next) => {
  try {
    markActivity();
    const result = await resumeAllIndexing();
    res.json({
      message: result.message
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/index", async (req, res, next) => {
  try {
    const confirmation = String(req.body?.confirmation || "").trim().toLowerCase();

    if (confirmation !== "supprimer") {
      return res.status(400).json({
        message:
          "Confirmation invalide. Ecrivez exactement 'supprimer'. Cette action est irreversible."
      });
    }

    if (getIndexingStatus().isRunning) {
      return res.status(409).json({
        message: "Une indexation est en cours. Attendez sa fin avant de tout supprimer."
      });
    }

    markActivity();
    const { clearedCollections } = await clearAllIndexes();
    resetAllDocumentIndexing();

    res.json({
      message:
        "Toutes les indexations ont ete supprimees. Cette action est irreversible. Les documents devront etre reindexes ensuite.",
      clearedCollections
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/index/auto", async (req, res, next) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ message: "La valeur enabled doit etre booleenne." });
    }

    markActivity();
    setSetting("autoIndexEnabled", String(enabled));
    res.json({
      message: enabled
        ? "Indexation automatique activee."
        : "Indexation automatique desactivee.",
      enabled
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/system/data", async (req, res, next) => {
  try {
    const confirmation = String(req.body?.confirmation || "").trim().toLowerCase();

    if (confirmation !== "supprimer") {
      return res.status(400).json({
        message:
          "Confirmation invalide. Ecrivez exactement 'supprimer'. Cette action est irreversible."
      });
    }

    if (getIndexingStatus().isRunning) {
      return res.status(409).json({
        message: "Une indexation est en cours. Attendez sa fin avant de tout supprimer."
      });
    }

    markActivity();
    await clearAllIndexes();
    await fileService.resetUploadsStorage();
    purgeAllProjectData();
    clearIndexationLogs();
    logAudit(req, "system.purge-all-data", {});
    res.json({
      message:
        "Toutes les donnees du projet ont ete supprimees definitivement. Cette action est irreversible."
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/system/conversations-feedback", async (req, res, next) => {
  try {
    const confirmation = String(req.body?.confirmation || "").trim().toLowerCase();

    if (confirmation !== "supprimer") {
      return res.status(400).json({
        message:
          "Confirmation invalide. Ecrivez exactement 'supprimer'. Cette action est irreversible."
      });
    }

    purgeConversationFeedbackData();
    logAudit(req, "system.purge-conversations-feedback", {});

    res.json({
      message:
        "Toutes les conversations et tous les feedbacks ont ete supprimes definitivement. Cette action est irreversible."
    });
  } catch (error) {
    next(error);
  }
});

router.get("/retrieval-scores", async (req, res, next) => {
  try {
    const limit = req.query?.limit ? parsePositiveInt(req.query.limit, "Limite") : 500;
    res.json(getRetrievalScoreSummary({ limit }));
  } catch (error) {
    next(error);
  }
});

router.get("/analytics/top-questions", async (req, res, next) => {
  try {
    const limit = req.query?.limit ? parsePositiveInt(req.query.limit, "Limite") : 20;
    res.json({ questions: getTopQuestions({ limit }) });
  } catch (error) {
    next(error);
  }
});

router.get("/analytics/unanswered-questions", async (req, res, next) => {
  try {
    const limit = req.query?.limit ? parsePositiveInt(req.query.limit, "Limite") : 20;
    res.json({ questions: getUnansweredQuestions({ limit }) });
  } catch (error) {
    next(error);
  }
});

// Journal d'audit.
router.get("/audit-log", requireRole(["administrator", "owner"]), async (req, res, next) => {
  try {
    const page = req.query?.page ? parsePositiveInt(req.query.page, "Page") : 1;
    const pageSize = req.query?.pageSize ? parsePositiveInt(req.query.pageSize, "Taille de page") : 50;
    res.json(listAuditLogEntries({ page, pageSize }));
  } catch (error) {
    next(error);
  }
});

function ensureAdminRole(value) {
  if (value === "referent" || value === "administrator") {
    return value;
  }
  const error = new Error("Rôle de compte invalide.");
  error.statusCode = 400;
  throw error;
}

function ensureAdminIdentifiant(value) {
  const identifiant = ensureSafeText(value, "Identifiant", { min: 3, max: 120 });
  if (!/^[\p{L}\p{N}._@-]+$/u.test(identifiant)) {
    const error = new Error("Identifiant invalide (lettres, chiffres, . _ @ - uniquement).");
    error.statusCode = 400;
    throw error;
  }
  return identifiant;
}

function requireExistingAdminUser(id) {
  const target = getAdminUserById(id);
  if (!target) {
    const error = new Error("Compte introuvable.");
    error.statusCode = 404;
    throw error;
  }
  return target;
}

// Comptes admin nommes (identifiant + mot de passe propres) : reserve au role
// Gestion des comptes nommés.
router.get("/admin-users", requireRole(["administrator", "owner"]), (_req, res, next) => {
  try {
    res.json({ users: listAdminUsers() });
  } catch (error) {
    next(error);
  }
});

router.post("/admin-users", requireRole(["administrator", "owner"]), async (req, res, next) => {
  try {
    const identifiant = ensureAdminIdentifiant(req.body?.identifiant);
    const password = ensureSafeText(req.body?.password, "Mot de passe", { min: 12, max: 256 });
    const role = ensureAdminRole(req.body?.role);

    const passwordHash = await bcrypt.hash(password, 12);
    let user;
    try {
      user = createAdminUser({ identifier: identifiant, passwordHash, role });
    } catch (dbError) {
      if (String(dbError?.code || "").includes("CONSTRAINT")) {
        const error = new Error("Cet identifiant est deja utilise.");
        error.statusCode = 409;
        throw error;
      }
      throw dbError;
    }

    logAudit(req, "admin-users.create", {
      targetType: "admin_user",
      targetId: user.id,
      details: { identifiant, role }
    });
    res.status(201).json({ user });
  } catch (error) {
    next(error);
  }
});

router.put("/admin-users/:id/password", requireRole(["administrator", "owner"]), async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, "Identifiant du compte");
    const password = ensureSafeText(req.body?.password, "Mot de passe", { min: 12, max: 256 });
    requireExistingAdminUser(id);

    const passwordHash = await bcrypt.hash(password, 12);
    updateAdminUserPasswordById(id, passwordHash);
    logAudit(req, "admin-users.reset-password", { targetType: "admin_user", targetId: id });
    res.json({ message: "Mot de passe mis a jour." });
  } catch (error) {
    next(error);
  }
});

router.put("/admin-users/:id/role", requireRole(["administrator", "owner"]), (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, "Identifiant du compte");
    const role = ensureAdminRole(req.body?.role);
    const target = requireExistingAdminUser(id);

    if (target.role === "administrator" && role !== "administrator" && countAdminUsersByRole("administrator") <= 1) {
      const error = new Error("Impossible de retirer le rôle du dernier compte principal.");
      error.statusCode = 400;
      throw error;
    }

    updateAdminUserRoleById(id, role);
    logAudit(req, "admin-users.update-role", { targetType: "admin_user", targetId: id, details: { role } });
    res.json({ message: "Role mis a jour." });
  } catch (error) {
    next(error);
  }
});

router.delete("/admin-users/:id", requireRole(["administrator", "owner"]), (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, "Identifiant du compte");
    if (req.user.adminUserId === id) {
      const error = new Error("Vous ne pouvez pas supprimer votre propre compte.");
      error.statusCode = 400;
      throw error;
    }

    const target = requireExistingAdminUser(id);
    if (target.role === "administrator" && countAdminUsersByRole("administrator") <= 1) {
      const error = new Error("Impossible de supprimer le dernier compte principal.");
      error.statusCode = 400;
      throw error;
    }

    deleteAdminUser(id);
    logAudit(req, "admin-users.delete", { targetType: "admin_user", targetId: id });
    res.json({ message: "Compte supprime." });
  } catch (error) {
    next(error);
  }
});

export default router;
