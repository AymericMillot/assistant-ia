import express from "express";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { spawn } from "child_process";

const app = express();
app.use(express.json({ limit: "2mb" }));

const workspaceDir = process.env.UPDATE_WORKSPACE_DIR || "/workspace";
const updateConfigPath = process.env.UPDATE_CONFIG_PATH || path.join(workspaceDir, "update.config.json");
const versionFilePath = process.env.VERSION_FILE_PATH || path.join(workspaceDir, "version.json");
const port = Number(process.env.UPDATE_PORT || process.env.PORT || 3010);
const backupStoreDir = path.join(workspaceDir, ".update-backups");
const maxBackupVersions = Math.max(1, Number(process.env.UPDATE_BACKUP_RETENTION || 3));
const composeProjectName =
  String(process.env.UPDATE_PROJECT_NAME || "").trim() || path.basename(workspaceDir) || "fablab-ai";
const hostWorkspaceDirOverride = String(process.env.UPDATE_HOST_WORKSPACE_DIR || "").trim();
// Services tiers sans code applicatif propre : redemarres (pas reconstruits) apres
// chaque mise a jour/rollback pour repartir sur un etat propre, comme ./restart.sh.
const fullStackRestartServices = ["ollama", "chromadb", "redis"];
const remoteFetchTimeoutMs = Math.max(1000, Number(process.env.UPDATE_REMOTE_TIMEOUT_MS || 8000));
const remoteReleaseTtlMs = Math.max(10000, Number(process.env.UPDATE_RELEASE_CACHE_TTL_MS || 60000));

let hostWorkspaceDirPromise = null;
let remoteReleaseCache = null;
let remoteReleaseCachedAt = 0;

const state = {
  busy: false,
  status: "idle",
  progress: 0,
  message: "Prêt.",
  currentVersion: "1.000",
  latestVersion: null,
  targetVersion: null,
  updateAvailable: false,
  logs: [],
  startedAt: null,
  completedAt: null,
  error: null
};

const deployState = {
  busy: false,
  status: "idle",
  progress: 0,
  message: "Pret.",
  version: null,
  publicUrl: null,
  sha256: null,
  logs: [],
  startedAt: null,
  completedAt: null,
  error: null
};

function pushLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  state.logs = [...state.logs.slice(-49), stamped];
}

function pushDeployLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  deployState.logs = [...deployState.logs.slice(-49), stamped];
}

function setDeployState(patch) {
  Object.assign(deployState, patch);
}

function setState(patch) {
  Object.assign(state, patch);
}

async function readJson(filePath, fallbackValue = {}) {
  try {
    const content = await fsp.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return fallbackValue;
  }
}

async function readVersion() {
  const payload = await readJson(versionFilePath, { version: "1.000" });
  return payload.version || "1.000";
}

async function detectHostWorkspaceDirFromDocker() {
  const currentContainerId = String(process.env.HOSTNAME || "").trim();
  if (!currentContainerId) {
    return "";
  }

  return new Promise((resolve) => {
    const child = spawn(
      "docker",
      [
        "inspect",
        currentContainerId,
        "--format",
        "{{range .Mounts}}{{if eq .Destination \"/workspace\"}}{{.Source}}{{end}}{{end}}"
      ],
      {
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(""));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      resolve("");
    });
  });
}

async function getHostWorkspaceDir() {
  if (!hostWorkspaceDirPromise) {
    hostWorkspaceDirPromise = (async () => {
      if (hostWorkspaceDirOverride) {
        return hostWorkspaceDirOverride;
      }

      const detectedHostWorkspaceDir = await detectHostWorkspaceDirFromDocker();
      if (detectedHostWorkspaceDir) {
        return detectedHostWorkspaceDir;
      }

      return workspaceDir;
    })();
  }

  return hostWorkspaceDirPromise;
}

function normalizeVersion(version) {
  return String(version || "0")
    .trim()
    .split(".")
    .map((part) => Number(part) || 0);
}

