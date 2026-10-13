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

// Jeton partage backend <-> updater. L'updater n'est pas publie sur l'hote mais
// reste joignable par tous les conteneurs du reseau Docker interne : si l'un
// d'eux (Ollama, ChromaDB...) est compromis, il pourrait piloter les operations
// privilegiees de l'updater (acces a docker.sock). Quand UPDATER_SHARED_TOKEN
// est defini, les routes qui modifient l'etat exigent ce jeton. Absent =
// comportement historique (compatibilite avec les installations existantes).
const updaterSharedToken = String(process.env.UPDATER_SHARED_TOKEN || "").trim();

function timingSafeEqualStrings(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireSharedToken(req, res, next) {
  if (!updaterSharedToken) {
    return next();
  }

  const header = String(req.headers.authorization || "");
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

  if (provided && timingSafeEqualStrings(provided, updaterSharedToken)) {
    return next();
  }

  return res.status(401).json({ message: "Jeton de service de mise a jour invalide." });
}

const workspaceDir = process.env.UPDATE_WORKSPACE_DIR || "/workspace";
const updateConfigPath = process.env.UPDATE_CONFIG_PATH || path.join(workspaceDir, "update.config.json");
const versionFilePath = process.env.VERSION_FILE_PATH || path.join(workspaceDir, "version.json");
const port = Number(process.env.UPDATE_PORT || process.env.PORT || 3010);
const backupStoreDir = path.join(workspaceDir, ".update-backups");
const maxBackupVersions = Math.max(1, Number(process.env.UPDATE_BACKUP_RETENTION || 3));
const composeProjectName =
  String(process.env.UPDATE_PROJECT_NAME || "").trim() || path.basename(workspaceDir) || "assistant-ia";
const hostWorkspaceDirOverride = String(process.env.UPDATE_HOST_WORKSPACE_DIR || "").trim();
// Services tiers sans code applicatif propre : redemarres (pas reconstruits) apres
// chaque mise a jour/rollback pour repartir sur un etat propre, comme ./restart.sh.
const fullStackRestartServices = ["ollama", "chromadb", "redis"];
const remoteFetchTimeoutMs = Math.max(1000, Number(process.env.UPDATE_REMOTE_TIMEOUT_MS || 8000));
// Telechargement de l'archive : nombre d'essais, et delai sans aucun octet recu
// au-dela duquel le transfert est considere comme bloque (sans ce garde-fou, un
// flux qui ne progresse plus laisserait la mise a jour "occupee" indefiniment).
const downloadAttempts = Math.max(1, Number(process.env.UPDATE_DOWNLOAD_ATTEMPTS || 3));
const downloadStallTimeoutMs = Math.max(5000, Number(process.env.UPDATE_DOWNLOAD_STALL_TIMEOUT_MS || 60000));
// Duree maximale d'une commande docker compose (build compris) : au-dela, elle
// est interrompue plutot que de bloquer l'updater dans l'etat "busy".
const composeTimeoutMs = Math.max(60000, Number(process.env.UPDATE_COMPOSE_TIMEOUT_MS || 30 * 60 * 1000));
// Delai laisse au backend pour devenir "healthy" apres reconstruction. Le
// healthcheck compose (start_period 30 s, puis 10 essais toutes les 15 s) ne
// declare "unhealthy" qu'apres ~3 min : on attend un peu plus longtemps.
const backendHealthTimeoutMs = Math.max(30000, Number(process.env.UPDATE_BACKEND_HEALTH_TIMEOUT_MS || 5 * 60 * 1000));
// Etat de la derniere operation, persiste sur disque : l'updater se reconstruit
// lui-meme en fin de mise a jour, et l'interface doit pouvoir lire le resultat
// final (termine / erreur / interrompue) apres ce redemarrage.
const stateFilePath = path.join(workspaceDir, ".update-state.json");
const restoredStateMaxAgeMs = 60 * 60 * 1000;
// 5 min par defaut : plancher de fraicheur du cache. Le TTL reellement applique
// (voir effectiveReleaseTtlMs) est releve pour ne jamais depasser le plafond
// quotidien d'appels a l'API GitHub.
const remoteReleaseTtlMs = Math.max(10000, Number(process.env.UPDATE_RELEASE_CACHE_TTL_MS || 5 * 60 * 1000));
// Plafond DUR d'appels a l'API GitHub par periode de 24 h (UTC), toutes sources
// confondues : polling admin, page /release publique, verification planifiee.
// L'API non authentifiee est limitee a 60 req/h par IP et une IP partagee
// (plusieurs installations, NAT d'etablissement) l'epuise vite -> 403. 10/jour
// laisse une marge confortable tout en gardant les mises a jour detectables.
const githubMaxCallsPerDay = Math.max(1, Number(process.env.UPDATE_GITHUB_MAX_CALLS_PER_DAY || 10));
// Espacement minimal entre deux appels reels : 24 h / plafond. Sert de TTL
// effectif pour lisser les appels sur la journee au lieu de les concentrer.
const minReleaseRefreshGapMs = Math.ceil((24 * 60 * 60 * 1000) / githubMaxCallsPerDay);
const effectiveReleaseTtlMs = Math.max(remoteReleaseTtlMs, minReleaseRefreshGapMs);
// Cache persiste sur disque : survit aux redemarrages du conteneur updater (qui
// se reconstruit lui-meme apres chaque mise a jour) pour que le compteur
// quotidien ne reparte pas de zero a chaque redemarrage.
// Espacement des nouvelles tentatives quand aucune liste n'a encore pu etre
// recuperee (premiere installation, reseau coupe au demarrage...).
const noCacheRetryGapMs = Math.max(10000, Number(process.env.UPDATE_NO_CACHE_RETRY_MS || 30 * 1000));
// Temps maximal pendant lequel /status attend la source distante : au-dela, la
// reponse part avec le cache (ou "verification en cours") et la verification
// continue en arriere-plan. Reste sous le delai d'attente du backend (12 s).
const statusRemoteWaitMs = Math.max(1000, Number(process.env.UPDATE_STATUS_REMOTE_WAIT_MS || 6000));
const releaseCacheFilePath =
  String(process.env.UPDATE_RELEASE_CACHE_FILE || "").trim() ||
  path.join(workspaceDir, ".update-release-cache.json");

let hostWorkspaceDirPromise = null;
let remoteReleaseCache = null;
let remoteReleaseCachedAt = 0;
// Copie en memoire du cache persiste { releases, fetchedAt, lastAttemptAt,
// budgetDay, budgetCount }. Chargee paresseusement depuis releaseCacheFilePath.
let persistentReleaseCache = null;
let persistentReleaseCacheLoaded = false;

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
  // Debut (busy: true) et fin (busy: false) d'operation : on persiste l'etat.
  if (Object.prototype.hasOwnProperty.call(patch, "busy")) {
    persistState();
  }
}

function persistState() {
  const snapshot = JSON.stringify({ ...state, savedAt: new Date().toISOString() });
  fsp
    .writeFile(stateFilePath, snapshot, "utf8")
    .catch(() => {
      // Best effort : un echec d'ecriture ne doit pas casser la mise a jour.
    });
}

