import { getDb } from "../config/db.js";
import {
  getConversationById,
  getConversationExchanges,
  getConversationMessages,
  updateConversationState
} from "./conversationService.js";

const feedbackStopWords = new Set([
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
  "avant",
  "apres",
  "faire",
  "donc",
  "tres",
  "comme",
  "tout",
  "toute",
  "juste",
  "cela",
  "avoir",
  "etre",
  "faut",
  "doit",
  "lorsque",
  "comment",
  "quelles",
  "quels",
  "quel",
  "quelle",
  "moi",
  "toi",
  "parle",
  "parler",
  "dit",
  "dire",
  "dis",
  "donne",
  "donner",
  "donnes",
  "peux",
  "peut",
  "veux",
  "veut",
  "besoin",
  "information",
  "informations",
  "sujet",
  "chose",
  "choses",
  "assistant",
  "reponse",
  "repondre"
]);

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeKeywords(value) {
  return normalizeText(value)
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length >= 3)
    .filter((token) => !feedbackStopWords.has(token));
}

function uniqueKeywords(tokens) {
  return [...new Set(tokens)].slice(0, 12);
}

function scoreRule(question, rule) {
  const normalizedQuestion = normalizeText(question);
  const questionTokens = new Set(tokenizeKeywords(question));
  if (questionTokens.size === 0) {
    return 0;
  }

  const ruleKeywords = Array.isArray(rule.keywords) ? rule.keywords : [];
  const exampleQuestion = normalizeText(rule.exampleQuestion || "");
  const exampleAnswer = normalizeText(rule.exampleAnswer || "");
  const haystack = `${normalizeText(rule.instruction)} ${normalizeText(rule.correctedResponse)} ${exampleQuestion} ${exampleAnswer}`;
  const overlapCount = [...questionTokens].filter((token) => ruleKeywords.includes(token)).length;
  let haystackMatches = 0;
  questionTokens.forEach((token) => {
    if (haystack.includes(token)) {
      haystackMatches += 1;
    }
  });

  let score = 0;
  const hasSemanticMatch =
    overlapCount > 0 ||
    haystackMatches > 0 ||
    (exampleQuestion && normalizedQuestion === exampleQuestion) ||
    (exampleQuestion && normalizedQuestion.includes(exampleQuestion)) ||
    (exampleQuestion && exampleQuestion.includes(normalizedQuestion));

  if (!hasSemanticMatch) {
    return 0;
  }

  score += overlapCount * 10;
  score += haystackMatches * 3;

  if (exampleQuestion && normalizedQuestion === exampleQuestion) {
    score += 24;
  } else if (exampleQuestion && normalizedQuestion.includes(exampleQuestion)) {
    score += 18;
  } else if (exampleQuestion && exampleQuestion.includes(normalizedQuestion)) {
    score += 12;
  }

  if (exampleQuestion && overlapCount > 0) {
    score += overlapCount * 3;
  }

  score += Math.max(0, 20 - Math.min(Number(rule.priority || 100), 100)) * 0.3;

  return Number(score.toFixed(3));
}

function mapFeedbackRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    exchangeId: row.exchange_id || null,
    adminUserId: row.admin_user_id,
    correctedResponse: row.corrected_response,
    instructions: row.instructions,
    feedbackStatus: row.feedback_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDeleted: Boolean(row.is_deleted),
    sessionId: row.session_id || null,
    conversationDeleted: row.conversation_is_deleted !== undefined ? Boolean(row.conversation_is_deleted) : null,
    conversationResolved: row.conversation_is_resolved !== undefined ? Boolean(row.conversation_is_resolved) : null,
    exchangeQuestion: row.exchange_question || null,
    exchangeAnswer: row.exchange_answer || null
  };
}

function mapRuleRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    feedbackId: row.feedback_id,
    instruction: row.instruction,
    correctedResponse: row.corrected_response,
    exampleQuestion: row.example_question || null,
    exampleAnswer: row.example_answer || null,
    keywords: row.keywords ? JSON.parse(row.keywords) : [],
    priority: Number(row.priority || 100),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function deriveKeywordsFromExchange(conversationId, exchangeId, fallbackText = "") {
  const sourceText =
    exchangeId
      ? getConversationExchanges(conversationId)
          .filter((exchange) => exchange.id === exchangeId)
          .map((exchange) => `${exchange.question} ${exchange.answer}`)
          .join(" ")
      : getConversationMessages(conversationId)
    .filter((message) => message.role === "user")
    .map((message) => message.content);

  return uniqueKeywords(
    tokenizeKeywords(`${Array.isArray(sourceText) ? sourceText.join(" ") : sourceText} ${fallbackText}`)
  );
}