function compareVersions(left, right) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  const maxLength = Math.max(a.length, b.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = a[index] || 0;
    const rightValue = b[index] || 0;
    if (leftValue > rightValue) {
      return 1;
    }
    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

async function readUpdateConfig() {
  return readJson(updateConfigPath, {
    server: {
      baseUrl: "",
      versionFile: "version.json",
      packageFile: "fablab-ai-update.tar.gz",
      notesFile: "release-notes.txt",
      headers: {}
    },
    apply: {
      services: ["backend", "frontend", "updater"],
      preservePaths: [".env", "update.config.json", "backend/uploads", "backend/logs", "backend/data"]
    }
  });
}

function joinUrl(baseUrl, targetPath) {
  const normalizedBase = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedPath = String(targetPath || "").replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedPath}`;
}

function extractIndexLinks(html) {
  const matches = [...String(html || "").matchAll(/<a\s+href="([^"]+)"/gi)];
  return matches
    .map((match) => String(match[1] || "").trim())
    .filter((href) => href && href !== "../" && !href.startsWith("?"))
    .filter((href, index, array) => array.indexOf(href) === index);
}

function extractDirectoryLinksFromIndex(html) {
  return extractIndexLinks(html)
    .filter((href) => href.endsWith("/"))
    .map((href) => href.replace(/\/+$/, ""));
}

function parseVersionFromPackageName(fileName) {
  const match = String(fileName || "").match(/fablab-ai-v(\d+(?:\.\d+)*)\.tar\.gz$/i);
  return match?.[1] || "";
}

function dedupeReleasesByVersion(releases = []) {
  const bestByVersion = new Map();

  for (const release of releases) {
    const versionKey = String(release?.version || "").trim();
    if (!versionKey) {
      continue;
    }

    const currentBest = bestByVersion.get(versionKey);
    if (!currentBest) {
      bestByVersion.set(versionKey, release);
      continue;
    }

    const currentPublishedAt = new Date(currentBest.publishedAt || 0).getTime() || 0;
    const candidatePublishedAt = new Date(release.publishedAt || 0).getTime() || 0;
    if (candidatePublishedAt >= currentPublishedAt) {
      bestByVersion.set(versionKey, release);
    }
  }

  return [...bestByVersion.values()].sort((left, right) =>
    compareVersions(String(right.version || ""), String(left.version || ""))
  );
}

async function resolveReleaseFromDirectory(baseUrl, versionFolder, serverConfig, headers = {}) {
  const releaseBaseUrl = joinUrl(baseUrl, versionFolder);
  const directoryHtml = await tryFetchText(`${releaseBaseUrl}/`, headers);
  const indexLinks = extractIndexLinks(directoryHtml);
  const notesFile = String(serverConfig?.notesFile || "release-notes.txt").trim();
  const versionPayload =
    (await tryFetchJson(joinUrl(releaseBaseUrl, serverConfig.versionFile || "version.json"), headers, null)) ||
    {};

  const packageCandidates = indexLinks.filter((href) => /\.tar\.gz$/i.test(href));
  const resolvedPackageFile =
    packageCandidates.find(
      (href) => String(href).trim() === resolvePackageFileName(serverConfig, versionFolder)
    ) || packageCandidates[0] || "";

  if (!resolvedPackageFile) {
    return null;
  }

  const inferredVersion =
    String(versionPayload.version || "").trim() ||
    parseVersionFromPackageName(resolvedPackageFile) ||
    String(versionFolder || "").trim();

  const packageUrl = joinUrl(releaseBaseUrl, resolvedPackageFile);
  const notesUrl = joinUrl(releaseBaseUrl, notesFile);
  const notes = await tryFetchText(notesUrl, headers);
  const publishedAt =
    (await tryFetchLastModified(notesUrl, headers, "")) ||
    (await tryFetchLastModified(packageUrl, headers, "")) ||
    "";

  return {
    version: inferredVersion,
    packageUrl,
    notes: notes.trim(),
    notesUrl,
    sha256: String(versionPayload.sha256 || "").toLowerCase(),
    publishedAt
  };
}

function isVersionFolderName(value) {
  return /^\d+(?:\.\d+)*$/.test(String(value || "").trim());
}

function resolvePackageFileName(serverConfig, version) {
  const template = String(serverConfig?.packageFileTemplate || "").trim();
  if (template) {
    return template.replace(/\{version\}/g, version);
  }

  const packageFile = String(serverConfig?.packageFile || "").trim();
  if (packageFile.includes("{version}")) {
    return packageFile.replace(/\{version\}/g, version);
  }

  return packageFile || `fablab-ai-v${version}.tar.gz`;
}

async function tryFetchText(url, headers = {}) {
  try {
    const response = await fetchWithTimeout(url, { headers });
    if (!response.ok) {
      return "";
    }

    return await response.text();
  } catch {
    return "";
  }
}

async function tryFetchLastModified(url, headers = {}, fallbackValue = "") {
  try {
    const response = await fetchWithTimeout(url, {
      method: "HEAD",
      headers
    });
    if (!response.ok) {
      return fallbackValue;
    }

    return response.headers.get("last-modified") || fallbackValue;
  } catch {
    return fallbackValue;
  }
}

async function tryFetchJson(url, headers = {}, fallbackValue = null) {
  try {
    const response = await fetchWithTimeout(url, { headers });
    if (!response.ok) {
      return fallbackValue;
    }

    return await response.json();
  } catch {
    return fallbackValue;
  }
}

async function fetchRemoteReleases() {
  const config = await readUpdateConfig();
  if (!config.server?.baseUrl) {
    throw new Error("Aucune URL de base n'est configurée dans update.config.json.");
  }

  const headers = config.server.headers || {};
  const baseUrl = String(config.server.baseUrl || "").replace(/\/+$/, "");
  const releaseLayout = String(config.server.releaseLayout || "").trim().toLowerCase();

  if (releaseLayout === "version-directories") {
    const response = await fetchWithTimeout(`${baseUrl}/`, { headers });
    if (!response.ok) {
      throw new Error(`Impossible de récupérer la liste des versions distantes (${response.status}).`);
    }

    const indexHtml = await response.text();
    const versions = extractDirectoryLinksFromIndex(indexHtml).filter(isVersionFolderName);
    if (versions.length === 0) {
      throw new Error("Aucune version exploitable n'a ete trouvee sur le serveur de mise a jour.");
    }

    versions.sort((left, right) => compareVersions(right, left));

    const releases = dedupeReleasesByVersion(
      (
      await Promise.all(
        versions.map((version) => resolveReleaseFromDirectory(baseUrl, version, config.server, headers))
      )
    )
        .filter(Boolean)
    );

    if (releases.length === 0) {
      throw new Error("Aucune version téléchargeable n'a été trouvée sur le serveur de mise à jour.");
    }

    return {
      releases,
      config
    };
  }

  const versionUrl = joinUrl(baseUrl, config.server.versionFile || "version.json");
  const response = await fetchWithTimeout(versionUrl, { headers });

  if (!response.ok) {
    throw new Error(`Impossible de récupérer la version distante (${response.status}).`);
  }

  const versionPayload = await response.json();
  const notesUrl = joinUrl(baseUrl, config.server.notesFile || "release-notes.txt");
  const packageUrl = joinUrl(baseUrl, config.server.packageFile || "fablab-ai-update.tar.gz");
  const notes = await tryFetchText(notesUrl, headers);
  const publishedAt =
    (await tryFetchLastModified(notesUrl, headers, "")) ||
    (await tryFetchLastModified(packageUrl, headers, "")) ||
    "";

  return {
    releases: [
      {
        version: versionPayload.version || "1.000",
        packageUrl,
        notes: notes.trim(),
        notesUrl,
        sha256: versionPayload.sha256 || "",
        publishedAt
      }
    ],
    config
  };
}

async function fetchRemoteReleaseInfo() {
  const { releases, config } = await fetchRemoteReleases();
  const release = releases[0];

  if (!release) {
    throw new Error("Aucune release distante n'est disponible pour le moment.");
  }

  return {
    release,
    config
  };
}

async function fetchRemoteReleaseInfoForVersion(targetVersion) {
  const normalizedTargetVersion = String(targetVersion || "").trim();
  const { releases, config } = await fetchRemoteReleases();

  if (!normalizedTargetVersion) {
    return {
      release: releases[0],
      config,
      releases
    };
  }

  const release = releases.find(
    (entry) => String(entry?.version || "").trim() === normalizedTargetVersion
  );

  if (!release) {
    throw new Error(`La version ${normalizedTargetVersion} n'est pas disponible sur le serveur de mise à jour.`);
  }

  return {
    release,
    config,
    releases
  };
}

function shouldPreserve(relativePath, preservePaths) {
  return preservePaths.some((entry) => {
    const normalizedEntry = entry.replace(/\\/g, "/").replace(/\/+$/, "");
    const normalizedTarget = relativePath.replace(/\\/g, "/");
    return normalizedTarget === normalizedEntry || normalizedTarget.startsWith(`${normalizedEntry}/`);
  });
}