async function restorePersistedState() {
  const saved = await readJson(stateFilePath, null);
  if (!saved || typeof saved !== "object") {
    return;
  }

  if (saved.busy) {
    // Le conteneur a ete arrete en pleine operation (redemarrage de l'hote,
    // docker stop...). On le signale au lieu de repartir sur un "Pret." muet.
    Object.assign(state, {
      busy: false,
      status: "error",
      progress: 100,
      message:
        "La derniere operation de mise a jour a ete interrompue (redemarrage du service). " +
        "Relancez-la depuis l'administration ou lancez ./update.sh sur le serveur.",
      error: "interrupted",
      targetVersion: saved.targetVersion || null,
      logs: Array.isArray(saved.logs) ? saved.logs : [],
      startedAt: saved.startedAt || null,
      completedAt: new Date().toISOString()
    });
    persistState();
    return;
  }

  const completedAt = new Date(saved.completedAt || 0).getTime() || 0;
  if (Date.now() - completedAt > restoredStateMaxAgeMs) {
    return;
  }

  Object.assign(state, {
    status: saved.status || "idle",
    progress: Number(saved.progress) || 0,
    message: saved.message || "Prêt.",
    error: saved.error || null,
    targetVersion: saved.targetVersion || null,
    logs: Array.isArray(saved.logs) ? saved.logs : [],
    startedAt: saved.startedAt || null,
    completedAt: saved.completedAt || null
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// Identifiants possibles de ce conteneur : HOSTNAME (id court par defaut) puis
// le nom fixe declare dans docker-compose.yml (si le hostname a ete change).
function getSelfContainerCandidates() {
  return [String(process.env.HOSTNAME || "").trim(), "assistant-ia-updater"].filter(
    (value, index, array) => value && array.indexOf(value) === index
  );
}

function inspectSelf(format) {
  return (async () => {
    for (const candidate of getSelfContainerCandidates()) {
      const output = await new Promise((resolve) => {
        const child = spawn("docker", ["inspect", candidate, "--format", format], {
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        child.on("error", () => {
          clearTimeout(timer);
          resolve("");
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code === 0 ? stdout.trim() : "");
        });
      });
      if (output) {
        return output;
      }
    }
    return "";
  })();
}

function detectOwnMountSource(destination) {
  return inspectSelf(
    `{{range .Mounts}}{{if eq .Destination "${destination}"}}{{.Source}}{{end}}{{end}}`
  );
}

// Chemin du projet SUR L'HOTE (les volumes de docker-compose.yml sont resolus
// par le moteur Docker, donc cote hote). Ne jamais retomber sur "/workspace"
// tant qu'une meilleure source existe : compose monterait alors des dossiers
// vides a la place des donnees du backend. Le resultat n'est memorise que s'il
// est fiable, pour qu'une detection ratee (moteur momentanement injoignable)
// soit retentee au prochain appel.
async function getHostWorkspaceDir() {
  if (hostWorkspaceDirOverride) {
    return hostWorkspaceDirOverride;
  }
  if (!hostWorkspaceDirPromise) {
    hostWorkspaceDirPromise = (async () => {
      const detected = await detectOwnMountSource("/workspace");
      if (detected) {
        return detected;
      }
      hostWorkspaceDirPromise = null;
      const fromEnv = String(process.env.PROJECT_WORKSPACE_DIR || "").trim();
      return fromEnv && fromEnv !== "." ? fromEnv : workspaceDir;
    })();
  }

  return hostWorkspaceDirPromise;
}

async function getHostDockerSocketPath() {
  return (
    (await detectOwnMountSource("/var/run/docker.sock")) ||
    String(process.env.DOCKER_SOCKET_PATH || "").trim() ||
    "/var/run/docker.sock"
  );
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

const DEFAULT_UPDATE_CONFIG = {
  server: {
    baseUrl: "",
    versionFile: "version.json",
    packageFile: "assistant-ia-update.tar.gz",
    notesFile: "release-notes.txt",
    headers: {}
  },
  apply: {
    services: ["backend", "frontend", "updater"],
    preservePaths: [".env", "update.config.json", "backend/uploads", "backend/logs", "backend/data"]
  }
};

async function readUpdateConfig() {
  // Distingue "fichier absent" (defauts silencieux, OK) de "fichier present
  // mais JSON invalide" : dans ce dernier cas on le signale explicitement au
  // lieu de retomber en silence sur des defauts qui produiront plus loin un
  // message trompeur ("aucune URL de base configuree").
  let raw;
  try {
    raw = await fsp.readFile(updateConfigPath, "utf8");
  } catch {
    return DEFAULT_UPDATE_CONFIG;
  }
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, ""));
    return parsed && typeof parsed === "object" ? parsed : DEFAULT_UPDATE_CONFIG;
  } catch (error) {
    throw new Error(`update.config.json est illisible (JSON invalide) : ${error.message}`);
  }
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
  const match = String(fileName || "").match(/assistant-ia-v(\d+(?:\.\d+)*)\.tar\.gz$/i);
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

  return packageFile || `assistant-ia-v${version}.tar.gz`;
}

function normalizeGithubReleaseVersion(tagName) {
  return String(tagName || "").trim().replace(/^v/i, "");
}

function findGithubAsset(assets, expectedName) {
  return (Array.isArray(assets) ? assets : []).find((asset) => asset?.name === expectedName) || null;
}

// Le SHA-256 est publie dans le corps de la release, pas en asset.
// Format attendu : "sha256 (<archive>.tar.gz): <64 hex>" ; a defaut, le
// premier "sha256 ... <64 hex>" du corps.
function extractReleaseSha256(body, packageName) {
  const escapedPackage = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const targetedSha =
    body.match(new RegExp(`${escapedPackage}[^0-9a-f]{0,20}([0-9a-f]{64})`, "i")) ||
    body.match(/sha-?256[^0-9a-f]{0,40}([0-9a-f]{64})/i) ||
    body.match(/\b([0-9a-f]{64})\b/i);
  return targetedSha ? targetedSha[1].toLowerCase() : "";
}

function finalizeGithubReleases(releases) {
  const validReleases = dedupeReleasesByVersion(releases.filter(Boolean));
  if (validReleases.length === 0) {
    throw new Error("Aucune release GitHub complète et vérifiable n'est disponible.");
  }
  // Trie par version decroissante plutot que de se fier a l'ordre de creation
  // GitHub.
  validReleases.sort((left, right) => compareVersions(right.version, left.version));
  return validReleases;
}

function getGithubRepository(serverConfig) {
  const repository = String(serverConfig?.repository || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Le dépôt GitHub de mise à jour est invalide.");
  }
  return repository;
}

async function fetchGithubReleasesFromApi(serverConfig, headers = {}) {
  const repository = getGithubRepository(serverConfig);
  const apiBaseUrl = String(serverConfig?.apiBaseUrl || "https://api.github.com").replace(/\/+$/, "");
  // Jeton optionnel : l'API GitHub non authentifiée est limitee a 60 requetes/
  // heure par IP (largement atteignable a plusieurs installations derriere la
  // meme IP), contre 5000/heure une fois authentifie.
  const githubToken = String(process.env.UPDATE_GITHUB_TOKEN || "").trim();
  const response = await fetchWithTimeout(`${apiBaseUrl}/repos/${repository}/releases?per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
      ...headers
    }
  });
  if (!response.ok) {
    const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
    if (response.status === 403 && rateLimitRemaining === "0") {
      const resetHeader = Number(response.headers.get("x-ratelimit-reset") || 0);
      const resetAt = resetHeader ? new Date(resetHeader * 1000).toISOString() : "";
      throw new Error(
        `Limite de requêtes GitHub atteinte (403).${resetAt ? ` Réinitialisation vers ${resetAt}.` : ""} ` +
          "Configurez UPDATE_GITHUB_TOKEN (jeton GitHub) pour relever cette limite."
      );
    }
    throw new Error(`Impossible de récupérer les releases GitHub (${response.status}).`);
  }

  const payload = await response.json();
  const requireSha256 = serverConfig?.requireSha256 !== false;
  const releases = (Array.isArray(payload) ? payload : [])
    .filter((release) => !release?.draft && !release?.prerelease)
    .map((release) => {
      const version = normalizeGithubReleaseVersion(release.tag_name);
      if (!isVersionFolderName(version)) {
        return null;
      }

      // Assets = uniquement le code source. On resout l'archive .tar.gz
      // attendue par nom.
      const packageName = resolvePackageFileName(serverConfig, version);
      const packageAsset = findGithubAsset(release.assets, packageName);
      if (!packageAsset?.browser_download_url) {
        return null;
      }

      const body = String(release.body || "");
      const sha256 = extractReleaseSha256(body, packageName);
      if (requireSha256 && !/^[a-f0-9]{64}$/.test(sha256)) {
        // Empreinte obligatoire mais introuvable dans le corps : release ignoree.
        return null;
      }

      return {
        version,
        packageUrl: packageAsset.browser_download_url,
        notes: body.trim(),
        notesUrl: release.html_url || "",
        releaseUrl: release.html_url || String(serverConfig?.latestReleaseUrl || ""),
        sha256,
        publishedAt: release.published_at || ""
      };
    });

  return finalizeGithubReleases(releases);
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function htmlToText(html) {
  return decodeXmlEntities(
    String(html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|h[1-6]|pre|div)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Repli sans API : le flux Atom public des releases (github.com/<depot>/
// releases.atom) n'est pas soumis au quota de l'API (60 req/h par IP, vite
// epuise derriere le NAT d'un etablissement) et contient le corps de chaque
// release, donc l'empreinte SHA-256. L'URL de l'archive suit le schema stable
// /releases/download/<tag>/<archive>. Une archive absente fait echouer le
// telechargement AVANT toute modification des fichiers.
async function fetchGithubReleasesFromAtom(serverConfig, headers = {}) {
  const repository = getGithubRepository(serverConfig);
  const webBaseUrl = String(serverConfig?.webBaseUrl || "https://github.com").replace(/\/+$/, "");
  const response = await fetchWithTimeout(`${webBaseUrl}/${repository}/releases.atom`, {
    headers: { Accept: "application/atom+xml", ...headers }
  });
  if (!response.ok) {
    throw new Error(`Flux des releases GitHub indisponible (${response.status}).`);
  }

  const feed = await response.text();
  const requireSha256 = serverConfig?.requireSha256 !== false;
  const releases = [...feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => {
    const link = (entry.match(/<link[^>]*href="([^"]+)"/) || [])[1] || "";
    let tag = "";
    try {
      tag = decodeURIComponent((link.match(/\/releases\/tag\/([^/?#]+)/) || [])[1] || "");
    } catch {
      return null;
    }
    const version = normalizeGithubReleaseVersion(tag);
    if (!tag || !isVersionFolderName(version)) {
      return null;
    }

    const packageName = resolvePackageFileName(serverConfig, version);
    // Corps HTML echappe dans le XML : on le desechappe avant d'oter les balises.
    const notes = htmlToText(decodeXmlEntities((entry.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || ""));
    const sha256 = extractReleaseSha256(notes, packageName);
    if (requireSha256 && !/^[a-f0-9]{64}$/.test(sha256)) {
      return null;
    }

    const releaseUrl = decodeXmlEntities(link);
    return {
      version,
      packageUrl: `${webBaseUrl}/${repository}/releases/download/${encodeURIComponent(tag)}/${packageName}`,
      notes,
      notesUrl: releaseUrl,
      releaseUrl,
      sha256,
      publishedAt: (entry.match(/<updated>([^<]+)<\/updated>/) || [])[1] || ""
    };
  });

  return finalizeGithubReleases(releases);
}

async function fetchGithubReleases(serverConfig, headers = {}) {
  try {
    return await fetchGithubReleasesFromApi(serverConfig, headers);
  } catch (apiError) {
    try {
      const releases = await fetchGithubReleasesFromAtom(serverConfig, headers);
      pushLog(`API GitHub indisponible (${apiError.message}) : liste des versions lue depuis le flux public.`);
      return releases;
    } catch {
      throw apiError;
    }
  }
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
  const headers = config.server.headers || {};
  const releaseLayout = String(config.server.releaseLayout || "").trim().toLowerCase();
  if (releaseLayout === "github-releases" || config.server.type === "github-releases") {
    return { releases: await fetchGithubReleases(config.server, headers), config };
  }
  if (!config.server?.baseUrl) {
    throw new Error("Aucune URL de base n'est configurée dans update.config.json.");
  }
  const baseUrl = String(config.server.baseUrl || "").replace(/\/+$/, "");

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
  const packageUrl = joinUrl(baseUrl, config.server.packageFile || "assistant-ia-update.tar.gz");
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

// Jour calendaire UTC : identifiant simple et non ambigu pour le compteur
// quotidien (pas de dependance au fuseau de l'hote).
function currentBudgetDay() {
  return new Date().toISOString().slice(0, 10);
}

async function loadPersistentReleaseCache() {
  if (persistentReleaseCacheLoaded) {
    return persistentReleaseCache;
  }
  persistentReleaseCacheLoaded = true;
  try {
    const parsed = JSON.parse(await fsp.readFile(releaseCacheFilePath, "utf8"));
    if (parsed && typeof parsed === "object") {
      persistentReleaseCache = {
        releases: Array.isArray(parsed.releases) ? parsed.releases : null,
        fetchedAt: Number(parsed.fetchedAt) || 0,
        lastAttemptAt: Number(parsed.lastAttemptAt) || 0,
        lastError: String(parsed.lastError || ""),
        budgetDay: String(parsed.budgetDay || ""),
        budgetCount: Number(parsed.budgetCount) || 0
      };
    }
  } catch {
    persistentReleaseCache = null;
  }
  return persistentReleaseCache;
}

async function savePersistentReleaseCache(next) {
  persistentReleaseCache = next;
  persistentReleaseCacheLoaded = true;
  try {
    const tmpPath = `${releaseCacheFilePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(next), "utf8");
    await fsp.rename(tmpPath, releaseCacheFilePath);
  } catch (error) {
    // Cache best-effort : une ecriture qui echoue (FS en lecture seule, droits)
    // ne doit pas casser la verification de mise a jour. La copie en memoire
    // continue de servir jusqu'au prochain redemarrage.
    pushLog(`Cache des releases non persiste sur disque : ${error.message}`);
  }
}

// Point de passage UNIQUE vers la source distante des releases. Applique :
//  - un cache (memoire + disque) avec TTL = max(TTL configure, 24h / plafond) ;
//  - un plafond dur de githubMaxCallsPerDay appels reels par periode de 24 h ;
//  - un repli sur le cache perime (stale) quand le plafond est atteint ou que
//    la source est injoignable, pour ne jamais marteler l'API.
// config est toujours relu localement (lecture fichier, pas d'appel reseau).
let remoteReleasesInFlight = null;
async function getRemoteReleasesRateLimited() {
  // Deduplication des appels concurrents (la page admin sollicite /status et
  // /releases quasi simultanement) : un seul passage a la fois, les autres
  // attendent le meme resultat au lieu de declencher plusieurs appels API.
  if (remoteReleasesInFlight) {
    return remoteReleasesInFlight;
  }
  remoteReleasesInFlight = (async () => {
    try {
      return await resolveRemoteReleasesRateLimited();
    } finally {
      remoteReleasesInFlight = null;
    }
  })();
  return remoteReleasesInFlight;
}

async function resolveRemoteReleasesRateLimited() {
  const config = await readUpdateConfig();
  const now = Date.now();
  const cache = (await loadPersistentReleaseCache()) || {
    releases: null,
    fetchedAt: 0,
    lastAttemptAt: 0,
    budgetDay: "",
    budgetCount: 0
  };

  const today = currentBudgetDay();
  const budgetUsed = cache.budgetDay === today ? cache.budgetCount : 0;
  const hasCache = Array.isArray(cache.releases) && cache.releases.length > 0;
  const budget = { used: budgetUsed, max: githubMaxCallsPerDay, day: today };

  const cacheFresh = hasCache && now - cache.fetchedAt < effectiveReleaseTtlMs;
  if (cacheFresh) {
    return { releases: cache.releases, config, stale: false, budget };
  }

  // Une tentative reelle (succes OU echec) a eu lieu recemment : on ressert le
  // cache tel quel sans rappeler la source ni consommer de budget.
  const recentlyAttempted = now - cache.lastAttemptAt < effectiveReleaseTtlMs;
  if (hasCache && recentlyAttempted) {
    return { releases: cache.releases, config, stale: true, budget };
  }

  // Sans cache, un echec ne doit pas etre rejoue a chaque sondage de
  // l'interface (toutes les 3 s) : cela epuisait le plafond quotidien en
  // quelques secondes et rendait le service "indisponible" jusqu'au lendemain.
  // On espace donc les nouvelles tentatives (noCacheRetryGapMs).
  if (!hasCache && cache.lastAttemptAt && now - cache.lastAttemptAt < noCacheRetryGapMs) {
    throw new Error(
      cache.lastError ||
        "La source des mises a jour est momentanement injoignable. Nouvelle tentative dans quelques minutes."
    );
  }

  // Sans aucune donnee en cache, le plafond n'est pas bloquant : il protege
  // l'API d'un sondage trop frequent, deja borne par noCacheRetryGapMs.
  if (budgetUsed >= githubMaxCallsPerDay && hasCache) {
    return { releases: cache.releases, config, stale: true, budget };
  }

  // Budget disponible + cache perime : on interroge la source pour de vrai.
  try {
    const { releases } = await fetchRemoteReleases();
    await savePersistentReleaseCache({
      releases,
      fetchedAt: now,
      lastAttemptAt: now,
      lastError: "",
      budgetDay: today,
      budgetCount: budgetUsed + 1
    });
    return {
      releases,
      config,
      stale: false,
      budget: { ...budget, used: budgetUsed + 1 }
    };
  } catch (error) {
    // Echec reseau/API : on consomme quand meme une unite de budget et on note
    // lastAttemptAt pour ne pas rappeler une source en erreur avant le prochain
    // creneau. On ressert le cache perime s'il existe.
    await savePersistentReleaseCache({
      releases: cache.releases,
      fetchedAt: cache.fetchedAt,
      lastAttemptAt: now,
      lastError: String(error?.message || ""),
      budgetDay: today,
      budgetCount: budgetUsed + 1
    });
    if (hasCache) {
      return {
        releases: cache.releases,
        config,
        stale: true,
        budget: { ...budget, used: budgetUsed + 1 }
      };
    }
    throw error;
  }
}

async function fetchRemoteReleaseInfo() {
  const { releases, config, stale, budget } = await getRemoteReleasesRateLimited();
  const release = releases[0];

  if (!release) {
    throw new Error("Aucune release distante n'est disponible pour le moment.");
  }

  return {
    release,
    config,
    stale,
    budget
  };
}

async function fetchRemoteReleaseInfoForVersion(targetVersion) {
  const normalizedTargetVersion = String(targetVersion || "").trim();
  // Meme chemin cache/plafond que la verification : l'admin choisit une version
  // deja listee par /status ou /releases, donc presente dans le cache.
  const { releases, config } = await getRemoteReleasesRateLimited();

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

async function downloadFileOnce(url, targetPath, headers = {}) {
  const controller = new AbortController();
  let timer = null;
  const armTimer = (delayMs, reason) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(reason)), delayMs);
  };

  armTimer(Math.max(remoteFetchTimeoutMs, 30000), "Le serveur de mise a jour ne repond pas.");
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Telechargement impossible (${response.status}).`);
    }

    // Surveillance de blocage : le delai repart a chaque bloc recu.
    const stallMessage = `Telechargement bloque (aucune donnee recue depuis ${Math.round(downloadStallTimeoutMs / 1000)} s).`;
    armTimer(downloadStallTimeoutMs, stallMessage);
    const body = Readable.fromWeb(response.body);
    body.on("data", () => armTimer(downloadStallTimeoutMs, stallMessage));
    await pipeline(body, fs.createWriteStream(targetPath));
  } catch (error) {
    throw controller.signal.aborted && controller.signal.reason instanceof Error
      ? controller.signal.reason
      : error;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadFile(url, targetPath, headers = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= downloadAttempts; attempt += 1) {
    try {
      await downloadFileOnce(url, targetPath, headers);
      return;
    } catch (error) {
      lastError = error;
      await fsp.rm(targetPath, { force: true }).catch(() => {});
      if (attempt < downloadAttempts) {
        pushLog(`Téléchargement échoué (essai ${attempt}/${downloadAttempts}) : ${error.message}. Nouvel essai...`);
        await sleep(attempt * 5000);
      }
    }
  }
  throw lastError;
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
    if (error?.message === "fetch failed") {
      const cause = error.cause?.code || error.cause?.message || "erreur reseau";
      let host = "";
      try {
        host = new URL(url).host;
      } catch {
        // URL deja validee par fetch : sans importance.
      }
      throw new Error(`Serveur de mise a jour injoignable${host ? ` (${host})` : ""} : ${cause}.`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Socle de preservation NON NEGOCIABLE, applique a chaque niveau de syncTree
// quel que soit le contenu de update.config.json (apply.preservePaths). Sans
// ce garde-fou, un update.config.json avec "preservePaths": [] ou sans ce
// champ effacerait .env, la base et les fichiers utilisateurs lors d'une
// mise a jour lancee depuis l'interface d'administration.
const MANDATORY_PRESERVED_PATHS = [
  ".update-backups",
  // Cache + compteur quotidien d'appels a l'API GitHub : le preserver evite que
  // le compteur reparte de zero apres chaque mise a jour (une mise a jour qui
  // echoue et se relance ne doit pas rouvrir un quota d'appels).
  ".update-release-cache.json",
  ".git",
  ".env",
  "update.config.json",
  "backend/data",
  "backend/uploads",
  "backend/logs",
  // Etat persiste de la derniere operation (voir persistState).
  ".update-state.json",
  // Artefacts locaux absents des releases : les effacer serait une perte
  // (exports construits, cookie d'administration des scripts, dependances
  // d'une machine de developpement).
  "assistant-ia-admin-cookie.txt",
  "export",
  "release",
  "backend/node_modules",
  "frontend/node_modules",
  "updater/node_modules"
];

function isRuntimePreservedPath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (MANDATORY_PRESERVED_PATHS.includes(normalized)) {
    return true;
  }
  // Tous les fichiers d'environnement locaux (.env.publish, .env.local...) sont
  // des secrets propres a l'instance ; seuls les modeles *.example viennent
  // de la release et doivent etre mis a jour.
  return /^\.env(\..+)?$/.test(normalized) && !normalized.endsWith(".example");
}

function formatBackupId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

// L'updater tourne en root (il pilote Docker via le socket). Sans correction,
// tout fichier qu'il ecrit dans le projet (code synchronise, sauvegardes,
// restauration) appartient a root sur l'hote : l'utilisateur du serveur devrait
// alors passer par sudo pour ./update.sh, git pull ou une suppression. On rend
// donc le projet a son proprietaire (celui du dossier racine monte).
async function restoreWorkspaceOwnership(reason = "") {
  try {
    const stats = await fsp.stat(workspaceDir);
    if (stats.uid === 0 || typeof process.getuid !== "function" || process.getuid() !== 0) {
      return false;
    }

    await new Promise((resolve, reject) => {
      const child = spawn("chown", ["-R", `${stats.uid}:${stats.gid}`, workspaceDir], {
        stdio: ["ignore", "ignore", "pipe"]
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        // Certains fichiers (montages macOS, fichiers verrouilles) peuvent
        // refuser le chown : non bloquant, on journalise seulement.
        if (code !== 0 && stderr.trim()) {
          console.warn(`chown partiel du projet : ${stderr.trim().split("\n").slice(0, 3).join(" | ")}`);
        }
        resolve();
      });
    });
    if (reason) {
      pushLog(`Propriétaire des fichiers du projet rétabli (${stats.uid}:${stats.gid}) ${reason}.`);
    }
    return true;
  } catch (error) {
    console.warn(`Impossible de rétablir le propriétaire des fichiers : ${error.message}`);
    return false;
  }
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
    "--exclude=.git",
    // Exports locaux (archives volumineuses) et etat runtime : inutiles au
    // retour arriere, ils sont de toute facon preserves par syncTree.
    "--exclude=./export",
    "--exclude=./release",
    "--exclude=./.update-state.json",
    "--exclude=./.update-release-cache.json"
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

// Execute une commande et renvoie sa sortie standard. Les sorties sont
// recopiees dans le journal de l'operation (logOutput) et la commande est
// interrompue au-dela de timeoutMs, pour que l'updater ne reste jamais bloque
// dans l'etat "busy" sur une commande Docker qui ne rend pas la main.
function runProcess(command, args, { env = process.env, timeoutMs = 0, logOutput = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceDir,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 10000).unref();
          }, timeoutMs)
        : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (logOutput) {
        pushLog(chunk.toString().trim());
      }
    });
    child.stderr.on("data", (chunk) => {
      if (logOutput) {
        pushLog(chunk.toString().trim());
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const label = `${command} ${args.slice(0, 2).join(" ")}`.trim();
      if (timedOut) {
        reject(new Error(`${label} interrompu après ${Math.round(timeoutMs / 1000)} s sans se terminer.`));
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${label} a quitté avec le code ${code}.`));
    });
  });
}