function upsertImprovementRuleFromFeedback(feedbackId) {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT
        feedback.*,
        conversation_exchanges.question AS exchange_question,
        conversation_exchanges.answer AS exchange_answer,
        conversations.is_deleted AS conversation_is_deleted
      FROM feedback
      INNER JOIN conversations ON conversations.id = feedback.conversation_id
      LEFT JOIN conversation_exchanges ON conversation_exchanges.id = feedback.exchange_id
      WHERE feedback.id = ?
    `
    )
    .get(feedbackId);

  if (!row) {
    return null;
  }

  const keywords = JSON.stringify(
    deriveKeywordsFromExchange(
      row.conversation_id,
      row.exchange_id,
      `${row.instructions} ${row.corrected_response}`
    )
  );
  const enabled = row.is_deleted || row.feedback_status !== "resolved" ? 0 : 1;
  const priority =
    row.feedback_status === "resolved" ? 10 : row.feedback_status === "ignored" ? 90 : 50;

  db.prepare(
    `
    INSERT INTO improvement_rules (
      feedback_id,
      instruction,
      corrected_response,
      example_question,
      example_answer,
      keywords,
      priority,
      enabled,
      updated_at
    )
    VALUES (
      @feedback_id,
      @instruction,
      @corrected_response,
      @example_question,
      @example_answer,
      @keywords,
      @priority,
      @enabled,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(feedback_id) DO UPDATE SET
      instruction = excluded.instruction,
      corrected_response = excluded.corrected_response,
      example_question = excluded.example_question,
      example_answer = excluded.example_answer,
      keywords = excluded.keywords,
      priority = excluded.priority,
      enabled = excluded.enabled,
      updated_at = CURRENT_TIMESTAMP
  `
  ).run({
    feedback_id: feedbackId,
    instruction: row.instructions,
    corrected_response: row.corrected_response,
    example_question: row.exchange_question || "",
    example_answer: row.exchange_answer || "",
    keywords,
    priority,
    enabled
  });

  return getImprovementRuleByFeedbackId(feedbackId);
}

export function getFeedbackById(id) {
  const row = getDb()
    .prepare(
      `
      SELECT
        feedback.*,
        conversation_exchanges.question AS exchange_question,
        conversation_exchanges.answer AS exchange_answer,
        conversations.session_id,
        conversations.is_deleted AS conversation_is_deleted,
        conversations.is_resolved AS conversation_is_resolved
      FROM feedback
      INNER JOIN conversations ON conversations.id = feedback.conversation_id
      LEFT JOIN conversation_exchanges ON conversation_exchanges.id = feedback.exchange_id
      WHERE feedback.id = ?
    `
    )
    .get(id);

  return mapFeedbackRow(row);
}

export function createFeedback({
  conversationId,
  exchangeId = null,
  adminUserId = "admin",
  correctedResponse,
  instructions,
  feedbackStatus = "pending"
}) {
  const conversation = getConversationById(conversationId);
  if (!conversation) {
    throw new Error("Conversation introuvable.");
  }

  if (exchangeId !== null) {
    const exchange = getConversationExchanges(conversationId).find((item) => item.id === exchangeId);
    if (!exchange) {
      throw new Error("Échange introuvable pour cette conversation.");
    }
  }

  const db = getDb();
  const result = db
    .prepare(
      `
      INSERT INTO feedback (
        conversation_id,
        exchange_id,
        admin_user_id,
        corrected_response,
        instructions,
        feedback_status
      )
      VALUES (
        @conversation_id,
        @exchange_id,
        @admin_user_id,
        @corrected_response,
        @instructions,
        @feedback_status
      )
    `
    )
    .run({
      conversation_id: conversationId,
      exchange_id: exchangeId,
      admin_user_id: adminUserId,
      corrected_response: correctedResponse,
      instructions,
      feedback_status: feedbackStatus
    });

  if (feedbackStatus === "resolved") {
    updateConversationState(conversationId, { isResolved: true });
  }

  upsertImprovementRuleFromFeedback(result.lastInsertRowid);
  return getFeedbackById(result.lastInsertRowid);
}

export function listFeedback({ status = null, includeDeleted = false } = {}) {
  const conditions = [];
  const parameters = {};

  if (!includeDeleted) {
    conditions.push("feedback.is_deleted = 0");
  }

  if (status) {
    conditions.push("feedback.feedback_status = @status");
    parameters.status = status;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return getDb()
    .prepare(
      `
      SELECT
        feedback.*,
        conversation_exchanges.question AS exchange_question,
        conversation_exchanges.answer AS exchange_answer,
        conversations.session_id,
        conversations.is_deleted AS conversation_is_deleted,
        conversations.is_resolved AS conversation_is_resolved
      FROM feedback
      INNER JOIN conversations ON conversations.id = feedback.conversation_id
      LEFT JOIN conversation_exchanges ON conversation_exchanges.id = feedback.exchange_id
      ${whereClause}
      ORDER BY feedback.created_at DESC, feedback.id DESC
    `
    )
    .all(parameters)
    .map(mapFeedbackRow);
}

export function updateFeedback(feedbackId, updates = {}) {
  const existing = getFeedbackById(feedbackId);
  if (!existing) {
    throw new Error("Feedback introuvable.");
  }

  const assignments = [];
  const values = { id: feedbackId };

  if (updates.correctedResponse !== undefined) {
    assignments.push("corrected_response = @corrected_response");
    values.corrected_response = updates.correctedResponse;
  }

  if (updates.instructions !== undefined) {
    assignments.push("instructions = @instructions");
    values.instructions = updates.instructions;
  }

  if (updates.feedbackStatus !== undefined) {
    assignments.push("feedback_status = @feedback_status");
    values.feedback_status = updates.feedbackStatus;
  }

  if (updates.isDeleted !== undefined) {
    assignments.push("is_deleted = @is_deleted");
    values.is_deleted = updates.isDeleted ? 1 : 0;
  }

  if (assignments.length === 0) {
    return existing;
  }

  getDb()
    .prepare(
      `
      UPDATE feedback
      SET ${assignments.join(", ")},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `
    )
    .run(values);

  const updated = getFeedbackById(feedbackId);

  if (updated.feedbackStatus === "resolved") {
    updateConversationState(updated.conversationId, { isResolved: true });
  }

  upsertImprovementRuleFromFeedback(feedbackId);
  return getFeedbackById(feedbackId);
}

export function softDeleteFeedback(feedbackId) {
  return updateFeedback(feedbackId, { isDeleted: true, feedbackStatus: "ignored" });
}

export function getImprovementRules({ enabledOnly = false } = {}) {
  const whereClause = enabledOnly ? "WHERE enabled = 1" : "";
  return getDb()
    .prepare(
      `
      SELECT *
      FROM improvement_rules
      ${whereClause}
      ORDER BY priority ASC, updated_at DESC, id DESC
    `
    )
    .all()
    .map(mapRuleRow);
}

export function getImprovementRuleByFeedbackId(feedbackId) {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM improvement_rules
      WHERE feedback_id = ?
    `
    )
    .get(feedbackId);

  return mapRuleRow(row);
}

export function getRelevantImprovementRules(question, { limit = 5 } = {}) {
  return getImprovementRules({ enabledOnly: true })
    .map((rule) => ({
      ...rule,
      matchScore: scoreRule(question, rule)
    }))
    .filter((rule) => rule.matchScore >= 8)
    .sort((left, right) => {
      if (right.matchScore !== left.matchScore) {
        return right.matchScore - left.matchScore;
      }
      return left.priority - right.priority;
    })
    .slice(0, limit);
}

export function getFeedbackInstructionsPayload(question = "") {
  const rules =
    String(question || "").trim().length > 0
      ? getRelevantImprovementRules(question)
      : getImprovementRules({ enabledOnly: true }).slice(0, 20);

  const instructionsText =
    rules.length > 0
      ? rules
          .map(
            (rule, index) =>
              `[CORRECTION ${index + 1}] Instruction : ${rule.instruction}${
                rule.correctedResponse
                  ? `\nRéponse corrigée attendue : ${rule.correctedResponse}`
                  : ""
              }`
          )
          .join("\n\n")
      : "";

  return {
    count: rules.length,
    instructionsText,
    rules
  };
}
