import Bull from "bull";
import {
  getDocumentById,
  getDocuments,
  getDocumentStats,
  getSetting,
  updateDocumentIndexing,
  updateLastFullIndexStats
} from "../config/db.js";
import { logIndexation, logger } from "../config/logger.js";
import {
  getHistoricalAverageTotalDurationMs,
  recordChatMetric
} from "./analyticsService.js";
import { broadcast, emitToClient } from "./realtimeService.js";
import { buildAttachmentPromptContext } from "./attachmentService.js";
import * as fileService from "./fileService.js";
import * as ollamaService from "./ollamaService.js";
import * as ragService from "./ragService.js";
import {
  markChatFinished,
  markChatStarted,
  waitForAssistantPriorityWindow
} from "./schedulerService.js";

const queue = new Bull("fablab-assistant-queue", process.env.REDIS_URL || "redis://127.0.0.1:6379", {
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 250
  },
  settings: {
    lockDuration: Number(process.env.QUEUE_LOCK_DURATION_MS || 15 * 60 * 1000),
    stalledInterval: Number(process.env.QUEUE_STALLED_INTERVAL_MS || 30000),
    maxStalledCount: Number(process.env.QUEUE_MAX_STALLED_COUNT || 2)
  }
});

const chatStreams = new Map();
const abortControllers = new Map();
const directChatAbortControllers = new Map();
const activeDocumentIndexJobs = new Map();
const documentIndexCancellationRequests = new Set();
const recentDurations = [];
const queueTimeoutMs = Number(process.env.QUEUE_TIMEOUT_MS || 300000);

let queueInitialized = false;
let maintenanceInterval = null;

const reindexState = {
  isRunning: false,
  isPending: false,
  isPaused: false,
  cancellationRequested: false,
  progressPercent: 0,
  processed: 0,
  total: 0,
  successful: 0,
  failed: 0,
  createdChunks: 0,
  currentDocumentChunkCount: 0,
  currentDocumentTotalChunks: 0,
  currentFile: null,
  trigger: null,
  startedAt: null,
  lastCompletedAt: null
};

let indexingResumeResolver = null;

function pushDuration(durationMs) {
  recentDurations.push(durationMs);
  while (recentDurations.length > 10) {
    recentDurations.shift();
  }
}

function getAverageDurationMs() {
  const historicalAverageMs = getHistoricalAverageTotalDurationMs(ollamaService.getActiveModel());

  if (recentDurations.length === 0) {
    return historicalAverageMs || 45000;
  }

  const recentAverageMs =
    recentDurations.reduce((total, value) => total + value, 0) / recentDurations.length;

  if (!historicalAverageMs) {
    return recentAverageMs;
  }

  const recentWeight = Math.min(1, recentDurations.length / 10);
  return recentAverageMs * recentWeight + historicalAverageMs * (1 - recentWeight);
}

function writeSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function getOrderedJobs() {
  const [activeJobs, waitingJobs] = await Promise.all([
    queue.getJobs(["active"]),
    queue.getJobs(["waiting"])
  ]);

  const sortJobs = (jobs) =>
    jobs.sort((left, right) => {
      const leftPriority = left.opts.priority || 2;
      const rightPriority = right.opts.priority || 2;

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return left.timestamp - right.timestamp;
    });

  return {
    activeJobs: sortJobs(activeJobs),
    allJobs: [...sortJobs(activeJobs), ...sortJobs(waitingJobs)]
  };
}

// Nombre de demandes actives + en attente : utilise pour affiner l'estimation de delai
// de reponse (l'attente en file grandit avec ce nombre, cf buildTimingModel).
export async function getCurrentQueueDepth() {
  const { allJobs } = await getOrderedJobs();
  return allJobs.length;
}

export async function getQueueStatus(clientId) {
  return {
    position: null,
    estimatedWaitSeconds: 0,
    totalInQueue: 0,
    isProcessing: clientId ? directChatAbortControllers.has(String(clientId)) : directChatAbortControllers.size > 0
  };
}

async function broadcastQueuePositions() {
  const { activeJobs, allJobs } = await getOrderedJobs();
  const clientIds = [...new Set(allJobs.map((job) => job.data.clientId).filter(Boolean))];

  await Promise.all(
    clientIds.map(async (clientId) => {
      const status = await getQueueStatus(clientId);
      emitToClient(clientId, "queue:update", status);
    })
  );

  broadcast("queue:global", {
    totalInQueue: allJobs.length,
    isProcessing: activeJobs.length > 0,
    averageResponseSeconds: Math.round(getAverageDurationMs() / 1000)
  });
}

function resetReindexState(trigger) {
  reindexState.isRunning = true;
  reindexState.isPending = false;
  reindexState.isPaused = false;
  reindexState.cancellationRequested = false;
  reindexState.progressPercent = 0;
  reindexState.processed = 0;
  reindexState.total = 0;
  reindexState.successful = 0;
  reindexState.failed = 0;
  reindexState.createdChunks = 0;
  reindexState.currentDocumentChunkCount = 0;
  reindexState.currentDocumentTotalChunks = 0;
  reindexState.currentFile = null;
  reindexState.trigger = trigger;
  reindexState.startedAt = new Date().toISOString();
}