// "docker compose" (plugin) de preference, "docker-compose" (binaire autonome,
// present dans l'image) en secours : une image dont la decouverte du plugin
// serait cassee (cas corrige en v1.0.2) peut ainsi toujours se reparer.
let composeCommandPromise = null;
function getComposeCommand() {
  if (!composeCommandPromise) {
    composeCommandPromise = (async () => {
      const candidates = [
        ["docker", "compose"],
        ["docker-compose"]
      ];
      for (const [command, ...prefix] of candidates) {
        try {
          await runProcess(command, [...prefix, "version"], { logOutput: false, timeoutMs: 15000 });
          return [command, ...prefix];
        } catch {
          // Candidat suivant.
        }
      }
      return candidates[0];
    })();
  }
  return composeCommandPromise;
}

async function runCompose(args, options = {}) {
  const hostWorkspaceDir = await getHostWorkspaceDir();
  const [command, ...prefix] = await getComposeCommand();
  return runProcess(
    command,
    [...prefix, "-p", composeProjectName, "-f", path.join(workspaceDir, "docker-compose.yml"), ...args],
    {
      env: {
        ...process.env,
        PROJECT_WORKSPACE_DIR: hostWorkspaceDir,
        BUILDKIT_PROGRESS: process.env.BUILDKIT_PROGRESS || "plain",
        COMPOSE_PROGRESS: process.env.COMPOSE_PROGRESS || "plain"
      },
      timeoutMs: composeTimeoutMs,
      ...options
    }
  );
}

