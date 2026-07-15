import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import multer from "multer";
import {
  deleteUserAttachmentById,
  getExpiredUserAttachments,
  getUserAttachmentById,
  insertUserAttachment,
  listUserAttachments,
  updateUserAttachmentRow
} from "../config/db.js";
import { logger } from "../config/logger.js";
import { ensurePathInside } from "../utils/security.js";
import { getUploadsRoot } from "./fileService.js";
import { deleteAttachmentFromIndex, indexAttachmentText, readPdfContent } from "./ragService.js";

// Pieces jointes utilisateur : texte et PDF uniquement (jamais d'images ni de videos).
const allowedTextExtensions = new Set([".txt", ".text", ".md", ".markdown", ".csv", ".log"]);
const allowedAttachmentExtensions = new Set([...allowedTextExtensions, ".pdf"]);
const attachmentMaxBytes = Number(process.env.USER_ATTACHMENT_MAX_BYTES || 2 * 1024 * 1024);
const attachmentRetentionDays = Number(process.env.USER_ATTACHMENT_RETENTION_DAYS || 30);
const attachmentPromptMaxChars = Number(process.env.USER_ATTACHMENT_PROMPT_MAX_CHARS || 6000);

function getAttachmentsRoot() {
  const root = path.join(getUploadsRoot(), "_attachments");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function sanitizeAttachmentName(value) {
  const base = path.basename(String(value || "piece-jointe.txt"));
  return base
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .toLowerCase() || "piece-jointe.txt";
}

function attachmentValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

const attachmentStorage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, getAttachmentsRoot());
  },
  filename: (_req, file, callback) => {
    const safeName = sanitizeAttachmentName(file.originalname);
    const extension = path.extname(safeName) || ".txt";
    const baseName = path.basename(safeName, extension) || "piece-jointe";
    callback(null, `${baseName}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${extension}`);
  }
});

function attachmentFileFilter(_req, file, callback) {
  const extension = path.extname(String(file.originalname || "")).toLowerCase();

  if (!allowedAttachmentExtensions.has(extension)) {
    callback(
      attachmentValidationError(
        `Format non accepté (${extension || "inconnu"}). Les images et vidéos ne sont pas prises en charge. Formats acceptés : ${[
          ...allowedAttachmentExtensions
        ].join(", ")}`
      )
    );
    return;
  }

  callback(null, true);
}

export const attachmentUploadMiddleware = multer({
  storage: attachmentStorage,
  fileFilter: attachmentFileFilter,
  limits: {
    fileSize: attachmentMaxBytes,
    files: 1
  }
});

function computeExpirationDate() {
  const expires = new Date();
  expires.setDate(expires.getDate() + Math.max(1, attachmentRetentionDays));
  return expires.toISOString();
}

