import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import mime from "mime-types";
import multer from "multer";
import {
  deleteDocumentById,
  getDocumentById,
  getDocumentByRelativePath,
  getDocuments,
  hasPendingDocuments,
  upsertDocument,
  updateDocumentRow
} from "../config/db.js";
import { logger } from "../config/logger.js";
import { ensurePathInside } from "../utils/security.js";

const uploadsRoot = path.resolve(process.cwd(), process.env.UPLOADS_DIR || "./uploads");
const incomingRoot = path.join(uploadsRoot, "_incoming");
const frenchCollator = new Intl.Collator("fr", {
  sensitivity: "base",
  numeric: true,
  ignorePunctuation: true
});
const syncCooldownMs = Number(process.env.FILESYSTEM_SYNC_COOLDOWN_MS || 2000);
const documentUploadMaxBytes = Math.max(
  1,
  Number(process.env.DOCUMENT_UPLOAD_MAX_BYTES || 100 * 1024 * 1024)
);
const documentUploadMaxFiles = Math.max(1, Number(process.env.DOCUMENT_UPLOAD_MAX_FILES || 20));
const supportedExtensions = new Set([
  ".pdf",
  ".txt",
  ".text",
  ".md",
  ".markdown",
  ".rst",
  ".adoc",
  ".odt",
  ".docx",
  ".html",
  ".htm",
  ".xml",
  ".csv",
  ".tsv",
  ".xlsx",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".log",
  ".sql",
  ".tex",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".cs",
  ".php",
  ".rb",
  ".go",
  ".rs",
  ".swift",
  ".kt",
  ".kts",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".vue",
  ".svelte",
  ".astro"
]);

export class DuplicateDocumentsError extends Error {
  constructor(duplicates = []) {
    super("Des doublons ont ete detectes pendant l'import.");
    this.name = "DuplicateDocumentsError";
    this.statusCode = 409;
    this.duplicates = duplicates;
  }
}

function ensureStorageRoots() {
  fs.mkdirSync(uploadsRoot, { recursive: true });
  fs.mkdirSync(incomingRoot, { recursive: true });
}

ensureStorageRoots();
let lastSyncCompletedAt = 0;
let syncInFlightPromise = null;

function sanitizeSegment(value) {
  return repairDisplayText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function looksMisencoded(value) {
  return /Ã|Â|â€|â€™|â€œ|â€\u009d|â€“|â€”|�/.test(String(value || ""));
}

function repairDisplayText(value) {
  const input = String(value || "");
  if (!input || !looksMisencoded(input)) {
    return input;
  }

  let repaired = input;

  for (let index = 0; index < 2; index += 1) {
    const nextValue = Buffer.from(repaired, "latin1").toString("utf8");
    if (!nextValue || nextValue === repaired) {
      break;
    }
    repaired = nextValue;
    if (!looksMisencoded(repaired)) {
      break;
    }
  }

  return repaired;
}

async function fileExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function waitForFileAvailability(targetPath, { attempts = 5, delayMs = 120 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await fileExists(targetPath)) {
      return true;
    }

    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return false;
}

async function moveIncomingFile(sourcePath, targetPath) {
  const sourceReady = await waitForFileAvailability(sourcePath);
  if (!sourceReady) {
    const error = new Error("Le fichier televerse temporaire est introuvable au moment du remplacement.");
    error.statusCode = 409;
    throw error;
  }

  await fsp.mkdir(path.dirname(targetPath), { recursive: true });

  try {
    await fsp.rename(sourcePath, targetPath);
  } catch (error) {
    if (error?.code !== "EXDEV" && error?.code !== "ENOENT") {
      throw error;
    }

    const sourceStillReady = await waitForFileAvailability(sourcePath, {
      attempts: 3,
      delayMs: 80
    });
    if (!sourceStillReady) {
      const missingSourceError = new Error(
        "Le fichier televerse temporaire a disparu avant son remplacement."
      );
      missingSourceError.statusCode = 409;
      throw missingSourceError;
    }

    await fsp.copyFile(sourcePath, targetPath);
    await fsp.unlink(sourcePath).catch(() => undefined);
  }
}

function buildSanitizedFilename(originalName) {
  const repairedOriginalName = repairDisplayText(originalName);
  const extension = path.extname(repairedOriginalName);
  const baseName = sanitizeSegment(path.basename(repairedOriginalName, extension)) || "document";
  return `${baseName}${extension.toLowerCase()}`;
}

function normalizeDuplicateKey(value) {
  return sanitizeSegment(path.basename(repairDisplayText(value || ""), path.extname(String(value || ""))));
}

async function ensureUniqueFilename(folderPath, originalName) {
  const repairedOriginalName = repairDisplayText(originalName);
  const extension = path.extname(repairedOriginalName).toLowerCase();
  const baseName =
    sanitizeSegment(path.basename(repairedOriginalName, path.extname(repairedOriginalName))) ||
    "document";
  let candidate = buildSanitizedFilename(repairedOriginalName);
  let index = 1;

  while (await fileExists(path.join(folderPath, candidate))) {
    candidate = `${baseName}-${index}${extension.toLowerCase()}`;
    index += 1;
  }

  return candidate;
}

export async function computeFileMd5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);

    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function getUploadsRoot() {
  ensureStorageRoots();
  return uploadsRoot;
}

