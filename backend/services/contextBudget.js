// Budget de contexte et memoire de conversation, independants du modele.
//
// Chaque modele Ollama a sa propre fenetre de contexte (2k a 128k tokens) et un
// cout memoire different par token (cache KV). Ce module, volontairement pur
// (aucun acces a Ollama ni a la base), calcule :
//   - la fenetre effective a demander a Ollama pour un modele donne ;
//   - la repartition de cette fenetre entre consignes, documents, pieces
//     jointes, historique et reponse ;
//   - la memoire de conversation : derniers echanges mot pour mot, echanges plus
//     anciens condenses plutot qu'oublies.

// Estimation prudente pour du francais : les tokenizers courants (Llama, Gemma,
// Qwen, Mistral) produisent environ 3,3 a 4 caracteres par token. Sous-estimer
// le ratio surestime les tokens, ce qui protege de la troncature silencieuse
// d'Ollama (qui coupe le debut du prompt, donc les consignes).
export const DEFAULT_CHARS_PER_TOKEN = 3.2;

// Surcout fixe par message (balises de role du template de chat).
const MESSAGE_OVERHEAD_TOKENS = 6;

const CONTEXT_FLOOR = 2048;
const CONTEXT_GRANULARITY = 1024;
const DEFAULT_UNKNOWN_CONTEXT = 8192;
const DEFAULT_AUTO_CONTEXT_CEILING = 32768;

export const TRIMMABLE_KINDS = new Set(["examples", "rag", "attachment", "history", "memory"]);

export function estimateTokens(text, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  const length = String(text || "").length;
  if (length === 0) {
    return 0;
  }

  return Math.ceil(length / Math.max(1, charsPerToken));
}

export function estimateMessageTokens(message, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  return estimateTokens(message?.content, charsPerToken) + MESSAGE_OVERHEAD_TOKENS;
}

export function estimateMessagesTokens(messages = [], charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  return messages.reduce((total, message) => total + estimateMessageTokens(message, charsPerToken), 0);
}

function firstNumber(value) {
  if (Array.isArray(value)) {
    // Certains modeles (ex: architectures hybrides) declarent une valeur par
    // couche : le maximum donne une borne haute sure.
    const numbers = value.map(Number).filter((entry) => Number.isFinite(entry) && entry > 0);
    return numbers.length > 0 ? Math.max(...numbers) : NaN;
  }

  return Number(value);
}

function findModelInfoValue(modelInfo, suffix) {
  const key = Object.keys(modelInfo || {}).find((entry) => entry.endsWith(suffix));
  return key ? firstNumber(modelInfo[key]) : NaN;
}

/**
 * Cout memoire du cache KV par token de contexte, deduit des metadonnees du
 * modele (/api/show -> model_info). Renvoie null si l'architecture ne publie
 * pas les informations necessaires.
 */
export function computeKvBytesPerToken(modelInfo = {}, { kvCacheType = "f16" } = {}) {
  const blockCount = findModelInfoValue(modelInfo, ".block_count");
  const headCount = findModelInfoValue(modelInfo, ".attention.head_count");
  let headCountKv = findModelInfoValue(modelInfo, ".attention.head_count_kv");
  const embeddingLength = findModelInfoValue(modelInfo, ".embedding_length");
  let keyLength = findModelInfoValue(modelInfo, ".attention.key_length");
  let valueLength = findModelInfoValue(modelInfo, ".attention.value_length");

  if (!Number.isFinite(headCountKv) || headCountKv <= 0) {
    headCountKv = headCount;
  }

  const fallbackHeadDim =
    Number.isFinite(embeddingLength) && Number.isFinite(headCount) && headCount > 0
      ? embeddingLength / headCount
      : NaN;
  if (!Number.isFinite(keyLength) || keyLength <= 0) {
    keyLength = fallbackHeadDim;
  }
  if (!Number.isFinite(valueLength) || valueLength <= 0) {
    valueLength = keyLength;
  }

  if (![blockCount, headCountKv, keyLength, valueLength].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }

  const bytesPerValue = { q8_0: 1, q4_0: 0.5 }[String(kvCacheType || "").toLowerCase()] || 2;
  return Math.ceil(blockCount * headCountKv * (keyLength + valueLength) * bytesPerValue);
}