function resetReindexIdleState() {
  reindexState.isRunning = false;
  reindexState.isPending = false;
  reindexState.isPaused = false;
  reindexState.cancellationRequested = false;
  reindexState.progressPercent = 0;
  reindexState.processed = 0;
  reindexState.total = 0;
  reindexState.successful = 0;
  reindexState.failed = 0;
  reindexState.createdChunks = 0;
  reindexState.currentDocumentChunkCount = 0;
  reindexState.currentDocumentTotalChunks = 0;
  reindexState.currentFile = null;
  reindexState.trigger = null;
  reindexState.startedAt = null;
}

function publishIndexingProgress() {
  broadcast("indexing:progress", getIndexingStatus());
}

function upsertActiveDocumentIndex(documentId, patch = {}) {
  const normalizedDocumentId = Number(documentId);
  const existing = activeDocumentIndexJobs.get(normalizedDocumentId) || {
    documentId: normalizedDocumentId
  };

  activeDocumentIndexJobs.set(normalizedDocumentId, {
    ...existing,
    ...patch,
    documentId: normalizedDocumentId
  });
}

async function waitForIndexingResume() {
  if (!reindexState.isPaused) {
    return;
  }

  await new Promise((resolve) => {
    indexingResumeResolver = resolve;
  });
}

async function processChatJob(job) {
  const stream = chatStreams.get(String(job.data.clientId));
  if (!stream) {
    throw new Error("Le flux SSE du client n'est plus disponible.");
  }

  const queueDelayMs = Date.now() - job.timestamp;
  if (queueDelayMs > queueTimeoutMs) {
    writeSseEvent(stream.res, "error", {
      message: "La requete a expire dans la file d'attente."
    });
    stream.res.end();
    chatStreams.delete(String(job.data.clientId));
    throw new Error("Queue timeout exceeded");
  }

  const startTime = Date.now();
  const modelName = ollamaService.getActiveModel();
  writeSseEvent(stream.res, "start", {
    message: "Generation de la reponse en cours..."
  });

  const controller = new AbortController();
  abortControllers.set(String(job.id), controller);
  markChatStarted();

  try {
    const { messages, promptPreview, sources, responseOverride, grounding, retrieval } = await ragService.buildRagPayload(
      job.data.question,
      job.data.folderName,
      job.data.history || []
    );

    if (responseOverride !== undefined && responseOverride !== null) {
      writeSseEvent(stream.res, "sources", {
        sources: sources || []
      });

      const processingDurationMs = Date.now() - startTime;

      recordChatMetric({
        question: job.data.question,
        folderName: job.data.folderName,
        modelName,
        prompt: promptPreview || "",
        responseText: responseOverride,
        queueDelayMs,
        processingDurationMs,
        sourceCount: (sources || []).length,
        ollamaPayload: null
      });

      writeSseEvent(stream.res, "done", {
        text: responseOverride,
        grounding,
        metrics: {
          promptTokens: 0,
          outputTokens: 0,
          totalDurationMs: processingDurationMs,
          queueDelayMs
        }
      });
      stream.res.end();

      pushDuration(processingDurationMs);
      return {
        text: responseOverride,
        sources: sources || [],
        grounding,
        metrics: {
          promptTokens: 0,
          outputTokens: 0,
          totalDurationMs: processingDurationMs,
          queueDelayMs
        },
        sourceCount: (sources || []).length,
        length: responseOverride.length
      };
    }

    const { text, payload } = await ollamaService.streamChatAnswer(
      {
        model: modelName,
        messages,
        signal: controller.signal
      },
      {
        onToken: (token) => {
          writeSseEvent(stream.res, "token", { token });
        },
        onThinkingToken: (token) => {
          writeSseEvent(stream.res, "thinking", { token });
        }
      }
    );

    const visibleSources = ragService.selectVisibleSourcesForResponse(
      job.data.question,
      text,
      retrieval
    );
    const finalText = ragService.ensureGeneralAiDisclosure(
      text,
      visibleSources,
      retrieval,
      job.data.question
    );

    writeSseEvent(stream.res, "sources", {
      sources: visibleSources
    });
    const processingDurationMs = Date.now() - startTime;
    const totalDurationMs =
      Number(payload?.total_duration || 0) > 0
        ? Math.round(Number(payload.total_duration) / 1_000_000)
        : processingDurationMs;

    recordChatMetric({
      question: job.data.question,
      folderName: job.data.folderName,
      modelName,
      prompt: promptPreview || "",
      responseText: finalText,
      queueDelayMs,
      processingDurationMs,
      sourceCount: visibleSources.length,
      ollamaPayload: payload
    });

    writeSseEvent(stream.res, "done", {
      text: finalText,
      grounding,
      metrics: {
        promptTokens: Number(payload?.prompt_eval_count || 0),
        outputTokens: Number(payload?.eval_count || 0),
        totalDurationMs,
        queueDelayMs
      }
    });
    stream.res.end();

    pushDuration(totalDurationMs);
    return {
      text: finalText,
      sources: visibleSources,
      grounding,
      metrics: {
        promptTokens: Number(payload?.prompt_eval_count || 0),
        outputTokens: Number(payload?.eval_count || 0),
        totalDurationMs,
        queueDelayMs
      },
      sourceCount: visibleSources.length,
      length: text.length
    };
  } catch (error) {
    const message =
      error.name === "AbortError"
        ? "La connexion du chat a ete interrompue."
        : error.message || "Erreur lors de la generation de la reponse.";

    if (!stream.res.writableEnded) {
      writeSseEvent(stream.res, "error", { message });
      stream.res.end();
    }

    throw error;
  } finally {
    markChatFinished();
    abortControllers.delete(String(job.id));
    chatStreams.delete(String(job.data.clientId));
  }
}

