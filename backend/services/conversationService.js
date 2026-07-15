import crypto from "crypto";
import { getDb } from "../config/db.js";

function nowIso() {
  return new Date().toISOString();
}

function normalizeBooleanFilter(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (value === true || value === "true" || value === 1 || value === "1") {
    return 1;
  }

  if (value === false || value === "false" || value === 0 || value === "0") {
    return 0;
  }

  return null;
}

function mapConversationRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDeleted: Boolean(row.is_deleted),
    isResolved: Boolean(row.is_resolved),
    exchangeCount: Number(row.exchange_count || 0),
    lastExchangeAt: row.last_exchange_at || null,
    lastQuestion: row.last_question || null,
    lastAnswer: row.last_answer || null
  };
}

function mapMessageRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp
  };
}

function mapExchangeRow(row) {
  if (!row) {
    return null;
  }

  let retrievalMetadata = null;
  if (row.retrieval_metadata) {
    try {
      retrievalMetadata = JSON.parse(row.retrieval_metadata);
    } catch {
      retrievalMetadata = null;
    }
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    question: row.question,
    answer: row.answer,
    createdAt: row.created_at,
    retrievalMetadata
  };
}

export function buildAnonymousUserId(req) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown-ip";
  const userAgent = req.headers["user-agent"] || "unknown-agent";
  const hash = crypto.createHash("sha256").update(`${ip}|${userAgent}`).digest("hex");
  return `anon-${hash.slice(0, 24)}`;
}

export function resolveConversationSessionId(value) {
  const safeValue = String(value || "").trim();
  return safeValue || crypto.randomUUID();
}

export function getConversationBySessionId(sessionId) {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM conversations
      WHERE session_id = ?
    `
    )
    .get(sessionId);
}

export function getConversationById(id) {
  return getDb()
    .prepare(
      `
      SELECT
        conversations.*,
        COUNT(conversation_exchanges.id) AS exchange_count,
        MAX(conversation_exchanges.created_at) AS last_exchange_at,
        (
          SELECT question
          FROM conversation_exchanges
          WHERE conversation_id = conversations.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) AS last_question,
        (
          SELECT answer
          FROM conversation_exchanges
          WHERE conversation_id = conversations.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) AS last_answer
      FROM conversations
      LEFT JOIN conversation_exchanges
        ON conversation_exchanges.conversation_id = conversations.id
      WHERE conversations.id = ?
      GROUP BY conversations.id
    `
    )
    .get(id);
}

export function ensureConversation({ sessionId, userId = null }) {
  const db = getDb();
  const existing = getConversationBySessionId(sessionId);

  if (existing) {
    db.prepare(
      `
      UPDATE conversations
      SET user_id = COALESCE(@user_id, user_id),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `
    ).run({
      id: existing.id,
      user_id: userId
    });

    return getConversationById(existing.id);
  }

  const result = db
    .prepare(
      `
      INSERT INTO conversations (session_id, user_id)
      VALUES (@session_id, @user_id)
    `
    )
    .run({
      session_id: sessionId,
      user_id: userId
    });

  return getConversationById(result.lastInsertRowid);
}

export function appendConversationMessage({ conversationId, role, content, timestamp = null }) {
  const db = getDb();
  const messageTimestamp = timestamp || nowIso();

  const result = db
    .prepare(
      `
      INSERT INTO messages (conversation_id, role, content, timestamp)
      VALUES (@conversation_id, @role, @content, @timestamp)
    `
    )
    .run({
      conversation_id: conversationId,
      role,
      content,
      timestamp: messageTimestamp
    });

  db.prepare(
    `
    UPDATE conversations
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `
  ).run(conversationId);

  return db.prepare("SELECT * FROM messages WHERE id = ?").get(result.lastInsertRowid);
}

export function appendConversationExchange({
  conversationId,
  question,
  answer,
  createdAt = null,
  retrievalMetadata = null
}) {
  const db = getDb();
  const exchangeCreatedAt = createdAt || nowIso();
  const result = db
    .prepare(
      `
      INSERT INTO conversation_exchanges (conversation_id, question, answer, created_at, retrieval_metadata)
      VALUES (@conversation_id, @question, @answer, @created_at, @retrieval_metadata)
    `
    )
    .run({
      conversation_id: conversationId,
      question,
      answer,
      created_at: exchangeCreatedAt,
      retrieval_metadata: retrievalMetadata ? JSON.stringify(retrievalMetadata) : null
    });

  db.prepare(
    `
    UPDATE conversations
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `
  ).run(conversationId);

  return db
    .prepare("SELECT * FROM conversation_exchanges WHERE id = ?")
    .get(result.lastInsertRowid);
}

export function saveConversationExchange({
  sessionId,
  userId = null,
  question,
  answer,
  retrievalMetadata = null
}) {
  const conversation = ensureConversation({ sessionId, userId });
  const exchange = appendConversationExchange({
    conversationId: conversation.id,
    question,
    answer,
    retrievalMetadata
  });

  return {
    conversation: getConversationById(conversation.id),
    exchange: mapExchangeRow(exchange)
  };
}

export function listConversations({
  page = 1,
  pageSize = 20,
  isResolved = null,
  isDeleted = 0,
  order = "desc"
} = {}) {
  const db = getDb();
  const filters = [];
  const parameters = {
    limit: Math.max(1, Math.min(Number(pageSize) || 20, 100)),
    offset: Math.max(0, ((Number(page) || 1) - 1) * (Math.max(1, Math.min(Number(pageSize) || 20, 100))))
  };

  const resolvedFilter = normalizeBooleanFilter(isResolved);
  const deletedFilter = normalizeBooleanFilter(isDeleted);

  if (resolvedFilter !== null) {
    filters.push("conversations.is_resolved = @is_resolved");
    parameters.is_resolved = resolvedFilter;
  }

  if (deletedFilter !== null) {
    filters.push("conversations.is_deleted = @is_deleted");
    parameters.is_deleted = deletedFilter;
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const direction = String(order).toLowerCase() === "asc" ? "ASC" : "DESC";

  const rows = db
    .prepare(
      `
      SELECT
        conversations.*,
        COUNT(conversation_exchanges.id) AS exchange_count,
        MAX(conversation_exchanges.created_at) AS last_exchange_at,
        (
          SELECT question
          FROM conversation_exchanges
          WHERE conversation_id = conversations.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) AS last_question,
        (
          SELECT answer
          FROM conversation_exchanges
          WHERE conversation_id = conversations.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) AS last_answer
      FROM conversations
      LEFT JOIN conversation_exchanges
        ON conversation_exchanges.conversation_id = conversations.id
      ${whereClause}
      GROUP BY conversations.id
      ORDER BY conversations.updated_at ${direction}, conversations.id ${direction}
      LIMIT @limit OFFSET @offset
    `
    )
    .all(parameters);

  const totalRow = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM conversations
      ${whereClause}
    `
    )
    .get(parameters);

  return {
    items: rows.map(mapConversationRow),
    total: Number(totalRow?.count || 0),
    page: Number(page) || 1,
    pageSize: parameters.limit
  };
}

