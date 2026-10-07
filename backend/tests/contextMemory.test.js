// Tests du budget de contexte, de la memoire de conversation et du choix des
// pages a decrire par le modele de vision (modules purs : ni Ollama, ni
// ChromaDB, ni SQLite).
//
//   docker exec assistant-ia-backend npm test
//   (ou, en local : cd backend && npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeEffectiveContextWindow,
  computeKvBytesPerToken,
  estimateMessagesTokens,
  fitMessagesToContext,
  packConversationHistory,
  planPromptBudget,
  truncateToTokens
} from "../services/contextBudget.js";
import {
  buildVisionPrompt,
  cleanVisionDescription,
  NO_VISUAL_CONTENT_MARKER,
  parsePdfImagesList,
  selectPagesForVision
} from "../services/pdfVisionPages.js";

const llamaInfo = {
  "llama.block_count": 28,
  "llama.attention.head_count": 24,
  "llama.attention.head_count_kv": 8,
  "llama.embedding_length": 3072,
  "llama.context_length": 131072
};

function buildHistory(exchanges, answerLength = 300) {
  return Array.from({ length: exchanges }, (_, index) => [
    { role: "user", content: `Question numero ${index + 1} sur la decoupeuse laser ?` },
    { role: "assistant", content: `Reponse ${index + 1} : ${"detail ".repeat(Math.ceil(answerLength / 7))}`.trim() }
  ]).flat();
}

function buildPrompt({ history = [], ragCharacters = 4000, question = "Et pour la suite ?" } = {}) {
  return [
    { role: "system", content: "Consignes generales de l'assistant." },
    { role: "system", content: "[RÈGLE 1] Toujours rappeler les EPI." },
    { role: "system", kind: "examples", content: "Bon exemple ".repeat(80) },
    { role: "system", kind: "rag", content: `[DOC 1]\n${"extrait ".repeat(ragCharacters / 8)}` },
    ...history.map((entry) => ({ ...entry, kind: "history" })),
    { role: "user", kind: "question", content: question }
  ];
}

test("le cout KV par token est deduit des metadonnees du modele", () => {
  // 28 couches x 8 tetes KV x (128 + 128) x 2 octets (f16)
  assert.equal(computeKvBytesPerToken(llamaInfo), 28 * 8 * 256 * 2);
  assert.equal(computeKvBytesPerToken(llamaInfo, { kvCacheType: "q8_0" }), 28 * 8 * 256);
  assert.equal(computeKvBytesPerToken({}), null);
});

test("la fenetre effective s'adapte au modele, a la memoire et au plafond explicite", () => {
  // Modele 128k sans contrainte memoire : plafond automatique de confort.
  assert.equal(computeEffectiveContextWindow({ modelMaxContext: 131072 }), 32768);
  // Petit modele : jamais au-dela de son maximum.
  assert.equal(computeEffectiveContextWindow({ modelMaxContext: 8192 }), 8192);
  // Memoire limitee : la fenetre se reduit (1 Gio / 114 688 octets par token).
  assert.equal(
    computeEffectiveContextWindow({
      modelMaxContext: 131072,
      kvBytesPerToken: computeKvBytesPerToken(llamaInfo),
      kvMemoryBudgetBytes: 1024 ** 3
    }),
    9216
  );
  // OLLAMA_NUM_CTX explicite : respecte, borne par le maximum du modele.
  assert.equal(computeEffectiveContextWindow({ modelMaxContext: 131072, configuredContext: 65536 }), 65536);
  assert.equal(computeEffectiveContextWindow({ modelMaxContext: 4096, configuredContext: 65536 }), 4096);
  // Modele inconnu : valeur prudente.
  assert.equal(computeEffectiveContextWindow({}), 8192);
});

test("un modele de raisonnement reserve plus de place a la reponse", () => {
  const normal = planPromptBudget({ contextWindow: 8192 });
  const reasoning = planPromptBudget({ contextWindow: 8192, isReasoning: true });
  assert.ok(reasoning.outputReserve > normal.outputReserve);
  assert.ok(reasoning.inputBudget < normal.inputBudget);
});

test("la troncature coupe proprement entre deux extraits", () => {
  const text = "[DOC 1]\nPremier extrait complet.\n\n[DOC 2]\nSecond extrait qui sera coupe en plein milieu de sa phrase.";
  const truncated = truncateToTokens(text, 22, 3.2);
  assert.ok(truncated.startsWith("[DOC 1]\nPremier extrait complet."));
  assert.ok(!truncated.includes("Second extrait qui sera coupe en plein"));
  assert.ok(truncated.endsWith("[…]"));
});

