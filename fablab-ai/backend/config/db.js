import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { decryptSecret, encryptSecret } from "../utils/secretsCrypto.js";

let dbInstance;
const allowedDocumentUpdateColumns = new Set([
  "folder_name",
  "filename",
  "original_name",
  "relative_path",
  "visibility",
  "mime_type",
  "size",
  "md5_hash",
  "indexed_md5_hash",
  "indexing_status",
  "chunk_count",
  "last_indexed_at",
  "last_error"
]);
const allowedManualResourceUpdateColumns = new Set([
  "title",
  "content",
  "is_enabled",
  "resource_type",
  "link_url"
]);
const allowedUserAttachmentUpdateColumns = new Set([
  "status",
  "indexing_status",
  "chunk_count",
  "last_error",
  "reviewed_at",
  "expires_at"
]);

const resolveRuntimePath = (targetPath) =>
  path.isAbsolute(targetPath) ? targetPath : path.resolve(process.cwd(), targetPath);

const defaultSettings = {
  activeModel: process.env.DEFAULT_MODEL || "gemma2:2b",
  embeddingModel: process.env.EMBEDDING_MODEL || "nomic-embed-text:latest",
  autoIndexEnabled: process.env.AUTO_INDEX_ENABLED ?? "true",
  lastFullIndexAt: "",
  lastIndexedDocumentsCount: "0"
};