/**
 * Fenetre de contexte effective (num_ctx) pour un modele. Toujours stable pour
 * un meme modele : changer num_ctx d'une requete a l'autre force Ollama a
 * recharger le modele.
 *
 * Ordre de decision :
 *   1. jamais au-dela du maximum du modele ;
 *   2. OLLAMA_NUM_CTX (plafond explicite de l'administrateur) s'il est defini ;
 *   3. sinon, plafond automatique : memoire disponible pour le cache KV et
 *      plafond de confort (au-dela, le traitement du prompt devient lent sur
 *      CPU sans apporter grand-chose a un assistant documentaire).
 */
export function computeEffectiveContextWindow({
  modelMaxContext = null,
  configuredContext = null,
  autoCeiling = DEFAULT_AUTO_CONTEXT_CEILING,
  kvBytesPerToken = null,
  kvMemoryBudgetBytes = null
} = {}) {
  const modelMax = Number(modelMaxContext) > 0 ? Number(modelMaxContext) : null;
  const explicit = Number(configuredContext) > 0 ? Number(configuredContext) : null;

  if (explicit) {
    return Math.max(256, modelMax ? Math.min(explicit, modelMax) : explicit);
  }

  let candidate = modelMax || DEFAULT_UNKNOWN_CONTEXT;
  candidate = Math.min(candidate, Number(autoCeiling) > 0 ? Number(autoCeiling) : DEFAULT_AUTO_CONTEXT_CEILING);

  if (Number(kvBytesPerToken) > 0 && Number(kvMemoryBudgetBytes) > 0) {
    candidate = Math.min(candidate, Math.floor(Number(kvMemoryBudgetBytes) / Number(kvBytesPerToken)));
  }

  candidate = Math.floor(candidate / CONTEXT_GRANULARITY) * CONTEXT_GRANULARITY;
  const floor = modelMax ? Math.min(CONTEXT_FLOOR, modelMax) : CONTEXT_FLOOR;
  return Math.max(floor, candidate);
}

/**
 * Part de la fenetre reservee a la reponse : les modeles de raisonnement
 * ecrivent leur reflexion dans la meme fenetre, ils ont besoin de plus.
 */
export function planPromptBudget({ contextWindow, isReasoning = false } = {}) {
  const window = Math.max(1024, Number(contextWindow) || DEFAULT_UNKNOWN_CONTEXT);
  const outputShare = isReasoning ? 0.35 : 0.2;
  const outputCap = isReasoning ? 8192 : 2048;
  const outputReserve = Math.max(256, Math.min(outputCap, Math.round(window * outputShare)));
  // Marge de securite : l'estimation des tokens reste approximative.
  const safetyMargin = Math.max(64, Math.round(window * 0.04));

  return {
    contextWindow: window,
    outputReserve,
    inputBudget: Math.max(256, window - outputReserve - safetyMargin)
  };
}

/**
 * Coupe un texte pour qu'il tienne en `maxTokens`, en privilegiant une coupure
 * propre (paragraphe, ligne, phrase). Les blocs [DOC n] / [RÈGLE n] etant
 * separes par une ligne vide, une coupure au paragraphe garde des extraits
 * entiers.
 */
export function truncateToTokens(text, maxTokens, charsPerToken = DEFAULT_CHARS_PER_TOKEN, { marker = "\n[…]" } = {}) {
  const value = String(text || "");
  const maxCharacters = Math.floor(Math.max(0, maxTokens) * charsPerToken);

  if (value.length <= maxCharacters) {
    return value;
  }

  if (maxCharacters < 40) {
    return "";
  }

  const slice = value.slice(0, maxCharacters - marker.length);
  const minimumKeep = slice.length * 0.5;
  // Par ordre de preference : fin de bloc, fin de ligne, fin de phrase.
  const cut =
    [slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(". ") + 1].find(
      (index) => index >= minimumKeep
    ) ?? slice.length;
  return `${slice.slice(0, cut).trimEnd()}${marker}`;
}