// Services a (re)demarrer apres un changement de fichiers : ceux declares par
// le docker-compose.yml qui vient d'etre installe (une nouvelle version peut
// ajouter un service ou modifier celui d'Ollama/ChromaDB/Redis), a defaut ceux
// de update.config.json. Les services sous "profile" (frontend de dev) ne sont
// pas listes par "config --services" et restent donc a l'ecart.
async function resolveApplicationServices(config) {
  let declared = [];
  try {
    declared = (await runCompose(["config", "--services"], { logOutput: false, timeoutMs: 60000 }))
      .split("\n")
      .map((service) => service.trim())
      .filter((service) => /^[a-zA-Z0-9_-]+$/.test(service));
  } catch (error) {
    pushLog(`Liste des services docker-compose indisponible (${error.message}) : services de update.config.json utilisés.`);
  }

  const services = declared.length > 0 ? declared : sanitizeServiceNames(config?.apply?.services);
  return {
    immediate: services.filter((service) => service !== "updater"),
    includesUpdater: services.includes("updater")
  };
}

// Attend que le backend reconstruit soit reellement operationnel, d'apres le
// healthcheck Docker (curl interne au conteneur : insensible au proxy sortant
// eventuellement configure pour l'updater).
async function waitForBackendHealthy() {
  const deadline = Date.now() + backendHealthTimeoutMs;
  let lastState = "inconnu";

  while (Date.now() < deadline) {
    try {
      const containerId = (await runCompose(["ps", "-q", "backend"], { logOutput: false, timeoutMs: 30000 }))
        .trim()
        .split("\n")[0];
      if (containerId) {
        const inspect = (
          await runProcess(
            "docker",
            ["inspect", "--format", "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}", containerId],
            { logOutput: false, timeoutMs: 30000 }
          )
        ).trim();
        const [status, health] = inspect.split("|");
        lastState = health ? `${status}, ${health}` : status;
        if (status === "running" && (health === "healthy" || !health)) {
          return;
        }
        if (health === "unhealthy") {
          break;
        }
      } else {
        lastState = "conteneur absent";
      }
    } catch (error) {
      lastState = error.message;
    }
    await sleep(3000);
  }

  try {
    pushLog("Derniers logs du backend :");
    await runCompose(["logs", "--no-color", "--tail", "40", "backend"], { timeoutMs: 30000 });
  } catch {
    // Diagnostic best effort.
  }
  throw new Error(`Le backend ne démarre pas correctement (état : ${lastState}).`);
}

