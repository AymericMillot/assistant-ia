import express from "express";
import path from "path";
import { getLiveChatEstimate } from "../services/analyticsService.js";
import { getDocumentById, getSetting } from "../config/db.js";
import {
  ATTACHMENTS_TEMPORARILY_DISABLED,
  ATTACHMENTS_DISABLED_REASON
} from "../config/featureFlags.js";
import {
  buildAnonymousUserId,
  resolveConversationSessionId,
  saveConversationExchange
} from "../services/conversationService.js";
import {
  generateChatResponse,
  processDirectChatRequest,
  registerChatStream,
  cancelChatJobsForClient,
  getCurrentQueueDepth
} from "../services/queueService.js";
import { getAbsoluteDocumentPath, listFolders } from "../services/fileService.js";
import { getActiveModel, getActiveModelByRole } from "../services/ollamaService.js";
import { getConversationContextSummary } from "../services/ragService.js";
import { markActivity } from "../services/schedulerService.js";
import {
  attachmentUploadMiddleware,
  saveUserAttachment
} from "../services/attachmentService.js";
import { recordAnswerRating } from "../services/ratingService.js";
import {
  createRateLimiter,
  ensureSafeText,
  ensureUuidLike,
  parsePositiveInt
} from "../utils/security.js";

const router = express.Router();
const chatEstimateRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: Number(process.env.CHAT_ESTIMATE_RATE_LIMIT || 80),
  keyPrefix: "chat-estimate",
  message: "Trop de demandes d'estimation. Reessayez dans une minute."
});
const chatStreamRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: Number(process.env.CHAT_STREAM_RATE_LIMIT || 30),
  keyPrefix: "chat-stream",
  message: "Trop de questions en peu de temps. Reessayez dans quelques minutes."
});
const attachmentRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.CHAT_ATTACHMENT_RATE_LIMIT || 12),
  keyPrefix: "chat-attachment",
  message: "Trop de pièces jointes en peu de temps. Réessayez plus tard."
});
const ratingRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: Number(process.env.CHAT_RATING_RATE_LIMIT || 40),
  keyPrefix: "chat-rating",
  message: "Trop d'évaluations en peu de temps. Réessayez dans quelques minutes."
});
// Le raisonnement approfondi est nettement plus coûteux en ressources qu'une
// reponse normale : limite dediee et stricte (independante du rate limit
// general du chat), qui ne s'applique que lorsque le mode est demande.
const reasoningRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 1,
  keyPrefix: "chat-reasoning",
  message: "Le raisonnement approfondi est limité à une utilisation toutes les 5 minutes. Réessayez plus tard."
});

function requireReasoningRateLimit(req, res, next) {
  if (req.body?.useReasoningModel) {
    return reasoningRateLimiter(req, res, next);
  }

  next();
}

function parseAttachmentIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .slice(0, 3)
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry > 0)
    )
  ];
}

function writeSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sanitizeConversationMessages(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .slice(-10)
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      if (entry.role !== "user" && entry.role !== "assistant") {
        return null;
      }

      try {
        return {
          role: entry.role,
          content: ensureSafeText(entry.content, "Contenu d'historique", { min: 1, max: 4000 })
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function extractConversationPayload(body) {
  const sessionId = resolveConversationSessionId(body?.sessionId);
  const rawMessages = sanitizeConversationMessages(body?.messages);

  if (rawMessages.length > 0) {
    const lastUserIndex = [...rawMessages]
      .reverse()
      .findIndex((entry) => entry.role === "user");

    if (lastUserIndex === -1) {
      throw new Error("Le dernier message utilisateur est introuvable.");
    }

    const userIndex = rawMessages.length - 1 - lastUserIndex;
    const question = ensureSafeText(rawMessages[userIndex].content, "Question", {
      min: 1,
      max: 4000
    });
    const history = rawMessages.filter((_, index) => index !== userIndex);

    return {
      question,
      history,
      sessionId
    };
  }

  return {
    question: ensureSafeText(body?.question ?? body?.message, "Question", { min: 1, max: 4000 }),
    history: sanitizeConversationMessages(body?.history),
    sessionId
  };
}

router.get("/folders", async (_req, res, next) => {
  try {
    const folders = await listFolders();
    res.json({
      folders: ["all", ...folders]
    });
  } catch (error) {
    next(error);
  }
});

router.post("/estimate", chatEstimateRateLimiter, async (req, res, next) => {
  try {
    const question = req.body?.question ? ensureSafeText(req.body.question, "Question", { max: 4000 }) : "";
    const useReasoningModel = Boolean(req.body?.useReasoningModel);
    // Le modele de raisonnement est nettement plus lent : l'estimer avec le modele de
    // conversation habituel donnerait un temps trompeur quand l'option est activee.
    const modelName = (useReasoningModel && getActiveModelByRole("reasoning")) || getActiveModel();
    const queueDepth = await getCurrentQueueDepth();
    const estimate = getLiveChatEstimate({
      question,
      folderName: "all",
      modelName,
      queueDepth
    });

    res.json(estimate);
  } catch (error) {
    next(error);
  }
});

router.post("/", chatStreamRateLimiter, requireReasoningRateLimit, async (req, res, next) => {
  try {
    const { question, history, sessionId } = extractConversationPayload(req.body);
    const attachmentIds = parseAttachmentIds(req.body?.attachmentIds);
    const useReasoningModel = Boolean(req.body?.useReasoningModel);
    markActivity();

    const payload = await generateChatResponse({
      question,
      folderName: "all",
      history,
      attachmentIds,
      useReasoningModel
    });
    let savedExchange = null;

    try {
      savedExchange = saveConversationExchange({
        sessionId,
        userId: buildAnonymousUserId(req),
        question,
        answer: payload.text,
        retrievalMetadata: payload.retrievalMetadata
      });
    } catch {
      // L'utilisateur doit quand même recevoir sa réponse, même si l'archivage échoue.
    }

    res.json({
      ...payload,
      sessionId,
      conversationId: savedExchange?.conversation?.id || null,
      exchangeId: savedExchange?.exchange?.id || null
    });
  } catch (error) {
    next(error);
  }
});

function handleAttachmentUpload(req, res, next) {
  attachmentUploadMiddleware.single("file")(req, res, (error) => {
    if (error?.name === "MulterError" && error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        message: "La pièce jointe dépasse la taille maximale autorisée de 2 Mo."
      });
    }

    next(error);
  });
}

function requireAttachmentsEnabled(req, res, next) {
  // Verrou de code (v1.1.2) : prime sur le reglage d'administration.
  if (ATTACHMENTS_TEMPORARILY_DISABLED) {
    return res.status(503).json({
      message: ATTACHMENTS_DISABLED_REASON,
      code: "ATTACHMENTS_TEMPORARILY_DISABLED"
    });
  }

  if (getSetting("attachmentsEnabled", "true") !== "true") {
    return res.status(403).json({
      message: "Les pièces jointes sont désactivées par l'administrateur."
    });
  }

  next();
}

router.post(
  "/attachments",
  attachmentRateLimiter,
  requireAttachmentsEnabled,
  handleAttachmentUpload,
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "Aucun fichier n'a été envoyé." });
      }

      const sessionId = req.body?.sessionId
        ? ensureUuidLike(req.body.sessionId, "Identifiant de session")
        : null;
      const question = req.body?.question
        ? ensureSafeText(req.body.question, "Question", { max: 4000 })
        : null;

      markActivity();
      const payload = await saveUserAttachment(req.file, { sessionId, question });

      res.status(201).json({
        message: "Pièce jointe reçue. L'assistant peut maintenant s'en servir.",
        ...payload
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post("/rate", ratingRateLimiter, async (req, res, next) => {
  try {
    const sessionId = ensureUuidLike(req.body?.sessionId, "Identifiant de session");
    const rating = String(req.body?.rating || "").trim().toLowerCase();
    const exchangeId =
      req.body?.exchangeId === undefined || req.body?.exchangeId === null || req.body?.exchangeId === ""
        ? null
        : parsePositiveInt(req.body.exchangeId, "Échange");

    if (rating !== "up" && rating !== "down") {
      return res.status(400).json({ message: "Évaluation invalide." });
    }

    markActivity();
    const saved = recordAnswerRating({ sessionId, exchangeId, rating });

    res.json({
      message:
        rating === "up"
          ? "Merci pour votre retour positif !"
          : "Merci pour votre retour. Il aidera à améliorer les prochaines réponses.",
      rating: saved
    });
  } catch (error) {
    next(error);
  }
});

router.get("/documents/:id/download", async (req, res, next) => {
  try {
    const document = getDocumentById(parsePositiveInt(req.params.id, "Document"));
    if (!document || document.visibility !== "public") {
      return res.status(404).json({ message: "Document public introuvable." });
    }

    const absolutePath = getAbsoluteDocumentPath(document.relative_path);
    const fileName = document.original_name || path.basename(document.relative_path);
    const wantsInline = String(req.query?.disposition || "").toLowerCase() === "inline";

    if (wantsInline) {
      if (document.mime_type) {
        res.type(document.mime_type);
      }
      res.setHeader("Content-Disposition", `inline; filename="${fileName.replace(/"/g, "")}"`);
      return res.sendFile(absolutePath);
    }

    res.download(absolutePath, fileName);
  } catch (error) {
    next(error);
  }
});

router.post("/stream", chatStreamRateLimiter, requireReasoningRateLimit, async (req, res, next) => {
  try {
    const { question, history, sessionId } = extractConversationPayload(req.body);
    const clientId = ensureUuidLike(req.body?.clientId, "Identifiant client");
    const attachmentIds = parseAttachmentIds(req.body?.attachmentIds);
    const useReasoningModel = Boolean(req.body?.useReasoningModel);

    markActivity();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    registerChatStream(clientId, res);
    writeSseEvent(res, "session", { sessionId });

    const contextModelName = (useReasoningModel && getActiveModelByRole("reasoning")) || getActiveModel();
    writeSseEvent(res, "context", await getConversationContextSummary(history, contextModelName));

    res.on("close", async () => {
      if (res.writableEnded) {
        return;
      }

      await cancelChatJobsForClient(clientId);
    });

    // L'échange est archivé avant l'événement final pour que le client reçoive
    // les identifiants nécessaires à l'évaluation de la réponse.
    await processDirectChatRequest({
      clientId,
      question,
      folderName: "all",
      history,
      attachmentIds,
      useReasoningModel,
      persistExchange: (finalText, retrievalMetadata) =>
        saveConversationExchange({
          sessionId,
          userId: buildAnonymousUserId(req),
          question,
          answer: finalText,
          retrievalMetadata
        })
    });
  } catch (error) {
    next(error);
  }
});

router.post("/cancel", async (req, res, next) => {
  try {
    const clientId = ensureUuidLike(req.body?.clientId, "Identifiant client");
    await cancelChatJobsForClient(clientId);
    res.json({
      success: true,
      message: "Generation interrompue."
    });
  } catch (error) {
    next(error);
  }
});

export default router;
