// Tests d'integration de la memoire de conversation et des extraits visuels
// dans ragService (Ollama et ChromaDB injoignables : profil de modele prudent).
//
//   docker exec assistant-ia-backend npm test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-memory-test-"));
process.env.SQLITE_PATH = path.join(tempRoot, "test.sqlite");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.LOGS_DIR = path.join(tempRoot, "logs");
process.env.CHROMA_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";

let rag;
let db;

before(async () => {
  db = await import("../config/db.js");
  db.initializeDatabase();
  rag = await import("../services/ragService.js");
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("les questions qui renvoient a la conversation sont reconnues", () => {
  for (const question of [
    "Peux-tu reprendre l'etape 2 ?",
    "Comment je m'appelle ?",
    "Elle consomme combien ?",
    "Resume ce qu'on a dit",
    "Tu m'as dit quoi pour le reglage du focus ?"
  ]) {
    assert.equal(rag.isConversationReferenceQuestion(question), true, question);
  }

  assert.equal(rag.isConversationReferenceQuestion("Quels sont les horaires d'ouverture du fablab le samedi matin ?"), false);
});

test("le prompt est ajuste au modele et garde la memoire de la conversation", async () => {
  const history = [
    { role: "user", content: "Je m'appelle Camille et je prepare une boite en contreplaque." },
    { role: "assistant", content: "Bonjour Camille ! Pour une boite en contreplaque de 3 mm, voici les etapes..." },
    ...Array.from({ length: 20 }, (_, index) => [
      { role: "user", content: `Question ${index} sur la decoupe ${"laser ".repeat(40)}` },
      { role: "assistant", content: `Reponse ${index} ${"detail ".repeat(200)}` }
    ]).flat()
  ];
  const retrieval = { manualResources: [], hasRelevantContext: false, contextString: "" };
  const messages = rag.buildChatMessages("Tu te souviens de mon prenom ?", history, retrieval);
  const fitted = await rag.fitChatMessagesForModel(messages, "modele-inexistant", { retrieval });

  assert.equal(retrieval.carriesHistory, true);
  assert.equal(fitted.messages.at(-1).content, "Tu te souviens de mon prenom ?");
  assert.ok(fitted.context.contextWindow > 0);
  assert.ok(fitted.context.estimatedPromptTokens <= fitted.context.inputBudget);
  // Le tout premier echange ne tient pas mot pour mot mais reste en memoire condensee.
  const memory = fitted.messages.find((message) => message.kind === "memory");
  assert.ok(memory, "memoire condensee presente");
  assert.match(memory.content, /Camille/);
});

test("les descriptions visuelles deviennent des extraits rattaches a leur page", async () => {
  const entries = await rag.buildVisualChunkEntries(
    [
      {
        pageNumber: 4,
        pageText: "Schema de cablage\nLe relais coupe l'alimentation.",
        content: "Schema du bouton d'arret d'urgence (rouge, en haut a droite) relie au relais K1. ".repeat(40)
      }
    ],
    { documentLabel: "Notice decoupeuse laser" }
  );

  assert.ok(entries.length > 1, "une longue description est decoupee");
  for (const entry of entries) {
    assert.equal(entry.kind, "visual");
    assert.equal(entry.pageNumber, 4);
    assert.ok(entry.content.startsWith("[Contenu visuel — page 4 du document « Notice decoupeuse laser »]"));
    assert.match(entry.content, /Contexte de la page : Schema de cablage/);
  }
});

test("le cache des descriptions visuelles est relu par fichier, modele et page", () => {
  const key = { fileHash: "abc", model: "gemma3:4b", pageNumber: 2, promptVersion: "v1" };
  assert.equal(db.getVisualDescription(key), null);
  db.saveVisualDescription({ ...key, description: "Photo du capot ouvert." });
  assert.equal(db.getVisualDescription(key), "Photo du capot ouvert.");
  assert.equal(db.getVisualDescription({ ...key, model: "llava:7b" }), null);
  db.saveVisualDescription({ ...key, description: "" });
  assert.equal(db.getVisualDescription(key), "");
});