async function downloadFile(url, targetPath, headers = {}) {
  const response = await fetchWithTimeout(url, { headers });
  if (!response.ok || !response.body) {
    throw new Error(`Telechargement impossible (${response.status}).`);
  }

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(targetPath));
}

async function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Inspecte le contenu d'une archive tar.gz avant extraction et rejette :
 * - les chemins absolus,
 * - les traversées de répertoire (..),
 * - les liens symboliques et liens durs (ils permettraient d'écrire hors du
 *   répertoire d'extraction pendant l'extraction).
 */
async function assertSafeArchive(archivePath) {
  const listing = await new Promise((resolve, reject) => {
    const child = spawn("tar", ["-tvzf", archivePath], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`Archive illisible ou corrompue (code ${code}).`));
    });
  });

  for (const line of listing.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const typeFlag = trimmed[0];
    if (typeFlag === "l" || typeFlag === "h") {
      throw new Error("Archive refusée : elle contient des liens symboliques ou des liens durs.");
    }

    const fields = trimmed.split(/\s+/);
    const memberPath = fields[fields.length - 1] || "";

    if (memberPath.startsWith("/")) {
      throw new Error("Archive refusée : elle contient des chemins absolus.");
    }

    if (memberPath.split("/").includes("..")) {
      throw new Error("Archive refusée : elle contient des traversées de répertoire (..).");
    }
  }
}

async function hashDirectoryContents(dirPath) {
  const hash = crypto.createHash("sha256");

  async function walk(currentPath) {
    const entries = await fsp.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    const sortedEntries = entries
      .filter((entry) => entry.name !== "node_modules")
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of sortedEntries) {
      const entryPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(dirPath, entryPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      hash.update(relativePath);
      const content = await fsp.readFile(entryPath).catch(() => Buffer.alloc(0));
      hash.update(content);
    }
  }

  await walk(dirPath);
  return hash.digest("hex");
}

// L'updater tourne depuis une image Docker construite a partir de updater/ :
// mettre a jour les fichiers du workspace ne suffit pas a changer son
// comportement tant que l'image n'est pas reconstruite (--build). Comme ce
// redemarrage rend le service brievement injoignable, on ne le declenche que
// si le code de l'updater a reellement change entre l'ancienne et la nouvelle
// version, au lieu de le faire systematiquement a chaque mise a jour.
async function hasUpdaterCodeChanged(packageRoot) {
  try {
    const [previousHash, nextHash] = await Promise.all([
      hashDirectoryContents(path.join(workspaceDir, "updater")),
      hashDirectoryContents(path.join(packageRoot, "updater"))
    ]);
    return previousHash !== nextHash;
  } catch {
    // En cas de doute, on redemarre par securite.
    return true;
  }
}

function sanitizeServiceNames(services, fallback = ["backend", "updater"]) {
  const candidates = Array.isArray(services) && services.length > 0 ? services : fallback;
  const safeServices = candidates
    .map((service) => String(service || "").trim())
    .filter((service) => /^[a-zA-Z0-9_-]+$/.test(service));

  return safeServices.length > 0 ? safeServices : fallback;
}

async function ensureDir(targetPath) {
  await fsp.mkdir(targetPath, { recursive: true });
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error("remote-fetch-timeout"));
  }, remoteFetchTimeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Le serveur distant de mise a jour ne repond pas a temps.");
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isRuntimePreservedPath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return [".update-backups", ".git"].includes(normalized);
}