async function computeMd5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function toAttachmentDto(row) {
  if (!row) {
    return null;
  }

  let daysRemaining = null;
  if (row.status === "pending" && row.expires_at) {
    const remainingMs = new Date(row.expires_at).getTime() - Date.now();
    daysRemaining = Math.max(0, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
  }

  return {
    id: row.id,
    originalName: row.original_name,
    filename: row.filename,
    size: row.size,
    mimeType: row.mime_type,
    status: row.status,
    indexingStatus: row.indexing_status,
    chunkCount: row.chunk_count,
    lastError: row.last_error,
    questionContext: row.question_context,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    expiresAt: row.expires_at,
    daysRemaining
  };
}

function getAttachmentAbsolutePath(row) {
  const absolutePath = path.resolve(getUploadsRoot(), row.relative_path);
  return ensurePathInside(getUploadsRoot(), absolutePath, "Pièce jointe");
}

/**
 * Extrait le texte exploitable d'une piece jointe stockee : lecture directe pour
 * le texte brut, extraction dediee pour un PDF (jamais d'images ni de videos).
 */
async function extractAttachmentText(absolutePath) {
  const extension = path.extname(absolutePath).toLowerCase();

  if (extension === ".pdf") {
    return readPdfContent(absolutePath);
  }

  return fsp.readFile(absolutePath, "utf8");
}

export async function readAttachmentText(attachmentId) {
  const row = getUserAttachmentById(attachmentId);
  if (!row) {
    return null;
  }

  try {
    return await extractAttachmentText(getAttachmentAbsolutePath(row));
  } catch {
    return null;
  }
}

/**
 * Enregistre une piece jointe (texte ou PDF) deposee par un utilisateur du chat,
 * puis l'indexe pour que l'assistant puisse s'en servir (apprentissage).
 */
export async function saveUserAttachment(file, { sessionId = null, question = null } = {}) {
  const storedPath = path.resolve(file.path);
  ensurePathInside(getUploadsRoot(), storedPath, "Pièce jointe");
  const extension = path.extname(storedPath).toLowerCase();
  const isPdf = extension === ".pdf";

  let content;
  try {
    content = await extractAttachmentText(storedPath);
  } catch (error) {
    await fsp.unlink(storedPath).catch(() => undefined);
    throw attachmentValidationError(
      isPdf
        ? error.message || "Impossible d'extraire le texte du PDF."
        : "Impossible de lire la pièce jointe."
    );
  }

  if (!content || !content.trim()) {
    await fsp.unlink(storedPath).catch(() => undefined);
    throw attachmentValidationError(
      isPdf
        ? "Ce PDF ne contient aucun texte exploitable (peut-être composé uniquement d'images)."
        : "La pièce jointe est vide."
    );
  }

  if (!isPdf && content.includes("\u0000")) {
    await fsp.unlink(storedPath).catch(() => undefined);
    throw attachmentValidationError(
      "La pièce jointe ne semble pas être un fichier texte valide."
    );
  }

  const md5Hash = await computeMd5(storedPath);
  const relativePath = path.join("_attachments", path.basename(storedPath));

  const row = insertUserAttachment({
    originalName: path.basename(String(file.originalname || "piece-jointe.txt")),
    filename: path.basename(storedPath),
    relativePath,
    mimeType: file.mimetype || (path.extname(storedPath).toLowerCase() === ".pdf" ? "application/pdf" : "text/plain"),
    size: file.size || Buffer.byteLength(content, "utf8"),
    md5Hash,
    sessionId,
    questionContext: question ? String(question).slice(0, 500) : null,
    expiresAt: computeExpirationDate()
  });

  // Indexation en arriere-plan : l'utilisateur n'attend pas la vectorisation.
  indexAttachmentText(row, content)
    .then((result) => {
      updateUserAttachmentRow(row.id, {
        indexing_status: "indexed",
        chunk_count: result.chunkCount,
        last_error: null
      });
    })
    .catch((error) => {
      updateUserAttachmentRow(row.id, {
        indexing_status: "error",
        last_error: error.message || "Indexation impossible."
      });
      logger.warn("Indexation d'une piece jointe utilisateur echouee.", {
        attachmentId: row.id,
        message: error.message
      });
    });

  return {
    attachment: toAttachmentDto(getUserAttachmentById(row.id)),
    contentPreview: content.slice(0, 400)
  };
}

export function listAttachments() {
  return listUserAttachments().map(toAttachmentDto);
}

export function getAttachment(attachmentId) {
  return toAttachmentDto(getUserAttachmentById(attachmentId));
}

/**
 * L'administrateur juge la piece jointe pertinente : elle est conservee sans limite
 * de temps et reste indexee pour l'apprentissage de l'assistant.
 */
export function keepAttachment(attachmentId) {
  const row = getUserAttachmentById(attachmentId);
  if (!row) {
    const error = new Error("Pièce jointe introuvable.");
    error.statusCode = 404;
    throw error;
  }

  return toAttachmentDto(
    updateUserAttachmentRow(attachmentId, {
      status: "kept",
      reviewed_at: new Date().toISOString(),
      expires_at: null
    })
  );
}

/**
 * Suppression complete : fichier, lignes d'index vectoriel et enregistrement.
 */
export async function deleteAttachment(attachmentId) {
  const row = getUserAttachmentById(attachmentId);
  if (!row) {
    const error = new Error("Pièce jointe introuvable.");
    error.statusCode = 404;
    throw error;
  }

  await deleteAttachmentFromIndex(row.id);
  await fsp.unlink(getAttachmentAbsolutePath(row)).catch(() => undefined);
  deleteUserAttachmentById(row.id);

  return toAttachmentDto(row);
}

/**
 * Construit le contexte de prompt pour les pieces jointes envoyees avec la question.
 */
export async function buildAttachmentPromptContext(attachmentIds = []) {
  const sections = [];

  for (const attachmentId of attachmentIds.slice(0, 3)) {
    const row = getUserAttachmentById(Number(attachmentId));
    if (!row) {
      continue;
    }

    const content = await readAttachmentText(row.id);
    if (!content) {
      continue;
    }

    sections.push(
      `[PIÈCE JOINTE] ${row.original_name}\n${content.slice(0, attachmentPromptMaxChars)}`
    );
  }

  if (sections.length === 0) {
    return null;
  }

  return `L'utilisateur a joint le(s) fichier(s) texte suivant(s) à sa question. Utilise leur contenu comme contexte prioritaire pour répondre :\n\n${sections.join("\n\n")}`;
}

/**
 * Supprime les pieces jointes en attente arrivees a expiration (30 jours par defaut).
 */
export async function cleanupExpiredAttachments() {
  const expired = getExpiredUserAttachments(new Date().toISOString());
  let deletedCount = 0;

  for (const row of expired) {
    try {
      await deleteAttachmentFromIndex(row.id);
      await fsp.unlink(getAttachmentAbsolutePath(row)).catch(() => undefined);
      deleteUserAttachmentById(row.id);
      deletedCount += 1;
    } catch (error) {
      logger.warn("Nettoyage d'une piece jointe expiree echoue.", {
        attachmentId: row.id,
        message: error.message
      });
    }
  }

  if (deletedCount > 0) {
    logger.info("Pieces jointes expirees supprimees automatiquement.", { deletedCount });
  }

  return { deletedCount };
}