// Reconstruit et redemarre la pile applicative apres un changement de fichiers
// (mise a jour ou retour arriere), puis verifie que le backend repond.
// L'updater n'est pas traite ici : voir scheduleUpdaterSelfRebuild.
async function restartApplicationStack(config) {
  const { immediate, includesUpdater } = await resolveApplicationServices(config);

  // Services tiers redemarres AVANT la reconstruction : "up" attend ensuite
  // qu'ils soient "healthy" (depends_on) avant de lancer le nouveau backend.
  const thirdParty = fullStackRestartServices.filter((service) => immediate.includes(service));
  if (thirdParty.length > 0) {
    try {
      await runCompose(["restart", ...thirdParty]);
      pushLog(`${thirdParty.join(", ")} redémarrés.`);
    } catch (error) {
      pushLog(`Redémarrage des services tiers ignoré : ${error.message}`);
    }
  }

  // Reconstruction retentee : un echec ponctuel (registre Docker lent, coupure
  // reseau, cache de build) ne doit pas declencher un retour arriere complet.
  const composeAttempts = Math.max(1, Number(process.env.UPDATE_COMPOSE_ATTEMPTS || 3));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runCompose(["up", "-d", "--build", ...immediate]);
      break;
    } catch (error) {
      // Un depassement du delai maximal n'est pas rejoue (il durerait autant).
      if (attempt >= composeAttempts || /interrompu après/.test(error.message)) {
        throw error;
      }
      pushLog(`Reconstruction échouée (essai ${attempt}/${composeAttempts}) : ${error.message}. Nouvel essai...`);
      await sleep(attempt * 15000);
    }
  }
  setState({ progress: 88, message: "Vérification du démarrage des services..." });
  await waitForBackendHealthy();
  return { includesUpdater };
}

