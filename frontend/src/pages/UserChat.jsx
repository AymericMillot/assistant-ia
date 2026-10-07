import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fetchJson, formatDuration } from "../lib/api";
import { reportError } from "../lib/errors";
import { consumeSseResponse } from "../lib/streaming";
import {
  clearConversations,
  deleteConversation,
  getConversation,
  isHistoryEnabled,
  loadConversations,
  saveConversation,
  setHistoryEnabled
} from "../lib/conversationStore";
import {
  isDictationSupported,
  isSpeechSynthesisSupported,
  speak,
  startDictation,
  stopSpeaking
} from "../lib/speech";
import ActionTooltip from "../components/ui/ActionTooltip";
import InfoPopover from "../components/ui/InfoPopover";
import FeedbackWidget from "../components/FeedbackWidget";
import { useBranding } from "../hooks/useBranding";

// Le serveur adapte ensuite la memoire a la fenetre de contexte du modele :
// derniers echanges mot pour mot, echanges plus anciens condenses.
const conversationMemoryLimit = 60;
const chatStreamRetryDelayMs = 1000;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createRuntimeId() {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function uniqueSources(sources = []) {
  const seen = new Set();

  return sources.filter((source) => {
    const key = source.documentId || `${source.relativePath}-${source.chunkIndex}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

const linkClassName =
  "text-sky-700 underline decoration-sky-300 underline-offset-4 transition hover:text-sky-800";

function renderLinkNode(key, href, label) {
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer" className={linkClassName}>
      {label}
    </a>
  );
}

function renderBoldAndBareLinks(text, keyPrefix) {
  const parts = String(text || "").split(/(\*\*[^*]+\*\*)/g);
  const urlPattern = /(https?:\/\/[^\s<]+[^\s<).,;!?])/g;
  const isUrlSegment = (value) => /^https?:\/\/[^\s<]+$/i.test(String(value || ""));

  const renderInlineLinks = (value, innerKeyPrefix) =>
    String(value || "")
      .split(urlPattern)
      .filter(Boolean)
      .map((segment, segmentIndex) =>
        isUrlSegment(segment)
          ? renderLinkNode(`${innerKeyPrefix}-link-${segmentIndex}`, segment, segment)
          : <span key={`${innerKeyPrefix}-text-${segmentIndex}`}>{segment}</span>
      );

  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={`${keyPrefix}-bold-${index}`} className="font-semibold text-slate-950">
          {renderInlineLinks(part.slice(2, -2), `${keyPrefix}-bold-${index}`)}
        </strong>
      );
    }

    return <span key={`${keyPrefix}-text-${index}`}>{renderInlineLinks(part, `${keyPrefix}-text-${index}`)}</span>;
  });
}

// Les reponses du backend peuvent contenir des liens au format Markdown
// `[texte](url)` (ex: suggestion de recherche Google). Ils sont extraits ici
// en <a> avec leur libelle plutot que d'etre affiches tels quels, car
// l'affichage du chat n'utilise pas de parseur Markdown complet.
function renderMessageContent(content) {
  const text = String(content || "");
  const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const segments = [];
  let lastIndex = 0;
  let match;

  while ((match = markdownLinkPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "link", label: match[1], href: match[2] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length || segments.length === 0) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }

  return segments.map((segment, segmentIndex) =>
    segment.type === "link"
      ? renderLinkNode(`mdlink-${segmentIndex}`, segment.href, segment.label)
      : (
        <span key={`segment-${segmentIndex}`}>
          {renderBoldAndBareLinks(segment.value, `segment-${segmentIndex}`)}
        </span>
      )
  );
}

// Le backend (ensureGeneralAiDisclosure / consigne du prompt systeme, voir ragService.js)
// fait precéder la reponse d'une phrase d'avertissement quand elle repose sur les
// connaissances generales du modele plutot que sur un document interne. Elle est
// detectee ici pour etre affichee separement (petit texte grise hors de la bulle)
// plutot que comme une phrase normale de la reponse.
const aiDisclaimerPattern = /^cette réponse est basée sur[^.]*précise[^.]*\.\s*/i;

function splitAiDisclaimer(content) {
  const text = String(content || "");
  const match = text.match(aiDisclaimerPattern);

  if (!match) {
    return { disclaimer: "", rest: text };
  }

  return { disclaimer: match[0].trim(), rest: text.slice(match[0].length) };
}

function resolveDownloadUrl(downloadUrl) {
  if (!downloadUrl) {
    return null;
  }

  try {
    return new URL(downloadUrl, window.location.origin).toString();
  } catch {
    return null;
  }
}

function isExternalUrl(value) {
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function isSourceOnlyRequest(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return false;
  }

  if (!normalized.includes("source")) {
    return false;
  }

  return /^(tu peux |peux[- ]tu |je peux |je veux |je voudrais |donne|donne moi|donnes moi|montre|affiche|ouvre|quelle est )?(me )?(donner |montrer |afficher |ouvrir |voir )?(la |les )?source(s)?( utilisees?| utilisées?)? ?(\?)?$/.test(
    normalized
  );
}

function isRetryableStreamStatus(status) {
  // 429 est volontairement exclu : c'est la limite de 5 minutes du raisonnement
  // approfondi (voir requireReasoningRateLimit cote backend), pas un incident
  // transitoire. La reessayer avec un delai de quelques secondes ne sert a rien.
  return [408, 425, 500, 502, 503, 504].includes(Number(status));
}

function isRetryableStreamError(error) {
  return (
    error?.name === "AbortError" ||
    error?.message === "Load failed" ||
    error?.message === "Failed to fetch" ||
    /fetch/i.test(String(error?.message || ""))
  );
}

async function openChatStreamWithRetry(payload, signal) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        body: JSON.stringify(payload),
        signal
      });

      if (response.ok) {
        return response;
      }

      let message = "Erreur lors de l'envoi de la question.";

      try {
        const body = await response.json();
        message = body.message || message;
      } catch {
        // On garde le message par défaut si le corps n'est pas lisible.
      }

      const error = new Error(message);
      error.statusCode = response.status;
      if (response.status === 429) {
        const retryAfterHeader = Number(response.headers.get("Retry-After"));
        error.retryAfterSeconds = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : 300;
      }
      lastError = error;

      if (attempt < 2 && isRetryableStreamStatus(response.status)) {
        await sleep(chatStreamRetryDelayMs * (attempt + 1));
        continue;
      }

      throw error;
    } catch (error) {
      lastError = error;

      if (signal?.aborted) {
        throw error;
      }

      if (attempt < 2 && isRetryableStreamError(error)) {
        await sleep(chatStreamRetryDelayMs * (attempt + 1));
        continue;
      }

      if (isRetryableStreamError(error)) {
        throw new Error(
          "Le serveur est temporairement tres sollicite. Reessayez dans quelques secondes."
        );
      }

      throw error;
    }
  }

  throw lastError || new Error("Erreur lors de l'envoi de la question.");
}

function getLatestPublicSources(messages) {
  const assistantMessages = [...messages]
    .reverse()
    .filter((message) => message.role === "assistant" && Array.isArray(message.sources));

  for (const message of assistantMessages) {
    const publicSources = uniqueSources(message.sources).filter(
      (source) => resolveDownloadUrl(source.downloadUrl)
    );

    if (publicSources.length > 0) {
      return publicSources;
    }
  }

  return [];
}

function buildConversationMemory(messages, currentQuestion = "") {
  const memory = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .filter((message) => message.id !== "welcome")
    .filter((message) => message.content?.trim())
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
      timestamp: message.timestamp || Date.now()
    }));

  if (currentQuestion.trim()) {
    memory.push({
      role: "user",
      content: currentQuestion.trim(),
      timestamp: Date.now()
    });
  }

  return memory
    .slice(-conversationMemoryLimit)
    .map((message) => ({
      role: message.role,
      content: message.content,
      timestamp: message.timestamp
    }));
}

// Jauge de contexte : tokens reellement mesures par le modele quand ils sont
// connus, sinon estimation du serveur, rapportes a la fenetre effective du
// modele qui repond (variable d'un modele a l'autre).
function buildContextGauge(summary) {
  const contextWindow = Number(summary?.contextWindow || summary?.modelContextWindow || 0);
  if (!summary || contextWindow <= 0) {
    return null;
  }

  const measured = Number(summary.measuredPromptTokens || 0);
  const used = measured > 0
    ? measured
    : Number(summary.estimatedPromptTokens || 0) || Math.round(Number(summary.characters || 0) / 3.2);
  const history = summary.history || null;
  const memoryParts = [];
  if (history?.verbatimMessages > 0) {
    memoryParts.push(`${history.verbatimMessages} message(s) récent(s)`);
  }
  if (history?.condensedExchanges > 0) {
    memoryParts.push(`${history.condensedExchanges} échange(s) résumé(s)`);
  }

  return {
    window: contextWindow,
    used,
    measured: measured > 0,
    percent: Math.min(100, Math.round((used / contextWindow) * 100)),
    memoryLabel: memoryParts.length > 0 ? `mémoire : ${memoryParts.join(" + ")}` : ""
  };
}

const defaultMessages = [];
const dismissedAnnouncementKey = "assistant-ia-dismissed-announcement";

function readDismissedAnnouncement() {
  try {
    return window.localStorage.getItem(dismissedAnnouncementKey) || "";
  } catch {
    return "";
  }
}

function formatHistoryDate(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat("fr-FR", sameDay ? { timeStyle: "short" } : { dateStyle: "medium" }).format(date);
}

function buildMarkdownTranscript(messages, projectName) {
  const lines = [
    `# Conversation — ${projectName}`,
    "",
    `_Exportée le ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" }).format(new Date())}_`,
    ""
  ];

  messages
    .filter((message) => String(message.content || "").trim())
    .forEach((message) => {
      lines.push(message.role === "user" ? "## Vous" : `## ${projectName}`);
      lines.push("");
      lines.push(String(message.content).trim());
      const sources = uniqueSources(message.sources || []).map((source) => source.fileName).filter(Boolean);
      if (message.role === "assistant" && sources.length > 0) {
        lines.push("");
        lines.push(`Sources : ${sources.join(", ")}`);
      }
      lines.push("");
    });

  return lines.join("\n");
}

function downloadTextFile(fileName, content, type = "text/markdown;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const announcementToneClasses = {
  info: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-100",
  warning: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100",
  critical: "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-100"
};

const defaultAttachmentExtensions = [".txt", ".text", ".md", ".markdown", ".csv", ".log", ".pdf", ".docx", ".xlsx"];
const defaultAttachmentMaxBytes = 5 * 1024 * 1024;
const attachmentLockedLabel =
  "Ajout de pièces jointes temporairement indisponible (maintenance technique et sécurité).";

function describeAttachmentLimits(limits) {
  const extensions = limits?.extensions?.length ? limits.extensions : defaultAttachmentExtensions;
  const maxMegabytes = Math.round((limits?.maxBytes || defaultAttachmentMaxBytes) / (1024 * 1024));
  const visibleExtensions = extensions.filter((extension) => ![".text", ".markdown"].includes(extension));
  return {
    accept: extensions.join(","),
    maxBytes: limits?.maxBytes || defaultAttachmentMaxBytes,
    maxCount: limits?.perQuestion || 3,
    label: `Joindre un fichier que l'assistant lira pour répondre (${visibleExtensions
      .map((extension) => extension.slice(1))
      .join(", ")} — ${maxMegabytes} Mo max)`,
    errorHint: `Vérifiez qu'il s'agit d'un fichier ${visibleExtensions
      .map((extension) => extension.slice(1))
      .join(", ")} de moins de ${maxMegabytes} Mo contenant du texte.`
  };
}

function renderAssistantStatus(message) {
  if (message.role !== "assistant" || message.content) {
    return null;
  }

  if (message.streamState === "generating") {
    return (
      <div className="assistant-thinking" aria-label="L'assistant réfléchit">
        <div className="assistant-thinking-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }

  return null;
}

function buildFollowUpSuggestions(message) {
  if (!message.sources || message.sources.length === 0) {
    return [];
  }

  // Titre lisible du document (sans extension ni separateurs de fichier) :
  // la suggestion est envoyee telle quelle comme question.
  const readableTitle = (fileName) =>
    String(fileName || "")
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  return [
    ...new Set(
      uniqueSources(message.sources)
        .map((source) => readableTitle(source.fileName))
        .filter((title) => title.length >= 3)
    )
  ]
    .slice(0, 2)
    .map((title) => `Peux-tu m'en dire plus sur « ${title} » ?`);
}

// Un message de la conversation. Memoise : pendant le streaming, seul le message
// en cours de generation change d'identite, les autres ne sont pas re-rendus.
const ChatMessage = memo(function ChatMessage({ message, isLast, isSpeaking, loading, speechSupported, actions }) {
  const { disclaimer, rest } = splitAiDisclaimer(message.content);
  const followUpSuggestions =
    message.role === "assistant" && message.content && !message.streamState && isLast
      ? buildFollowUpSuggestions(message)
      : [];

  return (
    <article
      className={`group/message relative z-0 flex ${
        message.role === "user" ? "justify-end" : "justify-start"
      } hover:z-20`}
    >
      {message.metrics && message.role === "assistant" && (
        <div className="mr-3 self-start pt-3">
          <InfoPopover label="Détails de la génération" align="left">
            <div className="space-y-2 text-sm">
              <div>Prompt modèle : ~{message.metrics.promptTokens} tokens</div>
              <div>Sortie générée : ~{message.metrics.outputTokens} tokens</div>
              <div>
                Génération : {formatDuration(Math.round(message.metrics.totalDurationMs / 1000))}
              </div>
              <div>
                Attente : {formatDuration(Math.round(message.metrics.queueDelayMs / 1000))}
              </div>
            </div>
          </InfoPopover>
        </div>
      )}

      <div className="flex max-w-[88%] flex-col sm:max-w-[78%]">
      <div
        className={`relative px-5 py-4 ${
          message.role === "user"
            ? "rounded-[28px] rounded-br-[10px] bg-slate-900 text-white shadow-[0_22px_48px_rgba(15,23,42,0.2)] dark:bg-slate-100 dark:text-slate-900"
            : "rounded-[28px] rounded-bl-[10px] border border-slate-200/80 bg-white/98 text-slate-800 shadow-[0_20px_45px_rgba(148,163,184,0.14)] dark:border-slate-700/80 dark:bg-slate-800/98 dark:text-slate-200"
        }`}
      >
        {message.thinking ? (
          message.isThinking ? (
            <div className="mb-3 rounded-2xl bg-slate-100/80 px-3 py-2.5 text-[13px] leading-6 text-slate-400 dark:bg-slate-900/50 dark:text-slate-500">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">
                Réflexion en cours…
              </p>
              <p className="whitespace-pre-wrap italic">{message.thinking}</p>
            </div>
          ) : (
            <details className="mb-3 rounded-2xl bg-slate-100/80 px-3 py-2.5 text-[13px] text-slate-400 dark:bg-slate-900/50 dark:text-slate-500">
              <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400 transition hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300">
                Voir le raisonnement
              </summary>
              <p className="mt-2 whitespace-pre-wrap italic leading-6">{message.thinking}</p>
            </details>
          )
        ) : null}

        {message.role === "user" && message.attachmentNames?.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {message.attachmentNames.map((name) => (
              <span
                key={name}
                className="inline-flex max-w-[220px] items-center gap-1 rounded-full bg-white/15 px-2.5 py-0.5 text-[12px] dark:bg-slate-900/10"
                title={name}
              >
                <span aria-hidden="true">📎</span>
                <span className="truncate">{name}</span>
              </span>
            ))}
          </div>
        )}

        {message.content ? (
          <p className="whitespace-pre-wrap text-[15px] leading-7">
            {renderMessageContent(rest)}
          </p>
        ) : (
          renderAssistantStatus(message)
        )}

        {message.sources?.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px] text-slate-500">
            <span className="text-slate-400">Sources</span>
            {uniqueSources(message.sources).map((source) =>
              resolveDownloadUrl(source.downloadUrl) ? (
                <button
                  key={`${source.relativePath}-${source.chunkIndex}`}
                  type="button"
                  className="source-link"
                  onClick={() => actions.openSource(source)}
                >
                  {source.fileName}
                </button>
              ) : (
                <span
                  key={`${source.relativePath}-${source.chunkIndex}`}
                  className="source-text"
                >
                  {source.fileName}
                </span>
              )
            )}
          </div>
        )}

        {message.role === "assistant" && message.content && !message.streamState && (
          <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
            <div className="inline-flex items-center gap-0.5 rounded-full border border-slate-200 bg-slate-50/80 p-1 dark:border-slate-700 dark:bg-slate-800/60">
              <ActionTooltip label={message.copyState === "copied" ? "Copié !" : "Copier"}>
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition hover:bg-white hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
                  aria-label={message.copyState === "copied" ? "Réponse copiée" : "Copier la réponse"}
                  onClick={() => actions.copy(message)}
                >
                  {message.copyState === "copied" ? (
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                      <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                      <rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
                      <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  )}
                </button>
              </ActionTooltip>

              {speechSupported ? (
                <ActionTooltip label={isSpeaking ? "Arrêter la lecture" : "Lire à voix haute"}>
                  <button
                    type="button"
                    className={`flex h-8 w-8 items-center justify-center rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 ${
                      isSpeaking
                        ? "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300"
                        : "text-slate-500 hover:bg-white hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
                    }`}
                    aria-pressed={isSpeaking}
                    aria-label={isSpeaking ? "Arrêter la lecture" : "Lire la réponse à voix haute"}
                    onClick={() => actions.toggleSpeech(message)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                      <path d="M11 5 6 9H3v6h3l5 4V5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                      {isSpeaking ? (
                        <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                      ) : (
                        <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                      )}
                    </svg>
                  </button>
                </ActionTooltip>
              ) : null}

              {isLast ? (
                <ActionTooltip label="Régénérer">
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition hover:bg-white hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
                    disabled={loading}
                    aria-label="Régénérer la réponse"
                    onClick={() => actions.regenerate(message)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                      <path
                        d="M20 11A8 8 0 1 0 18.5 15.5M20 11V5M20 11h-6"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </ActionTooltip>
              ) : null}

              {message.exchangeId ? (
                <div className="flex items-center gap-0.5" role="group" aria-label="Évaluer cette réponse">
                  <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" aria-hidden="true" />
                  <ActionTooltip label="Utile">
                    <button
                      type="button"
                      className={`flex h-8 w-8 items-center justify-center rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 ${
                        message.rating === "up"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                          : "text-slate-500 hover:bg-white hover:text-emerald-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-emerald-300"
                      }`}
                      aria-pressed={message.rating === "up"}
                      aria-label="Réponse utile"
                      onClick={() => actions.rate(message, "up")}
                    >
                      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                        <path
                          d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Zm0 0 5.5-6.5a1.5 1.5 0 0 1 2.6.9L14.5 9H19a2 2 0 0 1 1.98 2.29l-1.14 8A2 2 0 0 1 17.86 21H10a3 3 0 0 1-3-3v-8Z"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  </ActionTooltip>
                  <ActionTooltip label="Insatisfaisante">
                    <button
                      type="button"
                      className={`flex h-8 w-8 items-center justify-center rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 ${
                        message.rating === "down"
                          ? "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300"
                          : "text-slate-500 hover:bg-white hover:text-rose-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-rose-300"
                      }`}
                      aria-pressed={message.rating === "down"}
                      aria-label="Réponse insatisfaisante"
                      onClick={() => actions.rate(message, "down")}
                    >
                      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                        <path
                          d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3Zm0 0-5.5 6.5a1.5 1.5 0 0 1-2.6-.9L9.5 15H5a2 2 0 0 1-1.98-2.29l1.14-8A2 2 0 0 1 6.14 3H14a3 3 0 0 1 3 3v8Z"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  </ActionTooltip>
                </div>
              ) : null}
            </div>

            {message.ratingMessage ? (
              <span role="status" className="text-[12px] text-slate-500 dark:text-slate-400">
                {message.ratingMessage}
              </span>
            ) : null}
          </div>
        )}

        {followUpSuggestions.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 print:hidden">
              {followUpSuggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="chip-button text-[13px]"
                  disabled={loading}
                  onClick={() => actions.askFollowUp(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}

      </div>

      {message.reasoningDowngraded ? (
        <p className="mt-1.5 px-2 text-[11px] text-slate-400 dark:text-slate-500">
          Raisonnement approfondi indisponible (limité à une question toutes les 5 minutes) : réponse
          standard générée à la place.
        </p>
      ) : null}
      {disclaimer ? (
        <p className="mt-1.5 px-2 text-[11px] text-slate-400 dark:text-slate-500">{disclaimer}</p>
      ) : null}
      {message.role === "assistant" && message.skills?.length > 0 && !message.streamState ? (
        <p className="mt-1.5 px-2 text-[11px] text-slate-400 dark:text-slate-500">
          Méthode appliquée : {message.skills.map((skill) => skill.title).join(", ")}
        </p>
      ) : null}
      </div>
    </article>
  );
});

export default function UserChat() {
  const branding = useBranding();
  const attachmentConfig = describeAttachmentLimits(branding.attachmentLimits);
  const attachmentAcceptedExtensions = attachmentConfig.accept;
  const attachmentHelpLabel = attachmentConfig.label;
  const attachmentMaxCount = attachmentConfig.maxCount;
  // La conversation en cours est memorisee dans ce navigateur (voir
  // conversationStore) si l'utilisateur ne l'a pas desactive.
  const [messages, setMessages] = useState(defaultMessages);
  const [historyEnabled, setHistoryEnabledState] = useState(isHistoryEnabled);
  const [savedConversations, setSavedConversations] = useState(() => loadConversations());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [home, setHome] = useState({ announcement: null, suggestions: [], skills: [] });
  const [dismissedAnnouncementId, setDismissedAnnouncementId] = useState(readDismissedAnnouncement);
  const [selectedSkillId, setSelectedSkillId] = useState(null);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState(null);
  const [dictating, setDictating] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [liveEstimate, setLiveEstimate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copyStatusMessage, setCopyStatusMessage] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [useReasoningModel, setUseReasoningModel] = useState(false);
  const [reasoningCooldownUntil, setReasoningCooldownUntil] = useState(0);
  const [cooldownTick, setCooldownTick] = useState(0);
  const [contextSummary, setContextSummary] = useState(null);
  const attachmentInputRef = useRef(null);
  const clientIdRef = useRef(createRuntimeId());
  const sessionIdRef = useRef(createRuntimeId());
  const scrollAnchorRef = useRef(null);
  const textareaRef = useRef(null);
  const activeRequestControllerRef = useRef(null);
  const activeAssistantMessageIdRef = useRef(null);
  const stopRequestedRef = useRef(false);
  const stopDictationRef = useRef(null);
  const dictationBaseRef = useRef("");
  const skipNextSaveRef = useRef(false);
  const chatStageRef = useRef(null);
  // Suit le bas de la conversation tant que l'utilisateur y est : s'il remonte
  // lire un passage pendant la generation, on ne le ramene plus de force en bas.
  const stickToBottomRef = useRef(true);
  // Vide le tampon de tokens de la reponse en cours (voir askQuestion).
  const flushStreamRef = useRef(null);
  const actionsRef = useRef(null);
  const globalKeyDownRef = useRef(null);
  const hasConversationStarted = messages.length > 0;
  const contextGauge = buildContextGauge(contextSummary);
  const speechSupported = isSpeechSynthesisSupported();
  const dictationSupported = isDictationSupported();
  const selectedSkill = home.skills.find((skill) => skill.id === selectedSkillId) || null;
  const visibleAnnouncement =
    home.announcement && home.announcement.id !== dismissedAnnouncementId ? home.announcement : null;

  useEffect(() => {
    let active = true;
    fetchJson("/api/chat/home", { retryCount: 1 })
      .then((payload) => {
        if (active) {
          setHome({
            announcement: payload.announcement || null,
            suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : [],
            skills: Array.isArray(payload.skills) ? payload.skills : []
          });
        }
      })
      .catch(() => {
        // L'accueil reste utilisable sans annonce ni suggestions.
      });

    return () => {
      active = false;
    };
  }, []);

  // Sauvegarde locale apres chaque reponse terminee (pas pendant le flux).
  useEffect(() => {
    if (loading || !historyEnabled || messages.length === 0) {
      return;
    }

    // Simple reouverture d'une conversation : rien de neuf a enregistrer (sinon
    // elle remonterait en tete de l'historique sans avoir ete poursuivie).
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    saveConversation(sessionIdRef.current, messages);
    setSavedConversations(loadConversations());
  }, [messages, loading, historyEnabled]);

  // Arrete lecture vocale et dictee en quittant la page.
  useEffect(
    () => () => {
      stopSpeaking();
      stopDictationRef.current?.();
    },
    []
  );

  useEffect(() => {
    // Distance restante jusqu'au bas de ce qui defile reellement : la page
    // (cas courant) ou la zone de conversation si elle a sa propre barre.
    function isNearBottom() {
      const threshold = 120;
      const page = document.documentElement;
      const pageRemaining = page.scrollHeight - (window.scrollY + window.innerHeight);
      const stage = chatStageRef.current;
      const stageRemaining = stage ? stage.scrollHeight - stage.scrollTop - stage.clientHeight : 0;
      return pageRemaining <= threshold && stageRemaining <= threshold;
    }

    let releasedAt = 0;

    function handleScroll() {
      // Juste apres un geste de remontee, le defilement anime n'a pas encore
      // bouge la page : ne pas reactiver le suivi sur une position perimee.
      if (Date.now() - releasedAt < 600) {
        return;
      }
      stickToBottomRef.current = isNearBottom();
    }

    // L'evenement scroll n'arrive qu'a l'image suivante, apres que le flux a
    // deja ramene la page en bas : l'intention de remonter est donc detectee
    // directement sur la molette, le toucher et les touches de navigation.
    function releaseBottom() {
      releasedAt = Date.now();
      stickToBottomRef.current = false;
    }

    function handleWheel(event) {
      if (event.deltaY < 0) {
        releaseBottom();
      }
    }

    function handleKeyDown(event) {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) && !event.target?.closest?.("textarea, input")) {
        releaseBottom();
      }
    }

    const stage = chatStageRef.current;
    window.addEventListener("scroll", handleScroll, { passive: true });
    stage?.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("wheel", handleWheel, { passive: true });
    window.addEventListener("touchmove", releaseBottom, { passive: true });
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("scroll", handleScroll);
      stage?.removeEventListener("scroll", handleScroll);
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("touchmove", releaseBottom);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) {
      return;
    }

    // Pendant le flux : defilement immediat (une animation "smooth" relancee a
    // chaque bloc de tokens saccadait l'affichage).
    scrollAnchorRef.current?.scrollIntoView({ behavior: loading ? "auto" : "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }

    if (!question) {
      // Repart de la hauteur CSS par defaut (une ligne) plutot que de faire confiance
      // a scrollHeight, qui peut renvoyer une valeur trop grande sur un textarea vide
      // au tout premier rendu (avant que le navigateur ait stabilise la mise en page).
      textareaRef.current.style.height = "";
      return;
    }

    textareaRef.current.style.height = "0px";
    const nextHeight = Math.min(textareaRef.current.scrollHeight, 152);
    textareaRef.current.style.height = `${nextHeight}px`;
  }, [question]);

  // Le raisonnement approfondi est limite a une utilisation toutes les 5 minutes cote
  // serveur (par IP) : ce tick force un nouveau rendu chaque seconde pendant le
  // cooldown pour que le decompte affiche a l'utilisateur reste a jour.
  useEffect(() => {
    if (reasoningCooldownUntil <= Date.now()) {
      return;
    }

    const interval = window.setInterval(() => {
      setCooldownTick((value) => value + 1);
    }, 1000);

    return () => window.clearInterval(interval);
  }, [reasoningCooldownUntil]);

  const reasoningCooldownRemainingMs = Math.max(0, reasoningCooldownUntil - Date.now());
  const reasoningOnCooldown = reasoningCooldownRemainingMs > 0;
  const willUseReasoningModel =
    branding.reasoningModelAvailable && useReasoningModel && !reasoningOnCooldown;

  useEffect(() => {
    if (!question.trim()) {
      setLiveEstimate(null);
      return;
    }

    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchJson("/api/chat/estimate", {
        method: "POST",
        body: JSON.stringify({
          question,
          useReasoningModel: willUseReasoningModel
        }),
        signal: controller.signal
      })
        .then((payload) => {
          if (active) {
            setLiveEstimate(payload);
          }
        })
        .catch(() => {
          if (active) {
            setLiveEstimate(null);
          }
        });
    }, 220);

    return () => {
      active = false;
      window.clearTimeout(timer);
      // Estimation devenue inutile (nouvelle frappe) : la requete en vol est annulee.
      controller.abort();
    };
  }, [question, willUseReasoningModel]);

  function formatCooldown(remainingMs) {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function confidenceLabel(confidenceScore) {
    const score = Number(confidenceScore);
    if (!Number.isFinite(score)) {
      return "Estimation";
    }

    // confidenceScore reflete le volume d'historique reel utilise pour la regression
    // (voir getLiveChatEstimate cote backend) : peu d'echanges passes pour ce modele
    // => estimation plus approximative, beaucoup d'historique => plus fiable.
    if (score >= 0.6) {
      return "Estimation fiable";
    }

    if (score >= 0.4) {
      return "Estimation modérée";
    }

    return "Estimation approximative";
  }

  async function handleAttachmentSelect(event) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    if (attachments.length >= attachmentMaxCount) {
      setError(`Vous pouvez joindre au maximum ${attachmentMaxCount} fichiers par question.`);
      return;
    }

    if (file.size > attachmentConfig.maxBytes) {
      setError(`Le fichier « ${file.name} » est trop volumineux. ${attachmentConfig.errorHint}`);
      return;
    }

    setError("");
    setAttachmentUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("sessionId", sessionIdRef.current);
      if (question.trim()) {
        formData.append("question", question.trim());
      }

      const response = await fetch("/api/chat/attachments", {
        method: "POST",
        credentials: "include",
        body: formData
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.message || "L'envoi de la pièce jointe a échoué.");
      }

      setAttachments((current) => [
        ...current,
        {
          id: payload.attachment.id,
          name: payload.attachment.originalName
        }
      ]);
    } catch (uploadError) {
      setError(
        reportError(
          "chat:attachment",
          uploadError,
          `L'envoi de la pièce jointe a échoué. ${attachmentConfig.errorHint}`
        )
      );
    } finally {
      setAttachmentUploading(false);
    }
  }

  function removeAttachment(attachmentId) {
    setAttachments((current) => current.filter((entry) => entry.id !== attachmentId));
  }

  async function rateAnswer(message, rating) {
    if (!message.exchangeId || message.rating === rating) {
      return;
    }

    try {
      const payload = await fetchJson("/api/chat/rate", {
        method: "POST",
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          exchangeId: message.exchangeId,
          rating
        })
      });

      setMessages((current) =>
        current.map((entry) =>
          entry.id === message.id
            ? { ...entry, rating, ratingMessage: payload.message }
            : entry
        )
      );
    } catch (ratingError) {
      setError(
        reportError("chat:rate", ratingError, "L'évaluation n'a pas pu être enregistrée.")
      );
    }
  }

  async function handleSourceDownload(source) {
    const absoluteUrl = resolveDownloadUrl(source?.downloadUrl);
    if (!absoluteUrl) {
      setError("Lien de téléchargement invalide.");
      return;
    }

    try {
      setError("");
      if (isExternalUrl(absoluteUrl)) {
        window.open(absoluteUrl, "_blank", "noopener,noreferrer");
        return;
      }

      const inlineUrl = new URL(absoluteUrl);
      inlineUrl.searchParams.set("disposition", "inline");
      window.open(inlineUrl.toString(), "_blank", "noopener,noreferrer");
    } catch (downloadError) {
      setError(reportError("chat:download", downloadError, "Ouverture du fichier impossible."));
    }
  }

  async function askQuestion(
    questionText,
    { baseMessages = messages, attachmentIds = [], attachmentNames = [] } = {}
  ) {
    const trimmedQuestion = questionText.trim();
    if (!trimmedQuestion || loading) {
      return;
    }

    setError("");
    setLoading(true);

    const userMessage = {
      id: `${Date.now()}-user`,
      role: "user",
      content: trimmedQuestion,
      attachmentNames,
      timestamp: Date.now()
    };

    if (isSourceOnlyRequest(trimmedQuestion)) {
      const latestSources = getLatestPublicSources(baseMessages);

      if (latestSources.length > 0) {
        setMessages((current) => [
          ...current,
          userMessage,
          {
            id: `${Date.now()}-assistant-source`,
            role: "assistant",
            content: "",
            sources: latestSources,
            grounding: null,
            metrics: null,
            streamState: null,
            timestamp: Date.now()
          }
        ]);
        setQuestion("");
        setLiveEstimate(null);
        setLoading(false);
        return;
      }
    }

    const assistantMessageId = `${Date.now()}-assistant`;
    activeAssistantMessageIdRef.current = assistantMessageId;
    stopRequestedRef.current = false;
    // Identifiant propre a cette demande : une annulation tardive de la demande
    // precedente (bouton Stop puis nouvelle question) ne peut plus l'interrompre.
    clientIdRef.current = createRuntimeId();
    stickToBottomRef.current = true;

    const isReasoningRequest = willUseReasoningModel;
    // L'utilisateur a coche le raisonnement mais le cooldown de 5 minutes l'empeche
    // encore : la question part quand meme (avec le modele normal), on le signale
    // juste sur cette reponse plutot que de bloquer l'envoi.
    const reasoningDowngraded = branding.reasoningModelAvailable && useReasoningModel && reasoningOnCooldown;

    setMessages((current) => [
      ...current,
      userMessage,
      {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        thinking: "",
        isThinking: false,
        reasoningDowngraded,
        sources: [],
        grounding: null,
        metrics: null,
        streamState: "generating",
        timestamp: Date.now()
      }
    ]);

    // La jauge precedente reste affichee jusqu'aux chiffres de cette question.
    setContextSummary((current) => (current ? { ...current, stage: "stale" } : current));

    const payload = {
      clientId: clientIdRef.current,
      sessionId: sessionIdRef.current,
      messages: buildConversationMemory(baseMessages, trimmedQuestion),
      attachmentIds,
      useReasoningModel: isReasoningRequest,
      skillId: selectedSkillId
    };

    setQuestion("");
    setAttachments([]);

    const requestController = new AbortController();
    activeRequestControllerRef.current = requestController;

    // Les tokens sont accumules puis appliques une fois par image affichee :
    // un rendu React par token saturait le navigateur sur les longues reponses.
    let pendingContent = "";
    let pendingThinking = "";
    let scheduledFlush = null;

    const updateAssistantMessage = (update) => {
      setMessages((current) =>
        current.map((message) => (message.id === assistantMessageId ? update(message) : message))
      );
    };

    const flushPendingTokens = () => {
      if (scheduledFlush) {
        scheduledFlush.cancel();
        scheduledFlush = null;
      }
      if (!pendingContent && !pendingThinking) {
        return;
      }

      const content = pendingContent;
      const thinking = pendingThinking;
      pendingContent = "";
      pendingThinking = "";
      updateAssistantMessage((message) => ({
        ...message,
        content: content ? `${message.content}${content}` : message.content,
        thinking: thinking ? `${message.thinking || ""}${thinking}` : message.thinking,
        // La reponse finale a commence a arriver : la reflexion (s'il y en avait
        // une) est terminee, elle peut se replier dans le menu deroulant.
        isThinking: content ? false : thinking ? true : message.isThinking,
        streamState: "generating"
      }));
    };

    const scheduleTokenFlush = () => {
      if (scheduledFlush) {
        return;
      }

      // requestAnimationFrame est suspendu dans un onglet en arriere-plan.
      if (typeof window.requestAnimationFrame === "function" && document.visibilityState !== "hidden") {
        const frame = window.requestAnimationFrame(flushPendingTokens);
        scheduledFlush = { cancel: () => window.cancelAnimationFrame(frame) };
      } else {
        const timer = window.setTimeout(flushPendingTokens, 100);
        scheduledFlush = { cancel: () => window.clearTimeout(timer) };
      }
    };
    flushStreamRef.current = flushPendingTokens;

    try {
      const response = await openChatStreamWithRetry(payload, requestController.signal);

      // La requete a franchi le limiteur de raisonnement (5 minutes par IP, cote
      // serveur) : on demarre localement le meme decompte pour refleter fidelement
      // l'etat reel plutot que d'attendre un 429 sur la prochaine tentative.
      if (isReasoningRequest) {
        setReasoningCooldownUntil(Date.now() + 5 * 60 * 1000);
      }

      await consumeSseResponse(response, {
        queued: (payload) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? { ...message, streamState: "generating" }
                : message
            )
          );
        },
        start: () => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? { ...message, streamState: "generating" }
                : message
            )
          );
        },
        session: ({ sessionId }) => {
          if (sessionId) {
            sessionIdRef.current = sessionId;
          }
        },
        context: (payload) => {
          // L'estimation initiale ne doit pas ecraser le calcul du prompt reel.
          setContextSummary((current) =>
            payload?.stage === "estimate" && current?.stage === "prompt" ? current : payload
          );
        },
        thinking: ({ token }) => {
          if (typeof token === "string" && token) {
            pendingThinking += token;
            scheduleTokenFlush();
          }
        },
        token: ({ token }) => {
          if (typeof token === "string" && token) {
            pendingContent += token;
            scheduleTokenFlush();
          }
        },
        sources: ({ sources }) => {
          flushPendingTokens();
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId ? { ...message, sources } : message
            )
          );
        },
        error: ({ message }) => {
          flushPendingTokens();
          setError(message);
          setMessages((current) =>
            current.map((entry) =>
              entry.id === assistantMessageId
                ? {
                    ...entry,
                    content: entry.content || message,
                    isThinking: false,
                    streamState: null
                  }
                : entry
            )
          );
        },
        done: ({ text, metrics, grounding, exchangeId, conversationId, skills }) => {
          flushPendingTokens();
          // Nombre de tokens reellement traites par le modele : remplace l'estimation.
          if (Number(metrics?.promptTokens) > 0) {
            setContextSummary((current) =>
              current ? { ...current, measuredPromptTokens: Number(metrics.promptTokens) } : current
            );
          }
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    content: text || message.content || "",
                    isThinking: false,
                    grounding,
                    metrics,
                    skills: Array.isArray(skills) ? skills : [],
                    exchangeId: exchangeId || null,
                    conversationId: conversationId || null,
                    streamState: null
                  }
                : message
            )
          );
        },
        stopped: ({ message }) => {
          flushPendingTokens();
          setMessages((current) =>
            current.map((entry) =>
              entry.id === assistantMessageId
                ? {
                    ...entry,
                    content: entry.content || message || "Génération interrompue.",
                    isThinking: false,
                    streamState: null
                  }
                : entry
            )
          );
        }
      });
    } catch (requestError) {
      flushPendingTokens();
      if (requestError.name === "AbortError" && (stopRequestedRef.current || requestController.signal.aborted)) {
        setMessages((current) =>
          current.map((entry) =>
            entry.id === assistantMessageId
              ? {
                  ...entry,
                  content: entry.content || "Génération interrompue.",
                  streamState: null
                }
              : entry
          )
        );
        return;
      }

      if (requestError.statusCode === 429 && isReasoningRequest) {
        // Resynchronise le decompte local sur la vraie duree restante renvoyee par le
        // serveur (utile si l'etat local avait ete perdu, ex: apres un rechargement).
        setReasoningCooldownUntil(Date.now() + (requestError.retryAfterSeconds || 300) * 1000);
      }

      const friendlyMessage = reportError(
        "chat:stream",
        requestError,
        "L'assistant n'a pas pu répondre. Réessayez dans un instant."
      );
      setError(friendlyMessage);
      setMessages((current) =>
        current.map((entry) =>
          entry.id === assistantMessageId
            ? { ...entry, content: entry.content || friendlyMessage, streamState: null }
            : entry
        )
      );
    } finally {
      flushPendingTokens();
      // Une nouvelle question a pu partir entre-temps (Stop puis envoi) : on ne
      // touche alors ni a son etat de chargement ni a ses references.
      if (activeRequestControllerRef.current === requestController) {
        activeRequestControllerRef.current = null;
        activeAssistantMessageIdRef.current = null;
        flushStreamRef.current = null;
        stopRequestedRef.current = false;
        setLoading(false);
      }
    }
  }

  function submitQuestion(event) {
    event.preventDefault();
    stopDictationRef.current?.();
    askQuestion(question, {
      baseMessages: messages,
      attachmentIds: attachments.map((entry) => entry.id),
      attachmentNames: attachments.map((entry) => entry.name)
    });
  }

  function regenerateAnswer(assistantMessage) {
    if (loading) {
      return;
    }

    const assistantIndex = messages.findIndex((entry) => entry.id === assistantMessage.id);
    if (assistantIndex === -1) {
      return;
    }

    const precedingUserMessage = [...messages.slice(0, assistantIndex)]
      .reverse()
      .find((entry) => entry.role === "user");

    if (!precedingUserMessage) {
      return;
    }

    const messagesBeforeExchange = messages.filter(
      (entry) => entry.id !== assistantMessage.id && entry.id !== precedingUserMessage.id
    );

    setMessages(messagesBeforeExchange);
    askQuestion(precedingUserMessage.content, { baseMessages: messagesBeforeExchange });
  }

  async function copyMessageContent(message) {
    try {
      await navigator.clipboard.writeText(message.content || "");
      setMessages((current) =>
        current.map((entry) => (entry.id === message.id ? { ...entry, copyState: "copied" } : entry))
      );
      window.setTimeout(() => {
        setMessages((current) =>
          current.map((entry) => (entry.id === message.id ? { ...entry, copyState: null } : entry))
        );
      }, 1500);
    } catch {
      setError("Impossible de copier ce message. Copiez-le manuellement.");
    }
  }

  async function copyConversation() {
    const transcript = messages
      .filter((entry) => entry.content?.trim())
      .map((entry) => `${entry.role === "user" ? "Vous" : "Assistant"} : ${entry.content.trim()}`)
      .join("\n\n");

    if (!transcript) {
      return;
    }

    try {
      await navigator.clipboard.writeText(transcript);
      setCopyStatusMessage("Conversation copiée dans le presse-papiers.");
      window.setTimeout(() => setCopyStatusMessage(""), 2500);
    } catch {
      setError("Impossible de copier la conversation. Réessayez.");
    }
  }

  function askFollowUpQuestion(text) {
    if (loading) {
      return;
    }
    askQuestion(text, { baseMessages: messages, attachmentIds: [] });
  }

  function stopGeneration() {
    if (!loading) {
      return;
    }

    stopRequestedRef.current = true;
    setError("");
    // Les tokens deja recus restent affiches (et ne s'ajoutent pas apres
    // "Génération interrompue.").
    flushStreamRef.current?.();

    // Coupure locale immediate, puis signalement au serveur sans l'attendre :
    // l'arret ne doit jamais dependre de la reactivite du serveur.
    activeRequestControllerRef.current?.abort();
    setLoading(false);
    fetchJson("/api/chat/cancel", {
      method: "POST",
      body: JSON.stringify({ clientId: clientIdRef.current }),
      timeoutMs: 5000
    }).catch(() => {
      // La fermeture du flux suffit a interrompre la generation cote serveur.
    });
    setMessages((current) =>
      current.map((entry) =>
        entry.id === activeAssistantMessageIdRef.current
          ? {
              ...entry,
              content: entry.content || "Génération interrompue.",
              streamState: null
            }
          : entry
      )
    );
  }

  function resetComposerState() {
    stopSpeaking();
    setSpeakingMessageId(null);
    setQuestion("");
    setError("");
    setCopyStatusMessage("");
    setLiveEstimate(null);
    setAttachments([]);
    setContextSummary(null);
  }

  function clearSession() {
    if (loading) {
      return;
    }

    // Nouvelle conversation : l'ancienne reste dans l'historique local.
    resetComposerState();
    setMessages(defaultMessages);
    setSelectedSkillId(null);
    sessionIdRef.current = createRuntimeId();
    textareaRef.current?.focus();
  }

  function openConversation(conversationId) {
    if (loading) {
      return;
    }

    const stored = getConversation(conversationId);
    if (!stored) {
      setSavedConversations(loadConversations());
      return;
    }

    resetComposerState();
    // Reprend la meme session cote serveur : les pieces jointes et l'historique
    // archive restent rattaches a cette conversation.
    sessionIdRef.current = stored.id;
    skipNextSaveRef.current = true;
    setMessages(stored.messages);
    setHistoryOpen(false);
  }

  function removeConversation(conversationId) {
    deleteConversation(conversationId);
    setSavedConversations(loadConversations());
    if (conversationId === sessionIdRef.current && !loading) {
      setMessages(defaultMessages);
      sessionIdRef.current = createRuntimeId();
    }
  }

  function toggleHistoryEnabled() {
    const next = !historyEnabled;
    setHistoryEnabled(next);
    setHistoryEnabledState(next);
    if (next && messages.length > 0) {
      saveConversation(sessionIdRef.current, messages);
    }
    setSavedConversations(loadConversations());
  }

  function clearAllConversations() {
    clearConversations();
    setSavedConversations([]);
  }

  function exportConversation() {
    if (!hasConversationStarted) {
      return;
    }

    const date = new Date().toISOString().slice(0, 10);
    downloadTextFile(`conversation-${date}.md`, buildMarkdownTranscript(messages, branding.projectName));
  }

  function printConversation() {
    if (!hasConversationStarted) {
      return;
    }

    window.print();
  }

  function toggleSpeech(message) {
    if (speakingMessageId === message.id) {
      stopSpeaking();
      setSpeakingMessageId(null);
      return;
    }

    const started = speak(splitAiDisclaimer(message.content).rest, {
      onEnd: () => setSpeakingMessageId((current) => (current === message.id ? null : current))
    });
    setSpeakingMessageId(started ? message.id : null);
  }

  function toggleDictation() {
    if (dictating) {
      stopDictationRef.current?.();
      return;
    }

    setError("");
    dictationBaseRef.current = question ? `${question.trimEnd()} ` : "";
    setDictating(true);
    stopDictationRef.current = startDictation({
      onText: (finalText, interim) => {
        setQuestion(`${dictationBaseRef.current}${finalText}${interim}`);
      },
      onError: (message) => setError(message),
      onEnd: () => {
        setDictating(false);
        stopDictationRef.current = null;
        textareaRef.current?.focus();
      }
    });
  }

  function chooseSkill(skillId) {
    setSelectedSkillId(skillId);
    setSkillMenuOpen(false);
    textareaRef.current?.focus();
  }

  function dismissAnnouncement() {
    if (!home.announcement) {
      return;
    }

    setDismissedAnnouncementId(home.announcement.id);
    try {
      window.localStorage.setItem(dismissedAnnouncementKey, home.announcement.id);
    } catch {
      // Sans stockage local, l'annonce reapparaitra au prochain chargement.
    }
  }

  // Raccourcis clavier globaux : Echap (arreter / fermer), Ctrl/Cmd+K
  // (nouvelle conversation), "/" (aller a la zone de saisie).
  // Le gestionnaire est remplace a chaque rendu (etat courant), mais l'ecouteur
  // n'est pose qu'une fois au lieu d'etre retire/ajoute a chaque bloc de tokens.
  useLayoutEffect(() => {
    globalKeyDownRef.current = function handleGlobalKeyDown(event) {
      const target = event.target;
      const isTyping =
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

      if (event.key === "Escape") {
        if (loading) {
          event.preventDefault();
          stopGeneration();
        } else if (historyOpen || skillMenuOpen || shortcutsOpen) {
          setHistoryOpen(false);
          setSkillMenuOpen(false);
          setShortcutsOpen(false);
        } else if (dictating) {
          stopDictationRef.current?.();
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        clearSession();
        return;
      }

      if (event.key === "/" && !isTyping && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        textareaRef.current?.focus();
      }
    };
  });

  useEffect(() => {
    const listener = (event) => globalKeyDownRef.current?.(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // Actions des messages : objet stable (pour la memoisation de ChatMessage)
  // qui appelle toujours la version a jour des gestionnaires.
  useLayoutEffect(() => {
    actionsRef.current = {
      copyMessageContent,
      toggleSpeech,
      regenerateAnswer,
      rateAnswer,
      handleSourceDownload,
      askFollowUpQuestion
    };
  });

  const messageActions = useMemo(
    () => ({
      copy: (message) => actionsRef.current?.copyMessageContent(message),
      toggleSpeech: (message) => actionsRef.current?.toggleSpeech(message),
      regenerate: (message) => actionsRef.current?.regenerateAnswer(message),
      rate: (message, rating) => actionsRef.current?.rateAnswer(message, rating),
      openSource: (source) => actionsRef.current?.handleSourceDownload(source),
      askFollowUp: (text) => actionsRef.current?.askFollowUpQuestion(text)
    }),
    []
  );

  function handleComposerKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent?.isComposing) {
      event.preventDefault();
      submitQuestion(event);
      return;
    }

    // Fleche haut dans une zone vide : reprend la derniere question posee.
    if (event.key === "ArrowUp" && !question) {
      const lastQuestion = [...messages].reverse().find((entry) => entry.role === "user")?.content;
      if (lastQuestion) {
        event.preventDefault();
        setQuestion(lastQuestion);
      }
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[112rem] flex-col gap-4">
      <div className="print:hidden">
        <FeedbackWidget />
      </div>
      {visibleAnnouncement ? (
        <div
          role="status"
          className={`mx-auto flex w-full max-w-[112rem] items-start gap-3 rounded-[22px] border px-5 py-3 text-sm leading-6 shadow-soft print:hidden ${
            announcementToneClasses[visibleAnnouncement.tone] || announcementToneClasses.info
          }`}
        >
          <span aria-hidden="true" className="mt-0.5">
            {visibleAnnouncement.tone === "critical" ? "⚠️" : visibleAnnouncement.tone === "warning" ? "📣" : "ℹ️"}
          </span>
          <p className="flex-1 whitespace-pre-wrap">{visibleAnnouncement.message}</p>
          <button
            type="button"
            className="rounded-full px-2 text-lg leading-6 opacity-60 transition hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
            aria-label="Masquer l'annonce"
            onClick={dismissAnnouncement}
          >
            ×
          </button>
        </div>
      ) : null}
      <section className="panel chat-print-area mx-auto flex min-h-[76vh] w-full max-w-[112rem] flex-col overflow-hidden">
        <div className="border-b border-slate-200/70 bg-white/65 px-6 py-5 backdrop-blur-xl sm:px-8 dark:border-slate-700/70 dark:bg-slate-900/65">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-[-0.03em] text-slate-950 dark:text-slate-50">
                Conversation
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 print:hidden">
                Entrée pour envoyer, maj + entrée pour aller à la ligne.{" "}
                {historyEnabled
                  ? "Vos conversations sont gardées 30 jours sur cet appareil uniquement."
                  : "Mémorisation désactivée : tout s'efface au rechargement de la page."}
              </p>
            </div>
            <div className="flex items-center gap-2 print:hidden">
              <button
                type="button"
                className="ghost-button px-3 py-1.5 text-[13px]"
                aria-expanded={historyOpen}
                aria-controls="chat-history-panel"
                onClick={() => setHistoryOpen((value) => !value)}
              >
                Historique
                {savedConversations.length > 0 ? (
                  <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-600 dark:bg-slate-700 dark:text-slate-200">
                    {savedConversations.length}
                  </span>
                ) : null}
              </button>
              <div className="relative">
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 text-[13px] font-semibold text-slate-500 transition hover:text-slate-900 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-100"
                  aria-label="Raccourcis clavier"
                  aria-expanded={shortcutsOpen}
                  onClick={() => setShortcutsOpen((value) => !value)}
                >
                  ?
                </button>
                {shortcutsOpen ? (
                  <div className="absolute right-0 top-10 z-30 w-72 rounded-2xl border border-slate-200 bg-white p-4 text-[13px] text-slate-600 shadow-xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                    <p className="mb-2 font-semibold text-slate-900 dark:text-slate-100">Raccourcis clavier</p>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                      <dt><kbd className="kbd">Entrée</kbd></dt><dd>Envoyer</dd>
                      <dt><kbd className="kbd">Maj</kbd>+<kbd className="kbd">Entrée</kbd></dt><dd>Aller à la ligne</dd>
                      <dt><kbd className="kbd">Échap</kbd></dt><dd>Arrêter la réponse</dd>
                      <dt><kbd className="kbd">Ctrl</kbd>/<kbd className="kbd">⌘</kbd>+<kbd className="kbd">K</kbd></dt><dd>Nouvelle conversation</dd>
                      <dt><kbd className="kbd">↑</kbd></dt><dd>Reprendre la dernière question</dd>
                      <dt><kbd className="kbd">/</kbd></dt><dd>Aller à la zone de saisie</dd>
                    </dl>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {historyOpen ? (
          <div
            id="chat-history-panel"
            className="border-b border-slate-200/70 bg-slate-50/80 px-6 py-4 sm:px-8 dark:border-slate-700/70 dark:bg-slate-900/60 print:hidden"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Conversations sur cet appareil</p>
              <div className="flex flex-wrap items-center gap-3 text-[13px]">
                <label className="inline-flex cursor-pointer items-center gap-2 text-slate-600 dark:text-slate-300">
                  <input type="checkbox" checked={historyEnabled} onChange={toggleHistoryEnabled} />
                  Mémoriser sur cet appareil
                </label>
                {savedConversations.length > 0 ? (
                  <button type="button" className="text-rose-600 underline-offset-4 hover:underline dark:text-rose-300" onClick={clearAllConversations}>
                    Tout effacer
                  </button>
                ) : null}
              </div>
            </div>
            <p className="mt-1 text-[12px] text-slate-500 dark:text-slate-400">
              Sur un ordinateur partagé, décochez la mémorisation ou effacez l&apos;historique avant de partir.
            </p>
            {savedConversations.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Aucune conversation enregistrée.</p>
            ) : (
              <ul className="mt-3 max-h-64 space-y-1.5 overflow-y-auto pr-1">
                {savedConversations.map((conversation) => (
                  <li
                    key={conversation.id}
                    className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                      conversation.id === sessionIdRef.current
                        ? "border-sky-200 bg-white dark:border-sky-800 dark:bg-slate-800"
                        : "border-transparent hover:border-slate-200 hover:bg-white dark:hover:border-slate-700 dark:hover:bg-slate-800"
                    }`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-slate-700 disabled:opacity-50 dark:text-slate-200"
                      disabled={loading}
                      onClick={() => openConversation(conversation.id)}
                      title={conversation.title}
                    >
                      {conversation.title}
                    </button>
                    <span className="shrink-0 text-[12px] text-slate-400">{formatHistoryDate(conversation.updatedAt)}</span>
                    <button
                      type="button"
                      className="shrink-0 rounded-full px-1.5 text-slate-400 transition hover:text-rose-600"
                      aria-label={`Supprimer la conversation « ${conversation.title} »`}
                      onClick={() => removeConversation(conversation.id)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        <div ref={chatStageRef} className="chat-stage flex-1 space-y-4 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
          {messages.map((message, messageIndex) => {
            const isLast = messageIndex === messages.length - 1;
            return (
              <ChatMessage
                key={message.id}
                message={message}
                isLast={isLast}
                isSpeaking={speakingMessageId === message.id}
                loading={isLast ? loading : false}
                speechSupported={speechSupported}
                actions={messageActions}
              />
            );
          })}

          {error && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 shadow-soft dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
              {error}
            </div>
          )}
          {copyStatusMessage && (
            <div
              role="status"
              className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 shadow-soft dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200"
            >
              {copyStatusMessage}
            </div>
          )}
          <div ref={scrollAnchorRef} />
        </div>

        <form className="sticky bottom-0 border-t border-slate-100 bg-white/78 px-4 py-4 backdrop-blur-xl sm:px-6 sm:py-5 lg:px-8 dark:border-slate-800 dark:bg-slate-900/78 print:hidden" onSubmit={submitQuestion}>
          {!hasConversationStarted && (
            <div className="mb-4 rounded-[28px] border border-slate-200/80 bg-white/96 px-5 py-5 text-center shadow-[0_18px_40px_rgba(148,163,184,0.12)] dark:border-slate-700/80 dark:bg-slate-800/96">
              <h2 className="text-2xl font-semibold leading-[1.02] tracking-[-0.05em] text-slate-950 sm:text-[2.15rem] dark:text-slate-50">
                Posez une question.
                <br />
                {branding.shortName} répond.
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-[13px] leading-5 text-slate-500 sm:text-sm dark:text-slate-400">
                {branding.welcomeMessage}
              </p>
              {home.suggestions.length > 0 ? (
                <div className="mt-4 flex flex-wrap justify-center gap-2" aria-label="Questions suggérées">
                  {home.suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className="chip-button text-[13px]"
                      disabled={loading}
                      onClick={() => askFollowUpQuestion(suggestion)}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          {home.skills.length > 0 ? (
            <div className="relative mb-3 flex flex-wrap items-center gap-2 px-1">
              {selectedSkill ? (
                <span className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 text-[13px] text-sky-800 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-200">
                  <span aria-hidden="true">✦</span>
                  Méthode : {selectedSkill.title}
                  <button
                    type="button"
                    className="rounded-full px-1 text-sky-500 transition hover:text-sky-800 dark:hover:text-sky-100"
                    aria-label="Ne plus utiliser cette méthode"
                    onClick={() => setSelectedSkillId(null)}
                  >
                    ×
                  </button>
                </span>
              ) : null}
              <button
                type="button"
                className="chip-button text-[12px]"
                aria-expanded={skillMenuOpen}
                aria-haspopup="listbox"
                onClick={() => setSkillMenuOpen((value) => !value)}
              >
                {selectedSkill ? "Changer de méthode" : "✦ Choisir une méthode de réponse"}
              </button>
              {skillMenuOpen ? (
                <ul
                  role="listbox"
                  aria-label="Méthodes de réponse"
                  className="absolute bottom-full left-0 z-30 mb-2 max-h-72 w-full max-w-md overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-xl dark:border-slate-700 dark:bg-slate-900"
                >
                  <li>
                    <button
                      type="button"
                      role="option"
                      aria-selected={!selectedSkill}
                      className="w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                      onClick={() => chooseSkill(null)}
                    >
                      <span className="font-medium text-slate-800 dark:text-slate-100">Automatique</span>
                      <span className="block text-[12px] text-slate-500 dark:text-slate-400">
                        L&apos;assistant choisit seul la façon de répondre.
                      </span>
                    </button>
                  </li>
                  {home.skills.map((skill) => (
                    <li key={skill.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selectedSkillId === skill.id}
                        className={`w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800 ${
                          selectedSkillId === skill.id ? "bg-sky-50 dark:bg-sky-950/40" : ""
                        }`}
                        onClick={() => chooseSkill(skill.id)}
                      >
                        <span className="font-medium text-slate-800 dark:text-slate-100">{skill.title}</span>
                        {skill.description ? (
                          <span className="block text-[12px] text-slate-500 dark:text-slate-400">{skill.description}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {attachments.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 px-1" aria-live="polite">
              {attachments.map((attachment) => (
                <span
                  key={attachment.id}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[13px] text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                >
                  <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                    <path
                      d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="max-w-[200px] truncate">{attachment.name}</span>
                  <button
                    type="button"
                    className="rounded-full p-0.5 text-slate-400 transition hover:text-rose-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
                    aria-label={`Retirer la pièce jointe ${attachment.name}`}
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                      <path
                        d="M18 6 6 18M6 6l12 12"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="rounded-[30px] border border-slate-200/80 bg-white/96 p-2 shadow-[0_18px_40px_rgba(148,163,184,0.14)] dark:border-slate-700/80 dark:bg-slate-800/96">
            <div className="flex items-end gap-2">
              {branding.reasoningModelAvailable ? (
                <button
                  type="button"
                  className={`mb-1.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 ${
                    useReasoningModel && reasoningOnCooldown
                      ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
                      : useReasoningModel
                        ? "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-300"
                        : "border-transparent text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                  }`}
                  aria-pressed={useReasoningModel}
                  aria-label={
                    useReasoningModel
                      ? "Désactiver le raisonnement approfondi"
                      : "Activer le raisonnement approfondi"
                  }
                  title={
                    reasoningOnCooldown
                      ? `Raisonnement approfondi : disponible dans ${formatCooldown(reasoningCooldownRemainingMs)} (limité à une question toutes les 5 minutes)`
                      : "Raisonnement approfondi : réponses plus lentes et plus posées, limité à une question toutes les 5 minutes"
                  }
                  onClick={() => setUseReasoningModel((value) => !value)}
                >
                  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
                    <path
                      d="M9 18h6M10 21h4M12 3a6 6 0 0 0-6 6c0 2.4 1.2 3.9 2.2 4.9.6.6 1 1.4 1 2.1h5.6c0-.7.4-1.5 1-2.1C16.8 12.9 18 11.4 18 9a6 6 0 0 0-6-6Z"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ) : null}
              {branding.attachmentsLocked ? (
                <button
                  type="button"
                  className="mb-1.5 ml-1 flex h-10 w-10 shrink-0 cursor-not-allowed items-center justify-center rounded-full text-slate-300 opacity-60 dark:text-slate-600"
                  aria-label={attachmentLockedLabel}
                  title={attachmentLockedLabel}
                  disabled
                >
                  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
                    <path
                      d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ) : branding.attachmentsEnabled !== false ? (
                <>
                  <input
                    ref={attachmentInputRef}
                    type="file"
                    accept={attachmentAcceptedExtensions}
                    className="hidden"
                    onChange={handleAttachmentSelect}
                    aria-hidden="true"
                    tabIndex={-1}
                  />
                  <button
                    type="button"
                    className="mb-1.5 ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:opacity-40 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                    aria-label={attachmentHelpLabel}
                    title={attachmentHelpLabel}
                    disabled={attachmentUploading || loading || attachments.length >= attachmentMaxCount}
                    onClick={() => attachmentInputRef.current?.click()}
                  >
                    {attachmentUploading ? (
                      <span
                        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
                        aria-hidden="true"
                      />
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
                        <path
                          d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                </>
              ) : null}
              {dictationSupported ? (
                <button
                  type="button"
                  className={`mb-1.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:opacity-40 ${
                    dictating
                      ? "animate-pulse bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-300"
                      : "text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                  }`}
                  aria-pressed={dictating}
                  aria-label={dictating ? "Arrêter la dictée" : "Dicter la question"}
                  title={
                    dictating
                      ? "Arrêter la dictée"
                      : "Dicter la question (la reconnaissance vocale du navigateur peut passer par un service en ligne)"
                  }
                  disabled={loading}
                  onClick={toggleDictation}
                >
                  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
                    <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              ) : null}
              <textarea
                ref={textareaRef}
                className="message-input min-h-[54px] flex-1 resize-none"
                aria-label="Votre question"
                maxLength={4000}
                placeholder={dictating ? "Parlez, je vous écoute…" : "Écrivez votre question..."}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                rows={1}
              />
              <button
                type={loading ? "button" : "submit"}
                className={`message-send-button ${loading ? "message-stop-button" : ""}`}
                disabled={!loading && !question.trim()}
                onClick={loading ? stopGeneration : undefined}
                aria-label={loading ? "Arrêter la génération" : "Envoyer"}
              >
                {loading ? (
                  <>
                    <span className="h-3 w-3 rounded-[4px] bg-current" aria-hidden="true" />
                    <span className="message-send-label">Stop</span>
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                      <path
                        d="M5 12H19M19 12L13 6M19 12L13 18"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="message-send-label">Envoyer</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {branding.reasoningModelAvailable && (useReasoningModel || reasoningOnCooldown) ? (
            <p className="mt-3 px-1 text-[12px] text-slate-500 dark:text-slate-400">
              {reasoningOnCooldown
                ? `Raisonnement approfondi disponible dans ${formatCooldown(reasoningCooldownRemainingMs)} (une question toutes les 5 minutes).`
                : "Raisonnement approfondi activé : réponses plus lentes et plus posées."}
            </p>
          ) : null}

          {liveEstimate && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[12px] text-slate-500">
              <span>{confidenceLabel(liveEstimate.confidenceScore)}</span>
              <span>~{liveEstimate.userTokenEstimate} saisie</span>
              <span>~{liveEstimate.estimatedPromptTokens} prompt</span>
              <span>~{liveEstimate.estimatedOutputTokens} sortie</span>
              <span>{formatDuration(liveEstimate.estimatedResponseSeconds)}</span>
            </div>
          )}
        </form>
      </section>

      {contextGauge ? (
        <div className="mx-auto flex w-full max-w-xs flex-col items-center gap-1.5 print:hidden" aria-live="polite">
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
            role="meter"
            aria-label="Occupation du contexte du modèle"
            aria-valuemin={0}
            aria-valuemax={contextGauge.window}
            aria-valuenow={contextGauge.used}
          >
            <div
              className={`h-1 rounded-full transition-all duration-300 ${
                contextGauge.percent >= 90 ? "bg-amber-500" : "bg-slate-400 dark:bg-slate-500"
              }`}
              style={{ width: `${contextGauge.percent}%` }}
            />
          </div>
          <p className="text-center text-[11px] text-slate-400 dark:text-slate-500">
            Contexte du modèle : {contextGauge.measured ? "" : "~"}
            {contextGauge.used.toLocaleString("fr-FR")} / {contextGauge.window.toLocaleString("fr-FR")} tokens
            {contextGauge.memoryLabel ? ` · ${contextGauge.memoryLabel}` : ""}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-center gap-3 print:hidden">
        {hasConversationStarted ? (
          <>
            <button className="ghost-button px-3 py-1.5 text-[13px]" type="button" onClick={copyConversation}>
              Copier la conversation
            </button>
            <button className="ghost-button px-3 py-1.5 text-[13px]" type="button" onClick={exportConversation}>
              Exporter (.md)
            </button>
            <button className="ghost-button px-3 py-1.5 text-[13px]" type="button" onClick={printConversation}>
              Imprimer / PDF
            </button>
          </>
        ) : null}
        <button
          className="ghost-button px-3 py-1.5 text-[13px]"
          type="button"
          disabled={loading}
          onClick={clearSession}
          title="Ctrl/⌘ + K"
        >
          Nouvelle conversation
        </button>
      </div>
    </div>
  );
}