export function initializeDatabase() {
  if (dbInstance) {
    return dbInstance;
  }

  const sqlitePath = resolveRuntimePath(process.env.SQLITE_PATH || "./data/fablab.sqlite");
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

  dbInstance = new Database(sqlitePath);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");

  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      visibility TEXT NOT NULL DEFAULT 'public',
      mime_type TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      md5_hash TEXT NOT NULL,
      indexed_md5_hash TEXT,
      indexing_status TEXT NOT NULL DEFAULT 'pending',
      chunk_count INTEGER NOT NULL DEFAULT 0,
      last_indexed_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_name TEXT NOT NULL,
      folder_name TEXT NOT NULL,
      question_char_count INTEGER NOT NULL DEFAULT 0,
      question_word_count INTEGER NOT NULL DEFAULT 0,
      question_line_count INTEGER NOT NULL DEFAULT 0,
      prompt_char_count INTEGER NOT NULL DEFAULT 0,
      output_char_count INTEGER NOT NULL DEFAULT 0,
      prompt_eval_count INTEGER NOT NULL DEFAULT 0,
      eval_count INTEGER NOT NULL DEFAULT 0,
      load_duration_ms REAL NOT NULL DEFAULT 0,
      prompt_eval_duration_ms REAL NOT NULL DEFAULT 0,
      eval_duration_ms REAL NOT NULL DEFAULT 0,
      total_duration_ms REAL NOT NULL DEFAULT 0,
      queue_delay_ms REAL NOT NULL DEFAULT 0,
      processing_duration_ms REAL NOT NULL DEFAULT 0,
      source_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS manual_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      resource_type TEXT NOT NULL DEFAULT 'instruction',
      link_url TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS manual_resource_scrape_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manual_resource_id INTEGER NOT NULL REFERENCES manual_resources(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      fetched_at TEXT,
      error_message TEXT,
      characters INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_scrape_pages_resource
    ON manual_resource_scrape_pages(manual_resource_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      user_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      is_resolved INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversation_exchanges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      exchange_id INTEGER,
      admin_user_id TEXT,
      corrected_response TEXT NOT NULL,
      instructions TEXT NOT NULL,
      feedback_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (exchange_id) REFERENCES conversation_exchanges(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS improvement_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feedback_id INTEGER UNIQUE,
      instruction TEXT NOT NULL,
      corrected_response TEXT,
      example_question TEXT,
      example_answer TEXT,
      keywords TEXT,
      priority INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (feedback_id) REFERENCES feedback(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS user_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      mime_type TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      md5_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      indexing_status TEXT NOT NULL DEFAULT 'pending',
      chunk_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      session_id TEXT,
      question_context TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT,
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS answer_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER,
      exchange_id INTEGER,
      session_id TEXT NOT NULL,
      rating TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(exchange_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_attachments_status_expires
    ON user_attachments(status, expires_at);

    CREATE INDEX IF NOT EXISTS idx_answer_ratings_rating_created_at
    ON answer_ratings(rating, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_chat_metrics_model_folder_created_at
    ON chat_metrics(model_name, folder_name, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_timestamp
    ON messages(conversation_id, timestamp ASC, id ASC);

    CREATE INDEX IF NOT EXISTS idx_conversation_exchanges_conversation_created_at
    ON conversation_exchanges(conversation_id, created_at ASC, id ASC);

    CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
    ON conversations(updated_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_feedback_conversation_status
    ON feedback(conversation_id, feedback_status, is_deleted);

    CREATE INDEX IF NOT EXISTS idx_improvement_rules_enabled_priority
    ON improvement_rules(enabled, priority ASC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
    ON audit_log(created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS retrieval_score_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_name TEXT,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      retained_count INTEGER NOT NULL DEFAULT 0,
      min_score REAL,
      max_score REAL,
      avg_score REAL,
      out_of_scope INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_retrieval_score_logs_created_at
    ON retrieval_score_logs(created_at DESC, id DESC);
  `);

  const documentColumns = dbInstance.prepare("PRAGMA table_info(documents)").all();
  const hasVisibilityColumn = documentColumns.some((column) => column.name === "visibility");
  if (!hasVisibilityColumn) {
    dbInstance.exec(
      "ALTER TABLE documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'"
    );
  }

  const insertSetting = dbInstance.prepare(`
    INSERT INTO settings (key, value)
    VALUES (@key, @value)
    ON CONFLICT(key) DO NOTHING
  `);

  Object.entries(defaultSettings).forEach(([key, value]) => {
    insertSetting.run({ key, value: String(value) });
  });

  const currentEmbeddingModel = dbInstance
    .prepare("SELECT value FROM settings WHERE key = 'embeddingModel'")
    .get()?.value;
  if (currentEmbeddingModel === "nomic-embed-text") {
    dbInstance
      .prepare(
        "UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'embeddingModel'"
      )
      .run("nomic-embed-text:latest");
  }

  const conversationExchangeColumns = dbInstance.prepare("PRAGMA table_info(conversation_exchanges)").all();
  const hasRetrievalMetadataColumn = conversationExchangeColumns.some(
    (column) => column.name === "retrieval_metadata"
  );
  if (!hasRetrievalMetadataColumn) {
    dbInstance.exec("ALTER TABLE conversation_exchanges ADD COLUMN retrieval_metadata TEXT");
  }

  const feedbackColumns = dbInstance.prepare("PRAGMA table_info(feedback)").all();
  const hasExchangeIdColumn = feedbackColumns.some((column) => column.name === "exchange_id");
  if (!hasExchangeIdColumn) {
    dbInstance.exec("ALTER TABLE feedback ADD COLUMN exchange_id INTEGER REFERENCES conversation_exchanges(id) ON DELETE SET NULL");
  }

  const improvementRuleColumns = dbInstance.prepare("PRAGMA table_info(improvement_rules)").all();
  const hasExampleQuestionColumn = improvementRuleColumns.some(
    (column) => column.name === "example_question"
  );
  const hasExampleAnswerColumn = improvementRuleColumns.some(
    (column) => column.name === "example_answer"
  );
  if (!hasExampleQuestionColumn) {
    dbInstance.exec("ALTER TABLE improvement_rules ADD COLUMN example_question TEXT");
  }
  if (!hasExampleAnswerColumn) {
    dbInstance.exec("ALTER TABLE improvement_rules ADD COLUMN example_answer TEXT");
  }

  const manualResourceColumns = dbInstance.prepare("PRAGMA table_info(manual_resources)").all();
  const hasResourceTypeColumn = manualResourceColumns.some(
    (column) => column.name === "resource_type"
  );
  const hasLinkUrlColumn = manualResourceColumns.some((column) => column.name === "link_url");
  if (!hasResourceTypeColumn) {
    dbInstance.exec(
      "ALTER TABLE manual_resources ADD COLUMN resource_type TEXT NOT NULL DEFAULT 'instruction'"
    );
  }
  if (!hasLinkUrlColumn) {
    dbInstance.exec("ALTER TABLE manual_resources ADD COLUMN link_url TEXT");
  }

  const manualResourceScrapeColumns = [
    ["scrape_status", "TEXT NOT NULL DEFAULT 'idle'"],
    ["scraped_at", "TEXT"],
    ["scrape_error", "TEXT"],
    ["scraped_chars", "INTEGER NOT NULL DEFAULT 0"]
  ];
  manualResourceScrapeColumns.forEach(([columnName, definition]) => {
    const hasColumn = manualResourceColumns.some((column) => column.name === columnName);
    if (!hasColumn) {
      dbInstance.exec(`ALTER TABLE manual_resources ADD COLUMN ${columnName} ${definition}`);
    }
  });

  migrateMessagesToConversationExchanges();
  backfillFeedbackExchangeIds();

  ensureAdminUser(
    process.env.ADMIN_EMAIL || "admin@fablab.local",
    process.env.ADMIN_PASSWORD_HASH || ""
  );

  return dbInstance;
}

export function getDb() {
  if (!dbInstance) {
    return initializeDatabase();
  }

  return dbInstance;
}

export function getSetting(key, fallbackValue = null) {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallbackValue;
}

export function getSettings() {
  const rows = getDb().prepare("SELECT key, value FROM settings").all();
  return rows.reduce((accumulator, row) => {
    accumulator[row.key] = row.value;
    return accumulator;
  }, {});
}

export function setSetting(key, value) {
  getDb()
    .prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (@key, @value, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run({ key, value: String(value) });
}

// Variante chiffree au repos pour les secrets stockes en base (identifiants FTP,
// mots de passe d'export...) plutot qu'en clair dans .env. Reutilise le meme
// mecanisme de stockage que les settings classiques, seule la valeur differe
// (prefixee "enc:v1:").
export function getSettingDecrypted(key, fallbackValue = null) {
  const rawValue = getSetting(key, null);
  if (rawValue === null) {
    return fallbackValue;
  }

  return decryptSecret(rawValue);
}

export function setSettingEncrypted(key, plainValue) {
  setSetting(key, encryptSecret(plainValue));
}

export function ensureAdminUser(email, passwordHash) {
  const existingUser = getDb().prepare("SELECT id FROM admin_users WHERE email = ?").get(email);
  if (existingUser || !passwordHash) {
    return;
  }

  getDb()
    .prepare(`
      INSERT INTO admin_users (email, password_hash)
      VALUES (@email, @password_hash)
    `)
    .run({ email, password_hash: passwordHash });
}

export function findAdminByEmail(email) {
  return getDb()
    .prepare(`
      SELECT id, email, password_hash, created_at, updated_at
      FROM admin_users
      WHERE email = ?
    `)
    .get(email);
}

export function updateAdminPassword(email, passwordHash) {
  return getDb()
    .prepare(`
      UPDATE admin_users
      SET password_hash = @password_hash,
          updated_at = CURRENT_TIMESTAMP
      WHERE email = @email
    `)
    .run({ email, password_hash: passwordHash });
}

export function upsertDocument(document) {
  const row = getDb()
    .prepare(
      `
      INSERT INTO documents (
        folder_name,
        filename,
        original_name,
        relative_path,
        visibility,
        mime_type,
        size,
        md5_hash,
        indexed_md5_hash,
        indexing_status,
        chunk_count,
        last_indexed_at,
        last_error,
        updated_at
      )
      VALUES (
        @folder_name,
        @filename,
        @original_name,
        @relative_path,
        @visibility,
        @mime_type,
        @size,
        @md5_hash,
        @indexed_md5_hash,
        @indexing_status,
        @chunk_count,
        @last_indexed_at,
        @last_error,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(relative_path) DO UPDATE SET
        folder_name = excluded.folder_name,
        filename = excluded.filename,
        original_name = excluded.original_name,
        visibility = excluded.visibility,
        mime_type = excluded.mime_type,
        size = excluded.size,
        md5_hash = excluded.md5_hash,
        indexed_md5_hash = excluded.indexed_md5_hash,
        indexing_status = excluded.indexing_status,
        chunk_count = excluded.chunk_count,
        last_indexed_at = excluded.last_indexed_at,
        last_error = excluded.last_error,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `
    )
    .get({
      folder_name: document.folderName,
      filename: document.filename,
      original_name: document.originalName,
      relative_path: document.relativePath,
      visibility: document.visibility || "public",
      mime_type: document.mimeType || null,
      size: document.size || 0,
      md5_hash: document.md5Hash,
      indexed_md5_hash: document.indexedMd5Hash || null,
      indexing_status: document.indexingStatus || "pending",
      chunk_count: document.chunkCount || 0,
      last_indexed_at: document.lastIndexedAt || null,
      last_error: document.lastError || null
    });

  return row;
}

export function getDocuments({ folderName } = {}) {
  if (folderName) {
    return getDb()
      .prepare(
        `
        SELECT *
        FROM documents
        WHERE folder_name = ?
        ORDER BY folder_name ASC, original_name ASC
      `
      )
      .all(folderName);
  }

  return getDb()
    .prepare(
      `
      SELECT *
      FROM documents
      ORDER BY folder_name ASC, original_name ASC
    `
    )
    .all();
}

export function getDocumentById(id) {
  return getDb().prepare("SELECT * FROM documents WHERE id = ?").get(id);
}

export function getDocumentByRelativePath(relativePath) {
  return getDb().prepare("SELECT * FROM documents WHERE relative_path = ?").get(relativePath);
}

export function updateDocumentRow(id, updates) {
  const assignments = [];
  const values = { id };

  Object.entries(updates).forEach(([key, value]) => {
    if (!allowedDocumentUpdateColumns.has(key)) {
      throw new Error(`Colonne document non autorisee: ${key}`);
    }
    assignments.push(`${key} = @${key}`);
    values[key] = value;
  });

  if (assignments.length === 0) {
    return getDocumentById(id);
  }

  getDb()
    .prepare(
      `
      UPDATE documents
      SET ${assignments.join(", ")},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `
    )
    .run(values);

  return getDocumentById(id);
}

export function updateDocumentIndexing({
  id,
  indexingStatus,
  chunkCount = 0,
  indexedMd5Hash = null,
  lastError = null,
  lastIndexedAt = null
}) {
  return updateDocumentRow(id, {
    indexing_status: indexingStatus,
    chunk_count: chunkCount,
    indexed_md5_hash: indexedMd5Hash,
    last_error: lastError,
    last_indexed_at: lastIndexedAt
  });
}

export function deleteDocumentById(id) {
  return getDb().prepare("DELETE FROM documents WHERE id = ?").run(id);
}

export function deleteDocumentByRelativePath(relativePath) {
  return getDb().prepare("DELETE FROM documents WHERE relative_path = ?").run(relativePath);
}

export function getDocumentStats() {
  const summary = getDb()
    .prepare(
      `
      SELECT
        COUNT(*) AS totalDocuments,
        SUM(CASE WHEN indexing_status = 'indexed' THEN 1 ELSE 0 END) AS indexedDocuments,
        SUM(CASE WHEN indexing_status = 'pending' THEN 1 ELSE 0 END) AS pendingDocuments,
        SUM(CASE WHEN indexing_status = 'error' THEN 1 ELSE 0 END) AS erroredDocuments
      FROM documents
    `
    )
    .get();

  const folderCount =
    getDb().prepare("SELECT COUNT(DISTINCT folder_name) AS count FROM documents").get().count || 0;

  return {
    totalDocuments: Number(summary.totalDocuments || 0),
    indexedDocuments: Number(summary.indexedDocuments || 0),
    pendingDocuments: Number(summary.pendingDocuments || 0),
    erroredDocuments: Number(summary.erroredDocuments || 0),
    folderCount: Number(folderCount || 0)
  };
}

export function hasPendingDocuments() {
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM documents
      WHERE indexing_status != 'indexed'
         OR indexed_md5_hash IS NULL
         OR indexed_md5_hash != md5_hash
    `
    )
    .get();

  return Number(row.count || 0) > 0;
}

export function updateLastFullIndexStats(documentCount) {
  setSetting("lastFullIndexAt", new Date().toISOString());
  setSetting("lastIndexedDocumentsCount", String(documentCount));
}

export function resetAllDocumentIndexing() {
  getDb()
    .prepare(
      `
      UPDATE documents
      SET indexing_status = 'pending',
          chunk_count = 0,
          indexed_md5_hash = NULL,
          last_error = NULL,
          last_indexed_at = NULL,
          updated_at = CURRENT_TIMESTAMP
    `
    )
    .run();

  setSetting("lastFullIndexAt", "");
  setSetting("lastIndexedDocumentsCount", "0");
}

export function insertChatMetric(metric) {
  return getDb()
    .prepare(
      `
      INSERT INTO chat_metrics (
        model_name,
        folder_name,
        question_char_count,
        question_word_count,
        question_line_count,
        prompt_char_count,
        output_char_count,
        prompt_eval_count,
        eval_count,
        load_duration_ms,
        prompt_eval_duration_ms,
        eval_duration_ms,
        total_duration_ms,
        queue_delay_ms,
        processing_duration_ms,
        source_count
      )
      VALUES (
        @model_name,
        @folder_name,
        @question_char_count,
        @question_word_count,
        @question_line_count,
        @prompt_char_count,
        @output_char_count,
        @prompt_eval_count,
        @eval_count,
        @load_duration_ms,
        @prompt_eval_duration_ms,
        @eval_duration_ms,
        @total_duration_ms,
        @queue_delay_ms,
        @processing_duration_ms,
        @source_count
      )
    `
    )
    .run({
      model_name: metric.modelName,
      folder_name: metric.folderName,
      question_char_count: metric.questionCharCount || 0,
      question_word_count: metric.questionWordCount || 0,
      question_line_count: metric.questionLineCount || 0,
      prompt_char_count: metric.promptCharCount || 0,
      output_char_count: metric.outputCharCount || 0,
      prompt_eval_count: metric.promptEvalCount || 0,
      eval_count: metric.evalCount || 0,
      load_duration_ms: metric.loadDurationMs || 0,
      prompt_eval_duration_ms: metric.promptEvalDurationMs || 0,
      eval_duration_ms: metric.evalDurationMs || 0,
      total_duration_ms: metric.totalDurationMs || 0,
      queue_delay_ms: metric.queueDelayMs || 0,
      processing_duration_ms: metric.processingDurationMs || 0,
      source_count: metric.sourceCount || 0
    });
}

export function getRecentChatMetrics({ modelName = null, folderName = null, limit = 250 } = {}) {
  const conditions = [];
  const parameters = { limit };

  if (modelName) {
    conditions.push("model_name = @modelName");
    parameters.modelName = modelName;
  }

  if (folderName) {
    conditions.push("folder_name = @folderName");
    parameters.folderName = folderName;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return getDb()
    .prepare(
      `
      SELECT *
      FROM chat_metrics
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT @limit
    `
    )
    .all(parameters);
}

export function getAverageChatDurationMs({ modelName = null, limit = 100 } = {}) {
  const rows = getRecentChatMetrics({ modelName, limit });
  if (rows.length === 0) {
    return null;
  }

  const total = rows.reduce((sum, row) => sum + Number(row.total_duration_ms || 0), 0);
  return total / rows.length;
}

export function getManualResources({ enabledOnly = false, resourceType = null } = {}) {
  const filters = [];
  const params = {};

  if (enabledOnly) {
    filters.push("is_enabled = 1");
  }

  if (resourceType) {
    filters.push("resource_type = @resource_type");
    params.resource_type = resourceType;
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  return getDb()
    .prepare(
      `
      SELECT *
      FROM manual_resources
      ${whereClause}
      ORDER BY updated_at DESC, id DESC
    `
    )
    .all(params);
}

export function getManualResourceById(id) {
  return getDb().prepare("SELECT * FROM manual_resources WHERE id = ?").get(id);
}

export function createManualResource({
  title,
  content,
  isEnabled = true,
  resourceType = "instruction",
  linkUrl = null
}) {
  const result = getDb()
    .prepare(
      `
      INSERT INTO manual_resources (title, content, resource_type, link_url, is_enabled)
      VALUES (@title, @content, @resource_type, @link_url, @is_enabled)
    `
    )
    .run({
      title,
      content,
      resource_type: resourceType,
      link_url: linkUrl,
      is_enabled: isEnabled ? 1 : 0
    });

  return getManualResourceById(result.lastInsertRowid);
}

export function updateManualResource(id, { title, content, isEnabled, resourceType, linkUrl }) {
  const existingResource = getManualResourceById(id);
  if (!existingResource) {
    throw new Error("Ressource de personnalisation introuvable.");
  }

  const updates = [];
  const values = { id };

  if (title !== undefined) {
    if (!allowedManualResourceUpdateColumns.has("title")) {
      throw new Error("Mise a jour title non autorisee.");
    }
    updates.push("title = @title");
    values.title = title;
  }

  if (content !== undefined) {
    if (!allowedManualResourceUpdateColumns.has("content")) {
      throw new Error("Mise a jour content non autorisee.");
    }
    updates.push("content = @content");
    values.content = content;
  }

  if (isEnabled !== undefined) {
    if (!allowedManualResourceUpdateColumns.has("is_enabled")) {
      throw new Error("Mise a jour is_enabled non autorisee.");
    }
    updates.push("is_enabled = @is_enabled");
    values.is_enabled = isEnabled ? 1 : 0;
  }

  if (resourceType !== undefined) {
    if (!allowedManualResourceUpdateColumns.has("resource_type")) {
      throw new Error("Mise a jour resource_type non autorisee.");
    }
    updates.push("resource_type = @resource_type");
    values.resource_type = resourceType;
  }

  if (linkUrl !== undefined) {
    if (!allowedManualResourceUpdateColumns.has("link_url")) {
      throw new Error("Mise a jour link_url non autorisee.");
    }
    updates.push("link_url = @link_url");
    values.link_url = linkUrl;
  }

  if (updates.length === 0) {
    return getManualResourceById(id);
  }

  getDb()
    .prepare(
      `
      UPDATE manual_resources
      SET ${updates.join(", ")},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `
    )
    .run(values);

  return getManualResourceById(id);
}

export function deleteManualResource(id) {
  const existingResource = getManualResourceById(id);
  if (!existingResource) {
    throw new Error("Ressource de personnalisation introuvable.");
  }

  return getDb().prepare("DELETE FROM manual_resources WHERE id = ?").run(id);
}

export function updateManualResourceScrapeState(
  id,
  { scrapeStatus, scrapedAt = null, scrapeError = null, scrapedChars = null } = {}
) {
  const existingResource = getManualResourceById(id);
  if (!existingResource) {
    return null;
  }

  getDb()
    .prepare(
      `
      UPDATE manual_resources
      SET scrape_status = @scrape_status,
          scraped_at = COALESCE(@scraped_at, scraped_at),
          scrape_error = @scrape_error,
          scraped_chars = COALESCE(@scraped_chars, scraped_chars),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `
    )
    .run({
      id,
      scrape_status: scrapeStatus,
      scraped_at: scrapedAt,
      scrape_error: scrapeError,
      scraped_chars: scrapedChars
    });

  return getManualResourceById(id);
}

export function insertManualResourceScrapePage({
  manualResourceId,
  url,
  status,
  fetchedAt = null,
  errorMessage = null,
  characters = 0
}) {
  const result = getDb()
    .prepare(
      `
      INSERT INTO manual_resource_scrape_pages (
        manual_resource_id, url, status, fetched_at, error_message, characters
      ) VALUES (@manual_resource_id, @url, @status, @fetched_at, @error_message, @characters)
    `
    )
    .run({
      manual_resource_id: manualResourceId,
      url,
      status,
      fetched_at: fetchedAt,
      error_message: errorMessage,
      characters
    });

  return getDb()
    .prepare("SELECT * FROM manual_resource_scrape_pages WHERE id = ?")
    .get(result.lastInsertRowid);
}

export function listManualResourceScrapePages(manualResourceId, { limit = 50 } = {}) {
  return getDb()
    .prepare(
      `
      SELECT * FROM manual_resource_scrape_pages
      WHERE manual_resource_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `
    )
    .all(manualResourceId, limit);
}

export function insertUserAttachment(attachment) {
  const result = getDb()
    .prepare(
      `
      INSERT INTO user_attachments (
        original_name,
        filename,
        relative_path,
        mime_type,
        size,
        md5_hash,
        status,
        indexing_status,
        session_id,
        question_context,
        expires_at
      )
      VALUES (
        @original_name,
        @filename,
        @relative_path,
        @mime_type,
        @size,
        @md5_hash,
        'pending',
        'pending',
        @session_id,
        @question_context,
        @expires_at
      )
    `
    )
    .run({
      original_name: attachment.originalName,
      filename: attachment.filename,
      relative_path: attachment.relativePath,
      mime_type: attachment.mimeType || null,
      size: attachment.size || 0,
      md5_hash: attachment.md5Hash,
      session_id: attachment.sessionId || null,
      question_context: attachment.questionContext || null,
      expires_at: attachment.expiresAt || null
    });

  return getUserAttachmentById(result.lastInsertRowid);
}

export function getUserAttachmentById(id) {
  return getDb().prepare("SELECT * FROM user_attachments WHERE id = ?").get(id);
}

export function listUserAttachments() {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM user_attachments
      ORDER BY
        CASE status WHEN 'pending' THEN 0 ELSE 1 END ASC,
        created_at DESC,
        id DESC
    `
    )
    .all();
}

export function updateUserAttachmentRow(id, updates) {
  const assignments = [];
  const values = { id };

  Object.entries(updates).forEach(([key, value]) => {
    if (!allowedUserAttachmentUpdateColumns.has(key)) {
      throw new Error(`Colonne piece jointe non autorisee: ${key}`);
    }
    assignments.push(`${key} = @${key}`);
    values[key] = value;
  });

  if (assignments.length === 0) {
    return getUserAttachmentById(id);
  }

  getDb()
    .prepare(`UPDATE user_attachments SET ${assignments.join(", ")} WHERE id = @id`)
    .run(values);

  return getUserAttachmentById(id);
}

export function deleteUserAttachmentById(id) {
  return getDb().prepare("DELETE FROM user_attachments WHERE id = ?").run(id);
}

export function getExpiredUserAttachments(nowIsoString) {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM user_attachments
      WHERE status = 'pending'
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `
    )
    .all(nowIsoString);
}

export function upsertAnswerRating({
  conversationId = null,
  exchangeId = null,
  sessionId,
  rating,
  question,
  answer
}) {
  const db = getDb();

  if (exchangeId !== null) {
    db.prepare(
      `
      INSERT INTO answer_ratings (conversation_id, exchange_id, session_id, rating, question, answer)
      VALUES (@conversation_id, @exchange_id, @session_id, @rating, @question, @answer)
      ON CONFLICT(exchange_id, session_id) DO UPDATE SET
        rating = excluded.rating,
        question = excluded.question,
        answer = excluded.answer,
        updated_at = CURRENT_TIMESTAMP
    `
    ).run({
      conversation_id: conversationId,
      exchange_id: exchangeId,
      session_id: sessionId,
      rating,
      question,
      answer
    });

    return db
      .prepare("SELECT * FROM answer_ratings WHERE exchange_id = ? AND session_id = ?")
      .get(exchangeId, sessionId);
  }

  const result = db
    .prepare(
      `
      INSERT INTO answer_ratings (conversation_id, exchange_id, session_id, rating, question, answer)
      VALUES (@conversation_id, NULL, @session_id, @rating, @question, @answer)
    `
    )
    .run({
      conversation_id: conversationId,
      session_id: sessionId,
      rating,
      question,
      answer
    });

  return db.prepare("SELECT * FROM answer_ratings WHERE id = ?").get(result.lastInsertRowid);
}

export function listAnswerRatings({ rating = null, limit = 50 } = {}) {
  const filters = [];
  const parameters = { limit: Math.max(1, Math.min(Number(limit) || 50, 200)) };

  if (rating) {
    filters.push("rating = @rating");
    parameters.rating = rating;
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  return getDb()
    .prepare(
      `
      SELECT *
      FROM answer_ratings
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT @limit
    `
    )
    .all(parameters);
}

export function getAnswerRatingStats() {
  const row = getDb()
    .prepare(
      `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN rating = 'up' THEN 1 ELSE 0 END) AS upCount,
        SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END) AS downCount
      FROM answer_ratings
    `
    )
    .get();

  return {
    total: Number(row?.total || 0),
    upCount: Number(row?.upCount || 0),
    downCount: Number(row?.downCount || 0)
  };
}

export function insertAuditLogEntry({ actorRole, action, targetType = null, targetId = null, details = null }) {
  return getDb()
    .prepare(
      `
      INSERT INTO audit_log (actor_role, action, target_type, target_id, details)
      VALUES (@actor_role, @action, @target_type, @target_id, @details)
    `
    )
    .run({
      actor_role: actorRole,
      action,
      target_type: targetType,
      target_id: targetId !== null && targetId !== undefined ? String(targetId) : null,
      details: details ? JSON.stringify(details) : null
    });
}

export function listAuditLogEntries({ page = 1, pageSize = 50 } = {}) {
  const limit = Math.max(1, Math.min(Number(pageSize) || 50, 200));
  const offset = Math.max(0, ((Number(page) || 1) - 1) * limit);

  const rows = getDb()
    .prepare(
      `
      SELECT *
      FROM audit_log
      ORDER BY created_at DESC, id DESC
      LIMIT @limit OFFSET @offset
    `
    )
    .all({ limit, offset });

  const total = getDb().prepare("SELECT COUNT(*) AS count FROM audit_log").get()?.count || 0;

  return {
    items: rows.map((row) => ({
      id: row.id,
      actorRole: row.actor_role,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      details: row.details ? JSON.parse(row.details) : null,
      createdAt: row.created_at
    })),
    total: Number(total),
    page: Number(page) || 1,
    pageSize: limit
  };
}

export function insertRetrievalScoreLog({
  folderName = null,
  candidateCount = 0,
  retainedCount = 0,
  minScore = null,
  maxScore = null,
  avgScore = null,
  outOfScope = false
}) {
  return getDb()
    .prepare(
      `
      INSERT INTO retrieval_score_logs (
        folder_name, candidate_count, retained_count, min_score, max_score, avg_score, out_of_scope
      )
      VALUES (@folder_name, @candidate_count, @retained_count, @min_score, @max_score, @avg_score, @out_of_scope)
    `
    )
    .run({
      folder_name: folderName,
      candidate_count: candidateCount,
      retained_count: retainedCount,
      min_score: minScore,
      max_score: maxScore,
      avg_score: avgScore,
      out_of_scope: outOfScope ? 1 : 0
    });
}

export function getRetrievalScoreSummary({ limit = 500 } = {}) {
  const rows = getDb()
    .prepare(
      `
      SELECT *
      FROM retrieval_score_logs
      ORDER BY created_at DESC, id DESC
      LIMIT @limit
    `
    )
    .all({ limit: Math.max(1, Math.min(Number(limit) || 500, 2000)) });

  const withScores = rows.filter((row) => row.avg_score !== null && row.avg_score !== undefined);
  const total = rows.length;
  const outOfScopeCount = rows.filter((row) => row.out_of_scope).length;
  const avgOfAverages =
    withScores.length > 0
      ? withScores.reduce((sum, row) => sum + Number(row.avg_score || 0), 0) / withScores.length
      : null;
  const minObserved =
    withScores.length > 0 ? Math.min(...withScores.map((row) => Number(row.min_score ?? row.avg_score))) : null;
  const maxObserved =
    withScores.length > 0 ? Math.max(...withScores.map((row) => Number(row.max_score ?? row.avg_score))) : null;

  return {
    sampleCount: total,
    outOfScopeCount,
    outOfScopeRate: total > 0 ? Number((outOfScopeCount / total).toFixed(3)) : 0,
    averageOfAverageScores: avgOfAverages !== null ? Number(avgOfAverages.toFixed(3)) : null,
    minObservedScore: minObserved,
    maxObservedScore: maxObserved,
    recent: rows.slice(0, 50).map((row) => ({
      id: row.id,
      folderName: row.folder_name,
      candidateCount: row.candidate_count,
      retainedCount: row.retained_count,
      minScore: row.min_score,
      maxScore: row.max_score,
      avgScore: row.avg_score,
      outOfScope: Boolean(row.out_of_scope),
      createdAt: row.created_at
    }))
  };
}

export function updateConversationExchangeRetrievalMetadata(exchangeId, retrievalMetadata) {
  if (!exchangeId) {
    return;
  }

  getDb()
    .prepare("UPDATE conversation_exchanges SET retrieval_metadata = ? WHERE id = ?")
    .run(retrievalMetadata ? JSON.stringify(retrievalMetadata) : null, exchangeId);
}

export function getTopQuestions({ limit = 20 } = {}) {
  const rows = getDb()
    .prepare(
      `
      SELECT
        LOWER(TRIM(question)) AS normalized_question,
        question,
        COUNT(*) AS occurrences,
        MAX(created_at) AS last_asked_at
      FROM conversation_exchanges
      GROUP BY LOWER(TRIM(question))
      ORDER BY occurrences DESC, last_asked_at DESC
      LIMIT @limit
    `
    )
    .all({ limit: Math.max(1, Math.min(Number(limit) || 20, 100)) });

  return rows.map((row) => ({
    question: row.question,
    occurrences: Number(row.occurrences),
    lastAskedAt: row.last_asked_at
  }));
}

export function getUnansweredQuestions({ limit = 20 } = {}) {
  const rows = getDb()
    .prepare(
      `
      SELECT id, conversation_id, question, answer, created_at, retrieval_metadata
      FROM conversation_exchanges
      WHERE retrieval_metadata IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 500
    `
    )
    .all();

  const unanswered = rows.filter((row) => {
    try {
      const metadata = JSON.parse(row.retrieval_metadata || "{}");
      return metadata.groundingMode === "general" || metadata.hasStrongDocumentContext === false;
    } catch {
      return false;
    }
  });

  return unanswered.slice(0, Math.max(1, Math.min(Number(limit) || 20, 100))).map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    question: row.question,
    createdAt: row.created_at
  }));
}

export function purgeAllProjectData() {
  const db = getDb();

  purgeConversationFeedbackData();
  db.prepare("DELETE FROM documents").run();
  db.prepare("DELETE FROM manual_resources").run();
  db.prepare("DELETE FROM chat_metrics").run();
  db.prepare("DELETE FROM user_attachments").run();
  db.prepare(
    "DELETE FROM sqlite_sequence WHERE name IN ('documents', 'manual_resources', 'chat_metrics', 'messages', 'conversation_exchanges', 'conversations', 'feedback', 'improvement_rules', 'user_attachments', 'answer_ratings')"
  ).run();

  setSetting("lastFullIndexAt", "");
  setSetting("lastIndexedDocumentsCount", "0");
  optimizeDatabaseStorage();
}

export function purgeConversationFeedbackData() {
  const db = getDb();

  db.prepare("DELETE FROM improvement_rules").run();
  db.prepare("DELETE FROM feedback").run();
  db.prepare("DELETE FROM answer_ratings").run();
  db.prepare("DELETE FROM conversation_exchanges").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM conversations").run();
  db.prepare(
    "DELETE FROM sqlite_sequence WHERE name IN ('messages', 'conversation_exchanges', 'conversations', 'feedback', 'improvement_rules', 'answer_ratings')"
  ).run();
  optimizeDatabaseStorage();
}

export function optimizeDatabaseStorage() {
  const db = getDb();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
}

function migrateMessagesToConversationExchanges() {
  const db = getDb();
  const existingCount = db
    .prepare("SELECT COUNT(*) AS count FROM conversation_exchanges")
    .get()?.count;

  if (Number(existingCount || 0) > 0) {
    return;
  }

  const conversationIds = db.prepare("SELECT id FROM conversations ORDER BY id ASC").all();
  const insertExchange = db.prepare(`
    INSERT INTO conversation_exchanges (conversation_id, question, answer, created_at)
    VALUES (@conversation_id, @question, @answer, @created_at)
  `);

  const insertMany = db.transaction((ids) => {
    ids.forEach(({ id: conversationId }) => {
      const messages = db
        .prepare(
          `
          SELECT role, content, timestamp
          FROM messages
          WHERE conversation_id = ?
          ORDER BY timestamp ASC, id ASC
        `
        )
        .all(conversationId);

      let pendingQuestion = null;
      let pendingTimestamp = null;

      messages.forEach((message) => {
        if (message.role === "user") {
          pendingQuestion = message.content;
          pendingTimestamp = message.timestamp;
          return;
        }

        if (message.role === "assistant" && pendingQuestion) {
          insertExchange.run({
            conversation_id: conversationId,
            question: pendingQuestion,
            answer: message.content,
            created_at: message.timestamp || pendingTimestamp || new Date().toISOString()
          });
          pendingQuestion = null;
          pendingTimestamp = null;
        }
      });
    });
  });

  insertMany(conversationIds);
}

function backfillFeedbackExchangeIds() {
  const db = getDb();
  const feedbackRows = db
    .prepare(
      `
      SELECT id, conversation_id
      FROM feedback
      WHERE exchange_id IS NULL
      ORDER BY created_at ASC, id ASC
    `
    )
    .all();

  const updateFeedbackExchange = db.prepare(`
    UPDATE feedback
    SET exchange_id = @exchange_id
    WHERE id = @id
  `);

  feedbackRows.forEach((feedback) => {
    const exchange = db
      .prepare(
        `
        SELECT id
        FROM conversation_exchanges
        WHERE conversation_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
      )
      .get(feedback.conversation_id);

    if (exchange?.id) {
      updateFeedbackExchange.run({
        id: feedback.id,
        exchange_id: exchange.id
      });
    }
  });
}
