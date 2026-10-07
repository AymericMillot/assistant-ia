import os from "os";
import { getSetting, setSetting } from "../config/db.js";
import { computeEffectiveContextWindow, computeKvBytesPerToken } from "./contextBudget.js";

const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
const defaultThreadCount = Math.max(1, os.availableParallelism?.() || os.cpus().length || 4);

// La taille de contexte reelle d'un modele ne change qu'en cas de changement de modele/Modelfile :
// un cache court evite d'appeler /api/show a chaque message tout en restant a jour rapidement
// (6h en cas de succes, 1min en cas d'echec pour reessayer vite sans marteler Ollama).
const modelContextLengthCacheTtlMs = 6 * 60 * 60 * 1000;
const modelContextLengthFailureCacheTtlMs = 60 * 1000;
const modelProfileCache = new Map();
// Appels de metadonnees (/api/tags, /api/show) : une instance Ollama figee ne
// doit pas bloquer indefiniment une question ou une page d'administration.
const metadataRequestTimeoutMs = Math.max(1000, Number(process.env.OLLAMA_METADATA_TIMEOUT_MS || 15000));

// Le modele d'embedding est masque dans l'admin : la liste est recalculee a chaque appel
// pour suivre un eventuel changement de modele d'embedding sans redemarrage.
function getHiddenModelNames() {
  return new Set([
    getSetting("embeddingModel", process.env.EMBEDDING_MODEL || "nomic-embed-text-v2-moe:latest")
  ]);
}

// Un flux Ollama peut contenir une ligne tronquee ou corrompue : on l'ignore
// au lieu d'interrompre toute la generation.
function parseStreamLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseFallbackModelNames() {
  const configured = String(
    process.env.OLLAMA_FALLBACK_MODELS ||
      process.env.OLLAMA_FALLBACK_MODEL ||
      ""
  )
    .split(",")
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);

  return [...new Set(configured)];
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getKeepAliveValue() {
  const keepAlive = String(process.env.OLLAMA_KEEP_ALIVE || "24h").trim();
  if (!keepAlive) {
    return "24h";
  }

  if (keepAlive === "-1") {
    return "24h";
  }

  if (/^\d+$/.test(keepAlive)) {
    return `${keepAlive}m`;
  }

  return keepAlive;
}

// Memoire que le cache KV d'un modele peut occuper : une part de la RAM de
// l'hote, moins le poids du modele lui-meme et une marge pour le systeme.
// OLLAMA_MEMORY_BUDGET_GB permet de la fixer explicitement (ex: GPU dedie).
function computeKvMemoryBudgetBytes(modelSizeBytes) {
  const configuredGb = parseOptionalNumber(process.env.OLLAMA_MEMORY_BUDGET_GB);
  const gib = 1024 ** 3;
  const totalBudget = configuredGb !== null ? configuredGb * gib : os.totalmem() * 0.6;
  return Math.max(512 * 1024 ** 2, totalBudget - Number(modelSizeBytes || 0) - gib);
}

async function getInstalledModelSize(modelName) {
  try {
    const models = await listModels();
    const normalizedName = modelName.includes(":") ? modelName : `${modelName}:latest`;
    return Number(models.find((model) => model.name === normalizedName || model.name === modelName)?.size || 0);
  } catch {
    return 0;
  }
}

/**
 * Profil d'un modele, deduit de ses metadonnees reelles (/api/show) :
 *   - maxContext : fenetre maximale supportee par le modele ;
 *   - contextWindow : fenetre effectivement demandee a Ollama (num_ctx), stable
 *     pour ce modele, bornee par OLLAMA_NUM_CTX, la memoire disponible pour le
 *     cache KV et OLLAMA_AUTO_CTX_MAX ;
 *   - capabilities : capacites declarees ("completion", "vision", "thinking"...),
 *     null si la version d'Ollama ne les publie pas.
 * La cle de contexte varie selon l'architecture ("llama.context_length",
 * "gemma3.context_length", ...) : elle est cherchee dynamiquement.
 */