function clip(text, maxCharacters) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > maxCharacters ? `${value.slice(0, maxCharacters - 1).trimEnd()}…` : value;
}

/**
 * Regroupe l'historique en echanges (question + reponse) en conservant l'ordre.
 */
export function groupHistoryIntoExchanges(history = []) {
  const exchanges = [];
  let current = null;

  for (const entry of history) {
    if (!entry?.content || (entry.role !== "user" && entry.role !== "assistant")) {
      continue;
    }

    if (entry.role === "user" || !current) {
      current = { user: null, assistant: null };
      exchanges.push(current);
    }

    if (entry.role === "user") {
      current.user = entry.content;
    } else {
      current.assistant = current.assistant ? `${current.assistant}\n${entry.content}` : entry.content;
    }
  }

  return exchanges;
}

/**
 * Memoire condensee des echanges anciens : chaque echange tient sur deux lignes
 * (question complete ou presque, debut de la reponse). Extractif et sans appel
 * au modele : instantane et sans risque d'invention.
 */
export function buildCondensedMemory(exchanges = [], { maxTokens, charsPerToken = DEFAULT_CHARS_PER_TOKEN } = {}) {
  if (exchanges.length === 0 || maxTokens <= 0) {
    return { content: "", exchangeCount: 0 };
  }

  const header =
    "Memoire de la conversation : resume des echanges plus anciens avec cet utilisateur (du plus ancien au plus recent). " +
    "Sers-t'en quand la question y fait reference (informations donnees par l'utilisateur, sujets deja traites, reponses precedentes).";
  const lines = exchanges.map((exchange) =>
    [
      exchange.user ? `- Utilisateur : ${clip(exchange.user, 320)}` : "",
      exchange.assistant ? `  Assistant : ${clip(exchange.assistant, 280)}` : ""
    ]
      .filter(Boolean)
      .join("\n")
  );

  // Le premier echange pose souvent le cadre (prenom, projet, machine) : il est
  // garde en priorite, puis les plus recents ; ceux du milieu sont retires.
  const render = (keptLines, omitted) =>
    `${header}\n${
      omitted > 0 && keptLines.length > 1
        ? [keptLines[0], `- (${omitted} echange(s) intermediaire(s) omis)`, ...keptLines.slice(1)].join("\n")
        : keptLines.join("\n")
    }`;
  let kept = lines;
  let omitted = 0;
  while (kept.length > 0 && estimateTokens(render(kept, omitted), charsPerToken) > maxTokens) {
    kept = kept.length > 1 ? [kept[0], ...kept.slice(2)] : [];
    omitted += 1;
  }

  if (kept.length === 0) {
    return { content: "", exchangeCount: 0 };
  }

  return { content: render(kept, omitted), exchangeCount: kept.length };
}

/**
 * Memoire de conversation pour un budget donne : les messages les plus recents
 * sont repris mot pour mot (du plus recent au plus ancien) tant qu'ils tiennent,
 * les echanges anterieurs sont condenses. Le dernier echange est toujours
 * conserve, quitte a raccourcir une longue reponse : c'est lui qui donne son
 * sens a une relance ("et pour l'etape 2 ?").
 */