export function getSupportedExtensions() {
  return [...supportedExtensions];
}

export function resolveFolderName(folderName) {
  const normalized = sanitizeSegment(folderName);
  if (!normalized) {
    throw new Error("Nom de dossier invalide.");
  }

  return normalized;
}

export async function createFolder(folderName) {
  const safeFolderName = resolveFolderName(folderName);
  await fsp.mkdir(path.join(uploadsRoot, safeFolderName), { recursive: true });
  return safeFolderName;
}

export async function listFolders() {
  ensureStorageRoots();
  const entries = await fsp.readdir(uploadsRoot, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort((left, right) => frenchCollator.compare(left, right));
}

export function getAbsoluteDocumentPath(relativePath) {
  const absolutePath = path.resolve(uploadsRoot, relativePath);
  return ensurePathInside(uploadsRoot, absolutePath, "Document");
}

function toDocumentDto(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    folderName: row.folder_name,
    filename: row.filename,
    originalName: repairDisplayText(row.original_name),
    relativePath: row.relative_path,
    visibility: row.visibility || "public",
    mimeType: row.mime_type,
    size: row.size,
    md5Hash: row.md5_hash,
    indexedMd5Hash: row.indexed_md5_hash,
    indexingStatus: row.indexing_status,
    chunkCount: row.chunk_count,
    lastIndexedAt: row.last_indexed_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function persistFileMetadata({ folderName, targetPath, storedFilename, originalName, size }) {
  const relativePath = path.join(folderName, storedFilename);
  const md5Hash = await computeFileMd5(targetPath);
  const existing = getDocumentByRelativePath(relativePath);
  const displayOriginalName = repairDisplayText(originalName);

  const row = upsertDocument({
    folderName,
    filename: storedFilename,
    originalName: displayOriginalName,
    relativePath,
    visibility: existing?.visibility || "public",
    mimeType: mime.lookup(targetPath) || "application/octet-stream",
    size,
    md5Hash,
    indexedMd5Hash:
      existing && existing.indexed_md5_hash === md5Hash ? existing.indexed_md5_hash : null,
    indexingStatus:
      existing && existing.indexed_md5_hash === md5Hash ? existing.indexing_status : "pending",
    chunkCount: existing && existing.indexed_md5_hash === md5Hash ? existing.chunk_count : 0,
    lastIndexedAt:
      existing && existing.indexed_md5_hash === md5Hash ? existing.last_indexed_at : null,
    lastError: null
  });

  return toDocumentDto(row);
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    ensureStorageRoots();
    callback(null, incomingRoot);
  },
  filename: (_req, file, callback) => {
    const repairedOriginalName = repairDisplayText(file.originalname);
    const extension = path.extname(repairedOriginalName).toLowerCase();
    const baseName = sanitizeSegment(path.basename(repairedOriginalName, extension)) || "document";
    callback(null, `${baseName}-${Date.now()}${extension}`);
  }
});

