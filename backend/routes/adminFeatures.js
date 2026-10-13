import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import express from "express";
import multer from "multer";
import {
  createManualResource,
  deleteSkill,
  dismissUnansweredQuestion,
  getActivityOverview,
  getConversationExchangeById,
  getDocumentStats,
  getSetting,
  getSkillById,
  getTopQuestions,
  getUnansweredQuestions,
  insertAuditLogEntry,
  listAuditLogForExport,
  listExchangesForExport,
  listFeedbackForExport,
  listRatingsForExport,
  listSkills
} from "../config/db.js";
import { logger } from "../config/logger.js";
import { requireRole } from "../middleware/authMiddleware.js";
import {
  createBackup,
  deleteBackup,
  getBackupFilePath,
  getBackupOverview,
  getDiskUsage,
  restoreBackup,
  restoreUploadedBackup,
  setBackupSchedule
} from "../services/backupService.js";
import {
  getChatHomeSettings,
  saveAnnouncementSettings,
  saveSuggestionSettings
} from "../services/chatHomeService.js";
import { getIndexingStatus } from "../services/queueService.js";
import { computeTextOverlapScore } from "../services/ragService.js";
import {
  createSkillFromInput,
  installSkillTemplate,
  listSkillTemplates,
  parseSkillUpload,
  saveImportedSkills,
  selectSkillsForQuestion,
  serializeSkillMarkdown,
  updateSkillFromInput
} from "../services/skillService.js";
import { getActiveModel } from "../services/ollamaService.js";
import { sendCsv } from "../utils/csv.js";
import { ensureSafeText, ensureSafeIdentifier, parsePositiveInt } from "../utils/security.js";

const router = express.Router();
const elevatedRoles = ["administrator", "owner"];

function logAudit(req, action, { targetType = null, targetId = null, details = null } = {}) {
  try {
    insertAuditLogEntry({
      actorRole: req.user?.role || "unknown",
      action,
      targetType,
      targetId,
      details: { ...(details || {}), actor: req.user?.identifiant || req.user?.role || null }
    });
  } catch (error) {
    logger.warn("Journalisation d'audit ignoree.", { message: error.message, action });
  }
}

// --- Tableau de bord -----------------------------------------------------------

router.get("/dashboard", async (_req, res, next) => {
  try {
    const activity = getActivityOverview({ days: 14 });
    const unansweredWeek = getUnansweredQuestions({ limit: 1000, sinceDays: 7 });
    const skills = listSkills();

    res.json({
      activity,
      unansweredWeekCount: unansweredWeek.length,
      latestUnanswered: unansweredWeek.slice(0, 5).map(({ id, question, createdAt }) => ({ id, question, createdAt })),
      topQuestionsWeek: getTopQuestions({ limit: 5, sinceDays: 7 }),
      documents: getDocumentStats(),
      indexing: getIndexingStatus(),
      activeModel: getActiveModel(),
      embeddingModel: getSetting("embeddingModel", process.env.EMBEDDING_MODEL || "embeddinggemma-2:740m"),
      skills: {
        total: skills.length,
        enabled: skills.filter((skill) => skill.isEnabled).length
      },
      backups: {
        lastBackupAt: getSetting("lastBackupAt", "") || null
      },
      disk: await getDiskUsage()
    });
  } catch (error) {
    next(error);
  }
});

// --- Questions sans reponse : traitement direct ---------------------------------

router.post("/analytics/unanswered-questions/:id/dismiss", (req, res, next) => {
  try {
    const exchangeId = parsePositiveInt(req.params.id, "Question");
    if (!getConversationExchangeById(exchangeId)) {
      return res.status(404).json({ message: "Question introuvable." });
    }

    dismissUnansweredQuestion(exchangeId, "dismissed");
    res.json({ message: "Question écartée des questions sans réponse." });
  } catch (error) {
    next(error);
  }
});

router.post("/analytics/unanswered-questions/:id/resource", (req, res, next) => {
  try {
    const exchangeId = parsePositiveInt(req.params.id, "Question");
    if (!getConversationExchangeById(exchangeId)) {
      return res.status(404).json({ message: "Question introuvable." });
    }

    const title = ensureSafeText(req.body?.title, "Titre", { min: 1, max: 160 });
    const content = ensureSafeText(req.body?.content, "Contenu", { min: 1, max: 12000 });
    const resource = createManualResource({ title, content, isEnabled: true });
    dismissUnansweredQuestion(exchangeId, "resource");
    logAudit(req, "analytics.unanswered-to-resource", {
      targetType: "manual_resource",
      targetId: resource.id,
      details: { exchangeId }
    });

    res.status(201).json({
      message: "Personnalisation créée : l'assistant s'en servira dès la prochaine question.",
      resource: { id: resource.id, title: resource.title }
    });
  } catch (error) {
    next(error);
  }
});