// L'updater ne peut pas se recreer lui-meme : "docker compose up" arrete
// l'ancien conteneur AVANT de demarrer le nouveau, ce qui tue la commande
// compose lancee depuis ce conteneur et laisse l'updater arrete (verifie : le
// nouveau conteneur reste bloque a l'etat "Created"). La reconstruction est
// donc confiee a un conteneur auxiliaire ephemere, hors du projet compose,
// lance depuis la meme image (docker CLI + compose). Compose ne recree
// l'updater que si son image ou sa configuration a change.
// Script du conteneur auxiliaire : reconstruit l'updater (essais multiples),
// puis GARANTIT qu'un conteneur updater tourne a la fin, quoi qu'il arrive :
// si la reconstruction echoue (reseau, proxy, registre), l'ancienne image est
// relancee ; si le nouveau conteneur reste bloque a l'etat "Created", il est
// demarre explicitement.
const UPDATER_REBUILD_SCRIPT = `
sleep 5
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
COMPOSE="$DC -p $UPDATE_PROJECT_NAME -f /workspace/docker-compose.yml"
built=0
for attempt in 1 2 3; do
  echo "[rebuild] essai $attempt : reconstruction de l'updater"
  if $COMPOSE up -d --build updater; then built=1; break; fi
  sleep $((attempt * 15))
done
if [ "$built" != 1 ]; then
  echo "[rebuild] reconstruction impossible : relance de l'image existante"
  $COMPOSE up -d --no-build updater || true
fi
for i in $(seq 1 60); do
  cid="$($COMPOSE ps -a -q updater 2>/dev/null | head -n 1)"
  [ -z "$cid" ] && cid="$UPDATER_CONTAINER_NAME"
  state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo absent)"
  if [ "$state" = "running" ]; then echo "[rebuild] updater actif"; exit 0; fi
  if [ "$state" = "created" ] || [ "$state" = "exited" ]; then docker start "$cid" || true; fi
  if [ "$state" = "absent" ] && [ $((i % 10)) -eq 0 ]; then $COMPOSE up -d --no-build updater || true; fi
  sleep 3
done
echo "[rebuild] l'updater n'a pas pu etre relance"
exit 1
`;

// L'updater ne peut pas se recreer lui-meme : "docker compose up" arrete
// l'ancien conteneur AVANT de demarrer le nouveau, ce qui tue la commande
// compose lancee depuis ce conteneur et laisse l'updater arrete (verifie : le
// nouveau conteneur reste bloque a l'etat "Created"). La reconstruction est
// donc confiee a un conteneur auxiliaire ephemere, hors du projet compose,
// lance depuis la meme image (docker CLI + compose). Compose ne recree
// l'updater que si son image ou sa configuration a change.
async function scheduleUpdaterSelfRebuild() {
  const helperName = `${composeProjectName}-updater-rebuild`;
  try {
    const hostWorkspaceDir = await getHostWorkspaceDir();
    if (!hostWorkspaceDir || hostWorkspaceDir === workspaceDir) {
      throw new Error("dossier du projet sur l'hôte introuvable");
    }

    const image = await inspectSelf("{{.Image}}");
    if (!image) {
      throw new Error("image du service de mise à jour introuvable");
    }
    const hostSocketPath = await getHostDockerSocketPath();
    await runProcess("docker", ["rm", "-f", helperName], { logOutput: false, timeoutMs: 30000 }).catch(() => {});

    // Variables transmises au conteneur auxiliaire : proxy, et celles que
    // docker-compose.yml interpole (sinon compose les relit depuis .env).
    const forwardedEnv = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "DOCKER_SOCKET_PATH"
    ]
      .filter((key) => process.env[key])
      .flatMap((key) => ["-e", `${key}=${process.env[key]}`]);

    // Pas de --rm : "docker logs <helper>" reste disponible pour le diagnostic ;
    // le conteneur termine est supprime au lancement suivant (rm -f ci-dessus).
    await runProcess(
      "docker",
      [
        "run",
        "-d",
        "--name",
        helperName,
        "--restart",
        "on-failure:3",
        "-v",
        `${hostSocketPath}:/var/run/docker.sock`,
        "-v",
        `${hostWorkspaceDir}:/workspace`,
        "-w",
        "/workspace",
        "-e",
        "DOCKER_HOST=unix:///var/run/docker.sock",
        "-e",
        `PROJECT_WORKSPACE_DIR=${hostWorkspaceDir}`,
        "-e",
        `UPDATE_PROJECT_NAME=${composeProjectName}`,
        "-e",
        "UPDATER_CONTAINER_NAME=assistant-ia-updater",
        "-e",
        "BUILDKIT_PROGRESS=plain",
        "-e",
        "COMPOSE_PROGRESS=plain",
        ...forwardedEnv,
        "--entrypoint",
        "sh",
        image,
        "-c",
        UPDATER_REBUILD_SCRIPT
      ],
      { logOutput: false, timeoutMs: 60000 }
    );
    pushLog(`Reconstruction du service de mise à jour lancée en arrière-plan (docker logs ${helperName}).`);
    return true;
  } catch (error) {
    pushLog(
      `Reconstruction du service de mise à jour non lancée (${error.message}) : ` +
        "l'application est à jour, le service de mise à jour sera reconstruit au prochain ./update.sh."
    );
    return false;
  }
}