export async function processDirectChatRequest({
  clientId,
  question,
  folderName,
  history = [],
  attachmentIds = [],
  useReasoningModel = false,
  persistExchange = null
}) {
  const stream = chatStreams.get(String(clientId));
  if (!stream) {
    throw new Error("Le flux SSE du client n'est plus disponible.");
  }

  const startTime = Date.now();
  // Bascule sur le modele de raisonnement seulement s'il est reellement configure :
  // sinon on reste sur le modele par defaut plutot que d'echouer silencieusement.
  const reasoningModelName = useReasoningModel ? ollamaService.getActiveModelByRole("reasoning") : "";
  const modelName = reasoningModelName || ollamaService.getActiveModel();
  writeSseEvent(stream.res, "start", {
    message: "Generation de la reponse en cours..."
  });

  const controller = new AbortController();
  directChatAbortControllers.set(String(clientId), controller);
  markChatStarted();

  const persistAndBuildIds = (finalText, retrievalMetadata = null) => {
    if (typeof persistExchange !== "function") {
      return {};
    }

    try {
      const saved = persistExchange(finalText, retrievalMetadata);
      return {
        conversationId: saved?.conversation?.id || null,
        exchangeId: saved?.exchange?.id || null
      };
    } catch {
      // La reponse doit partir meme si l'archivage echoue.
      return {};
    }
  };

  try {
    const { messages, promptPreview, sources, responseOverride, grounding, retrieval } = await ragService.buildRagPayload(
      question,
      folderName,
      history
    );

    if (responseOverride !== undefined && responseOverride !== null) {
      writeSseEvent(stream.res, "sources", {
        sources: sources || []
      });

      const processingDurationMs = Date.now() - startTime;

      recordChatMetric({
        question,
        folderName,
        modelName,
        prompt: promptPreview || "",
        responseText: responseOverride,
        queueDelayMs: 0,
        processingDurationMs,
        sourceCount: (sources || []).length,
        ollamaPayload: null
      });

      const exchangeIds = persistAndBuildIds(
        responseOverride,
        ragService.buildRetrievalMetadataSummary(retrieval, grounding)
      );

      writeSseEvent(stream.res, "done", {
        text: responseOverride,
        grounding,
        ...exchangeIds,
        metrics: {
          promptTokens: 0,
          outputTokens: 0,
          totalDurationMs: processingDurationMs,
          queueDelayMs: 0
        }
      });
      stream.res.end();

      pushDuration(processingDurationMs);
      return {
        text: responseOverride,
        sources: sources || [],
        grounding,
        metrics: {
          promptTokens: 0,
          outputTokens: 0,
          totalDurationMs: processingDurationMs,
          queueDelayMs: 0
        },
        sourceCount: (sources || []).length,
        length: responseOverride.length
      };
    }

    // Les pieces jointes envoyees avec la question sont injectees comme contexte prioritaire.
    if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
      const attachmentContext = await buildAttachmentPromptContext(attachmentIds).catch(() => null);
      if (attachmentContext) {
        messages.splice(messages.length - 1, 0, {
          role: "system",
          content: attachmentContext
        });
      }
    }

    const { text, payload } = await ollamaService.streamChatAnswer(
      {
        model: modelName,
        messages,
        signal: controller.signal
      },
      {
        onToken: (token) => {
          writeSseEvent(stream.res, "token", { token });
        },
        onThinkingToken: (token) => {
          writeSseEvent(stream.res, "thinking", { token });
        }
      }
    );

    const visibleSources = ragService.selectVisibleSourcesForResponse(question, text, retrieval);
    const finalText = ragService.ensureGeneralAiDisclosure(text, visibleSources, retrieval, question);

    writeSseEvent(stream.res, "sources", {
      sources: visibleSources
    });
    const processingDurationMs = Date.now() - startTime;
    const totalDurationMs =
      Number(payload?.total_duration || 0) > 0
        ? Math.round(Number(payload.total_duration) / 1_000_000)
        : processingDurationMs;

    recordChatMetric({
      question,
      folderName,
      modelName,
      prompt: promptPreview || "",
      responseText: finalText,
      queueDelayMs: 0,
      processingDurationMs,
      sourceCount: visibleSources.length,
      ollamaPayload: payload
    });

    const exchangeIds = persistAndBuildIds(
      finalText,
      ragService.buildRetrievalMetadataSummary(retrieval, grounding)
    );

    writeSseEvent(stream.res, "done", {
      text: finalText,
      grounding,
      ...exchangeIds,
      metrics: {
        promptTokens: Number(payload?.prompt_eval_count || 0),
        outputTokens: Number(payload?.eval_count || 0),
        totalDurationMs,
        queueDelayMs: 0
      }
    });
    stream.res.end();

    pushDuration(totalDurationMs);
    return {
      text: finalText,
      sources: visibleSources,
      grounding,
      metrics: {
        promptTokens: Number(payload?.prompt_eval_count || 0),
        outputTokens: Number(payload?.eval_count || 0),
        totalDurationMs,
        queueDelayMs: 0
      },
      sourceCount: visibleSources.length,
      length: finalText.length
    };
  } catch (error) {
    const message =
      error.name === "AbortError"
        ? "La connexion du chat a ete interrompue."
        : error.message || "Erreur lors de la generation de la reponse.";

    if (!stream.res.writableEnded) {
      writeSseEvent(stream.res, "error", { message });
      stream.res.end();
    }

    throw error;
  } finally {
    markChatFinished();
    directChatAbortControllers.delete(String(clientId));
    chatStreams.delete(String(clientId));
  }
}