// --- Exports CSV -------------------------------------------------------------------

function formatGroundingMode(rawMetadata) {
  try {
    const metadata = JSON.parse(rawMetadata || "{}");
    return metadata.groundingMode || "";
  } catch {
    return "";
  }
}

const exportDefinitions = {
  questions: {
    fileName: "questions-reponses",
    roles: null,
    load: (req) => listExchangesForExport({ sinceDays: Number(req.query?.days) || 90 }),
    columns: [
      { label: "Date", key: "created_at" },
      { label: "Conversation", key: "conversation_id" },
      { label: "Question", key: "question" },
      { label: "Réponse", key: "answer" },
      { label: "Fondement", value: (row) => formatGroundingMode(row.retrieval_metadata) },
      { label: "Évaluation", value: (row) => (row.rating === "up" ? "utile" : row.rating === "down" ? "insatisfaisante" : "") }
    ]
  },
  "top-questions": {
    fileName: "questions-frequentes",
    roles: null,
    load: () => getTopQuestions({ limit: 500 }),
    columns: [
      { label: "Question", key: "question" },
      { label: "Occurrences", key: "occurrences" },
      { label: "Conversations", key: "conversationCount" },
      { label: "Dernière fois", key: "lastAskedAt" }
    ]
  },
  unanswered: {
    fileName: "questions-sans-reponse",
    roles: null,
    load: () => getUnansweredQuestions({ limit: 1000 }),
    columns: [
      { label: "Date", key: "createdAt" },
      { label: "Conversation", key: "conversationId" },
      { label: "Question", key: "question" },
      { label: "Réponse donnée", key: "answer" }
    ]
  },
  ratings: {
    fileName: "evaluations",
    roles: null,
    load: () => listRatingsForExport(),
    columns: [
      { label: "Date", key: "created_at" },
      { label: "Évaluation", value: (row) => (row.rating === "up" ? "utile" : "insatisfaisante") },
      { label: "Question", key: "question" },
      { label: "Réponse", key: "answer" }
    ]
  },
  feedback: {
    fileName: "corrections",
    roles: null,
    load: () => listFeedbackForExport(),
    columns: [
      { label: "Date", key: "created_at" },
      { label: "Statut", key: "feedback_status" },
      { label: "Question", key: "question" },
      { label: "Réponse d'origine", key: "original_answer" },
      { label: "Réponse corrigée", key: "corrected_response" },
      { label: "Consignes", key: "instructions" }
    ]
  },
  audit: {
    fileName: "journal-audit",
    roles: elevatedRoles,
    load: () => listAuditLogForExport(),
    columns: [
      { label: "Date", key: "created_at" },
      { label: "Rôle", key: "actor_role" },
      { label: "Action", key: "action" },
      { label: "Cible", value: (row) => [row.target_type, row.target_id].filter(Boolean).join(" #") },
      { label: "Détails", key: "details" }
    ]
  }
};

router.get("/exports/:dataset", (req, res, next) => {
  try {
    const definition = exportDefinitions[String(req.params.dataset || "")];
    if (!definition) {
      return res.status(404).json({ message: "Export inconnu." });
    }

    if (definition.roles && !definition.roles.includes(req.user?.role)) {
      return res.status(403).json({ message: "Cette action n'est pas autorisee." });
    }

    const rows = definition.load(req);
    const date = new Date().toISOString().slice(0, 10);
    logAudit(req, "export.csv", { targetType: "export", targetId: req.params.dataset, details: { rows: rows.length } });
    sendCsv(res, `${definition.fileName}-${date}.csv`, definition.columns, rows);
  } catch (error) {
    next(error);
  }
});

// --- Accueil du chat (annonce + suggestions) ---------------------------------------

router.get("/chat-home", (_req, res, next) => {
  try {
    res.json(getChatHomeSettings());
  } catch (error) {
    next(error);
  }
});

router.put("/chat-home/announcement", (req, res, next) => {
  try {
    const announcement = saveAnnouncementSettings({
      enabled: req.body?.enabled === true,
      message: req.body?.message,
      tone: req.body?.tone,
      expiresAt: req.body?.expiresAt || null
    });
    logAudit(req, "chat-home.announcement", { details: { enabled: announcement.enabled } });
    res.json({ message: announcement.enabled ? "Annonce publiée." : "Annonce désactivée.", ...getChatHomeSettings() });
  } catch (error) {
    next(error);
  }
});