export function getConversationDetail(conversationId) {
  const db = getDb();
  const conversation = getConversationById(conversationId);

  if (!conversation) {
    return null;
  }

  const exchanges = db
    .prepare(
      `
      SELECT *
      FROM conversation_exchanges
      WHERE conversation_id = ?
      ORDER BY created_at ASC, id ASC
    `
    )
    .all(conversationId)
    .map(mapExchangeRow);

  const feedback = db
    .prepare(
      `
      SELECT
        feedback.*,
        conversation_exchanges.question AS exchange_question,
        conversation_exchanges.answer AS exchange_answer
      FROM feedback
      LEFT JOIN conversation_exchanges ON conversation_exchanges.id = feedback.exchange_id
      WHERE feedback.conversation_id = ?
      ORDER BY feedback.created_at DESC, feedback.id DESC
    `
    )
    .all(conversationId)
    .map((row) => ({
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
      exchangeQuestion: row.exchange_question || null,
      exchangeAnswer: row.exchange_answer || null
    }));

  return {
    conversation: mapConversationRow(conversation),
    exchanges,
    feedback
  };
}

export function getConversationExchanges(conversationId) {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM conversation_exchanges
      WHERE conversation_id = ?
      ORDER BY created_at ASC, id ASC
    `
    )
    .all(conversationId)
    .map(mapExchangeRow);
}

export function updateConversationState(conversationId, { isResolved, isDeleted }) {
  const updates = [];
  const values = { id: conversationId };

  if (typeof isResolved === "boolean") {
    updates.push("is_resolved = @is_resolved");
    values.is_resolved = isResolved ? 1 : 0;
  }

  if (typeof isDeleted === "boolean") {
    updates.push("is_deleted = @is_deleted");
    values.is_deleted = isDeleted ? 1 : 0;
  }

  if (updates.length === 0) {
    return getConversationById(conversationId);
  }

  getDb()
    .prepare(
      `
      UPDATE conversations
      SET ${updates.join(", ")},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `
    )
    .run(values);

  return getConversationById(conversationId);
}

export function getConversationMessages(conversationId) {
  const exchanges = getDb()
    .prepare(
      `
      SELECT *
      FROM conversation_exchanges
      WHERE conversation_id = ?
      ORDER BY created_at ASC, id ASC
    `
    )
    .all(conversationId)
    .map(mapExchangeRow);

  return exchanges.flatMap((exchange) => [
    {
      id: `${exchange.id}-user`,
      conversationId: exchange.conversationId,
      role: "user",
      content: exchange.question,
      timestamp: exchange.createdAt
    },
    {
      id: `${exchange.id}-assistant`,
      conversationId: exchange.conversationId,
      role: "assistant",
      content: exchange.answer,
      timestamp: exchange.createdAt
    }
  ]);
}