function formatBackupId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function syncTree(sourceRoot, destinationRoot, preservePaths, workspaceRoot = destinationRoot) {
  await ensureDir(destinationRoot);

  const sourceEntries = await fsp.readdir(sourceRoot, { withFileTypes: true });
  const sourceEntryMap = new Map(sourceEntries.map((entry) => [entry.name, entry]));
  const destinationEntries = await fsp.readdir(destinationRoot, { withFileTypes: true }).catch(() => []);

  for (const destinationEntry of destinationEntries) {
    const destinationPath = path.join(destinationRoot, destinationEntry.name);
    const relativePath = path.relative(workspaceRoot, destinationPath);

    if (shouldPreserve(relativePath, preservePaths) || isRuntimePreservedPath(relativePath)) {
      continue;
    }

    const sourceEntry = sourceEntryMap.get(destinationEntry.name);
    if (!sourceEntry) {
      await fsp.rm(destinationPath, { recursive: true, force: true });
      pushLog(`Ancien fichier supprimé : ${relativePath}`);
      continue;
    }

    const destinationIsDir = destinationEntry.isDirectory();
    const sourceIsDir = sourceEntry.isDirectory();
    if (destinationIsDir !== sourceIsDir) {
      await fsp.rm(destinationPath, { recursive: true, force: true });
      pushLog(`Ancien élément remplacé : ${relativePath}`);
    }
  }

  for (const entry of sourceEntries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const destinationPath = path.join(destinationRoot, entry.name);
    const relativePath = path.relative(workspaceRoot, destinationPath);

    if (shouldPreserve(relativePath, preservePaths) || isRuntimePreservedPath(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      await ensureDir(destinationPath);
      await syncTree(sourcePath, destinationPath, preservePaths, workspaceRoot);
      continue;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    await ensureDir(path.dirname(destinationPath));
    await fsp.copyFile(sourcePath, destinationPath);
  }
}

async function backupCriticalFiles(backupRoot) {
  await ensureDir(backupRoot);

  for (const fileName of [".env", "update.config.json", "version.json", "docker-compose.yml"]) {
    const sourcePath = path.join(workspaceDir, fileName);
    try {
      await ensureDir(path.dirname(path.join(backupRoot, fileName)));
      await fsp.copyFile(sourcePath, path.join(backupRoot, fileName));
    } catch {
      // Ignore missing files; preserve as much context as available.
    }
  }

  return backupRoot;
}

async function writeBackupMetadata(backupRoot, metadata) {
  await ensureDir(backupRoot);
  await fsp.writeFile(
    path.join(backupRoot, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8"
  );
}

async function createWorkspaceBackup(currentVersion, preservePaths = []) {
  const backupId = formatBackupId();
  const backupRoot = path.join(backupStoreDir, backupId);
  const archivePath = path.join(backupRoot, "workspace.tar.gz");
  await ensureDir(backupRoot);
  await backupCriticalFiles(backupRoot);

  const excludeArgs = [
    "--exclude=.update-backups",
    "--exclude=backend/node_modules",
    "--exclude=frontend/node_modules",
    "--exclude=updater/node_modules",
    "--exclude=.git"
  ];

  for (const preservePath of preservePaths) {
    const normalized = String(preservePath || "").replace(/^\/+|\/+$/g, "");
    if (normalized) {
      excludeArgs.push(`--exclude=${normalized}`);
    }
  }

  await new Promise((resolve, reject) => {
    const child = spawn(
      "tar",
      [...excludeArgs, "-czf", archivePath, "-C", workspaceDir, "."],
      {
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    child.stdout.on("data", (chunk) => pushLog(chunk.toString().trim()));
    child.stderr.on("data", (chunk) => pushLog(chunk.toString().trim()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Creation de la sauvegarde impossible (code ${code}).`));
    });
  });

  const metadata = {
    id: backupId,
    version: currentVersion,
    createdAt: new Date().toISOString(),
    archiveFile: "workspace.tar.gz"
  };
  await writeBackupMetadata(backupRoot, metadata);
  return metadata;
}

async function listBackups() {
  try {
    await ensureDir(backupStoreDir);
    const entries = await fsp.readdir(backupStoreDir, { withFileTypes: true });
    const backups = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const backupRoot = path.join(backupStoreDir, entry.name);
      const metadata = await readJson(path.join(backupRoot, "metadata.json"), null);
      const archivePath = path.join(backupRoot, "workspace.tar.gz");

      try {
        const stat = await fsp.stat(archivePath);
        backups.push({
          id: entry.name,
          version: metadata?.version || "Inconnue",
          createdAt: metadata?.createdAt || stat.mtime.toISOString(),
          archivePath,
          size: stat.size
        });
      } catch {
        // Ignore invalid backup folders.
      }
    }

    return backups.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  } catch {
    return [];
  }
}

function splitBackupsForRetention(backups) {
  const versionSeen = new Set();
  const keptBackups = [];
  const removableDuplicates = [];

  for (const backup of backups) {
    const versionKey = String(backup.version || "").trim() || "Inconnue";
    if (versionSeen.has(versionKey)) {
      removableDuplicates.push(backup);
      continue;
    }

    versionSeen.add(versionKey);
    keptBackups.push(backup);
  }

  const staleBackups = keptBackups.slice(maxBackupVersions);

  return {
    visibleBackups: keptBackups.slice(0, maxBackupVersions),
    removableBackups: [...removableDuplicates, ...staleBackups]
  };
}

async function pruneOldBackups() {
  const backups = await listBackups();
  const { removableBackups } = splitBackupsForRetention(backups);

  for (const backup of removableBackups) {
    await fsp.rm(path.join(backupStoreDir, backup.id), { recursive: true, force: true });
    pushLog(`Sauvegarde supprimée : ${backup.id} (${backup.version}).`);
  }
}

async function detectPackageRoot(extractRoot) {
  const rootEntries = await fsp.readdir(extractRoot, { withFileTypes: true });
  const firstDirectory = rootEntries.find((entry) => entry.isDirectory());

  try {
    await fsp.access(path.join(extractRoot, "docker-compose.yml"));
    return extractRoot;
  } catch {
    if (firstDirectory) {
      const nestedRoot = path.join(extractRoot, firstDirectory.name);
      await fsp.access(path.join(nestedRoot, "docker-compose.yml"));
      return nestedRoot;
    }
  }

  throw new Error("Le package de mise à jour ne contient pas docker-compose.yml.");
}

async function validatePackageRoot(packageRoot) {
  const requiredEntries = [
    "docker-compose.yml",
    "backend",
    "frontend"
  ];

  for (const entry of requiredEntries) {
    try {
      await fsp.access(path.join(packageRoot, entry));
    } catch {
      throw new Error(`Le package de mise à jour est incomplet : ${entry} est introuvable.`);
    }
  }
}

async function runComposeUpdate(services) {
  const hostWorkspaceDir = await getHostWorkspaceDir();
  const composeFilePath = path.join(workspaceDir, "docker-compose.yml");
  const composeEnvironment = {
    ...process.env,
    PROJECT_WORKSPACE_DIR: hostWorkspaceDir
  };

  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "-p",
        composeProjectName,
        "-f",
        composeFilePath,
        "up",
        "-d",
        "--build",
        ...services
      ],
      {
        cwd: workspaceDir,
        env: composeEnvironment,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    child.stdout.on("data", (chunk) => {
      pushLog(chunk.toString().trim());
    });
    child.stderr.on("data", (chunk) => {
      pushLog(chunk.toString().trim());
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`docker-compose a quitte avec le code ${code}.`));
    });
  });
}

// Redemarre (sans reconstruire) des services qui n'ont pas de code applicatif
// propre (images tierces : Ollama, ChromaDB, Redis), pour repartir sur un etat
// completement propre apres chaque mise a jour ou rollback, comme le fait
// manuellement ./restart.sh.
async function runComposeRestart(services) {
  const hostWorkspaceDir = await getHostWorkspaceDir();
  const composeFilePath = path.join(workspaceDir, "docker-compose.yml");
  const composeEnvironment = {
    ...process.env,
    PROJECT_WORKSPACE_DIR: hostWorkspaceDir
  };

  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      ["compose", "-p", composeProjectName, "-f", composeFilePath, "restart", ...services],
      {
        cwd: workspaceDir,
        env: composeEnvironment,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    child.stdout.on("data", (chunk) => {
      pushLog(chunk.toString().trim());
    });
    child.stderr.on("data", (chunk) => {
      pushLog(chunk.toString().trim());
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`docker-compose restart a quitte avec le code ${code}.`));
    });
  });
}

function triggerDetachedComposeUpdate(services) {
  if (!Array.isArray(services) || services.length === 0) {
    return;
  }

  getHostWorkspaceDir()
    .then((hostWorkspaceDir) => {
      const child = spawn(
        "sh",
        [
          "-lc",
          `PROJECT_WORKSPACE_DIR="${hostWorkspaceDir}" docker-compose -p "${composeProjectName}" -f "${path.join(workspaceDir, "docker-compose.yml")}" up -d --build ${services
            .map((service) => `"${service}"`)
            .join(" ")} >/tmp/fablab-updater-detached.log 2>&1 &`
        ],
        {
          cwd: workspaceDir,
          detached: true,
          stdio: "ignore"
        }
      );

      child.unref();
    })
    .catch((error) => {
      pushLog(`Redémarrage différé impossible : ${error.message}`);
    });
}

async function restoreBackupArchive(archivePath, preservePaths = []) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "fablab-rollback-"));
  try {
    const extractRoot = path.join(tempRoot, "extract");
    await ensureDir(extractRoot);

    await new Promise((resolve, reject) => {
      const child = spawn("tar", ["-xzf", archivePath, "-C", extractRoot], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.on("data", (chunk) => pushLog(chunk.toString().trim()));
      child.stderr.on("data", (chunk) => pushLog(chunk.toString().trim()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Extraction de la sauvegarde impossible (code ${code}).`));
      });
    });

    const updaterCodeChanged = await hasUpdaterCodeChanged(extractRoot);
    await syncTree(extractRoot, workspaceDir, preservePaths || []);
    return { updaterCodeChanged };
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchCachedRemoteReleaseInfo() {
  const now = Date.now();
  if (remoteReleaseCache && now - remoteReleaseCachedAt < remoteReleaseTtlMs) {
    return remoteReleaseCache;
  }

  const result = await fetchRemoteReleaseInfo();
  remoteReleaseCache = result;
  remoteReleaseCachedAt = now;
  return result;
}

function invalidateRemoteReleaseCache() {
  remoteReleaseCache = null;
  remoteReleaseCachedAt = 0;
}

async function buildStatus() {
  const currentVersion = await readVersion();
  setState({ currentVersion });
  await pruneOldBackups();
  const backups = await listBackups();
  const { visibleBackups } = splitBackupsForRetention(backups);

  try {
    const { release } = await fetchCachedRemoteReleaseInfo();
    const latestVersion = release.version || currentVersion;
    const updateAvailable = compareVersions(latestVersion, currentVersion) === 1;

    setState({
      latestVersion,
      updateAvailable,
      ...(state.status === "unavailable" ? { status: "idle", message: "Prêt.", error: null } : {})
    });

    return {
      currentVersion,
      latestVersion,
      updateAvailable,
      release,
      retention: maxBackupVersions,
      backups: visibleBackups.map((backup) => ({
        id: backup.id,
        version: backup.version,
        createdAt: backup.createdAt,
        size: backup.size
      })),
      state
    };
  } catch (error) {
    // Ne pas écraser l'état si une mise à jour ou un rollback est en cours.
    if (!state.busy) {
      setState({
        busy: false,
        status: "unavailable",
        progress: 0,
        message: error.message || "Le service de mise a jour est temporairement indisponible."
      });
    }

    return {
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      release: null,
      retention: maxBackupVersions,
      backups: visibleBackups.map((backup) => ({
        id: backup.id,
        version: backup.version,
        createdAt: backup.createdAt,
        size: backup.size
      })),
      state,
      warning: error.message
    };
  }
}

async function applyUpdateInBackground(targetVersion = "") {
  invalidateRemoteReleaseCache();
  setState({
    busy: true,
    status: "checking",
    progress: 5,
    message: "Vérification de la mise à jour...",
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    logs: []
  });
  pushLog("Début de la procédure de mise à jour.");

  try {
    const requestedVersion = String(targetVersion || "").trim();
    const { release, config, releases } = await fetchRemoteReleaseInfoForVersion(requestedVersion);
    const currentVersion = await readVersion();
    const targetReleaseVersion = release.version || currentVersion;
    const latestVersion = releases?.[0]?.version || targetReleaseVersion;

    if (compareVersions(targetReleaseVersion, currentVersion) <= 0) {
      setState({
        busy: false,
        status: "idle",
        progress: 100,
        message: "Aucune mise à jour à appliquer.",
        latestVersion,
        targetVersion: targetReleaseVersion,
        updateAvailable: compareVersions(latestVersion, currentVersion) === 1,
        completedAt: new Date().toISOString()
      });
      return;
    }

    const packageUrl = release.packageUrl;
    if (!packageUrl) {
      throw new Error("Aucune archive de mise à jour n'est configurée.");
    }

    setState({
      status: "downloading",
      progress: 18,
      message: "Téléchargement du package de mise à jour...",
      targetVersion: targetReleaseVersion,
      latestVersion
    });

    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "fablab-update-"));
    try {
      const archivePath = path.join(tempRoot, "release.tar.gz");
      await downloadFile(packageUrl, archivePath, config.server.headers || {});
      pushLog(`Package téléchargé depuis ${packageUrl}.`);

      const requireSha256 = config.server?.requireSha256 !== false;
      if (!release.sha256 && requireSha256) {
        throw new Error(
          "La release distante ne fournit pas de somme SHA256. Installation refusée : publiez la version avec publish-release.sh pour générer le manifest."
        );
      }

      if (release.sha256) {
        const digest = await sha256OfFile(archivePath);
        if (digest !== String(release.sha256).toLowerCase()) {
          throw new Error("La verification SHA256 du package a echoue.");
        }
        pushLog("Verification SHA256 validee.");
      }

      pushLog("Contrôle de sécurité de l'archive...");
      await assertSafeArchive(archivePath);
      pushLog("Archive validée : aucun chemin dangereux détecté.");

      setState({
        status: "extracting",
        progress: 35,
        message: "Préparation des fichiers..."
      });

      const extractRoot = path.join(tempRoot, "extract");
      await ensureDir(extractRoot);
      await new Promise((resolve, reject) => {
        const child = spawn("tar", ["-xzf", archivePath, "-C", extractRoot], {
          stdio: ["ignore", "pipe", "pipe"]
        });
        child.stdout.on("data", (chunk) => pushLog(chunk.toString().trim()));
        child.stderr.on("data", (chunk) => pushLog(chunk.toString().trim()));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`Extraction impossible (code ${code}).`));
        });
      });

      const packageRoot = await detectPackageRoot(extractRoot);
      await validatePackageRoot(packageRoot);
      const backup = await createWorkspaceBackup(currentVersion, config.apply?.preservePaths || []);
      pushLog(`Sauvegarde de rollback créée (${backup.version}) dans ${backup.id}.`);

      const configuredServices = sanitizeServiceNames(config.apply?.services);
      const updaterCodeChanged =
        configuredServices.includes("updater") && (await hasUpdaterCodeChanged(packageRoot));

      setState({
        status: "copying",
        progress: 58,
        message: "Application des nouveaux fichiers..."
      });

      await syncTree(packageRoot, workspaceDir, config.apply?.preservePaths || []);
      pushLog("Nouveaux fichiers du projet synchronisés.");

      setState({
        status: "restarting",
        progress: 78,
        message: "Redémarrage du backend avec le frontend embarqué..."
      });

      const immediateServices = configuredServices.filter((service) => service !== "updater");
      const deferredServices = updaterCodeChanged
        ? configuredServices.filter((service) => service === "updater")
        : [];

      if (!updaterCodeChanged && configuredServices.includes("updater")) {
        pushLog("Code de l'updater inchangé : redémarrage du service de mise à jour évité.");
      }

      if (immediateServices.length > 0) {
        await runComposeUpdate(immediateServices);
      }

      setState({
        progress: 90,
        message: "Redémarrage complet des services (Ollama, ChromaDB, Redis)..."
      });
      try {
        await runComposeRestart(fullStackRestartServices);
        pushLog("Ollama, ChromaDB et Redis redémarrés.");
      } catch (error) {
        // Non bloquant : le code applicatif est deja a jour, un souci de
        // redemarrage sur ces services tiers ne doit pas faire echouer la mise a jour.
        pushLog(`Redémarrage complet ignoré : ${error.message}`);
      }

      await pruneOldBackups();

      setState({
        busy: false,
        status: "completed",
        progress: 100,
        message: "Mise à jour terminée.",
        currentVersion: targetReleaseVersion,
        latestVersion,
        targetVersion: targetReleaseVersion,
        updateAvailable: compareVersions(latestVersion, targetReleaseVersion) === 1,
        completedAt: new Date().toISOString()
      });
      pushLog(`Mise à jour terminée avec succès vers ${targetReleaseVersion}.`);

      if (deferredServices.length > 0) {
        pushLog("Redémarrage de l'updater programmé en arrière-plan.");
        triggerDetachedComposeUpdate(deferredServices);
      }
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    setState({
      busy: false,
      status: "error",
      progress: 100,
      message: error.message,
      error: error.message,
      completedAt: new Date().toISOString()
    });
    pushLog(`Erreur de mise à jour : ${error.message}`);
  }
}

