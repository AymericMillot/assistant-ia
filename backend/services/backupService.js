import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import Database from "better-sqlite3";
import {
  closeDatabase,
  getDb,
  getManualResources,
  getSetting,
  getSqlitePath,
  initializeDatabase,
  listUserAttachments,
  resetAllDocumentIndexing,
  setSetting,
  updateUserAttachmentRow
} from "../config/db.js";
import { logger } from "../config/logger.js";
import { getCurrentVersion } from "./appInfoService.js";

/**
 * Sauvegardes completes de l'instance : base SQLite (comptes, reglages,
 * conversations, retours, skills...), fichiers deposes (documents et pieces
 * jointes) et identite visuelle (branding.json). L'index vectoriel (ChromaDB)
 * n'est pas sauvegarde : il se reconstruit a partir des documents apres une
 * restauration.
 *
 * Format : archive .tar.gz contenant manifest.json, database.sqlite,
 * branding.json (facultatif) et uploads/.
 */

const execFileAsync = promisify(execFile);
const archiveApp = "assistant-ia";
const archiveFormat = 1;
const backupNamePattern = /^sauvegarde-\d{8}-\d{6}(?:-[a-z0-9-]{1,40})?\.tar\.gz$/;
const maxArchiveEntries = Number(process.env.BACKUP_MAX_ENTRIES || 200000);
const defaultSchedule = { enabled: true, time: "03:00", retention: 7 };

let operationInFlight = null;

function operationError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function resolveFromCwd(target) {
  return path.resolve(process.cwd(), target);
}

export function getBackupsDirectory() {
  return resolveFromCwd(process.env.BACKUP_DIR || path.join(path.dirname(getSqlitePath()), "backups"));
}

function getUploadsDirectory() {
  return resolveFromCwd(process.env.UPLOADS_DIR || "./uploads");
}

function getBrandingPath() {
  return resolveFromCwd(process.env.BRANDING_PATH || "data/branding.json");
}

function timestampForName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sanitizeTrigger(trigger) {
  return String(trigger || "manuel")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "manuel";
}

export function ensureValidBackupName(name) {
  const value = String(name || "").trim();
  if (!backupNamePattern.test(value)) {
    throw operationError("Nom de sauvegarde invalide.");
  }
  return value;
}

export function getBackupFilePath(name) {
  return path.join(getBackupsDirectory(), ensureValidBackupName(name));
}

export function getBackupSchedule() {
  try {
    const parsed = JSON.parse(getSetting("backupSchedule", "") || "{}");
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaultSchedule.enabled,
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.time || "") ? parsed.time : defaultSchedule.time,
      retention: Math.max(1, Math.min(Number(parsed.retention) || defaultSchedule.retention, 60))
    };
  } catch {
    return { ...defaultSchedule };
  }
}

export function setBackupSchedule({ enabled, time, retention }) {
  const current = getBackupSchedule();
  const next = {
    enabled: typeof enabled === "boolean" ? enabled : current.enabled,
    time: time === undefined ? current.time : String(time),
    retention: retention === undefined ? current.retention : Number(retention)
  };

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.time)) {
    throw operationError("Heure invalide (format HH:MM attendu).");
  }

  if (!Number.isInteger(next.retention) || next.retention < 1 || next.retention > 60) {
    throw operationError("Le nombre de sauvegardes conservées doit être compris entre 1 et 60.");
  }

  setSetting("backupSchedule", JSON.stringify(next));
  return next;
}

export async function listBackups() {
  const directory = getBackupsDirectory();
  let entries = [];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const backups = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && backupNamePattern.test(entry.name))
      .map(async (entry) => {
        const stat = await fsp.stat(path.join(directory, entry.name));
        const trigger = entry.name.match(/^sauvegarde-\d{8}-\d{6}-(.+)\.tar\.gz$/)?.[1] || "manuel";
        return {
          name: entry.name,
          size: stat.size,
          createdAt: stat.mtime.toISOString(),
          trigger
        };
      })
  );

  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function pruneBackups(retention) {
  const backups = await listBackups();
  // Les sauvegardes de securite (avant restauration) ne comptent pas dans la
  // rotation automatique : elles ne sont supprimees qu'a la main.
  const rotating = backups.filter((backup) => backup.trigger !== "avant-restauration");
  const toDelete = rotating.slice(Math.max(1, retention));

  for (const backup of toDelete) {
    await fsp.rm(path.join(getBackupsDirectory(), backup.name), { force: true });
  }

  return toDelete.map((backup) => backup.name);
}