router.put("/chat-home/suggestions", (req, res, next) => {
  try {
    const suggestions = saveSuggestionSettings({
      mode: String(req.body?.mode || ""),
      manual: req.body?.manual
    });
    logAudit(req, "chat-home.suggestions", { details: { mode: suggestions.mode } });
    res.json({ message: "Suggestions enregistrées.", ...getChatHomeSettings() });
  } catch (error) {
    next(error);
  }
});

// --- Skills ---------------------------------------------------------------------------

const skillUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!/\.(md|markdown|txt|zip)$/i.test(file.originalname || "")) {
      const error = new Error("Format non pris en charge : déposez un fichier .md, .txt ou .zip.");
      error.statusCode = 400;
      callback(error);
      return;
    }
    callback(null, true);
  }
});

function parseSkillBody(body = {}) {
  return {
    title: body.title,
    description: body.description,
    instructions: body.instructions,
    triggers: Array.isArray(body.triggers) ? body.triggers : String(body.triggers || ""),
    activation: body.activation,
    userSelectable: body.userSelectable,
    isEnabled: body.isEnabled
  };
}

router.get("/skills", (_req, res, next) => {
  try {
    res.json({ skills: listSkills(), templates: listSkillTemplates() });
  } catch (error) {
    next(error);
  }
});

router.post("/skills", (req, res, next) => {
  try {
    const skill = createSkillFromInput(parseSkillBody(req.body));
    logAudit(req, "skills.create", { targetType: "skill", targetId: skill.id, details: { title: skill.title } });
    res.status(201).json({ message: "Skill créé.", skill });
  } catch (error) {
    next(error);
  }
});

router.post("/skills/import", (req, res, next) => {
  skillUploadMiddleware.single("file")(req, res, (uploadError) => {
    if (uploadError) {
      if (uploadError.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ message: "Fichier trop volumineux (2 Mo maximum)." });
      }
      return next(uploadError);
    }

    try {
      if (!req.file) {
        return res.status(400).json({ message: "Aucun fichier n'a été envoyé." });
      }

      const parsed = parseSkillUpload({ buffer: req.file.buffer, originalName: req.file.originalname });
      const results = saveImportedSkills(parsed);
      logAudit(req, "skills.import", {
        details: { file: req.file.originalname.slice(0, 120), count: results.length }
      });

      const created = results.filter((entry) => entry.status === "created").length;
      const updated = results.length - created;
      res.status(201).json({
        message: `${results.length} skill(s) importé(s) : ${created} créé(s), ${updated} mis à jour.`,
        skills: results.map((entry) => entry.skill)
      });
    } catch (error) {
      next(error);
    }
  });
});

router.post("/skills/templates/:slug", (req, res, next) => {
  try {
    const slug = ensureSafeIdentifier(req.params.slug, "Modèle", { max: 80 });
    const { skill, status } = installSkillTemplate(slug);
    if (status === "created") {
      logAudit(req, "skills.install-template", { targetType: "skill", targetId: skill.id, details: { slug } });
    }
    res.status(status === "created" ? 201 : 200).json({
      message: status === "created" ? "Modèle installé." : "Ce modèle est déjà installé.",
      skill
    });
  } catch (error) {
    next(error);
  }
});

router.post("/skills/test", (req, res, next) => {
  try {
    const question = ensureSafeText(req.body?.question, "Question", { min: 1, max: 4000 });
    const explicitSkillId = req.body?.skillId ? parsePositiveInt(req.body.skillId, "Skill") : null;
    const selected = selectSkillsForQuestion(question, {
      explicitSkillId,
      overlapScorer: computeTextOverlapScore
    });
    res.json({
      skills: selected.map((skill) => ({
        id: skill.id,
        title: skill.title,
        reason: skill.reason,
        matchScore: skill.matchScore
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.get("/skills/:id/export", (req, res, next) => {
  try {
    const skill = getSkillById(parsePositiveInt(req.params.id, "Skill"));
    if (!skill) {
      return res.status(404).json({ message: "Skill introuvable." });
    }

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${skill.slug}.md"`);
    res.send(serializeSkillMarkdown(skill));
  } catch (error) {
    next(error);
  }
});

router.patch("/skills/:id", (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, "Skill");
    const updates = {};
    Object.entries(parseSkillBody(req.body)).forEach(([key, value]) => {
      if (req.body?.[key] !== undefined) {
        updates[key] = value;
      }
    });
    const skill = updateSkillFromInput(id, updates);
    logAudit(req, "skills.update", { targetType: "skill", targetId: id });
    res.json({ message: "Skill mis à jour.", skill });
  } catch (error) {
    next(error);
  }
});

router.delete("/skills/:id", (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, "Skill");
    const skill = getSkillById(id);
    if (!skill) {
      return res.status(404).json({ message: "Skill introuvable." });
    }

    deleteSkill(id);
    logAudit(req, "skills.delete", { targetType: "skill", targetId: id, details: { title: skill.title } });
    res.json({ message: "Skill supprimé." });
  } catch (error) {
    next(error);
  }
});

// --- Sauvegardes (administrateur uniquement : contiennent toute l'instance) -------

const backupUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, os.tmpdir()),
    filename: (_req, _file, callback) =>
      callback(null, `assistant-ia-upload-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`)
  }),
  limits: {
    fileSize: Number(process.env.BACKUP_UPLOAD_MAX_BYTES || 4 * 1024 * 1024 * 1024),
    files: 1
  }
});