async function rollbackToBackupInBackground(backupId) {
  setState({
    busy: true,
    status: "rollback",
    progress: 5,
    message: "Préparation du retour arrière...",
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    logs: []
  });
  pushLog(`Début du rollback vers ${backupId}.`);

  try {
    const config = await readUpdateConfig();
    const backups = await listBackups();
    const backup = backups.find((item) => item.id === backupId);

    if (!backup) {
      throw new Error("Sauvegarde introuvable.");
    }

    setState({
      progress: 28,
      message: "Restauration des fichiers sauvegardés...",
      targetVersion: backup.version
    });

    const { updaterCodeChanged } = await restoreBackupArchive(
      backup.archivePath,
      config.apply?.preservePaths || []
    );

    setState({
      progress: 72,
      message: "Redémarrage des services..."
    });

    const configuredServices = sanitizeServiceNames(config.apply?.services);
    const immediateServices = configuredServices.filter((service) => service !== "updater");
    const deferredServices = updaterCodeChanged
      ? configuredServices.filter((service) => service === "updater")
      : [];

    if (!updaterCodeChanged && configuredServices.includes("updater")) {
      pushLog("Code de l'updater inchangé : redémarrage du service de mise à jour évité.");
    }

    if (immediateServices.length > 0) {
      await runComposeUpdate(immediateServices);
    }

    setState({
      progress: 90,
      message: "Redémarrage complet des services (Ollama, ChromaDB, Redis)..."
    });
    try {
      await runComposeRestart(fullStackRestartServices);
      pushLog("Ollama, ChromaDB et Redis redémarrés.");
    } catch (error) {
      pushLog(`Redémarrage complet ignoré : ${error.message}`);
    }

    setState({
      busy: false,
      status: "completed",
      progress: 100,
      message: `Rollback terminé vers ${backup.version}.`,
      currentVersion: backup.version,
      latestVersion: state.latestVersion,
      updateAvailable: compareVersions(String(state.latestVersion || backup.version), backup.version) === 1,
      completedAt: new Date().toISOString()
    });
    pushLog(`Rollback terminé vers ${backup.version}.`);

    if (deferredServices.length > 0) {
      pushLog("Redémarrage de l'updater programmé en arrière-plan.");
      triggerDetachedComposeUpdate(deferredServices);
    }
  } catch (error) {
    setState({
      busy: false,
      status: "error",
      progress: 100,
      message: error.message,
      error: error.message,
      completedAt: new Date().toISOString()
    });
    pushLog(`Erreur de rollback : ${error.message}`);
  }
}