async function directorySize(directory) {
  let total = 0;
  let entries = [];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(fullPath);
    } else if (entry.isFile()) {
      total += (await fsp.stat(fullPath)).size;
    }
  }

  return total;
}

export async function getDiskUsage() {
  try {
    const stats = await fsp.statfs(path.dirname(getSqlitePath()));
    return {
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
      freeBytes: Number(stats.bavail) * Number(stats.bsize)
    };
  } catch {
    return null;
  }
}

function runExclusive(label, task) {
  if (operationInFlight) {
    throw operationError(`Une opération de sauvegarde est déjà en cours (${operationInFlight}).`, 409);
  }

  operationInFlight = label;
  return Promise.resolve()
    .then(task)
    .finally(() => {
      operationInFlight = null;
    });
}

export function isBackupOperationRunning() {
  return Boolean(operationInFlight);
}

async function createBackupUnlocked({ trigger = "manuel" } = {}) {
  const backupsDirectory = getBackupsDirectory();
  await fsp.mkdir(backupsDirectory, { recursive: true });

  const uploadsDirectory = getUploadsDirectory();
  const estimatedSize = (await directorySize(uploadsDirectory)) + fs.statSync(getSqlitePath()).size;
  const disk = await getDiskUsage();
  if (disk && disk.freeBytes < estimatedSize * 1.2 + 50 * 1024 * 1024) {
    throw operationError("Espace disque insuffisant pour créer la sauvegarde.", 409);
  }

  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), "assistant-ia-backup-"));
  const name = `sauvegarde-${timestampForName()}-${sanitizeTrigger(trigger)}.tar.gz`;
  const targetPath = path.join(backupsDirectory, name);
  const partialPath = `${targetPath}.partial`;

  try {
    // API de sauvegarde en ligne de SQLite : copie coherente meme si des
    // ecritures ont lieu pendant l'operation (contrairement a une copie brute).
    await getDb().backup(path.join(staging, "database.sqlite"));

    const files = ["manifest.json", "database.sqlite"];
    const brandingPath = getBrandingPath();
    if (fs.existsSync(brandingPath)) {
      await fsp.copyFile(brandingPath, path.join(staging, "branding.json"));
      files.push("branding.json");
    }

    await fsp.writeFile(
      path.join(staging, "manifest.json"),
      JSON.stringify(
        {
          app: archiveApp,
          format: archiveFormat,
          version: getCurrentVersion(),
          createdAt: new Date().toISOString(),
          trigger: sanitizeTrigger(trigger),
          includesUploads: fs.existsSync(uploadsDirectory)
        },
        null,
        2
      )
    );

    // Options avant les fichiers : GNU tar (Docker) et bsdtar (macOS) les
    // acceptent dans cet ordre uniquement.
    const tarArguments = ["-c", "-z", "-f", partialPath];
    const members = [...files];
    if (fs.existsSync(uploadsDirectory)) {
      // Le dossier d'uploads est ajoute sous le nom fixe "uploads/" quel que
      // soit son emplacement reel, via un lien suivi (-h) a la racine.
      await fsp.symlink(uploadsDirectory, path.join(staging, "uploads"));
      tarArguments.push("-h", "--exclude", "uploads/_incoming/*");
      members.push("uploads");
    }
    tarArguments.push("-C", staging, ...members);

    await execFileAsync("tar", tarArguments, { maxBuffer: 10 * 1024 * 1024 });
    await fsp.rename(partialPath, targetPath);

    const stat = await fsp.stat(targetPath);
    setSetting("lastBackupAt", new Date().toISOString());
    setSetting("lastBackupName", name);
    const pruned = await pruneBackups(getBackupSchedule().retention);

    logger.info("Sauvegarde creee.", { name, size: stat.size, trigger, pruned: pruned.length });
    return { name, size: stat.size, createdAt: stat.mtime.toISOString(), trigger: sanitizeTrigger(trigger), pruned };
  } catch (error) {
    await fsp.rm(partialPath, { force: true }).catch(() => undefined);
    logger.error("Echec de la creation d'une sauvegarde.", { message: error.message });
    throw error.statusCode ? error : operationError(`La sauvegarde a échoué : ${error.message}`, 500);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createBackup(options = {}) {
  return runExclusive("création", () => createBackupUnlocked(options));
}

export async function deleteBackup(name) {
  const filePath = getBackupFilePath(name);
  await fsp.rm(filePath);
}

/**
 * Verifie le contenu d'une archive avant toute extraction : chemins relatifs
 * uniquement, aucune remontee de dossier, aucun lien, et seulement les
 * entrees attendues.
 */
async function inspectArchive(archivePath) {
  let listing;
  try {
    listing = await execFileAsync("tar", ["-tzvf", archivePath], { maxBuffer: 256 * 1024 * 1024 });
  } catch {
    throw operationError("Archive illisible : ce n'est pas une sauvegarde valide (.tar.gz).");
  }

  const verboseLines = listing.stdout.split("\n").filter(Boolean);
  const names = (await execFileAsync("tar", ["-tzf", archivePath], { maxBuffer: 256 * 1024 * 1024 })).stdout
    .split("\n")
    .filter(Boolean);

  if (names.length === 0 || names.length > maxArchiveEntries) {
    throw operationError("Archive vide ou contenant trop de fichiers.");
  }

  verboseLines.forEach((line) => {
    const type = line.charAt(0);
    if (type !== "-" && type !== "d") {
      throw operationError("L'archive contient des liens ou des fichiers spéciaux : restauration refusée.");
    }
  });

  names.forEach((rawName) => {
    const name = rawName.replace(/^\.\//, "");
    if (!name || name === ".") {
      return;
    }
    const segments = name.split("/");
    if (path.isAbsolute(rawName) || segments.includes("..") || name.includes("\\")) {
      throw operationError("L'archive contient des chemins non autorisés : restauration refusée.");
    }
    const allowed =
      ["manifest.json", "database.sqlite", "branding.json"].includes(name) ||
      segments[0] === "uploads";
    if (!allowed) {
      throw operationError(`Entrée inattendue dans l'archive : ${name.slice(0, 120)}`);
    }
  });
}

function verifySqliteFile(filePath) {
  const header = Buffer.alloc(16);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, header, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (header.toString("latin1") !== "SQLite format 3\u0000") {
    throw operationError("La base de données de la sauvegarde est invalide.");
  }

  const candidate = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const result = candidate.pragma("integrity_check", { simple: true });
    if (result !== "ok") {
      throw operationError("La base de données de la sauvegarde est corrompue.");
    }
    const tables = candidate
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    if (!tables.includes("settings") || !tables.includes("documents")) {
      throw operationError("La sauvegarde ne provient pas de cette application.");
    }
  } finally {
    candidate.close();
  }
}

async function replaceDirectoryContents(targetDirectory, sourceDirectory) {
  await fsp.mkdir(targetDirectory, { recursive: true });
  const existing = await fsp.readdir(targetDirectory);
  for (const entry of existing) {
    await fsp.rm(path.join(targetDirectory, entry), { recursive: true, force: true });
  }

  if (!fs.existsSync(sourceDirectory)) {
    return;
  }

  // Copie (et non deplacement) : le dossier temporaire et le dossier d'uploads
  // sont generalement sur des volumes differents dans Docker.
  const restored = await fsp.readdir(sourceDirectory);
  for (const entry of restored) {
    await fsp.cp(path.join(sourceDirectory, entry), path.join(targetDirectory, entry), {
      recursive: true,
      errorOnExist: false,
      force: true
    });
  }
}

async function rebuildSearchIndexes() {
  // Imports dynamiques : ces services dependent de la base, rouverte juste avant.
  const [{ clearAllIndexes, syncFeedbackCorrectionIndex }, fileService, queueService, attachmentService, webScrapeService] =
    await Promise.all([
      import("./ragService.js"),
      import("./fileService.js"),
      import("./queueService.js"),
      import("./attachmentService.js"),
      import("./webScrapeService.js")
    ]);

  await clearAllIndexes().catch((error) => {
    logger.warn("Nettoyage de l'index vectoriel incomplet apres restauration.", { message: error.message });
  });
  resetAllDocumentIndexing();
  await fileService.syncFilesystemToDatabase().catch(() => undefined);
  await queueService.enqueueFullReindex({ trigger: "restauration" }).catch((error) => {
    logger.warn("Reindexation apres restauration non planifiee.", { message: error.message });
  });

  listUserAttachments().forEach((row) => {
    updateUserAttachmentRow(row.id, { indexing_status: "pending", index_attempts: 0, chunk_count: 0 });
  });
  attachmentService.reconcileAttachmentIndexes();

  const feedbackIds = getDb()
    .prepare("SELECT id FROM feedback WHERE is_deleted = 0")
    .all()
    .map((row) => row.id);
  for (const feedbackId of feedbackIds) {
    await syncFeedbackCorrectionIndex(feedbackId).catch(() => undefined);
  }

  getManualResources({ enabledOnly: true, resourceType: "document_link" }).forEach((resource) => {
    webScrapeService.scheduleLinkScrape(resource.id);
  });
}

async function restoreFromArchiveUnlocked(archivePath, { actor = "admin" } = {}) {
  await inspectArchive(archivePath);

  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), "assistant-ia-restore-"));
  try {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", staging, "--no-same-owner"], {
      maxBuffer: 10 * 1024 * 1024
    });

    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(staging, "manifest.json"), "utf8"));
    } catch {
      throw operationError("Manifeste absent ou illisible : ce n'est pas une sauvegarde de l'assistant.");
    }

    if (manifest?.app !== archiveApp || Number(manifest?.format) !== archiveFormat) {
      throw operationError("Cette archive n'est pas une sauvegarde compatible de l'assistant.");
    }

    const restoredDatabasePath = path.join(staging, "database.sqlite");
    if (!fs.existsSync(restoredDatabasePath)) {
      throw operationError("La sauvegarde ne contient pas de base de données.");
    }
    verifySqliteFile(restoredDatabasePath);

    // Filet de securite : l'etat actuel est sauvegarde avant d'etre remplace.
    const safetyBackup = await createBackupUnlocked({ trigger: "avant-restauration" });

    // Aucune indexation ne doit ecrire en base pendant le remplacement. Attente
    // bornee : une file Redis indisponible ne doit pas bloquer la restauration.
    const queueService = await import("./queueService.js");
    await Promise.race([
      queueService.stopAllIndexing().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 15000).unref())
    ]);

    const sqlitePath = getSqlitePath();
    closeDatabase();
    try {
      await fsp.rm(`${sqlitePath}-wal`, { force: true });
      await fsp.rm(`${sqlitePath}-shm`, { force: true });
      await fsp.copyFile(restoredDatabasePath, sqlitePath);
    } finally {
      // Rouvre toujours la base (restauree ou, en cas d'echec de copie, l'ancienne).
      initializeDatabase();
    }

    if (manifest.includesUploads !== false) {
      await replaceDirectoryContents(getUploadsDirectory(), path.join(staging, "uploads"));
    }

    const restoredBrandingPath = path.join(staging, "branding.json");
    if (fs.existsSync(restoredBrandingPath)) {
      JSON.parse(await fsp.readFile(restoredBrandingPath, "utf8"));
      await fsp.mkdir(path.dirname(getBrandingPath()), { recursive: true });
      await fsp.copyFile(restoredBrandingPath, getBrandingPath());
    }

    setSetting("lastRestoreAt", new Date().toISOString());
    // La reconstruction de l'index vectoriel peut etre longue : elle se poursuit
    // en arriere-plan, l'assistant reste utilisable pendant ce temps.
    rebuildSearchIndexes().catch((error) => {
      logger.error("Reconstruction des index apres restauration incomplete.", { message: error.message });
    });

    logger.info("Sauvegarde restauree.", {
      actor,
      backupVersion: manifest.version,
      backupCreatedAt: manifest.createdAt,
      safetyBackup: safetyBackup.name
    });

    return {
      restoredFrom: manifest.createdAt || null,
      backupVersion: manifest.version || null,
      safetyBackup: safetyBackup.name
    };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function restoreBackup(name, options = {}) {
  const archivePath = getBackupFilePath(name);
  if (!fs.existsSync(archivePath)) {
    throw operationError("Sauvegarde introuvable.", 404);
  }
  return runExclusive("restauration", () => restoreFromArchiveUnlocked(archivePath, options));
}

export function restoreUploadedBackup(archivePath, options = {}) {
  return runExclusive("restauration", () => restoreFromArchiveUnlocked(archivePath, options));
}

export async function getBackupOverview() {
  const backups = await listBackups();
  return {
    backups,
    schedule: getBackupSchedule(),
    lastBackupAt: getSetting("lastBackupAt", "") || null,
    lastRestoreAt: getSetting("lastRestoreAt", "") || null,
    running: operationInFlight,
    disk: await getDiskUsage(),
    directory: getBackupsDirectory()
  };
}