export async function getModelProfile(modelName) {
  const normalizedName = String(modelName || "").trim();
  if (!normalizedName) {
    return null;
  }

  const cached = modelProfileCache.get(normalizedName);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let value;
  let ttl = modelContextLengthCacheTtlMs;

  try {
    const response = await ollamaRequest(
      "/api/show",
      { model: normalizedName, name: normalizedName },
      { signal: AbortSignal.timeout(metadataRequestTimeoutMs) }
    );
    const payload = await response.json();
    const modelInfo = payload?.model_info || {};
    const contextLengthKey = Object.keys(modelInfo).find((key) => key.endsWith(".context_length"));
    const contextLength = contextLengthKey ? Number(modelInfo[contextLengthKey]) : NaN;
    const maxContext = Number.isFinite(contextLength) && contextLength > 0 ? contextLength : null;
    const kvBytesPerToken = computeKvBytesPerToken(modelInfo, {
      kvCacheType: process.env.OLLAMA_KV_CACHE_TYPE
    });
    const modelSizeBytes = await getInstalledModelSize(normalizedName);

    value = {
      name: normalizedName,
      maxContext,
      kvBytesPerToken,
      modelSizeBytes,
      capabilities: Array.isArray(payload?.capabilities) ? payload.capabilities : null,
      family: String(payload?.details?.family || ""),
      contextWindow: computeEffectiveContextWindow({
        modelMaxContext: maxContext,
        configuredContext: parseOptionalNumber(process.env.OLLAMA_NUM_CTX),
        autoCeiling: parseOptionalNumber(process.env.OLLAMA_AUTO_CTX_MAX) || undefined,
        kvBytesPerToken,
        kvMemoryBudgetBytes: computeKvMemoryBudgetBytes(modelSizeBytes)
      })
    };
  } catch {
    // Ollama injoignable ou modele inconnu : profil prudent, reessaye vite.
    ttl = modelContextLengthFailureCacheTtlMs;
    const configuredContext = parseOptionalNumber(process.env.OLLAMA_NUM_CTX);
    value = {
      name: normalizedName,
      maxContext: null,
      kvBytesPerToken: null,
      modelSizeBytes: 0,
      capabilities: null,
      family: "",
      contextWindow: computeEffectiveContextWindow({ configuredContext }),
      unavailable: true
    };
  }

  modelProfileCache.set(normalizedName, { value, expiresAt: Date.now() + ttl });
  return value;
}

// Fenetre maximale du modele (affichee dans l'admin).
export async function getModelContextLength(modelName) {
  const profile = await getModelProfile(modelName);
  return profile?.maxContext ?? null;
}

// Fenetre effectivement utilisee pour ce modele (num_ctx envoye a Ollama).
export async function getEffectiveContextWindow(modelName) {
  const profile = await getModelProfile(modelName);
  return profile?.contextWindow ?? computeEffectiveContextWindow({});
}

/**
 * Le modele sait-il lire des images ? Si Ollama ne publie pas les capacites
 * (versions anciennes), on se fie au nom du modele.
 */
export async function modelSupportsVision(modelName) {
  const profile = await getModelProfile(modelName);
  if (!profile || profile.unavailable) {
    return false;
  }

  if (Array.isArray(profile.capabilities)) {
    return profile.capabilities.includes("vision");
  }

  return /(llava|vision|-vl|vl:|bakllava|moondream|minicpm-v|gemma3|qwen2\.5vl|qwen3-vl|mistral-small3\.[12]|granite3\.2-vision|llama4)/i.test(
    profile.name
  );
}

async function modelSupportsThinking(modelName) {
  const profile = await getModelProfile(modelName);
  return Array.isArray(profile?.capabilities) && profile.capabilities.includes("thinking");
}

async function buildOllamaOptions(temperature, modelName, { numCtx = null } = {}) {
  const options = {
    num_thread: parseOptionalNumber(process.env.OLLAMA_NUM_THREAD) || defaultThreadCount,
    temperature
  };

  const configuredGpuCount = parseOptionalNumber(process.env.OLLAMA_NUM_GPU);
  if (configuredGpuCount !== null) {
    options.num_gpu = configuredGpuCount;
  }

  // Fenetre stable par modele (voir getModelProfile) : une valeur differente
  // d'une requete a l'autre obligerait Ollama a recharger le modele.
  options.num_ctx = numCtx || (await getEffectiveContextWindow(modelName));

  return options;
}

function isInsufficientMemoryError(error) {
  const message = String(error?.message || "");
  return /requires more system memory|system memory.*available|insufficient memory/i.test(message);
}

function isModelUnavailableError(error) {
  const message = String(error?.message || "");
  return /model .* not found|pull it first|unknown model|not enough memory to allocate|does not exist/i.test(
    message
  );
}

async function resolveFallbackModels(primaryModel) {
  const installedModels = await listModels();
  const installedModelNames = new Set(installedModels.map((model) => model.name));
  const configuredFallbacks = parseFallbackModelNames().filter((modelName) => modelName !== primaryModel);
  const orderedCandidates = [];
  const seen = new Set([primaryModel]);

  for (const candidate of configuredFallbacks) {
    if (!installedModelNames.has(candidate) || isHiddenModel(candidate) || seen.has(candidate)) {
      continue;
    }

    orderedCandidates.push(candidate);
    seen.add(candidate);
  }

  const sortedVisibleAlternatives = installedModels
    .filter((model) => !isHiddenModel(model.name))
    .filter((model) => model.name !== primaryModel)
    .sort((left, right) => Number(left.size || Number.MAX_SAFE_INTEGER) - Number(right.size || Number.MAX_SAFE_INTEGER));

  for (const model of sortedVisibleAlternatives) {
    if (seen.has(model.name)) {
      continue;
    }

    orderedCandidates.push(model.name);
    seen.add(model.name);
  }

  return orderedCandidates;
}

