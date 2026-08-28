import fs from "fs";
import path from "path";
import { getCurrentVersion } from "./appInfoService.js";
import { getSetting, getSettingDecrypted } from "../config/db.js";

const updaterBaseUrl = process.env.UPDATER_URL || "http://updater:3010";
// Jeton partage : authentifie le backend aupres de l'updater sur le reseau
// Docker interne (voir requireSharedToken cote updater). Optionnel pour rester
// compatible avec les installations existantes.
const updaterSharedToken = String(process.env.UPDATER_SHARED_TOKEN || "").trim();
const updaterTimeoutMs = Number(process.env.UPDATER_TIMEOUT_MS || 12000);
// L'updater redemarre son propre conteneur apres chaque mise a jour (voir
// triggerDetachedComposeUpdate cote updater) : il est normal qu'il soit brievement
// injoignable pendant quelques secondes. On retente avant de declarer le service
// indisponible pour ne pas remonter une erreur transitoire a l'utilisateur.
const updaterConnectRetries = Math.max(0, Number(process.env.UPDATER_CONNECT_RETRIES ?? 6));
const updaterConnectRetryDelayMs = Math.max(0, Number(process.env.UPDATER_CONNECT_RETRY_DELAY_MS ?? 2000));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createUpdaterUnavailableError() {
  const error = new Error("Le service de mise a jour est temporairement indisponible.");
  error.code = "UPDATER_UNAVAILABLE";
  return error;
}

function isUpdaterUnavailableError(error) {
  return error?.code === "UPDATER_UNAVAILABLE";
}

function isMissingEndpointResponse(response, payload) {
  if (response.status !== 404) {
    return false;
  }

  const message = String(payload?.message || "").trim();
  return /cannot get|not found|introuvable/i.test(message);
}

function getUpdaterPathCandidates(pathname) {
  const normalizedPath = String(pathname || "").trim() || "/";
  const candidates = [normalizedPath];

  if (!normalizedPath.startsWith("/api/")) {
    candidates.push(`/api${normalizedPath}`);
  }

  return [...new Set(candidates)];
}

async function attemptRequester(pathname, options) {
  let lastError = null;

  for (const candidatePath of getUpdaterPathCandidates(pathname)) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new Error("updater-timeout"));
    }, updaterTimeoutMs);

    try {
      const response = await fetch(`${updaterBaseUrl}${candidatePath}`, {
        headers: {
          "Content-Type": "application/json",
          ...(updaterSharedToken ? { Authorization: `Bearer ${updaterSharedToken}` } : {}),
          ...(options.headers || {})
        },
        ...options,
        signal: controller.signal
      });

      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await response.json()
        : { message: await response.text() };

      if (!response.ok) {
        if (isMissingEndpointResponse(response, payload)) {
          lastError = new Error(payload.message || "Endpoint updater introuvable.");
          continue;
        }

        const upstreamError = new Error(payload.message || "Le service de mise a jour est indisponible.");
        // Preserve le code d'erreur d'origine (400/409...) pour un affichage
        // utilisateur correct plutot qu'un 500 generique.
        upstreamError.statusCode = response.status;
        throw upstreamError;
      }

      return { payload };
    } catch (error) {
      const message = String(error?.message || "");

      if (
        error?.name === "AbortError" ||
        /updater-timeout|fetch|connect|network|econnrefused|enotfound|socket hang up/i.test(message)
      ) {
        lastError = createUpdaterUnavailableError();
        continue;
      }

      lastError = error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return { error: lastError || createUpdaterUnavailableError() };
}

async function requestUpdater(pathname, options = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= updaterConnectRetries; attempt += 1) {
    const { payload, error } = await attemptRequester(pathname, options);

    if (payload !== undefined) {
      return payload;
    }

    lastError = error;

    // Ne retenter que les erreurs de connectivite (updater injoignable) : une
    // erreur applicative (400/409/...) doit remonter immediatement.
    if (!isUpdaterUnavailableError(error) || attempt === updaterConnectRetries) {
      break;
    }

    await sleep(updaterConnectRetryDelayMs);
  }

  throw lastError || createUpdaterUnavailableError();
}