export function packConversationHistory(
  history = [],
  {
    tokenBudget,
    maxVerbatimMessages = 40,
    verbatim = true,
    charsPerToken = DEFAULT_CHARS_PER_TOKEN
  } = {}
) {
  const entries = (Array.isArray(history) ? history : [])
    .filter((entry) => entry?.content && (entry.role === "user" || entry.role === "assistant"))
    .map((entry) => ({ role: entry.role, content: String(entry.content).trim() }))
    .filter((entry) => entry.content);
  const budget = Math.max(0, Number(tokenBudget) || 0);
  const empty = {
    messages: [],
    memoryMessage: null,
    stats: { totalMessages: entries.length, verbatimMessages: 0, condensedExchanges: 0, droppedMessages: entries.length, tokens: 0 }
  };

  if (entries.length === 0 || budget < 32) {
    return empty;
  }

  const verbatimMessages = [];
  let used = 0;

  if (verbatim) {
    // Une petite part est gardee pour la memoire condensee des echanges plus
    // anciens, s'il y en a.
    const condensedReserve = entries.length > 2 ? Math.min(Math.floor(budget * 0.2), 600) : 0;
    const verbatimBudget = budget - condensedReserve;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (verbatimMessages.length >= maxVerbatimMessages) {
        break;
      }

      const entry = entries[index];
      const cost = estimateMessageTokens(entry, charsPerToken);

      if (used + cost <= verbatimBudget) {
        verbatimMessages.unshift(entry);
        used += cost;
        continue;
      }

      if (entries.length - index > 2) {
        break;
      }

      // Message trop long du dernier echange : on le raccourcit plutot que de
      // perdre le fil. Une longue reponse laisse la place a sa question.
      const precedingQuestion = index > 0 && entries[index - 1].role === "user" && entries.length - index === 1
        ? entries[index - 1]
        : null;
      const questionReserve = precedingQuestion
        ? Math.min(estimateMessageTokens(precedingQuestion, charsPerToken), Math.floor(verbatimBudget / 3))
        : 0;
      const shortened = truncateToTokens(
        entry.content,
        verbatimBudget - used - questionReserve - MESSAGE_OVERHEAD_TOKENS,
        charsPerToken
      );
      if (!shortened) {
        break;
      }

      const truncatedEntry = { role: entry.role, content: shortened };
      verbatimMessages.unshift(truncatedEntry);
      used += estimateMessageTokens(truncatedEntry, charsPerToken);
    }
  }

  // Une conversation doit reprendre sur un message utilisateur : un message
  // assistant orphelin en tete serait mal interprete par certains templates.
  while (verbatimMessages.length > 0 && verbatimMessages[0].role !== "user") {
    verbatimMessages.shift();
  }

  // Les echanges anterieurs au verbatim sont condenses dans le budget restant.
  const olderEntries = entries.slice(0, entries.length - verbatimMessages.length);
  const condensed = buildCondensedMemory(groupHistoryIntoExchanges(olderEntries), {
    maxTokens: budget - used - MESSAGE_OVERHEAD_TOKENS,
    charsPerToken
  });
  const memoryMessage = condensed.content
    ? { role: "system", kind: "memory", content: condensed.content }
    : null;
  const memoryTokens = memoryMessage ? estimateMessageTokens(memoryMessage, charsPerToken) : 0;
  const condensedMessages = Math.min(olderEntries.length, condensed.exchangeCount * 2);

  return {
    messages: verbatimMessages.map((entry) => ({ ...entry, kind: "history" })),
    memoryMessage,
    stats: {
      totalMessages: entries.length,
      verbatimMessages: verbatimMessages.length,
      condensedExchanges: condensed.exchangeCount,
      droppedMessages: Math.max(0, entries.length - verbatimMessages.length - condensedMessages),
      tokens: used + memoryTokens
    }
  };
}

/**
 * Ajuste des messages deja construits a la fenetre d'un modele.
 *
 * Les messages portent un champ `kind` :
 *   - sans kind / "instruction" / "question" : jamais tronques (consignes,
 *     personnalisations, corrections validees, question) ;
 *   - "examples" : exemples notes par les utilisateurs, sacrifies en premier ;
 *   - "rag" / "attachment" : extraits documentaires et pieces jointes ;
 *   - "history" : historique brut a repartir (voir packConversationHistory).
 *
 * Repartition : le dernier echange est garanti, puis les documents et pieces
 * jointes, puis le reste de l'historique (verbatim puis condense).
 */