export async function generateChatResponse({
  question,
  folderName = "all",
  history = [],
  attachmentIds = [],
  useReasoningModel = false
}) {
  const reasoningModelName = useReasoningModel ? ollamaService.getActiveModelByRole("reasoning") : "";
  const modelName = reasoningModelName || ollamaService.getActiveModel();
  const startTime = Date.now();
  const { messages, promptPreview, sources, responseOverride, grounding, retrieval } = await ragService.buildRagPayload(
    question,
    folderName,
    history
  );

  if (messages && Array.isArray(attachmentIds) && attachmentIds.length > 0) {
    const attachmentContext = await buildAttachmentPromptContext(attachmentIds).catch(() => null);
    if (attachmentContext) {
      messages.splice(messages.length - 1, 0, {
        role: "system",
        content: attachmentContext
      });
    }
  }

  if (responseOverride !== undefined && responseOverride !== null) {
    const totalDurationMs = Date.now() - startTime;

    recordChatMetric({
      question,
      folderName,
      modelName,
      prompt: promptPreview || "",
      responseText: responseOverride,
      queueDelayMs: 0,
      processingDurationMs: totalDurationMs,
      sourceCount: (sources || []).length,
      ollamaPayload: null
    });

    return {
      text: responseOverride,
      sources: sources || [],
      grounding,
      retrievalMetadata: ragService.buildRetrievalMetadataSummary(retrieval, grounding),
      metrics: {
        promptTokens: 0,
        outputTokens: 0,
        totalDurationMs,
        queueDelayMs: 0
      }
    };
  }

  const { text, payload } = await ollamaService.generateChatAnswer({
    model: modelName,
    messages
  });
  const totalDurationMs =
    Number(payload?.total_duration || 0) > 0
      ? Math.round(Number(payload.total_duration) / 1_000_000)
      : Date.now() - startTime;
  const visibleSources = ragService.selectVisibleSourcesForResponse(question, text, retrieval);
  const finalText = ragService.ensureGeneralAiDisclosure(text, visibleSources, retrieval, question);

  recordChatMetric({
    question,
    folderName,
    modelName,
    prompt: promptPreview || "",
    responseText: finalText,
    queueDelayMs: 0,
    processingDurationMs: totalDurationMs,
    sourceCount: visibleSources.length,
    ollamaPayload: payload
  });

  return {
    text: finalText,
    sources: visibleSources,
    grounding,
    retrievalMetadata: ragService.buildRetrievalMetadataSummary(retrieval, grounding),
    metrics: {
      promptTokens: Number(payload?.prompt_eval_count || 0),
      outputTokens: Number(payload?.eval_count || 0),
      totalDurationMs,
      queueDelayMs: 0
    }
  };
}