/**
 * Export et publication de la version en cours d'edition (ce workspace) vers
 * le serveur de mise à jour distant.
 */
// Les identifiants peuvent venir du backend (stockage chiffre en base, transmis
// sur le reseau Docker interne uniquement) plutot que des variables d'environnement
// en clair : l'override transmis par la requete de publication est prioritaire.
function getDeployFtpConfig(override = {}) {
  return {
    host: String(override.host ?? process.env.DEPLOY_FTP_HOST ?? "").trim(),
    user: String(override.user ?? process.env.DEPLOY_FTP_USER ?? "").trim(),
    password: String(override.password ?? process.env.DEPLOY_FTP_PASSWORD ?? "").trim(),
    remoteDir: String(override.remoteDir ?? process.env.DEPLOY_FTP_REMOTE_DIR ?? "")
      .trim()
      .replace(/^\/+|\/+$/g, ""),
    // Dossier ou est deposee la derniere version en .zip sous un nom fixe
    // (fablab-ai.zip), pour l'installation web en une commande - separe du
    // dossier versionne ci-dessus. Par defaut, un niveau au-dessus de
    // remoteDir (ex: remoteDir "iutlab/maj" -> latestZipDir "iutlab").
    latestZipDir: String(override.latestZipDir ?? process.env.DEPLOY_LATEST_ZIP_DIR ?? "")
      .trim()
      .replace(/^\/+|\/+$/g, ""),
    publicBaseUrl: String(override.publicBaseUrl ?? process.env.DEPLOY_PUBLIC_BASE_URL ?? "")
      .trim()
      .replace(/\/+$/, "")
  };
}

function bumpVersion(version) {
  const segments = String(version || "1.000").trim().split(".");
  const lastIndex = segments.length - 1;
  const originalSegment = segments[lastIndex];
  const lastValue = Number(originalSegment);
  const nextValue = Number.isFinite(lastValue) ? lastValue + 1 : 1;
  // Preserve le remplissage par des zeros (ex. "013" -> "014", pas "14").
  segments[lastIndex] = String(nextValue).padStart(originalSegment.length, "0");
  return segments.join(".");
}

function isValidVersionString(version) {
  return /^\d+(\.\d+)*$/.test(String(version || "").trim());
}

const exportExcludes = [
  ".git",
  ".DS_Store",
  "._*",
  "export",
  "release",
  ".update-backups",
  ".claude",
  "backend/node_modules",
  "frontend/node_modules",
  "updater/node_modules",
  "backend/data",
  "backend/logs",
  "backend/uploads",
  ".env",
  ".env.publish",
  "data",
  "logs",
  "uploads",
  "fablab-admin-cookie.txt"
];

