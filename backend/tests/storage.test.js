// Tests de la couche de stockage : reglages SQLite, cache des requetes
// preparees, purge du journal des scores et synchronisation incrementale du
// dossier des documents (sans Ollama ni ChromaDB).
//
//   docker exec assistant-ia-backend npm test
//   (ou, en local : cd backend && npm test)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "storage-test-"));
process.env.SQLITE_PATH = path.join(tempRoot, "test.sqlite");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.LOGS_DIR = path.join(tempRoot, "logs");
process.env.FILESYSTEM_SYNC_COOLDOWN_MS = "0";

let db;
let fileService;

before(async () => {
  db = await import("../config/db.js");
  db.initializeDatabase();
  fileService = await import("../services/fileService.js");
});

after(() => {
  db.closeDatabase();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("SQLite : WAL, synchronous NORMAL et attente du verrou", () => {
  const database = db.getDb();
  assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(database.pragma("synchronous", { simple: true }), 1);
  assert.equal(database.pragma("busy_timeout", { simple: true }), 5000);
});

test("une meme requete n'est compilee qu'une fois", () => {
  const database = db.getDb();
  const first = database.prepare("SELECT value FROM settings WHERE key = ?");
  const second = database.prepare("SELECT value FROM settings WHERE key = ?");
  assert.equal(first, second);
  assert.equal(db.getSetting("autoIndexEnabled"), "true");
});

test("le journal des scores de recherche est borne", () => {
  const insertMany = db.getDb().transaction((count) => {
    for (let index = 0; index < count; index += 1) {
      db.insertRetrievalScoreLog({ candidateCount: index, retainedCount: 1, avgScore: 0.5 });
    }
  });
  insertMany(2100);

  const removed = db.pruneRetrievalScoreLogs({ keep: 2000 });
  const remaining = db.getDb().prepare("SELECT COUNT(*) AS count, MIN(candidate_count) AS oldest FROM retrieval_score_logs").get();

  assert.equal(removed, 100);
  assert.equal(remaining.count, 2000);
  // Ce sont bien les plus anciennes lignes qui disparaissent.
  assert.equal(remaining.oldest, 100);
});

test("synchronisation : nouveau fichier, fichier inchange, fichier modifie, fichier supprime", async () => {
  const folderPath = path.join(process.env.UPLOADS_DIR, "procedures");
  fs.mkdirSync(folderPath, { recursive: true });
  const filePath = path.join(folderPath, "securite.txt");
  fs.writeFileSync(filePath, "Porter des lunettes de protection.");

  const firstSync = await fileService.syncFilesystemToDatabase();
  assert.equal(firstSync.changedDocuments.length, 1);
  const created = db.getDocumentByRelativePath(path.join("procedures", "securite.txt"));
  assert.equal(created.indexing_status, "pending");

  // Fichier inchange : aucune reecriture de la ligne.
  db.getDb().prepare("UPDATE documents SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(created.id);
  const unchangedSync = await fileService.syncFilesystemToDatabase();
  assert.equal(unchangedSync.changedDocuments.length, 0);
  assert.equal(db.getDocumentById(created.id).updated_at, "2000-01-01 00:00:00");

  // Contenu modifie : nouvelle empreinte, document a reindexer.
  db.getDb().prepare("UPDATE documents SET indexing_status = 'indexed' WHERE id = ?").run(created.id);
  fs.writeFileSync(filePath, "Porter des lunettes et des gants de protection.");
  const changedSync = await fileService.syncFilesystemToDatabase();
  const updated = db.getDocumentById(created.id);
  assert.equal(changedSync.changedDocuments.length, 1);
  assert.notEqual(updated.md5_hash, created.md5_hash);
  assert.equal(updated.indexing_status, "pending");

  fs.rmSync(filePath);
  const removedSync = await fileService.syncFilesystemToDatabase();
  assert.equal(removedSync.removedRecords.length, 1);
  assert.equal(db.getDocumentById(created.id), undefined);
});