async function processDocumentIndexJob(job) {
  await waitForIndexingResume();
  const document = getDocumentById(job.data.documentId);
  if (!document) {
    return { skipped: true };
  }

  const documentDto = fileService.getDocumentRecord(document.id);
  const normalizedDocumentId = Number(document.id);
  upsertActiveDocumentIndex(normalizedDocumentId, {
    jobId: String(job.id),
    status: "running",
    fileName:
      documentDto?.originalName || documentDto?.filename || `Document ${normalizedDocumentId}`,
    relativePath: documentDto?.relativePath || null,
    startedAt: new Date().toISOString(),
    chunkCount: 0,
    totalChunks: 0
  });
  publishIndexingProgress();
  await waitForAssistantPriorityWindow({
    reason: `index-document:${documentDto.relativePath}`
  });

  logIndexation("Indexation d'un document", {
    relativePath: documentDto.relativePath,
    trigger: job.data.reason || "admin"
  });

  try {
    const result = await ragService.indexDocument(documentDto, {
      shouldAbort: () => documentIndexCancellationRequests.has(normalizedDocumentId),
      beforeBatch: async () => {
        await waitForIndexingResume();
        await waitForAssistantPriorityWindow({
          reason: `index-document-batch:${documentDto.relativePath}`,
          pollMs: 750
        });
      },
      onProgress: async ({ processedChunks, totalChunks }) => {
        upsertActiveDocumentIndex(normalizedDocumentId, {
          chunkCount: Number(processedChunks || 0),
          totalChunks: Number(totalChunks || 0)
        });
        publishIndexingProgress();
      }
    });
    updateDocumentIndexing({
      id: document.id,
      indexingStatus: "indexed",
      chunkCount: result.chunkCount,
      indexedMd5Hash: document.md5_hash,
      lastError: null,
      lastIndexedAt: new Date().toISOString()
    });

    logIndexation("Document indexe avec succes", {
      relativePath: documentDto.relativePath,
      chunkCount: result.chunkCount
    });

    publishIndexingProgress();
    return result;
  } catch (error) {
    if (error.name === "AbortError") {
      documentIndexCancellationRequests.delete(normalizedDocumentId);
      updateDocumentIndexing({
        id: document.id,
        indexingStatus: "pending",
        chunkCount: 0,
        indexedMd5Hash: null,
        lastError: null,
        lastIndexedAt: null
      });

      logIndexation("Indexation d'un document interrompue manuellement", {
        relativePath: documentDto.relativePath
      });
      publishIndexingProgress();
      return { cancelled: true };
    }

    updateDocumentIndexing({
      id: document.id,
      indexingStatus: "error",
      chunkCount: 0,
      indexedMd5Hash: document.indexed_md5_hash,
      lastError: error.message,
      lastIndexedAt: document.last_indexed_at
    });

    logIndexation(
      "Erreur pendant l'indexation d'un document",
      {
        relativePath: documentDto.relativePath,
        message: error.message
      },
      "error"
    );
    publishIndexingProgress();
    throw error;
  } finally {
    activeDocumentIndexJobs.delete(normalizedDocumentId);
    documentIndexCancellationRequests.delete(normalizedDocumentId);
    publishIndexingProgress();
  }
}

async function processDeleteDocumentIndexJob(job) {
  await ragService.deleteDocumentFromIndex(job.data.document);
  logIndexation("Document retire de l'index vectoriel", {
    relativePath: job.data.document.relativePath
  });
  publishIndexingProgress();
  return { removed: true };
}

async function processFullReindexJob(job) {
  await waitForIndexingResume();
  resetReindexState(job.data.trigger || "manuel");
  publishIndexingProgress();
  let createdChunks = 0;

  logIndexation("Debut d'une reindexation complete", {
    trigger: job.data.trigger || "manuel"
  });

  const syncResult = await fileService.syncFilesystemToDatabase();
  for (const removed of syncResult.removedRecords) {
    await ragService.deleteDocumentFromIndex(removed);
  }

  const documents = getDocuments().map((document) => fileService.getDocumentRecord(document.id));
  reindexState.total = documents.length;
  publishIndexingProgress();

  for (const document of documents) {
    await waitForIndexingResume();
    await waitForAssistantPriorityWindow({
      reason: `reindex-all:${document.relativePath}`
    });

    if (reindexState.cancellationRequested) {
      logIndexation("Reindexation complete arretee manuellement", {
        processed: reindexState.processed,
        total: reindexState.total,
        currentFile: reindexState.currentFile
      });
      break;
    }

    reindexState.currentFile = document.originalName;
    reindexState.currentDocumentChunkCount = 0;
    reindexState.currentDocumentTotalChunks = 0;
    publishIndexingProgress();

    try {
      const result = await ragService.indexDocument(document, {
        shouldAbort: () => reindexState.cancellationRequested,
        beforeBatch: async () => {
          await waitForIndexingResume();
          await waitForAssistantPriorityWindow({
            reason: `reindex-all-batch:${document.relativePath}`,
            pollMs: 750
          });
        },
        onProgress: async ({ processedChunks, totalChunks }) => {
          reindexState.currentDocumentChunkCount = Number(processedChunks || 0);
          reindexState.currentDocumentTotalChunks = Number(totalChunks || 0);
          reindexState.createdChunks = createdChunks + Number(processedChunks || 0);
          publishIndexingProgress();
        }
      });
      updateDocumentIndexing({
        id: document.id,
        indexingStatus: "indexed",
        chunkCount: result.chunkCount,
        indexedMd5Hash: document.md5Hash,
        lastError: null,
        lastIndexedAt: new Date().toISOString()
      });
      reindexState.successful += 1;
      createdChunks += Number(result.chunkCount || 0);
      reindexState.createdChunks = createdChunks;
      reindexState.currentDocumentChunkCount = Number(result.chunkCount || 0);
      reindexState.currentDocumentTotalChunks = Number(result.chunkCount || 0);
      logIndexation("Document reindexe", {
        relativePath: document.relativePath,
        chunkCount: result.chunkCount
      });
    } catch (error) {
      updateDocumentIndexing({
        id: document.id,
        indexingStatus: "error",
        chunkCount: 0,
        indexedMd5Hash: document.indexedMd5Hash,
        lastError: error.message,
        lastIndexedAt: document.lastIndexedAt
      });
      reindexState.failed += 1;
      reindexState.currentDocumentChunkCount = 0;
      reindexState.currentDocumentTotalChunks = 0;
      logIndexation(
        "Erreur de reindexation",
        {
          relativePath: document.relativePath,
          message: error.message
        },
        "error"
      );
    }

    reindexState.processed += 1;
    reindexState.progressPercent =
      reindexState.total === 0
        ? 100
        : Math.round((reindexState.processed / reindexState.total) * 100);
    publishIndexingProgress();
  }

  if (!reindexState.cancellationRequested) {
    updateLastFullIndexStats(documents.length);
  }
  reindexState.isRunning = false;
  reindexState.isPending = false;
  reindexState.progressPercent = reindexState.cancellationRequested
    ? reindexState.progressPercent
    : 100;
  reindexState.currentFile = null;
  reindexState.currentDocumentChunkCount = 0;
  reindexState.currentDocumentTotalChunks = 0;
  reindexState.lastCompletedAt = new Date().toISOString();

  if (!reindexState.cancellationRequested) {
    logIndexation("Reindexation complete terminee", {
      total: documents.length,
      successful: reindexState.successful,
      failed: reindexState.failed
    });
  }
  publishIndexingProgress();

  return {
    total: documents.length,
    successful: reindexState.successful,
    failed: reindexState.failed,
    cancelled: reindexState.cancellationRequested
  };
}