function uploadFilter(_req, file, callback) {
  const repairedOriginalName = repairDisplayText(file.originalname);
  const extension = path.extname(repairedOriginalName).toLowerCase();
  const safeOriginalName = path.basename(repairedOriginalName || "");
  if (!safeOriginalName || safeOriginalName !== repairedOriginalName) {
    const error = new Error("Nom de fichier invalide.");
    error.statusCode = 400;
    callback(error);
    return;
  }

  if (!supportedExtensions.has(extension)) {
    const error = new Error(
      `Format non supporte (${extension || "inconnu"}). Formats acceptes : ${[
        ...supportedExtensions
      ].join(", ")}`
    );
    error.statusCode = 400;
    callback(error);
    return;
  }

  callback(null, true);
}

export const uploadMiddleware = multer({
  storage,
  fileFilter: uploadFilter,
  limits: {
    fileSize: documentUploadMaxBytes,
    files: documentUploadMaxFiles,
    fields: 10,
    parts: documentUploadMaxFiles + 10
  }
});

export async function saveUploadedFiles(files, folderName) {
  return saveUploadedFilesWithStrategy(files, folderName, {});
}

export async function saveUploadedFilesWithStrategy(
  files,
  folderName,
  { duplicateStrategy = "reject", onBeforeReplace = null } = {}
) {
  const safeFolderName = await createFolder(folderName);
  const targetFolder = path.join(uploadsRoot, safeFolderName);
  const savedDocuments = [];
  const existingDocuments = getDocuments({ folderName: safeFolderName }).map(toDocumentDto);
  const preparedUploads = [];
  const handledReplacementIds = new Set();

  for (const file of files) {
    const sourcePath = path.resolve(file.path);

    try {
      ensurePathInside(incomingRoot, sourcePath, "Fichier televerse");
      const md5Hash = await computeFileMd5(sourcePath);
      const normalizedIncomingName = normalizeDuplicateKey(file.originalname);
      const duplicate = existingDocuments.find((document) => {
        const sameMd5 = document.md5Hash && document.md5Hash === md5Hash;
        const sameName =
          normalizeDuplicateKey(document.originalName || document.filename) === normalizedIncomingName;

        return sameMd5 || sameName;
      });

      preparedUploads.push({
        file,
        sourcePath,
        md5Hash,
        duplicate,
        duplicateReason: duplicate
          ? duplicate.md5Hash === md5Hash &&
            normalizeDuplicateKey(duplicate.originalName || duplicate.filename) === normalizedIncomingName
            ? "name-and-content"
            : duplicate.md5Hash === md5Hash
              ? "content"
              : "name"
          : null
      });
    } catch (error) {
      if (await fileExists(sourcePath)) {
        await fsp.unlink(sourcePath).catch(() => undefined);
      }
      throw error;
    }
  }

  const duplicates = preparedUploads
    .filter((entry) => entry.duplicate)
    .map((entry) => ({
      incomingName: repairDisplayText(entry.file.originalname),
      incomingSize: entry.file.size,
      existingDocument: entry.duplicate,
      reason: entry.duplicateReason
    }));

  if (duplicates.length > 0 && duplicateStrategy === "reject") {
    await Promise.all(
      preparedUploads.map(async (entry) => {
        if (await fileExists(entry.sourcePath)) {
          await fsp.unlink(entry.sourcePath).catch(() => undefined);
        }
      })
    );
    throw new DuplicateDocumentsError(duplicates);
  }

  for (const entry of preparedUploads) {
    const { file, sourcePath, md5Hash, duplicate } = entry;

    try {
      if (duplicate && duplicateStrategy === "ignore") {
        if (await fileExists(sourcePath)) {
          await fsp.unlink(sourcePath).catch(() => undefined);
        }
        continue;
      }

      if (duplicate && duplicateStrategy === "replace") {
        const canReplace = !handledReplacementIds.has(duplicate.id) && getDocumentById(duplicate.id);
        if (canReplace) {
          if (typeof onBeforeReplace === "function") {
            await onBeforeReplace(duplicate);
          }
          await deleteDocument(duplicate.id);
          handledReplacementIds.add(duplicate.id);
        }
      }

      const storedFilename = await ensureUniqueFilename(targetFolder, file.originalname);
      const targetPath = path.join(targetFolder, storedFilename);
      await moveIncomingFile(sourcePath, targetPath);

      const document = toDocumentDto(
        upsertDocument({
          folderName: safeFolderName,
          filename: storedFilename,
          originalName: repairDisplayText(file.originalname),
          relativePath: path.join(safeFolderName, storedFilename),
          visibility: "public",
          mimeType: mime.lookup(targetPath) || "application/octet-stream",
          size: file.size,
          md5Hash,
          indexedMd5Hash: null,
          indexingStatus: "pending",
          chunkCount: 0,
          lastIndexedAt: null,
          lastError: null
        })
      );

      savedDocuments.push(document);
    } catch (error) {
      if (await fileExists(sourcePath)) {
        await fsp.unlink(sourcePath).catch(() => undefined);
      }
      throw error;
    }
  }

  return savedDocuments;
}

