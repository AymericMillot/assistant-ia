// Tests du client Ollama contre un faux serveur Ollama local : repli sur un
// autre modele, options des taches utilitaires (reformulations) et absence
// d'appels superflus.
//
//   docker exec assistant-ia-backend npm test
//   (ou, en local : cd backend && npm test)
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-test-"));
process.env.SQLITE_PATH = path.join(tempRoot, "test.sqlite");
process.env.LOGS_DIR = path.join(tempRoot, "logs");
process.env.OLLAMA_FALLBACK_MODELS = "";

const calls = { tags: 0, chatBodies: [] };
const installedModels = [
  { name: "principal:latest", size: 5 },
  { name: "pense:latest", size: 3 },
  { name: "secours:latest", size: 1 },
  { name: "nomic-embed-text-v2-moe:latest", size: 0.5 }
];

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

const fakeOllama = http.createServer(async (req, res) => {
  const body = await readJsonBody(req);
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/api/tags") {
    calls.tags += 1;
    res.end(JSON.stringify({ models: installedModels }));
    return;
  }

  if (req.url === "/api/show") {
    res.end(
      JSON.stringify({
        capabilities: body.model === "pense:latest" ? ["completion", "thinking"] : ["completion"],
        model_info: { "llama.context_length": 8192 }
      })
    );
    return;
  }

  if (req.url === "/api/chat") {
    calls.chatBodies.push(body);
    if (body.model === "absent:latest") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "model 'absent:latest' not found, try pulling it first" }));
      return;
    }
    if (body.model === "casse:latest") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "panne interne" }));
      return;
    }
    res.end(JSON.stringify({ message: { content: `reponse de ${body.model}` }, done: true }));
    return;
  }

  res.statusCode = 404;
  res.end("{}");
});

let ollama;

before(async () => {
  await new Promise((resolve) => fakeOllama.listen(0, "127.0.0.1", resolve));
  process.env.OLLAMA_URL = `http://127.0.0.1:${fakeOllama.address().port}`;
  const db = await import("../config/db.js");
  db.initializeDatabase();
  ollama = await import("../services/ollamaService.js");
});

after(async () => {
  await new Promise((resolve) => fakeOllama.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("le modele principal repond sans lister les modeles installes a chaque appel", async () => {
  await ollama.generateChatAnswer({ model: "principal:latest", messages: [{ role: "user", content: "a" }] });
  const tagsCallsAfterWarmup = calls.tags;

  const result = await ollama.generateChatAnswer({
    model: "principal:latest",
    messages: [{ role: "user", content: "b" }]
  });

  assert.equal(result.text, "reponse de principal:latest");
  assert.equal(result.usedFallbackModel, false);
  assert.equal(calls.tags, tagsCallsAfterWarmup);
});

test("un modele absent bascule sur le plus leger des modeles visibles", async () => {
  const result = await ollama.generateChatAnswer({
    model: "absent:latest",
    messages: [{ role: "user", content: "question" }]
  });

  assert.equal(result.modelUsed, "secours:latest");
  assert.equal(result.usedFallbackModel, true);
  assert.equal(result.text, "reponse de secours:latest");
});

test("une erreur ordinaire du modele principal n'essaie aucun autre modele", async () => {
  const chatCallsBefore = calls.chatBodies.length;

  await assert.rejects(
    ollama.generateChatAnswer({ model: "casse:latest", messages: [{ role: "user", content: "x" }] }),
    /panne interne/
  );
  assert.equal(calls.chatBodies.length, chatCallsBefore + 1);
});

test("tache utilitaire : longueur plafonnee et reflexion coupee pour un modele raisonneur", async () => {
  await ollama.generateChatAnswer({
    model: "pense:latest",
    messages: [{ role: "user", content: "reformule" }],
    maxTokens: 50,
    disableThinking: true
  });

  const body = calls.chatBodies.at(-1);
  assert.equal(body.think, false);
  assert.equal(body.options.num_predict, 50);
  assert.equal(body.options.num_ctx > 0, true);
});

test("le parametre think n'est jamais envoye a un modele qui ne raisonne pas", async () => {
  await ollama.generateChatAnswer({
    model: "principal:latest",
    messages: [{ role: "user", content: "reformule" }],
    disableThinking: true
  });

  const body = calls.chatBodies.at(-1);
  assert.equal("think" in body, false);
  assert.equal("num_predict" in body.options, false);
});