router.get("/backups", requireRole(elevatedRoles), async (_req, res, next) => {
  try {
    res.json(await getBackupOverview());
  } catch (error) {
    next(error);
  }
});

router.post("/backups", requireRole(elevatedRoles), async (req, res, next) => {
  try {
    const backup = await createBackup({ trigger: "manuel" });
    logAudit(req, "backup.create", { targetType: "backup", targetId: backup.name });
    res.status(201).json({ message: "Sauvegarde créée.", backup, ...(await getBackupOverview()) });
  } catch (error) {
    next(error);
  }
});

router.put("/backups/schedule", requireRole(elevatedRoles), async (req, res, next) => {
  try {
    const schedule = setBackupSchedule({
      enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined,
      time: req.body?.time,
      retention: req.body?.retention === undefined ? undefined : Number(req.body.retention)
    });
    logAudit(req, "backup.schedule", { details: schedule });
    res.json({ message: "Planification enregistrée.", ...(await getBackupOverview()) });
  } catch (error) {
    next(error);
  }
});

router.get("/backups/:name/download", requireRole(elevatedRoles), (req, res, next) => {
  try {
    const filePath = getBackupFilePath(req.params.name);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "Sauvegarde introuvable." });
    }

    logAudit(req, "backup.download", { targetType: "backup", targetId: req.params.name });
    res.download(filePath, path.basename(filePath));
  } catch (error) {
    next(error);
  }
});

router.delete("/backups/:name", requireRole(elevatedRoles), async (req, res, next) => {
  try {
    await deleteBackup(req.params.name);
    logAudit(req, "backup.delete", { targetType: "backup", targetId: req.params.name });
    res.json({ message: "Sauvegarde supprimée.", ...(await getBackupOverview()) });
  } catch (error) {
    if (error.code === "ENOENT") {
      return res.status(404).json({ message: "Sauvegarde introuvable." });
    }
    next(error);
  }
});

function ensureRestoreConfirmation(req) {
  if (String(req.body?.confirmation || "").trim().toLowerCase() !== "restaurer") {
    const error = new Error("Confirmation invalide. Écrivez exactement « restaurer ».");
    error.statusCode = 400;
    throw error;
  }
}

router.post("/backups/:name/restore", requireRole(elevatedRoles), async (req, res, next) => {
  try {
    ensureRestoreConfirmation(req);
    const result = await restoreBackup(req.params.name, { actor: req.user?.identifiant || req.user?.role });
    logAudit(req, "backup.restore", { targetType: "backup", targetId: req.params.name, details: result });
    res.json({
      message:
        "Sauvegarde restaurée. Les documents sont en cours de réindexation ; reconnectez-vous si votre session a expiré.",
      ...result
    });
  } catch (error) {
    next(error);
  }
});

router.post("/backups/restore-upload", requireRole(elevatedRoles), (req, res, next) => {
  backupUploadMiddleware.single("archive")(req, res, async (uploadError) => {
    const uploadedPath = req.file?.path;
    try {
      if (uploadError) {
        if (uploadError.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ message: "Archive trop volumineuse." });
        }
        throw uploadError;
      }

      if (!uploadedPath) {
        return res.status(400).json({ message: "Aucune archive n'a été envoyée." });
      }

      ensureRestoreConfirmation(req);
      const result = await restoreUploadedBackup(uploadedPath, { actor: req.user?.identifiant || req.user?.role });
      logAudit(req, "backup.restore-upload", { details: { ...result, file: String(req.file.originalname || "").slice(0, 120) } });
      res.json({
        message:
          "Sauvegarde restaurée. Les documents sont en cours de réindexation ; reconnectez-vous si votre session a expiré.",
        ...result
      });
    } catch (error) {
      next(error);
    } finally {
      if (uploadedPath) {
        await fsp.rm(uploadedPath, { force: true }).catch(() => undefined);
      }
    }
  });
});

export default router;