async function executeWithModelFallback(primaryModel, executor) {
  let lastError = null;

  try {
    const result = await executor(primaryModel);
    return {
      ...result,
      modelUsed: primaryModel,
      usedFallbackModel: false,
      fallbackReason: null
    };
  } catch (error) {
    if (!isInsufficientMemoryError(error) && !isModelUnavailableError(error)) {
      throw error;
    }
    lastError = error;
  }

  // Les modeles de secours ne sont recherches (GET /api/tags) qu'en cas d'echec
  // du modele principal : auparavant chaque generation commencait par lister
  // tous les modeles, et une erreur de cette liste empechait meme de repondre.
  const fallbackModels = await resolveFallbackModels(primaryModel).catch(() => []);

  for (const candidate of fallbackModels) {
    try {
      const result = await executor(candidate);
      return {
        ...result,
        modelUsed: candidate,
        usedFallbackModel: true,
        fallbackReason: "automatic-fallback"
      };
    } catch (error) {
      lastError = error;

      if (!isInsufficientMemoryError(error) && !isModelUnavailableError(error)) {
        throw error;
      }
    }
  }

  if (lastError && (isInsufficientMemoryError(lastError) || isModelUnavailableError(lastError))) {
    throw new Error(
      "Aucun modele Ollama disponible ne peut repondre pour le moment avec la memoire actuelle. Un modele de secours plus leger doit etre installe ou active."
    );
  }

  throw lastError || new Error("Aucun modele Ollama disponible.");
}

async function ollamaRequest(endpoint, payload, options = {}) {
  const response = await fetch(`${ollamaUrl}${endpoint}`, {
    method: options.method || "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: options.signal
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama a retourne une erreur (${response.status}) : ${body}`);
  }

  return response;
}

export async function listModels() {
  const response = await fetch(`${ollamaUrl}/api/tags`, {
    signal: AbortSignal.timeout(metadataRequestTimeoutMs)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Impossible de recuperer les modeles Ollama : ${body}`);
  }

  const payload = await response.json();
  return (payload.models || []).map((model) => ({
    name: model.name,
    size: model.size,
    modifiedAt: model.modified_at,
    digest: model.digest
  }));
}

export function isHiddenModel(modelName) {
  const normalizedName = String(modelName || "").trim();
  if (!normalizedName) {
    return false;
  }

  const hiddenModelNames = getHiddenModelNames();

  if (hiddenModelNames.has(normalizedName)) {
    return true;
  }

  if (normalizedName.endsWith(":latest")) {
    return hiddenModelNames.has(normalizedName.slice(0, -":latest".length));
  }

  return hiddenModelNames.has(`${normalizedName}:latest`);
}

export async function listVisibleModels() {
  const models = await listModels();
  return models.filter((model) => !isHiddenModel(model.name));
}

export function getActiveModel() {
  return getSetting("activeModel", process.env.DEFAULT_MODEL || "gemma2:2b");
}

export function setActiveModel(modelName) {
  setSetting("activeModel", modelName);
}

const modelRoleSettingKeys = {
  image: "activeImageModel",
  reasoning: "activeReasoningModel"
};

// Le role "text" reste alias de activeModel (compatibilite ascendante) ;
// image/raisonnement sont optionnels et vides tant qu'ils ne sont pas configures.
export function getActiveModelByRole(role) {
  const settingKey = modelRoleSettingKeys[role];
  if (!settingKey) {
    return getActiveModel();
  }

  return getSetting(settingKey, "") || "";
}

export function setActiveModelByRole(role, modelName) {
  const settingKey = modelRoleSettingKeys[role];
  if (!settingKey) {
    setActiveModel(modelName);
    return;
  }

  setSetting(settingKey, modelName);
}

export async function deleteModel(modelName) {
  await ollamaRequest(
    "/api/delete",
    { model: modelName },
    {
      method: "DELETE"
    }
  );
}

export async function pullModel(modelName, { onProgress, signal } = {}) {
  const response = await ollamaRequest(
    "/api/pull",
    {
      name: modelName,
      stream: true
    },
    { signal }
  );

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastPayload = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const payload = parseStreamLine(line);
      if (!payload) {
        continue;
      }

      lastPayload = payload;
      if (onProgress) {
        onProgress(payload);
      }
    }
  }

  return lastPayload;
}