export async function moveDocument(documentId, targetFolderName) {
  const document = getDocumentById(documentId);
  if (!document) {
    throw new Error("Document introuvable.");
  }

  const safeFolderName = await createFolder(targetFolderName);
  const sourcePath = getAbsoluteDocumentPath(document.relative_path);
  const targetFolder = path.join(uploadsRoot, safeFolderName);
  const targetFilename = await ensureUniqueFilename(targetFolder, document.original_name);
  const targetPath = path.join(targetFolder, targetFilename);

  await fsp.rename(sourcePath, targetPath);

  const md5Hash = await computeFileMd5(targetPath);
  const updated = updateDocumentRow(document.id, {
    folder_name: safeFolderName,
    filename: targetFilename,
    relative_path: path.join(safeFolderName, targetFilename),
    visibility: document.visibility || "public",
    mime_type: mime.lookup(targetPath) || document.mime_type,
    size: (await fsp.stat(targetPath)).size,
    md5_hash: md5Hash,
    indexing_status: "pending",
    indexed_md5_hash: null,
    chunk_count: 0,
    last_error: null,
    last_indexed_at: null
  });

  return toDocumentDto(updated);
}

export async function deleteDocument(documentId) {
  const document = getDocumentById(documentId);
  if (!document) {
    throw new Error("Document introuvable.");
  }

  const absolutePath = getAbsoluteDocumentPath(document.relative_path);
  if (await fileExists(absolutePath)) {
    await fsp.unlink(absolutePath);
  }

  deleteDocumentById(documentId);
  return toDocumentDto(document);
}

export async function deleteFolder(folderName) {
  const safeFolderName = resolveFolderName(folderName);
  const folderPath = path.join(uploadsRoot, safeFolderName);
  const documents = getDocuments({ folderName: safeFolderName }).map(toDocumentDto);

  if (await fileExists(folderPath)) {
    await fsp.rm(folderPath, { recursive: true, force: true });
  }

  documents.forEach((document) => {
    deleteDocumentById(document.id);
  });

  return {
    folderName: safeFolderName,
    deletedDocuments: documents
  };
}

export async function resetUploadsStorage() {
  if (await fileExists(uploadsRoot)) {
    const entries = await fsp.readdir(uploadsRoot);

    await Promise.all(
      entries.map((entry) =>
        fsp.rm(path.join(uploadsRoot, entry), {
          recursive: true,
          force: true
        })
      )
    );
  }

}

export async function getFolderTree() {
  const folders = await listFolders();
  const documents = getDocuments().map(toDocumentDto);
  const byFolder = new Map();

  folders.forEach((folderName) => {
    byFolder.set(folderName, []);
  });

  documents.forEach((document) => {
    if (!byFolder.has(document.folderName)) {
      byFolder.set(document.folderName, []);
    }

    byFolder.get(document.folderName).push(document);
  });

  return [...byFolder.entries()]
    .sort(([leftName], [rightName]) => frenchCollator.compare(leftName, rightName))
    .map(([name, items]) => ({
      name,
      documentCount: items.length,
      documents: [...items].sort((left, right) =>
        frenchCollator.compare(left.originalName || left.filename || "", right.originalName || right.filename || "")
      )
    }));
}