test("toute la conversation tient dans un grand modele", () => {
  const history = buildHistory(8);
  const { messages, stats } = fitMessagesToContext(buildPrompt({ history }), { contextWindow: 32768 });
  assert.equal(stats.history.verbatimMessages, 16);
  assert.equal(stats.history.condensedExchanges, 0);
  assert.equal(messages.at(-1).content, "Et pour la suite ?");
  assert.equal(messages.at(-2).role, "assistant");
  assert.equal(stats.overflow, false);
});

test("un petit modele garde le dernier echange et condense les plus anciens", () => {
  const history = buildHistory(30, 900);
  const { messages, stats } = fitMessagesToContext(buildPrompt({ history }), { contextWindow: 4096 });
  const memory = messages.find((message) => message.kind === "memory");

  assert.ok(stats.history.verbatimMessages >= 2, "le dernier echange est conserve mot pour mot");
  assert.ok(stats.history.verbatimMessages < 60);
  assert.ok(memory, "les echanges anciens sont condenses plutot qu'oublies");
  assert.match(memory.content, /Question numero \d+/);
  assert.equal(messages.filter((message) => message.kind === "history")[0].role, "user");
  assert.ok(stats.estimatedPromptTokens <= stats.inputBudget, "le prompt tient dans la fenetre");
  // Consignes et question jamais tronquees.
  assert.equal(messages[0].content, "Consignes generales de l'assistant.");
  assert.equal(messages.at(-1).content, "Et pour la suite ?");
});

test("les documents sont reduits avant le dernier echange quand la place manque", () => {
  const history = buildHistory(1, 1200);
  const { messages, stats } = fitMessagesToContext(buildPrompt({ history, ragCharacters: 40000 }), {
    contextWindow: 4096
  });
  const rag = messages.find((message) => message.kind === "rag");

  assert.ok(rag && rag.content.length < 40000);
  assert.equal(stats.truncatedDocuments, 1);
  assert.equal(stats.history.verbatimMessages, 2);
  assert.ok(estimateMessagesTokens(messages) <= stats.inputBudget);
});

test("les exemples notes sont sacrifies en premier", () => {
  const { messages, stats } = fitMessagesToContext(buildPrompt({ ragCharacters: 9000 }), { contextWindow: 4096 });
  assert.equal(stats.droppedExamples, 1);
  assert.ok(!messages.some((message) => message.kind === "examples"));
  assert.ok(messages.some((message) => message.kind === "rag"));
});

test("changement de sujet : memoire condensee seulement, pas d'historique brut", () => {
  const history = buildHistory(3);
  const { messages, stats } = fitMessagesToContext(buildPrompt({ history }), {
    contextWindow: 8192,
    verbatimHistory: false
  });
  assert.equal(stats.history.verbatimMessages, 0);
  assert.equal(stats.history.condensedExchanges, 3);
  assert.ok(messages.some((message) => message.kind === "memory"));
});

test("la limite de messages verbatim est respectee, le reste est condense", () => {
  const packed = packConversationHistory(buildHistory(10, 100), { tokenBudget: 20000, maxVerbatimMessages: 6 });
  assert.equal(packed.stats.verbatimMessages, 6);
  assert.equal(packed.stats.condensedExchanges, 7);
  assert.equal(packed.stats.droppedMessages, 0);
});

test("une tres longue derniere reponse est raccourcie, pas perdue", () => {
  const history = [
    { role: "user", content: "Explique toute la procedure." },
    { role: "assistant", content: "Etape. ".repeat(4000) }
  ];
  const packed = packConversationHistory(history, { tokenBudget: 600 });
  assert.equal(packed.stats.verbatimMessages, 2);
  assert.ok(packed.messages[1].content.endsWith("[…]"));
});

const pdfImagesList = `page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio
--------------------------------------------------------------------------------------------
   1     0 image     200    60  rgb     3   8  jpeg   no         5  0   150   150 4.1K 1.1%
   1     1 image    1600  1200  rgb     3   8  jpeg   no         7  0   300   300  180K 3.1%
   1     2 smask    1600  1200  gray    1   8  image  no         8  0   300   300  12K 0.6%
   2     3 image     200    60  rgb     3   8  jpeg   no         5  0   150   150 4.1K 1.1%
   3     4 image     200    60  rgb     3   8  jpeg   no         5  0   150   150 4.1K 1.1%
   3     5 image      40    40  rgb     3   8  jpeg   no        11  0   300   300  1K 0.1%
   4     6 image     200    60  rgb     3   8  jpeg   no         5  0   150   150 4.1K 1.1%
   4     7 image     900   700  rgb     3   8  jpeg   no        13  0   300   300  90K 2.0%
`;

