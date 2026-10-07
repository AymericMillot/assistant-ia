import { getSetting, getTopQuestions, getUnansweredQuestions, setSetting } from "../config/db.js";
import { listPublicSkills } from "./skillService.js";

/**
 * Accueil du chat : bandeau d'annonce (fermeture, maintenance...) et
 * questions suggerees, tous deux reglables depuis l'administration.
 */

const announcementTones = ["info", "warning", "critical"];
const suggestionModes = ["auto", "manual", "off"];
const maxSuggestions = 4;
// Une question n'est proposee automatiquement que si elle a ete posee dans
// plusieurs conversations distinctes : une question isolee peut contenir des
// informations personnelles et ne doit jamais etre montree aux autres.
const autoSuggestionMinConversations = Number(process.env.CHAT_SUGGESTION_MIN_CONVERSATIONS || 3);
const autoSuggestionCacheMs = 10 * 60 * 1000;

let autoSuggestionCache = { expiresAt: 0, questions: [] };

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function readJsonSetting(key, fallback) {
  try {
    const parsed = JSON.parse(getSetting(key, "") || "null");
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function cleanLine(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function getAnnouncementSettings() {
  const stored = readJsonSetting("chatAnnouncement", {});
  return {
    enabled: Boolean(stored.enabled),
    message: String(stored.message || ""),
    tone: announcementTones.includes(stored.tone) ? stored.tone : "info",
    expiresAt: stored.expiresAt || null,
    updatedAt: stored.updatedAt || null
  };
}

export function saveAnnouncementSettings({ enabled, message, tone, expiresAt }) {
  const cleanMessage = cleanLine(message, 400);
  if (enabled && !cleanMessage) {
    throw validationError("Le message de l'annonce est vide.");
  }

  let normalizedExpiry = null;
  if (expiresAt) {
    const date = new Date(expiresAt);
    if (Number.isNaN(date.getTime())) {
      throw validationError("Date d'expiration invalide.");
    }
    normalizedExpiry = date.toISOString();
  }

  const next = {
    enabled: Boolean(enabled),
    message: cleanMessage,
    tone: announcementTones.includes(tone) ? tone : "info",
    expiresAt: normalizedExpiry,
    updatedAt: new Date().toISOString()
  };
  setSetting("chatAnnouncement", JSON.stringify(next));
  return next;
}

export function getActiveAnnouncement() {
  const announcement = getAnnouncementSettings();
  if (!announcement.enabled || !announcement.message) {
    return null;
  }

  if (announcement.expiresAt && new Date(announcement.expiresAt).getTime() <= Date.now()) {
    return null;
  }

  return {
    message: announcement.message,
    tone: announcement.tone,
    // Identifiant de version : le navigateur memorise qu'une annonce a ete
    // fermee, et la reaffiche si elle est modifiee.
    id: announcement.updatedAt || announcement.message.length.toString()
  };
}

export function getSuggestionSettings() {
  const stored = readJsonSetting("chatSuggestions", {});
  return {
    mode: suggestionModes.includes(stored.mode) ? stored.mode : "auto",
    manual: Array.isArray(stored.manual)
      ? stored.manual.map((entry) => cleanLine(entry, 160)).filter(Boolean).slice(0, 8)
      : []
  };
}

export function saveSuggestionSettings({ mode, manual }) {
  if (!suggestionModes.includes(mode)) {
    throw validationError("Mode de suggestions invalide.");
  }

  const manualEntries = (Array.isArray(manual) ? manual : [])
    .map((entry) => cleanLine(entry, 160))
    .filter((entry) => entry.length >= 3);

  if (manualEntries.length > 8) {
    throw validationError("8 suggestions maximum.");
  }

  const next = { mode, manual: manualEntries };
  setSetting("chatSuggestions", JSON.stringify(next));
  autoSuggestionCache = { expiresAt: 0, questions: [] };
  return next;
}

function computeAutoSuggestions() {
  if (autoSuggestionCache.expiresAt > Date.now()) {
    return autoSuggestionCache.questions;
  }

  // Les questions restees sans reponse documentaire ne sont pas mises en
  // avant : l'assistant y repond mal, autant ne pas les suggerer.
  const unanswered = new Set(
    getUnansweredQuestions({ limit: 1000, sinceDays: 90 }).map((entry) =>
      entry.question.trim().toLowerCase()
    )
  );

  const questions = getTopQuestions({ limit: 50, sinceDays: 90 })
    .filter((entry) => entry.conversationCount >= autoSuggestionMinConversations)
    .map((entry) => cleanLine(entry.question, 160))
    .filter((question) => question.length >= 12 && question.length <= 140)
    // Pas d'adresse e-mail, de numero de telephone ni d'URL dans une suggestion publique.
    .filter((question) => !/[@]|https?:|\d{6,}|(\d{2}[ .-]?){5}/i.test(question))
    .filter((question) => !unanswered.has(question.toLowerCase()))
    .slice(0, maxSuggestions);

  autoSuggestionCache = { expiresAt: Date.now() + autoSuggestionCacheMs, questions };
  return questions;
}

export function getPublicSuggestions() {
  const settings = getSuggestionSettings();
  if (settings.mode === "off") {
    return [];
  }

  if (settings.mode === "manual") {
    return settings.manual.slice(0, maxSuggestions);
  }

  const automatic = computeAutoSuggestions();
  // Mode automatique : les suggestions saisies a la main completent la liste.
  return [...new Set([...settings.manual, ...automatic])].slice(0, maxSuggestions);
}

export function getChatHomePayload() {
  return {
    announcement: getActiveAnnouncement(),
    suggestions: getPublicSuggestions(),
    skills: listPublicSkills()
  };
}

export function getChatHomeSettings() {
  return {
    announcement: getAnnouncementSettings(),
    suggestions: getSuggestionSettings(),
    preview: {
      announcement: getActiveAnnouncement(),
      suggestions: getPublicSuggestions()
    }
  };
}
