import { logger } from "../config/logger.js";

const inactivityThresholdMinutes = Number(process.env.INACTIVITY_THRESHOLD_MINUTES || 30);
const smartAutoIndexCheckMs = Number(process.env.SMART_AUTO_INDEX_CHECK_MS || 5 * 60 * 1000);
const schedulerTimeZone = process.env.ACCESS_PASSWORD_TIMEZONE || "Europe/Paris";

const attachmentCleanupIntervalMs = Number(
  process.env.ATTACHMENT_CLEANUP_INTERVAL_MS || 6 * 60 * 60 * 1000
);

let lastActivityAt = Date.now();
let activeChatCount = 0;
let activeInteractiveRequestCount = 0;
let schedulerInterval = null;
let attachmentCleanupInterval = null;
let schedulerCheckInFlight = false;
let lastPriorityWaitLogAt = 0;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function markActivity() {
  lastActivityAt = Date.now();
}

export function markChatStarted() {
  activeChatCount += 1;
  markActivity();
}

export function markChatFinished() {
  activeChatCount = Math.max(0, activeChatCount - 1);
  markActivity();
}

export function markInteractiveRequestStarted() {
  activeInteractiveRequestCount += 1;
  markActivity();
}

export function markInteractiveRequestFinished() {
  activeInteractiveRequestCount = Math.max(0, activeInteractiveRequestCount - 1);
  markActivity();
}

export function getAssistantActivitySnapshot() {
  return {
    activeChatCount,
    activeInteractiveRequestCount,
    lastActivityAt,
    idleMinutes: Number(((Date.now() - lastActivityAt) / 60000).toFixed(1))
  };
}

export function isAssistantBusy() {
  return activeChatCount > 0 || activeInteractiveRequestCount > 0;
}

export function isAssistantPriorityBusy() {
  return activeChatCount > 0;
}

export async function waitForAssistantPriorityWindow({
  reason = "indexation",
  pollMs = 2000
} = {}) {
  while (isAssistantPriorityBusy()) {
    const now = Date.now();
    if (now - lastPriorityWaitLogAt >= 10000) {
      logger.info("Attente d'un creux avant de continuer l'indexation.", {
        reason,
        activeChatCount
      });
      lastPriorityWaitLogAt = now;
    }
    await sleep(pollMs);
  }
}

function isIdleEnough() {
  return Date.now() - lastActivityAt >= inactivityThresholdMinutes * 60 * 1000;
}

async function maybeScheduleSmartAutoIndex() {
  if (schedulerCheckInFlight) {
    return;
  }

  schedulerCheckInFlight = true;

  try {
    const [{ getSetting, hasPendingDocuments, setSetting }, analyticsModule, queueModule] =
      await Promise.all([
        import("../config/db.js"),
        import("./analyticsService.js"),
        import("./queueService.js")
      ]);

    if (getSetting("autoIndexEnabled", process.env.AUTO_INDEX_ENABLED ?? "true") !== "true") {
      return;
    }

    if (!hasPendingDocuments()) {
      return;
    }

    const indexingStatus = queueModule.getIndexingStatus();
    if (indexingStatus.isRunning || indexingStatus.isPending) {
      return;
    }

    if (isAssistantBusy() || !isIdleEnough()) {
      return;
    }

    const usage = analyticsModule.getCurrentUsageWindowAnalysis({
      timeZone: schedulerTimeZone,
      days: Number(process.env.SMART_AUTO_INDEX_LOOKBACK_DAYS || 30),
      limit: Number(process.env.SMART_AUTO_INDEX_MAX_SAMPLES || 5000)
    });

    if (!usage.isQuietWindow) {
      logger.info("Auto-indexation differée : plage horaire encore trop utilisee.", {
        currentHour: usage.currentHour,
        usageScore: usage.currentBucket?.usageScore || 0,
        quietThreshold: usage.quietThreshold,
        timeZone: schedulerTimeZone
      });
      return;
    }

    const job = await queueModule.enqueueFullReindex({ trigger: "auto-intelligent" });
    if (!job) {
      return;
    }

    setSetting("lastSmartAutoIndexAt", new Date().toISOString());
    logger.info("Auto-indexation intelligente declenchee pendant un creux d'usage.", {
      currentHour: usage.currentHour,
      timeZone: schedulerTimeZone,
      usageScore: usage.currentBucket?.usageScore || 0
    });
  } catch (error) {
    logger.error("Erreur pendant la planification intelligente de l'indexation.", {
      message: error.message
    });
  } finally {
    schedulerCheckInFlight = false;
  }
}

async function runAttachmentCleanup() {
  try {
    const { cleanupExpiredAttachments } = await import("./attachmentService.js");
    await cleanupExpiredAttachments();
  } catch (error) {
    logger.error("Erreur pendant le nettoyage des pieces jointes expirees.", {
      message: error.message
    });
  }
}

export function initializeSchedulerService() {
  lastActivityAt = Date.now();
  activeChatCount = 0;
  activeInteractiveRequestCount = 0;

  if (schedulerInterval) {
    clearInterval(schedulerInterval);
  }

  schedulerInterval = setInterval(() => {
    maybeScheduleSmartAutoIndex().catch((error) => {
      logger.error("Erreur du scheduler d'indexation intelligente.", {
        message: error.message
      });
    });
  }, smartAutoIndexCheckMs);

  if (attachmentCleanupInterval) {
    clearInterval(attachmentCleanupInterval);
  }

  // Les pieces jointes non triees par l'admin sont supprimees apres 30 jours :
  // un passage au demarrage puis un controle periodique.
  runAttachmentCleanup();
  attachmentCleanupInterval = setInterval(runAttachmentCleanup, attachmentCleanupIntervalMs);
}

export function shutdownSchedulerService() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }

  if (attachmentCleanupInterval) {
    clearInterval(attachmentCleanupInterval);
    attachmentCleanupInterval = null;
  }

  activeChatCount = 0;
  activeInteractiveRequestCount = 0;
  lastActivityAt = Date.now();
}