export async function streamGeneratedAnswer(
  { model = getActiveModel(), prompt, context, signal },
  { onToken } = {}
) {
  return executeWithModelFallback(model, async (resolvedModel) => {
    const response = await ollamaRequest(
      "/api/generate",
      {
        model: resolvedModel,
        prompt,
        system: systemPrompt,
        context,
        stream: true,
        keep_alive: getKeepAliveValue(),
        options: await buildOllamaOptions(0.2, resolvedModel)
      },
      { signal }
    );

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalPayload = null;
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const payload = parseStreamLine(line);
        if (!payload) {
          continue;
        }

        finalPayload = payload;

        if (payload.response) {
          fullText += payload.response;
          if (onToken) {
            onToken(payload.response);
          }
        }
      }
    }

    return {
      text: fullText,
      payload: finalPayload
    };
  });
}

function normalizeChatMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && typeof message === "object")
    .filter((message) => ["system", "user", "assistant"].includes(message.role))
    .map((message) => ({
      role: message.role,
      content: String(message.content || "")
    }))
    .filter((message) => message.content.trim().length > 0);
}

export async function streamChatAnswer(
  { model = getActiveModel(), messages, signal },
  { onToken, onThinkingToken } = {}
) {
  return executeWithModelFallback(model, async (resolvedModel) => {
    const response = await ollamaRequest(
      "/api/chat",
      {
        model: resolvedModel,
        messages: normalizeChatMessages(messages),
        stream: true,
        keep_alive: getKeepAliveValue(),
        options: await buildOllamaOptions(Number(process.env.OLLAMA_TEMPERATURE || 0.3), resolvedModel)
      },
      { signal }
    );

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalPayload = null;
    let fullText = "";
    let fullThinking = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const payload = parseStreamLine(line);
        if (!payload) {
          continue;
        }

        finalPayload = payload;

        // Les modeles "raisonneurs" (ex: deepseek-r1) renvoient leur reflexion dans
        // message.thinking, distinct de message.content (la reponse finale) : Ollama
        // les separe deja nativement, pas besoin de parser des balises <think> ici.
        const thinkingToken = payload?.message?.thinking || "";
        if (thinkingToken) {
          fullThinking += thinkingToken;
          if (onThinkingToken) {
            onThinkingToken(thinkingToken);
          }
        }

        const token = payload?.message?.content || "";
        if (token) {
          fullText += token;
          if (onToken) {
            onToken(token);
          }
        }
      }
    }

    return {
      text: fullText,
      thinking: fullThinking,
      payload: finalPayload
    };
  });
}

export async function generateChatAnswer({
  model = getActiveModel(),
  messages,
  signal,
  maxTokens = null,
  disableThinking = false
}) {
  return executeWithModelFallback(model, async (resolvedModel) => {
    const options = await buildOllamaOptions(Number(process.env.OLLAMA_TEMPERATURE || 0.3), resolvedModel);
    // num_predict ne fait pas recharger le modele (contrairement a num_ctx).
    if (Number(maxTokens) > 0) {
      options.num_predict = Math.round(Number(maxTokens));
    }

    const body = {
      model: resolvedModel,
      messages: normalizeChatMessages(messages),
      stream: false,
      keep_alive: getKeepAliveValue(),
      options
    };
    // Taches utilitaires (reformulations...) : un modele "raisonneur" passerait
    // l'essentiel du temps a reflechir. "think" n'est envoye qu'aux modeles qui
    // declarent cette capacite, les autres le refuseraient.
    if (disableThinking && (await modelSupportsThinking(resolvedModel))) {
      body.think = false;
    }

    const response = await ollamaRequest("/api/chat", body, { signal });

    const payload = await response.json();

    return {
      text: payload?.message?.content || "",
      payload
    };
  });
}

/**
 * Analyse d'une image par un modele de vision (indexation des PDF illustres).
 * Pas de repli automatique vers un autre modele : un modele texte ne saurait
 * pas lire l'image et produirait une description inventee.
 * keep_alive court : le modele de vision libere la memoire peu apres la fin de
 * l'indexation au lieu de rester charge a cote du modele de conversation.
 */
export async function describeImage({ model, system, prompt, imageBase64, signal, numCtx = null }) {
  const profile = await getModelProfile(model);
  // Une image represente plusieurs centaines a plus d'un millier de tokens :
  // fenetre d'au moins 8k si le modele le permet.
  const contextWindow =
    numCtx ||
    Math.min(Math.max(profile?.contextWindow || 4096, 8192), profile?.maxContext || 8192);

  const response = await ollamaRequest(
    "/api/chat",
    {
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt, images: [imageBase64] }
      ],
      stream: false,
      keep_alive: process.env.OLLAMA_VISION_KEEP_ALIVE || "5m",
      options: await buildOllamaOptions(0.1, model, { numCtx: contextWindow })
    },
    { signal }
  );

  const payload = await response.json();
  return {
    text: String(payload?.message?.content || "").trim(),
    payload
  };
}