async function enforceWaitingTimeouts() {
  const waitingJobs = await queue.getJobs(["waiting"]);

  for (const job of waitingJobs) {
    // Le timeout d'attente ne concerne que le chat utilisateur.
    // Les jobs techniques d'indexation peuvent légitimement attendre plus longtemps
    // sans devoir être supprimés.
    if (job.data?.type !== "chat") {
      continue;
    }

    if (Date.now() - job.timestamp <= queueTimeoutMs) {
      continue;
    }

    const clientStream = chatStreams.get(String(job.data.clientId));
    if (clientStream && !clientStream.res.writableEnded) {
      writeSseEvent(clientStream.res, "error", {
        message: "La requete a ete abandonnee apres cinq minutes d'attente."
      });
      clientStream.res.end();
    }

    chatStreams.delete(String(job.data.clientId));
    await job.remove();
    logger.warn("Job retire pour depassement de delai d'attente.", {
      jobId: job.id,
      type: job.data.type
    });
  }

  await broadcastQueuePositions();
}

export function initializeQueueService() {
  if (queueInitialized) {
    return queue;
  }

  queue.process(1, async (job) => {
    switch (job.data.type) {
      case "chat":
        return processChatJob(job);
      case "index-document":
        return processDocumentIndexJob(job);
      case "delete-document-index":
        return processDeleteDocumentIndexJob(job);
      case "reindex-all":
        return processFullReindexJob(job);
      default:
        throw new Error(`Type de job inconnu : ${job.data.type}`);
    }
  });

  queue.on("active", async () => {
    await broadcastQueuePositions();
  });

  queue.on("completed", async () => {
    await broadcastQueuePositions();
  });

  queue.on("failed", async (job, error) => {
    logger.error("Echec d'un job Bull.", {
      jobId: job.id,
      type: job.data.type,
      message: error.message
    });
    await broadcastQueuePositions();
  });

  maintenanceInterval = setInterval(() => {
    enforceWaitingTimeouts().catch((error) => {
      logger.error("Erreur pendant le nettoyage de la file d'attente.", {
        message: error.message
      });
    });
  }, 15000);

  queueInitialized = true;
  return queue;
}

export async function enqueueChatJob({ clientId, question, folderName, history = [] }) {
  const job = await queue.add(
    {
      type: "chat",
      clientId,
      question,
      folderName,
      history
    },
    {
      priority: 2
    }
  );

  await broadcastQueuePositions();
  return job;
}

export function registerChatStream(clientId, res) {
  const existingStream = chatStreams.get(String(clientId));
  if (existingStream && !existingStream.res.writableEnded) {
    writeSseEvent(existingStream.res, "stopped", {
      message: "Une nouvelle demande a remplace cette conversation."
    });
    existingStream.res.end();
  }

  chatStreams.set(String(clientId), { res });
}

export async function cancelChatJob(jobId) {
  const controller = abortControllers.get(String(jobId));
  if (controller) {
    controller.abort();
  }

  const job = await queue.getJob(jobId);
  if (job) {
    const state = await job.getState();
    if (state === "waiting" || state === "delayed") {
      await job.remove();
    }
  }

  await broadcastQueuePositions();
}