async function buildExportArchive(version) {
  const exportRoot = path.join(workspaceDir, "export", version);
  await ensureDir(exportRoot);
  const archiveName = `fablab-ai-v${version}.tar.gz`;
  const archivePath = path.join(exportRoot, archiveName);

  const excludeArgs = exportExcludes.map((entry) => `--exclude=${entry}`);

  // L'archive doit contenir un dossier "fablab-ai/" au sommet (pas de fichiers
  // en vrac, et surtout pas "workspace/" : workspaceDir vaut toujours
  // "/workspace" a l'interieur du conteneur, peu importe le nom reel du
  // dossier hote). --transform renomme le prefixe "./" en "composeProjectName/"
  // a la volee pendant l'archivage, sans avoir a dupliquer les fichiers.
  await new Promise((resolve, reject) => {
    const child = spawn(
      "tar",
      [
        ...excludeArgs,
        `--transform=s,^\\.\\(/\\|$\\),${composeProjectName}\\1,`,
        "-czf",
        archivePath,
        "-C",
        workspaceDir,
        "."
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    child.stdout.on("data", (chunk) => pushDeployLog(chunk.toString().trim()));
    child.stderr.on("data", (chunk) => pushDeployLog(chunk.toString().trim()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Construction de l'archive impossible (code ${code}).`));
    });
  });

  return { exportRoot, archivePath, archiveName };
}

// Reconstruit un .zip identique au .tar.gz deja construit (memes exclusions,
// deja appliquees dans l'archive) : extraction dans un dossier temporaire
// puis rezippage, pour ne pas dupliquer la liste d'exclusions. Sert au fichier
// "derniere version" (fablab-ai.zip) attendu par l'installation web en une
// commande (irm ... | iex, voir web-install.ps1), qui n'a pas d'equivalent
// tar.gz cote client Windows.
async function buildExportZip(exportRoot, archivePath, version) {
  const zipName = `fablab-ai-v${version}.zip`;
  const zipPath = path.join(exportRoot, zipName);
  const stagingDir = await fsp.mkdtemp(path.join(os.tmpdir(), "fablab-zip-"));

  try {
    await new Promise((resolve, reject) => {
      const child = spawn("tar", ["-xzf", archivePath, "-C", stagingDir], { stdio: ["ignore", "pipe", "pipe"] });
      child.stderr.on("data", (chunk) => pushDeployLog(chunk.toString().trim()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Extraction pour construire le zip impossible (code ${code}).`));
      });
    });

    await fsp.rm(zipPath, { force: true });

    await new Promise((resolve, reject) => {
      const child = spawn("zip", ["-rq", "-X", zipPath, "."], {
        cwd: stagingDir,
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stderr.on("data", (chunk) => pushDeployLog(chunk.toString().trim()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Construction du zip impossible (code ${code}).`));
      });
    });
  } finally {
    await fsp.rm(stagingDir, { recursive: true, force: true });
  }

  return { zipPath, zipName };
}

