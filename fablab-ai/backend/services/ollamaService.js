import os from "os";
import { getSetting, setSetting } from "../config/db.js";

const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
const defaultThreadCount = Math.max(1, os.availableParallelism?.() || os.cpus().length || 4);

// Le modele d'embedding est masque dans l'admin : la liste est recalculee a chaque appel
// pour suivre un eventuel changement de modele d'embedding sans redemarrage.
function getHiddenModelNames() {
  return new Set([
    getSetting("embeddingModel", process.env.EMBEDDING_MODEL || "nomic-embed-text")
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

function buildOllamaOptions(temperature) {
  const options = {
    num_thread: parseOptionalNumber(process.env.OLLAMA_NUM_THREAD) || defaultThreadCount,
    temperature
  };

  const configuredGpuCount = parseOptionalNumber(process.env.OLLAMA_NUM_GPU);
  const configuredContextSize = parseOptionalNumber(process.env.OLLAMA_NUM_CTX);

  if (configuredGpuCount !== null) {
    options.num_gpu = configuredGpuCount;
  }

  if (configuredContextSize !== null) {
    options.num_ctx = configuredContextSize;
  }

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
  const fallbackModels = await resolveFallbackModels(primaryModel);
  const candidates = [primaryModel, ...fallbackModels];
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const result = await executor(candidate);
      return {
        ...result,
        modelUsed: candidate,
        usedFallbackModel: candidate !== primaryModel,
        fallbackReason: candidate !== primaryModel ? "automatic-fallback" : null
      };
    } catch (error) {
      lastError = error;

      if (candidate === primaryModel && !isInsufficientMemoryError(error) && !isModelUnavailableError(error)) {
        throw error;
      }

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
  const response = await fetch(`${ollamaUrl}/api/tags`);
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
        options: buildOllamaOptions(0.2)
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
  { onToken } = {}
) {
  return executeWithModelFallback(model, async (resolvedModel) => {
    const response = await ollamaRequest(
      "/api/chat",
      {
        model: resolvedModel,
        messages: normalizeChatMessages(messages),
        stream: true,
        keep_alive: getKeepAliveValue(),
        options: buildOllamaOptions(Number(process.env.OLLAMA_TEMPERATURE || 0.3))
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
      payload: finalPayload
    };
  });
}

export async function generateChatAnswer({ model = getActiveModel(), messages, signal }) {
  return executeWithModelFallback(model, async (resolvedModel) => {
    const response = await ollamaRequest(
      "/api/chat",
      {
        model: resolvedModel,
        messages: normalizeChatMessages(messages),
        stream: false,
        keep_alive: getKeepAliveValue(),
        options: buildOllamaOptions(Number(process.env.OLLAMA_TEMPERATURE || 0.3))
      },
      { signal }
    );

    const payload = await response.json();

    return {
      text: payload?.message?.content || "",
      payload
    };
  });
}