export async function syncFilesystemToDatabase() {
  const now = Date.now();
  if (syncInFlightPromise) {
    return syncInFlightPromise;
  }

  if (lastSyncCompletedAt && now - lastSyncCompletedAt < syncCooldownMs) {
    return {
      scannedFolders: 0,
      changedDocuments: [],
      removedRecords: [],
      hasPendingChanges: hasPendingDocuments()
    };
  }

  syncInFlightPromise = (async () => {
  ensureStorageRoots();
  const folders = await listFolders();
  const seenRelativePaths = new Set();
  const changedDocuments = [];

  for (const folderName of folders) {
    const folderPath = path.join(uploadsRoot, folderName);
    const entries = await fsp.readdir(folderPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!supportedExtensions.has(extension)) {
        continue;
      }

      let effectiveFilename = entry.name;
      let absolutePath = path.join(folderPath, effectiveFilename);
      let relativePath = path.join(folderName, effectiveFilename);
      const existing = getDocumentByRelativePath(relativePath);

      if (existing?.original_name) {
        const preferredFilename = buildSanitizedFilename(existing.original_name);
        if (preferredFilename && preferredFilename !== effectiveFilename) {
          let candidateFilename = preferredFilename;
          let index = 1;

          while (
            candidateFilename !== effectiveFilename &&
            (await fileExists(path.join(folderPath, candidateFilename)))
          ) {
            const ext = path.extname(preferredFilename);
            const base = path.basename(preferredFilename, ext);
            candidateFilename = `${base}-${index}${ext}`;
            index += 1;
          }

          const targetPath = path.join(folderPath, candidateFilename);
          if (candidateFilename !== effectiveFilename && !(await fileExists(targetPath))) {
            await fsp.rename(absolutePath, targetPath);
            effectiveFilename = candidateFilename;
            absolutePath = targetPath;
            relativePath = path.join(folderName, effectiveFilename);
          }
        }
      }

      seenRelativePaths.add(relativePath);

      const stats = await fsp.stat(absolutePath);
      const md5Hash = await computeFileMd5(absolutePath);
      const currentRecord =
        getDocumentByRelativePath(relativePath) ||
        existing ||
        getDocuments({ folderName }).find((document) => document.id === existing?.id) ||
        null;
      const hasChanged = !currentRecord || currentRecord.md5_hash !== md5Hash;

      const row = upsertDocument({
        folderName,
        filename: effectiveFilename,
        originalName: repairDisplayText(currentRecord?.original_name || effectiveFilename),
        relativePath,
        visibility: currentRecord?.visibility || "public",
        mimeType: mime.lookup(absolutePath) || "application/octet-stream",
        size: stats.size,
        md5Hash,
        indexedMd5Hash:
          currentRecord && !hasChanged
            ? currentRecord.indexed_md5_hash
            : currentRecord?.indexed_md5_hash || null,
        indexingStatus: hasChanged ? "pending" : currentRecord?.indexing_status || "pending",
        chunkCount: hasChanged ? 0 : currentRecord?.chunk_count || 0,
        lastIndexedAt: hasChanged ? null : currentRecord?.last_indexed_at || null,
        lastError: hasChanged ? null : currentRecord?.last_error || null
      });

      if (hasChanged) {
        changedDocuments.push(toDocumentDto(row));
      }
    }
  }

  const removedRecords = [];
  getDocuments().forEach((record) => {
    if (!seenRelativePaths.has(record.relative_path)) {
      removedRecords.push(toDocumentDto(record));
      deleteDocumentById(record.id);
    }
  });

  logger.info("Synchronisation du systeme de fichiers terminee.", {
    changedDocuments: changedDocuments.length,
    removedDocuments: removedRecords.length
  });

  return {
    scannedFolders: folders.length,
    changedDocuments,
    removedRecords,
    hasPendingChanges: hasPendingDocuments()
  };
  })();

  try {
    const result = await syncInFlightPromise;
    lastSyncCompletedAt = Date.now();
    return result;
  } finally {
    syncInFlightPromise = null;
  }
}

export function getDocumentRecord(documentId) {
  return toDocumentDto(getDocumentById(documentId));
}

export async function updateDocumentMetadata(documentId, metadata) {
  const document = getDocumentById(documentId);
  if (!document) {
    throw new Error("Document introuvable.");
  }

  const updated = updateDocumentRow(documentId, metadata);
  return toDocumentDto(updated);
}