export async function cancelChatJobsForClient(clientId) {
  const normalizedClientId = String(clientId);
  const directController = directChatAbortControllers.get(normalizedClientId);

  if (directController) {
    directController.abort();
    directChatAbortControllers.delete(normalizedClientId);
  }

  const jobs = await queue.getJobs(["active", "waiting", "delayed"]);

  for (const job of jobs) {
    if (job.data.type !== "chat" || String(job.data.clientId) !== normalizedClientId) {
      continue;
    }

    const controller = abortControllers.get(String(job.id));
    if (controller) {
      controller.abort();
    }

    const state = await job.getState();
    if (state === "waiting" || state === "delayed") {
      await job.remove();
    }
  }

  const stream = chatStreams.get(normalizedClientId);
  if (stream && !stream.res.writableEnded) {
    writeSseEvent(stream.res, "stopped", {
      message: "Generation interrompue."
    });
    stream.res.end();
  }

  chatStreams.delete(normalizedClientId);
  await broadcastQueuePositions();
}

export async function enqueueDocumentIndex(documentId, reason = "admin") {
  const normalizedDocumentId = Number(documentId);
  const documentRecord = fileService.getDocumentRecord(normalizedDocumentId);

  upsertActiveDocumentIndex(normalizedDocumentId, {
    jobId: null,
    status: "queued",
    fileName:
      documentRecord?.originalName || documentRecord?.filename || `Document ${normalizedDocumentId}`,
    relativePath: documentRecord?.relativePath || null,
    startedAt: null,
    queuedAt: new Date().toISOString(),
    reason,
    chunkCount: 0,
    totalChunks: 0
  });
  publishIndexingProgress();

  const job = await queue.add(
    {
      type: "index-document",
      documentId: normalizedDocumentId,
      reason
    },
    {
      priority: 1
    }
  );

  upsertActiveDocumentIndex(normalizedDocumentId, {
    jobId: String(job.id)
  });
  publishIndexingProgress();
  return job;
}

export async function cancelDocumentIndex(documentId) {
  const normalizedDocumentId = Number(documentId);
  const jobs = await queue.getJobs(["waiting", "active", "delayed"]);
  const targetJobs = jobs.filter(
    (job) => job.data?.type === "index-document" && Number(job.data?.documentId) === normalizedDocumentId
  );

  if (targetJobs.length === 0 && !activeDocumentIndexJobs.has(normalizedDocumentId)) {
    return {
      stopped: false,
      message: "Aucune indexation individuelle active ou en attente pour ce document."
    };
  }

  let removedWaitingJob = false;

  for (const job of targetJobs) {
    const state = await job.getState();
    if (state === "waiting" || state === "delayed") {
      await job.remove();
      removedWaitingJob = true;
    }
  }

  if (removedWaitingJob && !activeDocumentIndexJobs.has(normalizedDocumentId)) {
    updateDocumentIndexing({
      id: normalizedDocumentId,
      indexingStatus: "pending",
      chunkCount: 0,
      indexedMd5Hash: null,
      lastError: null,
      lastIndexedAt: null
    });
    publishIndexingProgress();
    return {
      stopped: true,
      message: "L'indexation individuelle en attente a été annulée."
    };
  }

  if (removedWaitingJob) {
    activeDocumentIndexJobs.delete(normalizedDocumentId);
    publishIndexingProgress();
  }

  documentIndexCancellationRequests.add(normalizedDocumentId);
  upsertActiveDocumentIndex(normalizedDocumentId, {
    status: "stopping",
    chunkCount: 0,
    totalChunks: 0
  });
  publishIndexingProgress();
  return {
    stopped: true,
    message: "L'arrêt de l'indexation individuelle a été demandé."
  };
}

export async function enqueueDocumentDeletion(document) {
  return queue.add(
    {
      type: "delete-document-index",
      document
    },
    {
      priority: 1
    }
  );
}

export async function hasPendingReindexJob() {
  const jobs = await queue.getJobs(["active", "waiting"]);
  return jobs.some((job) => job.data.type === "reindex-all");
}

export async function enqueueFullReindex({ trigger = "manuel" } = {}) {
  if (await hasPendingReindexJob()) {
    return null;
  }

  const job = await queue.add(
    {
      type: "reindex-all",
      trigger
    },
    {
      priority: 1
    }
  );

  reindexState.isPending = true;
  reindexState.isPaused = false;
  reindexState.cancellationRequested = false;
  reindexState.trigger = trigger;
  reindexState.currentFile = null;
  reindexState.startedAt = reindexState.startedAt || new Date().toISOString();
  publishIndexingProgress();
  return job;
}

export async function cancelFullReindex() {
  const jobs = await queue.getJobs(["waiting", "active"]);
  const fullReindexJob = jobs.find((job) => job.data?.type === "reindex-all");

  if (!fullReindexJob) {
    return {
      stopped: false,
      message: "Aucune reindexation complete active ou en attente."
    };
  }

  const state = await fullReindexJob.getState();

  if (state === "waiting" || state === "delayed") {
    await fullReindexJob.remove();
    resetReindexIdleState();
    reindexState.lastCompletedAt = new Date().toISOString();
    logIndexation("Reindexation complete annulee avant son demarrage", {
      trigger: fullReindexJob.data?.trigger || "manuel"
    });
    publishIndexingProgress();
    return {
      stopped: true,
      message: "La reindexation complete en attente a ete annulee."
    };
  }

  reindexState.cancellationRequested = true;
  if (reindexState.isPaused && indexingResumeResolver) {
    const resolver = indexingResumeResolver;
    indexingResumeResolver = null;
    resolver();
  }
  publishIndexingProgress();
  return {
    stopped: true,
    message: "L'arret de la reindexation complete a ete demande."
  };
}