async function restoreBackupArchive(archivePath, preservePaths = []) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "assistant-ia-rollback-"));
  try {
    const extractRoot = path.join(tempRoot, "extract");
    await extractArchive(archivePath, extractRoot);
    await syncTree(extractRoot, workspaceDir, preservePaths || []);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// Le cache (memoire + disque) et le plafond quotidien sont desormais portes par
// getRemoteReleasesRateLimited : cette fonction ne fait plus que deleguer. Le
// polling rapproche du front (statut toutes les 2,5 s pendant l'overlay, focus
// d'onglet, page /release publique) est ainsi absorbe sans appel reseau.
async function fetchCachedRemoteReleaseInfo() {
  return fetchRemoteReleaseInfo();
}

// Variante bornee dans le temps pour /status : une source distante lente
// (proxy, GitHub qui rame) ne doit jamais faire depasser au statut le delai
// d'attente du backend, qui conclurait alors a tort que le service de mise a
// jour est indisponible. La verification continue en arriere-plan et son
// resultat (mis en cache) sert aux appels suivants.
async function fetchRemoteReleaseInfoForStatus() {
  const pending = Symbol("pending");
  const remote = fetchCachedRemoteReleaseInfo();
  remote.catch(() => undefined);
  let timer = null;
  const result = await Promise.race([
    remote,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(pending), statusRemoteWaitMs);
    })
  ]).finally(() => clearTimeout(timer));

  if (result !== pending) {
    return result;
  }

  const cache = await loadPersistentReleaseCache();
  if (Array.isArray(cache?.releases) && cache.releases.length > 0) {
    return {
      release: cache.releases[0],
      config: await readUpdateConfig(),
      stale: true,
      budget: { used: cache.budgetCount, max: githubMaxCallsPerDay, day: cache.budgetDay }
    };
  }
  throw new Error("Vérification des mises à jour en cours, réessayez dans quelques secondes.");
}

// Appelee au lancement d'une mise a jour / d'un rollback. Ne force PAS de
// nouvel appel a l'API distante (ce serait exploitable par le polling 2,5 s de
// l'overlay) : on invalide seulement la fraicheur pour que le prochain creneau
// autorise recalcule la disponibilite. Le compteur quotidien est preserve.
function invalidateRemoteReleaseCache() {
  remoteReleaseCache = null;
  remoteReleaseCachedAt = 0;
  if (persistentReleaseCache) {
    persistentReleaseCache = { ...persistentReleaseCache, fetchedAt: 0 };
  }
}