async function uploadFileViaFtps(localPath, remoteUrl, ftpConfig) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--ssl-reqd",
        "--ftp-create-dirs",
        "--user",
        `${ftpConfig.user}:${ftpConfig.password}`,
        "--upload-file",
        localPath,
        remoteUrl
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Envoi FTPS impossible (code ${code}). ${stderr.trim()}`.trim()));
    });
  });
}

async function verifyPublicManifest(publicBaseUrl, version) {
  const manifestUrl = `${publicBaseUrl}/${version}/version.json`;
  const response = await fetchWithTimeout(manifestUrl, {}).catch(() => null);
  if (!response || !response.ok) {
    return { ok: false, manifestUrl };
  }

  try {
    const payload = await response.json();
    return { ok: String(payload.version || "").trim() === version, manifestUrl };
  } catch {
    return { ok: false, manifestUrl };
  }
}

async function runExportPublishInBackground({ version, notes, ftpConfigOverride }) {
  setDeployState({
    busy: true,
    status: "building",
    progress: 5,
    message: "Construction de l'archive du projet...",
    version,
    publicUrl: null,
    sha256: null,
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    logs: []
  });
  pushDeployLog(`Debut de l'export de la version ${version}.`);

  try {
    const ftpConfig = getDeployFtpConfig(ftpConfigOverride);
    if (!ftpConfig.host || !ftpConfig.user || !ftpConfig.password || !ftpConfig.remoteDir) {
      throw new Error(
        "Configuration FTP de deploiement incomplete. Verifiez DEPLOY_FTP_HOST, DEPLOY_FTP_USER, DEPLOY_FTP_PASSWORD et DEPLOY_FTP_REMOTE_DIR."
      );
    }

    const { exportRoot, archivePath, archiveName } = await buildExportArchive(version);
    pushDeployLog(`Archive construite : ${archiveName}.`);

    const { zipPath, zipName } = await buildExportZip(exportRoot, archivePath, version);
    pushDeployLog(`Archive zip construite : ${zipName}.`);

    setDeployState({ status: "hashing", progress: 30, message: "Calcul de l'empreinte SHA256..." });
    const sha256 = await sha256OfFile(archivePath);
    pushDeployLog(`SHA256 : ${sha256}.`);

    const publishedAt = new Date().toISOString();
    const manifest = { version, sha256, packageFile: archiveName, publishedAt };
    await fsp.writeFile(path.join(exportRoot, "version.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fsp.writeFile(path.join(exportRoot, "release-notes.txt"), `${notes}\n`, "utf8");

    // Le workspace en cours d'edition reflete desormais cette version publiee.
    await fsp.writeFile(versionFilePath, `${JSON.stringify({ version }, null, 2)}\n`, "utf8");
    await fsp.writeFile(path.join(workspaceDir, "release-notes.txt"), `${notes}\n`, "utf8");
    invalidateRemoteReleaseCache();

    setDeployState({ status: "uploading", progress: 55, message: "Envoi vers le serveur distant (FTPS)..." });
    const remoteBase = `ftp://${ftpConfig.host}/${ftpConfig.remoteDir}/${version}`;
    await uploadFileViaFtps(archivePath, `${remoteBase}/${archiveName}`, ftpConfig);
    pushDeployLog("Archive envoyee.");
    await uploadFileViaFtps(path.join(exportRoot, "version.json"), `${remoteBase}/version.json`, ftpConfig);
    pushDeployLog("Manifest envoye.");
    await uploadFileViaFtps(path.join(exportRoot, "release-notes.txt"), `${remoteBase}/release-notes.txt`, ftpConfig);
    pushDeployLog("Notes de version envoyees.");

    // Copie "derniere version" sous un nom fixe (fablab-ai.zip), toujours au meme
    // endroit et toujours ecrasee : c'est ce que telecharge l'installation web en
    // une commande (irm ... | iex), qui n'a aucun moyen de connaitre le numero de
    // version a l'avance et ne doit jamais avoir a etre mise a jour manuellement.
    const latestZipDir = ftpConfig.latestZipDir || path.posix.dirname(`/${ftpConfig.remoteDir}`).replace(/^\/+/, "");
    if (latestZipDir && latestZipDir !== ".") {
      await uploadFileViaFtps(zipPath, `ftp://${ftpConfig.host}/${latestZipDir}/fablab-ai.zip`, ftpConfig);
      pushDeployLog(`fablab-ai.zip mis a jour dans ${latestZipDir}/ (toujours la derniere version).`);
    } else {
      pushDeployLog(
        "Attention : impossible de determiner le dossier de fablab-ai.zip (DEPLOY_FTP_REMOTE_DIR trop court) - non mis a jour."
      );
    }

    setDeployState({ status: "verifying", progress: 85, message: "Verification de l'acces public HTTPS..." });
    const publicUrl = ftpConfig.publicBaseUrl ? `${ftpConfig.publicBaseUrl}/${version}` : null;
    let verified = true;
    if (ftpConfig.publicBaseUrl) {
      const verification = await verifyPublicManifest(ftpConfig.publicBaseUrl, version);
      verified = verification.ok;
      pushDeployLog(
        verified
          ? `Verification publique OK : ${verification.manifestUrl}.`
          : `Attention : verification publique impossible sur ${verification.manifestUrl}.`
      );
    }

    setDeployState({
      busy: false,
      status: verified ? "completed" : "completed-unverified",
      progress: 100,
      message: verified
        ? `Version ${version} publiee avec succes.`
        : `Version ${version} envoyee, mais la verification publique a echoue (propagation possible).`,
      version,
      publicUrl,
      sha256,
      completedAt: new Date().toISOString()
    });
    pushDeployLog(`Publication terminee pour la version ${version}.`);
  } catch (error) {
    setDeployState({
      busy: false,
      status: "error",
      progress: 100,
      message: error.message,
      error: error.message,
      completedAt: new Date().toISOString()
    });
    pushDeployLog(`Erreur : ${error.message}`);
  }
}

app.get("/health", async (_req, res) => {
  res.json({
    status: "ok",
    currentVersion: await readVersion()
  });
});

app.get("/status", async (_req, res) => {
  const payload = await buildStatus();
  res.json(payload);
});

app.get("/releases", async (_req, res) => {
  try {
    const { releases } = await fetchRemoteReleases();
    res.json({
      releases,
      latestVersion: releases[0]?.version || null
    });
  } catch (error) {
    res.status(503).json({
      message: error.message || "Impossible de récupérer les notes de version.",
      releases: [],
      latestVersion: null
    });
  }
});

app.post("/apply", async (req, res) => {
  if (state.busy) {
    return res.status(409).json({
      message: "Une mise à jour est déjà en cours.",
      state
    });
  }

  const targetVersion = String(req.body?.targetVersion || "").trim();

  applyUpdateInBackground(targetVersion).catch((error) => {
    pushLog(`Erreur inattendue: ${error.message}`);
  });

  return res.status(202).json({
    message: "Mise à jour lancée.",
    state
  });
});

app.get("/backups", async (_req, res) => {
  await pruneOldBackups();
  const backups = await listBackups();
  const { visibleBackups } = splitBackupsForRetention(backups);
  res.json({
    backups: visibleBackups.map((backup) => ({
      id: backup.id,
      version: backup.version,
      createdAt: backup.createdAt,
      size: backup.size
    })),
    retention: maxBackupVersions
  });
});

app.post("/rollback", async (req, res) => {
  if (state.busy) {
    return res.status(409).json({
      message: "Une mise à jour ou un rollback est déjà en cours.",
      state
    });
  }

  const backupId = String(req.body?.backupId || "").trim();
  if (!backupId) {
    return res.status(400).json({
      message: "backupId est requis."
    });
  }

  rollbackToBackupInBackground(backupId).catch((error) => {
    pushLog(`Erreur inattendue de rollback: ${error.message}`);
  });

  return res.status(202).json({
    message: "Rollback lance.",
    state
  });
});

app.get("/export/status", async (_req, res) => {
  const currentVersion = await readVersion();
  const ftpConfig = getDeployFtpConfig();

  res.json({
    currentVersion,
    suggestedNextVersion: bumpVersion(currentVersion),
    publicBaseUrl: ftpConfig.publicBaseUrl || null,
    configured: Boolean(ftpConfig.host && ftpConfig.user && ftpConfig.password && ftpConfig.remoteDir),
    state: deployState
  });
});

app.post("/export/publish", async (req, res) => {
  if (deployState.busy) {
    return res.status(409).json({
      message: "Un export est deja en cours.",
      state: deployState
    });
  }

  if (state.busy) {
    return res.status(409).json({
      message: "Une mise a jour ou un rollback est en cours. Attendez sa fin avant de publier.",
      state: deployState
    });
  }

  const currentVersion = await readVersion();
  const requestedVersion = String(req.body?.version || "").trim() || bumpVersion(currentVersion);
  const notes = String(req.body?.notes || "").trim();

  if (!isValidVersionString(requestedVersion)) {
    return res.status(400).json({ message: "Numero de version invalide (format attendu : 1.014)." });
  }

  if (compareVersions(requestedVersion, currentVersion) <= 0) {
    return res.status(400).json({
      message: `La version ${requestedVersion} doit etre superieure a la version actuelle (${currentVersion}).`
    });
  }

  if (!notes) {
    return res.status(400).json({ message: "Une note de version est requise." });
  }

  const ftpConfigOverride =
    req.body?.ftpConfig && typeof req.body.ftpConfig === "object" ? req.body.ftpConfig : undefined;

  runExportPublishInBackground({ version: requestedVersion, notes, ftpConfigOverride }).catch(
    (error) => {
      pushDeployLog(`Erreur inattendue : ${error.message}`);
    }
  );

  return res.status(202).json({
    message: "Export et publication lances.",
    state: deployState
  });
});

app.listen(port, async () => {
  setState({ currentVersion: await readVersion() });
  console.log(`Updater ready on port ${port}`);
});