export function fitMessagesToContext(
  messages = [],
  {
    contextWindow,
    isReasoning = false,
    charsPerToken = DEFAULT_CHARS_PER_TOKEN,
    maxVerbatimMessages = 40,
    verbatimHistory = true
  } = {}
) {
  const plan = planPromptBudget({ contextWindow, isReasoning });
  const historyEntries = messages.filter((message) => message.kind === "history");
  const others = messages.filter((message) => message.kind !== "history");
  const fixed = others.filter((message) => !TRIMMABLE_KINDS.has(message.kind));
  const examples = others.filter((message) => message.kind === "examples");
  const documents = others.filter((message) => message.kind === "rag" || message.kind === "attachment");

  const fixedTokens = estimateMessagesTokens(fixed, charsPerToken);
  let remaining = plan.inputBudget - fixedTokens;
  const historyTotal = estimateMessagesTokens(historyEntries, charsPerToken);
  const documentsTotal = estimateMessagesTokens(documents, charsPerToken);

  // Plancher reserve a l'historique : au moins le dernier echange (dans la
  // limite d'un tiers de l'espace disponible).
  // En cas de changement de sujet (memoire condensee seule), un plancher plus
  // modeste suffit.
  const lastExchangeTokens = estimateMessagesTokens(historyEntries.slice(-2), charsPerToken);
  const historyFloor = verbatimHistory
    ? Math.min(lastExchangeTokens, Math.max(0, Math.floor(remaining / 3)))
    : Math.min(historyTotal, 400, Math.max(0, Math.floor(remaining / 6)));

  // Documents et pieces jointes : tout ce qui tient au-dela du plancher,
  // reparti equitablement (un message tres long ne prive pas les suivants).
  const documentBudget = Math.max(0, remaining - historyFloor);
  const fittedDocuments = new Map();
  let documentTokensUsed = 0;
  let truncatedDocuments = 0;

  documents.forEach((message, index) => {
    const share = Math.floor((documentBudget - documentTokensUsed) / (documents.length - index));
    const cost = estimateMessageTokens(message, charsPerToken);
    if (cost <= share) {
      fittedDocuments.set(message, message);
      documentTokensUsed += cost;
      return;
    }

    truncatedDocuments += 1;
    const content = truncateToTokens(message.content, share - MESSAGE_OVERHEAD_TOKENS, charsPerToken);
    if (content) {
      const shortened = { ...message, content };
      fittedDocuments.set(message, shortened);
      documentTokensUsed += estimateMessageTokens(shortened, charsPerToken);
    }
  });
  remaining -= documentTokensUsed;

  // Historique : tout l'espace restant (au minimum le plancher).
  const packedHistory = packConversationHistory(historyEntries, {
    tokenBudget: Math.max(historyFloor, remaining),
    maxVerbatimMessages,
    verbatim: verbatimHistory,
    charsPerToken
  });
  remaining -= packedHistory.stats.tokens;

  // Exemples notes : seulement s'il reste de la place.
  const fittedExamples = [];
  for (const message of examples) {
    const cost = estimateMessageTokens(message, charsPerToken);
    if (cost <= remaining) {
      fittedExamples.push(message);
      remaining -= cost;
    }
  }

  // Reassemblage dans l'ordre d'origine : consignes et contexte, memoire
  // condensee, historique verbatim, puis la question (toujours en dernier).
  const keptExamples = new Set(fittedExamples);
  const questionIndex = others.findLastIndex((message) => message.kind === "question");
  const result = [];

  others.forEach((message, index) => {
    if (index === questionIndex) {
      return;
    }

    if (!TRIMMABLE_KINDS.has(message.kind) || keptExamples.has(message)) {
      result.push(message);
    } else if (fittedDocuments.has(message)) {
      result.push(fittedDocuments.get(message));
    }
  });

  if (packedHistory.memoryMessage) {
    result.push(packedHistory.memoryMessage);
  }
  result.push(...packedHistory.messages);
  if (questionIndex !== -1) {
    result.push(others[questionIndex]);
  }

  const estimatedPromptTokens = estimateMessagesTokens(result, charsPerToken);

  return {
    messages: result,
    stats: {
      contextWindow: plan.contextWindow,
      outputReserve: plan.outputReserve,
      inputBudget: plan.inputBudget,
      estimatedPromptTokens,
      fixedTokens,
      documentTokens: documentTokensUsed,
      documentTokensRequested: documentsTotal,
      truncatedDocuments,
      historyTokens: packedHistory.stats.tokens,
      historyTokensRequested: historyTotal,
      droppedExamples: examples.length - fittedExamples.length,
      history: packedHistory.stats,
      overflow: estimatedPromptTokens > plan.inputBudget
    }
  };
}
