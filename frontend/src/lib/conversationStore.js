// Historique des conversations conserve uniquement dans ce navigateur
// (localStorage) : rien n'est envoye a un serveur pour le retrouver. Il peut
// etre desactive par l'utilisateur, et s'efface de lui-meme apres 30 jours.

const storageKey = "assistant-ia-conversations";
const preferenceKey = "assistant-ia-remember-conversations";
const maxConversations = 30;
const maxMessagesPerConversation = 80;
const maxStoredCharacters = 1_500_000;
const retentionMs = 30 * 24 * 60 * 60 * 1000;

function safeRead(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key, value) {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
    return true;
  } catch {
    return false;
  }
}

export function isHistoryEnabled() {
  return safeRead(preferenceKey) !== "off";
}

export function setHistoryEnabled(enabled) {
  safeWrite(preferenceKey, enabled ? "on" : "off");
  if (!enabled) {
    clearConversations();
  }
}

export function loadConversations() {
  const raw = safeRead(storageKey);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    const now = Date.now();
    return (Array.isArray(parsed) ? parsed : [])
      .filter((entry) => entry && typeof entry.id === "string" && Array.isArray(entry.messages))
      .filter((entry) => now - Number(entry.updatedAt || 0) < retentionMs)
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  } catch {
    return [];
  }
}

function persist(conversations) {
  let list = conversations.slice(0, maxConversations);
  let serialized = JSON.stringify(list);

  // Quota du navigateur : on retire les conversations les plus anciennes.
  while (serialized.length > maxStoredCharacters && list.length > 1) {
    list = list.slice(0, -1);
    serialized = JSON.stringify(list);
  }

  if (!safeWrite(storageKey, serialized) && list.length > 1) {
    safeWrite(storageKey, JSON.stringify(list.slice(0, Math.ceil(list.length / 2))));
  }
}

// Seuls les champs utiles a la relecture sont conserves (pas d'etat
// d'interface ni de raisonnement intermediaire).
function compactMessage(message) {
  return {
    id: message.id,
    role: message.role,
    content: String(message.content || "").slice(0, 20000),
    timestamp: message.timestamp || Date.now(),
    sources: Array.isArray(message.sources)
      ? message.sources.slice(0, 8).map((source) => ({
          fileName: source.fileName,
          relativePath: source.relativePath,
          chunkIndex: source.chunkIndex,
          documentId: source.documentId,
          downloadUrl: source.downloadUrl,
          visibility: source.visibility
        }))
      : [],
    attachmentNames: message.attachmentNames || [],
    exchangeId: message.exchangeId || null,
    rating: message.rating || null,
    skills: message.skills || []
  };
}

function buildTitle(messages) {
  const firstQuestion = messages.find((message) => message.role === "user")?.content || "Conversation";
  const singleLine = firstQuestion.replace(/\s+/g, " ").trim();
  return singleLine.length > 70 ? `${singleLine.slice(0, 67)}…` : singleLine;
}

export function saveConversation(id, messages) {
  if (!isHistoryEnabled() || !id) {
    return;
  }

  const finished = messages.filter((message) => !message.streamState && String(message.content || "").trim());
  if (!finished.some((message) => message.role === "user")) {
    return;
  }

  const conversations = loadConversations().filter((entry) => entry.id !== id);
  conversations.unshift({
    id,
    title: buildTitle(finished),
    updatedAt: Date.now(),
    messages: finished.slice(-maxMessagesPerConversation).map(compactMessage)
  });
  persist(conversations);
}

export function deleteConversation(id) {
  persist(loadConversations().filter((entry) => entry.id !== id));
}

export function clearConversations() {
  safeWrite(storageKey, null);
}

export function getConversation(id) {
  return loadConversations().find((entry) => entry.id === id) || null;
}