function getLocalReleaseNotesCandidates() {
  return [
    process.env.RELEASE_NOTES_FILE_PATH,
    path.resolve(process.cwd(), "release-notes.txt"),
    path.resolve(process.cwd(), "release-notes.example.txt")
  ].filter(Boolean);
}

function getLocalReleaseNotesPayload() {
  for (const filePath of getLocalReleaseNotesCandidates()) {
    try {
      const notes = fs.readFileSync(filePath, "utf8").trim();
      const stat = fs.statSync(filePath);

      return {
        notes,
        notesPath: filePath,
        publishedAt: stat.mtime.toISOString()
      };
    } catch {
      // Try the next candidate.
    }
  }

  return {
    notes: "",
    notesPath: "",
    publishedAt: ""
  };
}

function buildLocalReleasePayload() {
  const currentVersion = getCurrentVersion();
  const localNotes = getLocalReleaseNotesPayload();

  return {
    releases: [
      {
        version: currentVersion,
        packageUrl: "",
        notes: localNotes.notes,
        notesUrl: "",
        publishedAt: localNotes.publishedAt
      }
    ],
    latestVersion: currentVersion,
    source: localNotes.notes ? "local-fallback" : "current-version-only"
  };
}

export async function getUpdateStatus() {
  try {
    return await requestUpdater("/status");
  } catch (error) {
    const fallbackPayload = buildLocalReleasePayload();
    return {
      currentVersion: getCurrentVersion(),
      latestVersion: fallbackPayload.latestVersion,
      updateAvailable: false,
      release: fallbackPayload.releases[0] || null,
      state: {
        busy: false,
        status: "unavailable",
        progress: 0,
        message: "Le service de mise a jour est temporairement indisponible.",
        logs: []
      },
      warning: "Source distante indisponible. Affichage local de secours."
    };
  }
}

export function applyUpdate(targetVersion) {
  return requestUpdater("/apply", {
    method: "POST",
    body: JSON.stringify(
      targetVersion
        ? {
            targetVersion
          }
        : {}
    )
  });
}

export function getUpdateBackups() {
  return requestUpdater("/backups");
}

export function rollbackUpdate(backupId) {
  return requestUpdater("/rollback", {
    method: "POST",
    body: JSON.stringify({ backupId })
  });
}

export function getDeploymentStatus() {
  return requestUpdater("/export/status");
}

// Config FTP de deploiement stockee chiffree en base (voir /api/admin/deployment/ftp-config).
// Si rien n'est configure cote admin, le service updater retombe sur ses
// propres variables d'environnement (compatibilite ascendante).
export function getStoredFtpConfig() {
  const host = getSetting("deployFtpHost", "");
  const user = getSettingDecrypted("deployFtpUser", "");
  const password = getSettingDecrypted("deployFtpPassword", "");
  const remoteDir = getSetting("deployFtpRemoteDir", "");
  const publicBaseUrl = getSetting("deployPublicBaseUrl", "");

  if (!host && !user && !password && !remoteDir) {
    return null;
  }

  return { host, user, password, remoteDir, publicBaseUrl };
}

export function publishDeployment({ version, notes }) {
  const ftpConfig = getStoredFtpConfig();

  return requestUpdater("/export/publish", {
    method: "POST",
    body: JSON.stringify({ version, notes, ...(ftpConfig ? { ftpConfig } : {}) })
  });
}

export async function getPublicReleases() {
  try {
    return await requestUpdater("/releases");
  } catch (error) {
    try {
      const statusPayload = await requestUpdater("/status");
      if (statusPayload?.release) {
        return {
          releases: [statusPayload.release],
          latestVersion: statusPayload.latestVersion || statusPayload.release.version || null,
          source: "status-fallback"
        };
      }
    } catch {
      // Fall back to local notes below.
    }

    return buildLocalReleasePayload();
  }
}
