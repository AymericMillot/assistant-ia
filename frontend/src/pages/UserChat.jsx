import { useEffect, useRef, useState } from "react";
import { fetchJson, formatDuration } from "../lib/api";
import { reportError } from "../lib/errors";
import { consumeSseResponse } from "../lib/streaming";
import ActionTooltip from "../components/ui/ActionTooltip";
import InfoPopover from "../components/ui/InfoPopover";
import { useBranding } from "../hooks/useBranding";

const conversationMemoryLimit = 10;
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

const defaultMessages = [
];

const attachmentAcceptedExtensions = ".txt,.text,.md,.markdown,.csv,.log,.pdf";
const attachmentHelpLabel = "Joindre un fichier texte ou PDF (txt, md, csv, log, pdf — 2 Mo max)";
const attachmentLockedLabel =
  "Ajout de pièces jointes temporairement indisponible (maintenance technique et sécurité).";
const attachmentMaxCount = 3;

export default function UserChat() {
  const branding = useBranding();
  // Mémoire de conversation strictement en RAM : elle disparait au rechargement de la page.
  const [messages, setMessages] = useState(defaultMessages);
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
  const hasConversationStarted = messages.length > 0;

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
    const timer = window.setTimeout(() => {
      fetchJson("/api/chat/estimate", {
        method: "POST",
        body: JSON.stringify({
          question,
          useReasoningModel: willUseReasoningModel
        })
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
          "L'envoi de la pièce jointe a échoué. Vérifiez qu'il s'agit d'un fichier texte ou PDF de moins de 2 Mo."
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

  async function askQuestion(questionText, { baseMessages = messages, attachmentIds = [] } = {}) {
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

    const payload = {
      clientId: clientIdRef.current,
      sessionId: sessionIdRef.current,
      messages: buildConversationMemory(baseMessages, trimmedQuestion),
      attachmentIds,
      useReasoningModel: isReasoningRequest
    };

    setQuestion("");
    setAttachments([]);

    try {
      const requestController = new AbortController();
      activeRequestControllerRef.current = requestController;
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
          setContextSummary(payload);
        },
        thinking: ({ token }) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    thinking: `${message.thinking || ""}${token}`,
                    isThinking: true,
                    streamState: "generating"
                  }
                : message
            )
          );
        },
        token: ({ token }) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    content: `${message.content}${token}`,
                    // La reponse finale a commence a arriver : la reflexion (si il y en
                    // avait une) est terminee, elle peut se replier dans le menu deroulant.
                    isThinking: false,
                    streamState: "generating"
                  }
                : message
            )
          );
        },
        sources: ({ sources }) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId ? { ...message, sources } : message
            )
          );
        },
        error: ({ message }) => {
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
        done: ({ text, metrics, grounding, exchangeId, conversationId }) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    content: text || message.content || "",
                    isThinking: false,
                    grounding,
                    metrics,
                    exchangeId: exchangeId || null,
                    conversationId: conversationId || null,
                    streamState: null
                  }
                : message
            )
          );
        },
        stopped: ({ message }) => {
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
      if (requestError.name === "AbortError" && stopRequestedRef.current) {
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
      activeRequestControllerRef.current = null;
      activeAssistantMessageIdRef.current = null;
      stopRequestedRef.current = false;
      setLoading(false);
    }
  }

  function submitQuestion(event) {
    event.preventDefault();
    askQuestion(question, {
      baseMessages: messages,
      attachmentIds: attachments.map((entry) => entry.id)
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

  function buildFollowUpSuggestions(message) {
    if (!message.sources || message.sources.length === 0) {
      return [];
    }

    return uniqueSources(message.sources)
      .slice(0, 2)
      .map((source) => `Peux-tu m'en dire plus sur ${source.fileName} ?`);
  }

  function askFollowUpQuestion(text) {
    if (loading) {
      return;
    }
    askQuestion(text, { baseMessages: messages, attachmentIds: [] });
  }

  async function stopGeneration() {
    if (!loading) {
      return;
    }

    stopRequestedRef.current = true;
    setError("");

    try {
      await fetchJson("/api/chat/cancel", {
        method: "POST",
        body: JSON.stringify({ clientId: clientIdRef.current })
      });
    } catch (_error) {
      // L'annulation réseau locale reste prioritaire même si l'API de stop ne répond pas.
    }

    activeRequestControllerRef.current?.abort();
    setLoading(false);
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

  function clearSession() {
    // Nouvelle conversation : la mémoire RAM est vidée immédiatement.
    setMessages(defaultMessages);
    setQuestion("");
    setError("");
    setCopyStatusMessage("");
    setLiveEstimate(null);
    setAttachments([]);
    setContextSummary(null);
    sessionIdRef.current = createRuntimeId();
  }

  function handleComposerKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitQuestion(event);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[112rem] flex-col gap-4">
      <section className="panel mx-auto flex min-h-[76vh] w-full max-w-[112rem] flex-col overflow-hidden">
        <div className="border-b border-slate-200/70 bg-white/65 px-6 py-5 backdrop-blur-xl sm:px-8 dark:border-slate-700/70 dark:bg-slate-900/65">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-[-0.03em] text-slate-950 dark:text-slate-50">
                Conversation
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Entrée pour envoyer, maj + entrée pour aller à la ligne. Par confidentialité, la
                conversation n&apos;est pas conservée : tout s&apos;efface au rechargement de la page.
              </p>
            </div>
          </div>
        </div>

        <div className="chat-stage flex-1 space-y-4 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
          {messages.map((message, messageIndex) => {
            const { disclaimer, rest } = splitAiDisclaimer(message.content);

            return (
            <article
              key={message.id}
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
                          onClick={() => handleSourceDownload(source)}
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
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <div className="inline-flex items-center gap-0.5 rounded-full border border-slate-200 bg-slate-50/80 p-1 dark:border-slate-700 dark:bg-slate-800/60">
                      <ActionTooltip label={message.copyState === "copied" ? "Copié !" : "Copier"}>
                        <button
                          type="button"
                          className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition hover:bg-white hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
                          aria-label={message.copyState === "copied" ? "Réponse copiée" : "Copier la réponse"}
                          onClick={() => copyMessageContent(message)}
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

                      {messageIndex === messages.length - 1 ? (
                        <ActionTooltip label="Régénérer">
                          <button
                            type="button"
                            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition hover:bg-white hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
                            disabled={loading}
                            aria-label="Régénérer la réponse"
                            onClick={() => regenerateAnswer(message)}
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
                              onClick={() => rateAnswer(message, "up")}
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
                              onClick={() => rateAnswer(message, "down")}
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

                {message.role === "assistant" &&
                  message.content &&
                  !message.streamState &&
                  messageIndex === messages.length - 1 &&
                  buildFollowUpSuggestions(message).length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {buildFollowUpSuggestions(message).map((suggestion) => (
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
              </div>
            </article>
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

        <form className="sticky bottom-0 border-t border-slate-100 bg-white/78 px-4 py-4 backdrop-blur-xl sm:px-6 sm:py-5 lg:px-8 dark:border-slate-800 dark:bg-slate-900/78" onSubmit={submitQuestion}>
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
            </div>
          )}

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
              <textarea
                ref={textareaRef}
                className="message-input min-h-[54px] flex-1 resize-none"
                placeholder="Écrivez votre question..."
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

      {contextSummary && contextSummary.modelContextWindow > 0 ? (
        <div className="mx-auto flex w-full max-w-xs flex-col items-center gap-1.5" aria-live="polite">
          <div className="h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div
              className="h-1 rounded-full bg-slate-400 transition-all duration-300 dark:bg-slate-500"
              style={{
                width: `${Math.min(
                  100,
                  Math.round(
                    (Math.round(contextSummary.characters / 4) / contextSummary.modelContextWindow) * 100
                  )
                )}%`
              }}
            />
          </div>
          <p className="text-[11px] text-slate-400 dark:text-slate-500">
            Contexte du modèle : ~{Math.round(contextSummary.characters / 4).toLocaleString("fr-FR")} /{" "}
            {contextSummary.modelContextWindow.toLocaleString("fr-FR")} tokens utilisés
          </p>
        </div>
      ) : null}

      <div className="flex justify-center gap-3">
        {hasConversationStarted ? (
          <button
            className="ghost-button px-3 py-1.5 text-[13px]"
            type="button"
            onClick={copyConversation}
          >
            Copier la conversation
          </button>
        ) : null}
        <button className="ghost-button px-3 py-1.5 text-[13px]" type="button" onClick={clearSession}>
          Vider la mémoire
        </button>
      </div>
    </div>
  );
}