export async function pauseAllIndexing() {
  reindexState.isPaused = true;
  publishIndexingProgress();

  return {
    paused: true,
    message:
      reindexState.isRunning || reindexState.isPending
        ? "La pause de l'indexation a ete demandee. Le traitement se mettra en pause des que possible."
        : "L'indexation est maintenant en pause."
  };
}

export async function resumeAllIndexing() {
  reindexState.isPaused = false;

  if (indexingResumeResolver) {
    const resolver = indexingResumeResolver;
    indexingResumeResolver = null;
    resolver();
  }

  publishIndexingProgress();

  return {
    resumed: true,
    message: "L'indexation a repris."
  };
}

export function getIndexingStatus() {
  const stats = getDocumentStats();
  const activeDocumentIndexes = [...activeDocumentIndexJobs.values()]
    .sort((left, right) =>
      String(left.startedAt || left.queuedAt || "").localeCompare(
        String(right.startedAt || right.queuedAt || "")
      )
    )
    .map((entry) => ({
      documentId: entry.documentId,
      jobId: entry.jobId || null,
      status: entry.status || "queued",
      fileName: entry.fileName || `Document ${entry.documentId}`,
      relativePath: entry.relativePath || null,
      reason: entry.reason || "admin",
      queuedAt: entry.queuedAt || null,
      startedAt: entry.startedAt || null,
      chunkCount: Number(entry.chunkCount || 0),
      totalChunks: Number(entry.totalChunks || 0)
    }));

  return {
    ...reindexState,
    activeDocumentIndexCount: activeDocumentIndexes.length,
    activeDocumentIndexes,
    autoIndexEnabled: getSetting("autoIndexEnabled", "true") === "true",
    lastFullIndexAt: getSetting("lastFullIndexAt", ""),
    lastIndexedDocumentsCount: Number(getSetting("lastIndexedDocumentsCount", "0")),
    documentStats: stats
  };
}

export async function getActiveDocumentIndexIds() {
  const jobs = await queue.getJobs(["waiting", "active", "delayed"]);
  const activeIds = new Set();

  jobs.forEach((job) => {
    if (job.data?.type === "index-document" && Number.isFinite(Number(job.data?.documentId))) {
      activeIds.add(Number(job.data.documentId));
    }
  });

  activeDocumentIndexJobs.forEach((_jobId, documentId) => {
    activeIds.add(Number(documentId));
  });

  return [...activeIds];
}

export async function stopAllIndexing() {
  const jobs = await queue.getJobs(["waiting", "active", "delayed"]);
  const indexJobs = jobs.filter(
    (job) => job.data?.type === "index-document" || job.data?.type === "reindex-all"
  );

  if (indexJobs.length === 0 && activeDocumentIndexJobs.size === 0 && !reindexState.isRunning) {
    return {
      stopped: false,
      message: "Aucune indexation active ou en attente."
    };
  }

  let removedWaitingDocuments = 0;
  let requestedRunningDocuments = 0;
  let removedFullReindex = false;
  let requestedFullReindexStop = false;

  for (const job of indexJobs) {
    const state = await job.getState();

    if (job.data?.type === "index-document") {
      const documentId = Number(job.data?.documentId);

      if (state === "waiting" || state === "delayed") {
        await job.remove();
        updateDocumentIndexing({
          id: documentId,
          indexingStatus: "pending",
          chunkCount: 0,
          indexedMd5Hash: null,
          lastError: null,
          lastIndexedAt: null
        });
        removedWaitingDocuments += 1;
        continue;
      }

      documentIndexCancellationRequests.add(documentId);
      requestedRunningDocuments += 1;
      continue;
    }

    if (job.data?.type === "reindex-all") {
      if (state === "waiting" || state === "delayed") {
        await job.remove();
        removedFullReindex = true;
        continue;
      }

      reindexState.cancellationRequested = true;
      requestedFullReindexStop = true;
    }
  }

  if (removedFullReindex) {
    resetReindexIdleState();
    reindexState.lastCompletedAt = new Date().toISOString();
  }

  if (reindexState.isPaused && indexingResumeResolver) {
    const resolver = indexingResumeResolver;
    indexingResumeResolver = null;
    resolver();
  }

  publishIndexingProgress();

  return {
    stopped: true,
    message:
      "L'arrêt de toutes les indexations a été demandé.",
    removedWaitingDocuments,
    requestedRunningDocuments,
    removedFullReindex,
    requestedFullReindexStop
  };
}

export async function shutdownQueue() {
  if (maintenanceInterval) {
    clearInterval(maintenanceInterval);
  }

  await queue.close();
}