async function buildStatus() {
  const currentVersion = await readVersion();
  setState({ currentVersion });
  await pruneOldBackups();
  const backups = await listBackups();
  const { visibleBackups } = splitBackupsForRetention(backups);

  // readUpdateConfig peut desormais lever (JSON invalide) : on l'inclut dans le
  // meme try que la resolution distante pour degrader proprement en payload
  // "warning" plutot qu'en 500.
  let latestReleaseUrl = "";
  try {
    const updateConfig = await readUpdateConfig();
    latestReleaseUrl = String(updateConfig?.server?.latestReleaseUrl || "").trim();
    const { release, stale, budget } = await fetchRemoteReleaseInfoForStatus();
    const latestVersion = release.version || currentVersion;
    const updateAvailable = compareVersions(latestVersion, currentVersion) === 1;
    const releaseCheck = {
      stale: Boolean(stale),
      budgetUsed: budget?.used ?? null,
      budgetMax: budget?.max ?? githubMaxCallsPerDay
    };

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
      releaseCheck,
      latestReleaseUrl,
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
      latestReleaseUrl,
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

async function extractArchive(archivePath, extractRoot) {
  await ensureDir(extractRoot);
  await runProcess("tar", ["-xzf", archivePath, "-C", extractRoot], { timeoutMs: 10 * 60 * 1000 });
}

// Remet en place les fichiers d'une sauvegarde puis reconstruit les services.
// Sert au retour arriere manuel ET au retour automatique apres un echec.
async function restoreBackupAndRestart(backup, config) {
  // Chemin recalcule depuis l'id : les metadonnees renvoyees par
  // createWorkspaceBackup ne portent pas archivePath (seul listBackups l'ajoute).
  const archivePath = path.join(backupStoreDir, backup.id, "workspace.tar.gz");
  await restoreBackupArchive(archivePath, config?.apply?.preservePaths || []);
  await restoreWorkspaceOwnership("après restauration");
  return restartApplicationStack(config);
}

async function applyUpdateInBackground(targetVersion = "") {
  invalidateRemoteReleaseCache();
  setState({
    busy: true,
    status: "checking",
    progress: 5,
    message: "Vérification de la mise à jour...",
    error: null,
    filesSynced: false,
    recoverableBackupId: "",
    startedAt: new Date().toISOString(),
    completedAt: null,
    logs: []
  });
  pushLog("Début de la procédure de mise à jour.");

  // Des que la synchronisation des fichiers a commence, un echec laisserait un
  // projet incoherent (nouveaux fichiers, anciens conteneurs ou backend qui ne
  // demarre pas) : on revient alors automatiquement a la sauvegarde prise
  // juste avant.
  let config = null;
  let backup = null;
  let workspaceTouched = false;
  let currentVersion = "";
  let targetReleaseVersion = "";
  let tempRoot = "";
  let rebuildUpdater = false;

  try {
    const requestedVersion = String(targetVersion || "").trim();
    const remote = await fetchRemoteReleaseInfoForVersion(requestedVersion);
    const { release, releases } = remote;
    config = remote.config;
    currentVersion = await readVersion();
    targetReleaseVersion = release.version || currentVersion;
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

    const requireSha256 = config.server?.requireSha256 !== false;
    if (!release.sha256 && requireSha256) {
      throw new Error(
        "La release distante ne fournit pas de somme SHA256. Installation refusée : publiez la version avec publish-release.sh pour générer le manifest."
      );
    }

    setState({
      status: "downloading",
      progress: 18,
      message: "Téléchargement du package de mise à jour...",
      targetVersion: targetReleaseVersion,
      latestVersion
    });

    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "assistant-ia-update-"));
    const archivePath = path.join(tempRoot, "release.tar.gz");
    await downloadFile(packageUrl, archivePath, config.server.headers || {});
    pushLog(`Package téléchargé depuis ${packageUrl}.`);

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
    await extractArchive(archivePath, extractRoot);
    const packageRoot = await detectPackageRoot(extractRoot);
    await validatePackageRoot(packageRoot);
    const packageVersionJson = await fsp
      .readFile(path.join(packageRoot, "version.json"), "utf8")
      .catch(() => `${JSON.stringify({ version: targetReleaseVersion }, null, 2)}\n`);

    const preservePaths = config.apply?.preservePaths || [];
    backup = await createWorkspaceBackup(currentVersion, preservePaths);
    pushLog(`Sauvegarde de rollback créée (${backup.version}) dans ${backup.id}.`);

    setState({
      status: "copying",
      progress: 58,
      message: "Application des nouveaux fichiers..."
    });

    // version.json n'est PAS synchronise ici : il n'est ecrit qu'une fois la
    // nouvelle version demarree. Tant qu'il porte l'ancien numero, la mise a
    // jour reste detectee comme disponible et peut etre relancee.
    workspaceTouched = true;
    await syncTree(packageRoot, workspaceDir, [...preservePaths, "version.json"]);
    pushLog("Nouveaux fichiers du projet synchronisés.");
    await restoreWorkspaceOwnership("après synchronisation (aucun sudo nécessaire ensuite)");

    setState({
      status: "restarting",
      progress: 72,
      message: "Reconstruction et redémarrage des services..."
    });

    const { includesUpdater } = await restartApplicationStack(config);
    pushLog("Nouvelle version démarrée : le backend répond correctement.");

    // Ecriture sur place (meme inode) : version.json est monte fichier par
    // fichier dans le backend, un remplacement par renommage n'y serait pas vu.
    await fsp.writeFile(versionFilePath, packageVersionJson, "utf8");
    rebuildUpdater = includesUpdater;
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
  } catch (error) {
    let message = error.message;
    let restored = false;

    if (workspaceTouched && backup) {
      pushLog(`Erreur : ${error.message}`);
      pushLog(`Retour automatique à la version ${currentVersion}...`);
      setState({
        status: "rollback",
        progress: 90,
        message: `Échec de la mise à jour : retour automatique à la version ${currentVersion}...`
      });
      try {
        await restoreBackupAndRestart(backup, config);
        restored = true;
        message =
          `La mise à jour vers ${targetReleaseVersion} a échoué (${error.message}). ` +
          `Retour automatique à la version ${currentVersion} effectué : l'application fonctionne normalement.`;
      } catch (restoreError) {
        message =
          `La mise à jour vers ${targetReleaseVersion} a échoué (${error.message}) et le retour automatique aussi ` +
          `(${restoreError.message}). Restaurez la sauvegarde ${backup.id} depuis l'onglet Mises à jour, ` +
          "ou lancez ./doctor.sh sur le serveur.";
      }
    }

    setState({
      busy: false,
      status: "error",
      progress: 100,
      message,
      error: message,
      filesSynced: workspaceTouched && !restored,
      recoverableBackupId: workspaceTouched && !restored && backup ? backup.id : "",
      completedAt: new Date().toISOString()
    });
    pushLog(`Erreur de mise à jour : ${message}`);
  } finally {
    if (tempRoot) {
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  // En dernier, une fois l'etat final enregistre : ce conteneur va etre remplace.
  if (rebuildUpdater) {
    await scheduleUpdaterSelfRebuild();
    persistState();
  }
}

async function rollbackToBackupInBackground(backupId) {
  setState({
    busy: true,
    status: "rollback",
    progress: 5,
    message: "Préparation du retour arrière...",
    error: null,
    filesSynced: false,
    recoverableBackupId: "",
    startedAt: new Date().toISOString(),
    completedAt: null,
    logs: []
  });
  pushLog(`Début du rollback vers ${backupId}.`);

  let rebuildUpdater = false;
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

    const { includesUpdater } = await restoreBackupAndRestart(backup, config);
    rebuildUpdater = includesUpdater;

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

  if (rebuildUpdater) {
    await scheduleUpdaterSelfRebuild();
    persistState();
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
    // (assistant-ia.zip), pour l'installation web en une commande - separe du
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
  ".update-release-cache.json",
  ".update-state.json",
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
  "assistant-ia-admin-cookie.txt"
];

async function buildExportArchive(version) {
  const exportRoot = path.join(workspaceDir, "export", version);
  await ensureDir(exportRoot);
  const archiveName = `assistant-ia-v${version}.tar.gz`;
  const archivePath = path.join(exportRoot, archiveName);

  const excludeArgs = exportExcludes.map((entry) => `--exclude=${entry}`);

  // L'archive doit contenir un dossier "assistant-ia/" au sommet (pas de fichiers
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
// "derniere version" (assistant-ia.zip) attendu par l'installation web en une
// commande (irm ... | iex, voir web-install.ps1), qui n'a pas d'equivalent
// tar.gz cote client Windows.
async function buildExportZip(exportRoot, archivePath, version) {
  const zipName = `assistant-ia-v${version}.zip`;
  const zipPath = path.join(exportRoot, zipName);
  const stagingDir = await fsp.mkdtemp(path.join(os.tmpdir(), "assistant-ia-zip-"));

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

    // Copie "derniere version" sous un nom fixe (assistant-ia.zip), toujours au meme
    // endroit et toujours ecrasee : c'est ce que telecharge l'installation web en
    // une commande (irm ... | iex), qui n'a aucun moyen de connaitre le numero de
    // version a l'avance et ne doit jamais avoir a etre mise a jour manuellement.
    const latestZipDir = ftpConfig.latestZipDir || path.posix.dirname(`/${ftpConfig.remoteDir}`).replace(/^\/+/, "");
    if (latestZipDir && latestZipDir !== ".") {
      await uploadFileViaFtps(zipPath, `ftp://${ftpConfig.host}/${latestZipDir}/assistant-ia.zip`, ftpConfig);
      pushDeployLog(`assistant-ia.zip mis a jour dans ${latestZipDir}/ (toujours la derniere version).`);
    } else {
      pushDeployLog(
        "Attention : impossible de determiner le dossier de assistant-ia.zip (DEPLOY_FTP_REMOTE_DIR trop court) - non mis a jour."
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
  try {
    res.json(await buildStatus());
  } catch (error) {
    // Jamais de 500 ici : le backend l'interpreterait comme un service de mise
    // a jour indisponible. On renvoie l'etat courant, avec l'erreur en alerte.
    res.json({
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion || state.currentVersion,
      updateAvailable: Boolean(state.updateAvailable),
      release: null,
      backups: [],
      retention: maxBackupVersions,
      state,
      warning: error?.message || "Statut partiel."
    });
  }
});

app.get("/releases", async (_req, res) => {
  try {
    // Route publique (page /release, sans auth) : passe par le cache + plafond
    // pour qu'un afflux de visiteurs ne declenche pas d'appels a l'API GitHub.
    const { releases, stale } = await getRemoteReleasesRateLimited();
    res.json({
      releases,
      latestVersion: releases[0]?.version || null,
      stale: Boolean(stale)
    });
  } catch (error) {
    res.status(503).json({
      message: error.message || "Impossible de récupérer les notes de version.",
      releases: [],
      latestVersion: null
    });
  }
});

app.post("/apply", requireSharedToken, async (req, res) => {
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

app.post("/rollback", requireSharedToken, async (req, res) => {
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

app.post("/export/publish", requireSharedToken, async (req, res) => {
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

// Une erreur imprevue ne doit jamais laisser l'updater a moitie vivant (port
// ouvert mais plus rien ne repond) : une promesse rejetee non geree est
// journalisee sans arreter le service ; une exception non rattrapee arrete le
// processus apres avoir persiste l'etat, et Docker le relance (restart: always).
process.on("unhandledRejection", (reason) => {
  console.error("Promesse rejetee non geree :", reason);
});
process.on("uncaughtException", (error) => {
  console.error("Erreur fatale de l'updater :", error);
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify({ ...state, savedAt: new Date().toISOString() }), "utf8");
  } catch {
    // Best effort.
  }
  process.exit(1);
});

const server = app.listen(port, async () => {
  try {
    await restorePersistedState();
    setState({ currentVersion: await readVersion() });
  } catch (error) {
    console.error(`Restauration de l'etat impossible : ${error.message}`);
  }
  console.log(`Updater ready on port ${port}`);
  // Repare au demarrage les fichiers laisses a root par une version precedente.
  restoreWorkspaceOwnership().catch(() => undefined);
  // Prechauffe le cache des versions : le premier affichage de l'onglet Mises
  // a jour n'a alors plus a attendre la source distante.
  getRemoteReleasesRateLimited().catch(() => undefined);
});
server.on("error", (error) => {
  console.error(`Ecoute sur le port ${port} impossible : ${error.message}`);
  process.exit(1);
});
