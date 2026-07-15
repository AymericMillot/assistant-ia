import {
  getAnswerRatingStats,
  listAnswerRatings,
  upsertAnswerRating
} from "../config/db.js";
import { getConversationBySessionId, getConversationExchanges } from "./conversationService.js";

const ratingSignalMinScore = Number(process.env.RATING_SIGNAL_MIN_SCORE || 0.34);
const ratingSignalMaxExamples = Number(process.env.RATING_SIGNAL_MAX_EXAMPLES || 2);
const ratingSignalAnswerMaxChars = Number(process.env.RATING_SIGNAL_ANSWER_MAX_CHARS || 1200);

const ratingStopWords = new Set([
  "les",
  "des",
  "une",
  "pour",
  "dans",
  "avec",
  "sans",
  "sur",
  "qui",
  "quoi",
  "quand",
  "vous",
  "nous",
  "elle",
  "elles",
  "ils",
  "est",
  "sont",
  "pas",
  "plus",
  "par",
  "que",
  "aux",
  "ses",
  "ces",
  "cet",
  "cette",
  "comment",
  "quel",
  "quelle",
  "quels",
  "quelles",
  "peux",
  "peut",
  "veux",
  "faire",
  "donne",
  "donner"
]);

function tokenizeRatingText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)
    .filter((token) => !ratingStopWords.has(token));
}

function computeQuestionSimilarity(question, candidateQuestion) {
  const questionTokens = new Set(tokenizeRatingText(question));
  if (questionTokens.size === 0) {
    return 0;
  }

  const candidateTokens = new Set(tokenizeRatingText(candidateQuestion));
  if (candidateTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  questionTokens.forEach((token) => {
    if (candidateTokens.has(token)) {
      overlap += 1;
    }
  });

  return overlap / questionTokens.size;
}

function mapRatingRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    exchangeId: row.exchange_id,
    sessionId: row.session_id,
    rating: row.rating,
    question: row.question,
    answer: row.answer,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function recordAnswerRating({ sessionId, exchangeId = null, rating }) {
  if (rating !== "up" && rating !== "down") {
    const error = new Error("Évaluation invalide.");
    error.statusCode = 400;
    throw error;
  }

  const conversation = getConversationBySessionId(sessionId);
  if (!conversation) {
    const error = new Error("Conversation introuvable pour cette évaluation.");
    error.statusCode = 404;
    throw error;
  }

  const exchanges = getConversationExchanges(conversation.id);
  const exchange =
    exchangeId !== null
      ? exchanges.find((entry) => entry.id === Number(exchangeId))
      : exchanges[exchanges.length - 1];

  if (!exchange) {
    const error = new Error("Échange introuvable pour cette évaluation.");
    error.statusCode = 404;
    throw error;
  }

  const row = upsertAnswerRating({
    conversationId: conversation.id,
    exchangeId: exchange.id,
    sessionId,
    rating,
    question: exchange.question,
    answer: exchange.answer
  });

  return mapRatingRow(row);
}

export function getRatingsOverview({ limit = 30 } = {}) {
  return {
    stats: getAnswerRatingStats(),
    recentDown: listAnswerRatings({ rating: "down", limit }).map(mapRatingRow),
    recentUp: listAnswerRatings({ rating: "up", limit }).map(mapRatingRow)
  };
}

/**
 * Retourne des exemples issus des evaluations utilisateur pertinents pour la question :
 * les reponses appreciees servent de reference, les reponses rejetees d'anti-exemples.
 */
export function getRatingSignalsForQuestion(question) {
  const safeQuestion = String(question || "").trim();
  if (!safeQuestion) {
    return { goodExamples: [], badExamples: [] };
  }

  const buildExamples = (rating) =>
    listAnswerRatings({ rating, limit: 120 })
      .map((row) => ({
        question: row.question,
        answer: String(row.answer || "").slice(0, ratingSignalAnswerMaxChars),
        score: computeQuestionSimilarity(safeQuestion, row.question)
      }))
      .filter((entry) => entry.score >= ratingSignalMinScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, ratingSignalMaxExamples))
      .map(({ question: exampleQuestion, answer }) => ({ question: exampleQuestion, answer }));

  return {
    goodExamples: buildExamples("up"),
    badExamples: buildExamples("down")
  };
}