test("la sortie de pdfimages -list est analysee", () => {
  const images = parsePdfImagesList(pdfImagesList);
  assert.equal(images.length, 8);
  assert.deepEqual(images[1], { pageNumber: 1, type: "image", width: 1600, height: 1200, objectId: "7 0" });
});

test("seules les pages illustrees ou scannees sont confiees a la vision", () => {
  const pages = [
    { pageNumber: 1, text: "Presentation de la machine avec une photo de la face avant." },
    { pageNumber: 2, text: "Texte seul avec le logo en en-tete, consignes generales d'utilisation." },
    { pageNumber: 3, text: "Une petite icone seulement a cote d'un paragraphe explicatif." },
    { pageNumber: 4, text: "Schema de cablage du bouton d'arret d'urgence et du relais." },
    { pageNumber: 5, text: "   " }
  ];
  const { selected } = selectPagesForVision(pages, parsePdfImagesList(pdfImagesList), {});
  // Logo repete (objet 5) et icone minuscule ignores ; page 5 sans texte = scan.
  assert.deepEqual(
    selected.map((page) => [page.pageNumber, page.reason]),
    [[1, "images"], [4, "images"], [5, "low-text"]]
  );
});

test("au-dela de la limite, les scans et pages les plus illustrees sont prioritaires", () => {
  const pages = [1, 2, 3].map((pageNumber) => ({ pageNumber, text: pageNumber === 3 ? "" : "Du texte suffisant pour ne pas etre une page scannee." }));
  const images = [
    { pageNumber: 1, type: "image", width: 300, height: 300, objectId: "1 0" },
    { pageNumber: 2, type: "image", width: 1200, height: 900, objectId: "2 0" }
  ];
  const { selected, skipped } = selectPagesForVision(pages, images, { maxPages: 2 });
  assert.deepEqual(selected.map((page) => page.pageNumber), [2, 3]);
  assert.equal(skipped, 1);
});

test("le prompt de vision adapte sa consigne aux pages scannees", () => {
  const illustrated = buildVisionPrompt({ documentLabel: "Notice laser", pageNumber: 2, totalPages: 9, pageText: "Reglage du focus" });
  const scanned = buildVisionPrompt({ documentLabel: "Notice laser", pageNumber: 3, totalPages: 9, pageText: "", reason: "low-text" });
  assert.match(illustrated, /Reglage du focus/);
  assert.match(illustrated, /uniquement le contenu visuel/);
  assert.match(scanned, /Transcris d'abord fidelement/);
  assert.match(scanned, new RegExp(NO_VISUAL_CONTENT_MARKER));
});

test("les descriptions de vision sont nettoyees pour l'indexation", () => {
  assert.equal(cleanVisionDescription(NO_VISUAL_CONTENT_MARKER), "");
  assert.equal(cleanVisionDescription(` ${NO_VISUAL_CONTENT_MARKER}. `), "");
  assert.equal(
    cleanVisionDescription("<think>analyse</think>\n## Schema\nBouton d'arret d'urgence rouge en haut a droite."),
    "**Schema**\nBouton d'arret d'urgence rouge en haut a droite."
  );
  assert.equal(
    cleanVisionDescription("Voici la description de la page :\nPhoto de la decoupeuse laser, capot ouvert."),
    "Photo de la decoupeuse laser, capot ouvert."
  );
});

test("la memoire condensee garde le premier echange et les plus recents", () => {
  const history = [
    { role: "user", content: "Je m'appelle Camille, je fabrique une boite." },
    { role: "assistant", content: "Bonjour Camille." },
    ...buildHistory(40, 400)
  ];
  const packed = packConversationHistory(history, { tokenBudget: 1500, maxVerbatimMessages: 2 });
  assert.match(packed.memoryMessage.content, /Camille/);
  assert.match(packed.memoryMessage.content, /intermediaire\(s\) omis/);
  assert.match(packed.memoryMessage.content, /Question numero 39 /);
  assert.ok(packed.stats.droppedMessages > 0);
});
