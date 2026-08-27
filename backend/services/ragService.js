import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { execFile } from "child_process";
import AdmZip from "adm-zip";
import { load as loadHtml } from "cheerio";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { Document } from "@langchain/core/documents";
import { OllamaEmbeddings } from "@langchain/ollama";
import { getActiveModel, getModelContextLength } from "./ollamaService.js";
import { TokenTextSplitter } from "@langchain/textsplitters";
import { ChromaClient } from "chromadb";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import ExcelJS from "exceljs";
import {
  getDocumentById,
  getDocumentByRelativePath,
  getDocuments,
  getManualResources,
  getSetting,
  insertRetrievalScoreLog
} from "../config/db.js";
import { getBranding } from "../config/branding.js";
import { logger } from "../config/logger.js";
import { getAbsoluteDocumentPath, listFolders, syncFilesystemToDatabase } from "./fileService.js";
import { getRelevantImprovementRules } from "./feedbackService.js";
import { getRatingSignalsForQuestion } from "./ratingService.js";

// Collections dediees hors dossiers documentaires : liens web scrapes et pieces jointes utilisateur.
const webLinksFolderKey = "_web_links";
const attachmentsFolderKey = "_attachments";

const chromaUrl = new URL(process.env.CHROMA_URL || "http://localhost:8000");
const chromaClient = new ChromaClient({
  host: chromaUrl.hostname,
  port: Number(chromaUrl.port || (chromaUrl.protocol === "https:" ? 443 : 80)),
  ssl: chromaUrl.protocol === "https:"
});
const minimumVectorRelevanceScore = Number(process.env.MIN_VECTOR_RELEVANCE_SCORE || 0.16);
const minimumManualOverlapScore = Number(process.env.MIN_MANUAL_OVERLAP_SCORE || 0.08);
const minimumDocumentOverlapScore = Number(process.env.MIN_DOCUMENT_OVERLAP_SCORE || 0.08);
const ragTopK = Number(process.env.RAG_TOP_K || 6);
const defaultConversationHistoryLimit = Number(process.env.CHAT_HISTORY_LIMIT || 10);
const maxConversationCharacters = Number(process.env.CHAT_HISTORY_MAX_CHARACTERS || 12000);
const maxChunksPerDocument = Number(process.env.RAG_MAX_CHUNKS_PER_DOCUMENT || 3);
const maxContextCharacters = Number(process.env.RAG_MAX_CONTEXT_CHARACTERS || 7000);
const maxManualResourcesInPrompt = Number(process.env.MANUAL_RESOURCE_PROMPT_LIMIT || 4);
const maxDocumentLinksInPrompt = Number(process.env.DOCUMENT_LINK_PROMPT_LIMIT || 4);
const maxEmbeddingChunkCharacters = Number(process.env.RAG_MAX_EMBEDDING_CHUNK_CHARACTERS || 1200);
const embeddingChunkCharacterOverlap = Number(
  process.env.RAG_EMBEDDING_CHUNK_CHARACTER_OVERLAP || 120
);
const embeddingRequestBatchSize = Number(process.env.RAG_EMBEDDING_REQUEST_BATCH_SIZE || 8);
const searchCache = new Map();
const vectorStoreCache = new Map();
const collectionCache = new Map();
let embeddingsInstance = null;
const execFileAsync = promisify(execFile);
function getDomainKeywords() {
  const branding = getBranding();
  const keywords = Array.isArray(branding.domainKeywords) ? branding.domainKeywords : [];
  return new Set(keywords.map(normalizeFrenchStem));
}

function slugify(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function getCollectionName(folderName) {
  return `fablab_${slugify(folderName)}`;
}

let embeddingsInstanceModel = null;

function getEmbeddings() {
  const configuredEmbeddingModel = getSetting(
    "embeddingModel",
    process.env.EMBEDDING_MODEL || "nomic-embed-text-v2-moe:latest"
  );
  const embeddingModel = String(configuredEmbeddingModel || "").includes(":")
    ? configuredEmbeddingModel
    : `${configuredEmbeddingModel}:latest`;

  // Si le modele d'embedding configure change, l'instance en cache doit etre reconstruite,
  // sinon les nouvelles indexations utiliseraient l'ancien modele.
  if (embeddingsInstance && embeddingsInstanceModel === embeddingModel) {
    return embeddingsInstance;
  }

  embeddingsInstance = new OllamaEmbeddings({
    model: embeddingModel,
    baseUrl: process.env.OLLAMA_URL || "http://localhost:11434"
  });
  if (embeddingsInstanceModel && embeddingsInstanceModel !== embeddingModel) {
    vectorStoreCache.clear();
    collectionCache.clear();
    searchCache.clear();
  }
  embeddingsInstanceModel = embeddingModel;

  return embeddingsInstance;
}

function getChromaEmbeddingFunction() {
  const embeddings = getEmbeddings();

  return {
    name: "ollama-embeddings",
    generate: async (texts) => {
      const safeBatchSize = Math.max(1, embeddingRequestBatchSize);
      const allEmbeddings = [];

      for (let index = 0; index < texts.length; index += safeBatchSize) {
        const batch = texts.slice(index, index + safeBatchSize);
        const batchEmbeddings = await embeddings.embedDocuments(batch);
        allEmbeddings.push(...batchEmbeddings);
      }

      return allEmbeddings;
    },
    generateForQueries: async (texts) =>
      Promise.all(texts.map((text) => embeddings.embedQuery(text)))
  };
}

async function getVectorStore(folderName) {
  const cacheKey = getCollectionName(folderName);
  if (vectorStoreCache.has(cacheKey)) {
    return vectorStoreCache.get(cacheKey);
  }

  const vectorStore = new Chroma(getEmbeddings(), {
    url: process.env.CHROMA_URL || "http://localhost:8000",
    collectionName: cacheKey
  });
  vectorStoreCache.set(cacheKey, vectorStore);
  return vectorStore;
}

async function getCollection(folderName) {
  const collectionName = getCollectionName(folderName);
  if (collectionCache.has(collectionName)) {
    return collectionCache.get(collectionName);
  }

  const collectionPromise = chromaClient.getOrCreateCollection({
    name: collectionName,
    embeddingFunction: getChromaEmbeddingFunction()
  });
  collectionCache.set(collectionName, collectionPromise);
  return collectionPromise;
}

async function deleteCollectionIfExists(folderName) {
  const collectionName = getCollectionName(folderName);
  const collections = await chromaClient.listCollections();
  const exists = collections.some((collection) => {
    if (typeof collection === "string") {
      return collection === collectionName;
    }

    return collection?.name === collectionName;
  });

  if (exists) {
    await chromaClient.deleteCollection({ name: collectionName });
    collectionCache.delete(collectionName);
    vectorStoreCache.delete(collectionName);
    return true;
  }

  return false;
}

async function readFileContent(absolutePath) {
  const extension = path.extname(absolutePath).toLowerCase();

  if (extension === ".pdf") {
    return readPdfContent(absolutePath);
  }

  if (extension === ".docx") {
    const payload = await mammoth.extractRawText({ path: absolutePath });
    return payload.value;
  }

  if (extension === ".odt") {
    const zip = new AdmZip(absolutePath);
    const contentEntry = zip.getEntry("content.xml");
    if (!contentEntry) {
      throw new Error("Impossible de lire le contenu du fichier ODT.");
    }

    const xml = contentEntry.getData().toString("utf8");
    const $ = loadHtml(xml, { xmlMode: true });
    return $("text\\:p, text\\:h, text\\:span")
      .toArray()
      .map((node) => $(node).text())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (extension === ".xlsx") {
    const workbook = new ExcelJS.Workbook();
    // La version npm de SheetJS ne fournit aucun correctif pour ses alertes
    // de pollution de prototype/ReDoS. ExcelJS permet de conserver la lecture
    // XLSX tout en bornant le travail effectue sur un classeur pathologique.
    await workbook.xlsx.readFile(absolutePath, {
      ignoreNodes: ["dataValidations", "extLst"]
    });

    const maxSheets = Number(process.env.XLSX_MAX_SHEETS || 30);
    const maxRowsPerSheet = Number(process.env.XLSX_MAX_ROWS_PER_SHEET || 20_000);
    const maxCellsPerRow = Number(process.env.XLSX_MAX_CELLS_PER_ROW || 200);
    const sections = [];

    workbook.worksheets.slice(0, maxSheets).forEach((worksheet) => {
      const rows = [];
      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber > maxRowsPerSheet) {
          return;
        }

        const cells = [];
        row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
          if (columnNumber <= maxCellsPerRow) {
            const text = String(cell.text ?? "").trim();
            if (text) {
              cells.push(text);
            }
          }
        });

        if (cells.length > 0) {
          rows.push(cells.join(" | "));
        }
      });

      if (rows.length > 0) {
        sections.push(`Feuille: ${worksheet.name}\n${rows.join("\n")}`);
      }
    });

    return sections.join("\n\n");
  }

  if (extension === ".html" || extension === ".htm") {
    const html = await fs.readFile(absolutePath, "utf8");
    const $ = loadHtml(html);
    return $("body").text().replace(/\s+/g, " ").trim();
  }

  return fs.readFile(absolutePath, "utf8");
}

async function readPdfWithPdfParse(absolutePath) {
  const buffer = await fs.readFile(absolutePath);
  const parser = new PDFParse({ data: buffer });
  const originalConsoleError = console.error;

  try {
    console.error = (...args) => {
      const message = args.map((part) => String(part ?? "")).join(" ");
      if (
        message.includes("Invalid PDF structure") ||
        message.includes("Invalid Root reference")
      ) {
        return;
      }

      originalConsoleError(...args);
    };
    const payload = await parser.getText();
    return payload.text;
  } finally {
    console.error = originalConsoleError;
    await parser.destroy().catch(() => {});
  }
}

async function isLikelyValidPdf(absolutePath) {
  const handle = await fs.open(absolutePath, "r");

  try {
    const headerBuffer = Buffer.alloc(8);
    const { bytesRead } = await handle.read(headerBuffer, 0, headerBuffer.length, 0);
    const header = headerBuffer.subarray(0, bytesRead).toString("latin1");
    return header.startsWith("%PDF-");
  } finally {
    await handle.close();
  }
}

async function readPdfWithPdftotext(absolutePath) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fablab-pdf-"));
  const outputPath = path.join(tempDir, "document.txt");

  try {
    await execFileAsync("pdftotext", ["-enc", "UTF-8", absolutePath, outputPath], {
      maxBuffer: 50 * 1024 * 1024
    });
    return await fs.readFile(outputPath, "utf8");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function readPdfContent(absolutePath) {
  const validPdfHeader = await isLikelyValidPdf(absolutePath);
  if (!validPdfHeader) {
    throw new Error(
      "Le fichier n'est pas un PDF valide. Verifiez son extension ou remplacez-le par un vrai PDF."
    );
  }

  try {
    return await readPdfWithPdfParse(absolutePath);
  } catch (error) {
    logger.warn("Extraction PDF principale echouee, tentative de repli pdftotext", {
      absolutePath,
      error: error?.message || String(error)
    });
  }

  try {
    return await readPdfWithPdftotext(absolutePath);
  } catch (fallbackError) {
    throw new Error(
      `Impossible d'extraire le texte du PDF. Le fichier est peut-etre corrompu ou compose d'images uniquement. Detail: ${
        fallbackError?.message || String(fallbackError)
      }`
    );
  }
}

function formatSource(result) {
  const score = typeof result.score === "number" ? result.score : 0;
  const relevanceScore = Number((1 / (1 + Math.max(score, 0))).toFixed(3));

  if (result.metadata.source_type === "web_link") {
    return {
      documentId: `link-${result.metadata.link_id}`,
      folder: "documentation",
      fileName: result.metadata.original_name || result.metadata.file_name || "Page web",
      relativePath: result.metadata.file_name || "",
      chunkIndex: result.metadata.chunk_index,
      relevanceScore,
      visibility: "public",
      downloadUrl: result.metadata.file_name || null
    };
  }

  if (result.metadata.source_type === "attachment") {
    // Les pieces jointes utilisateur nourrissent les reponses mais ne sont jamais
    // exposees comme sources telechargeables.
    return {
      documentId: `attachment-${result.metadata.attachment_id}`,
      folder: "pieces-jointes",
      fileName: result.metadata.original_name || "Piece jointe",
      relativePath: "",
      chunkIndex: result.metadata.chunk_index,
      relevanceScore,
      visibility: "private",
      downloadUrl: null
    };
  }

  const relativePath = result.metadata.source_path;
  const folderName = result.metadata.folder;
  const originalName = result.metadata.original_name || result.metadata.file_name;
  const filename = result.metadata.file_name || "";
  const documentRecord =
    (result.metadata.document_id ? getDocumentById(Number(result.metadata.document_id)) : null) ||
    getDocumentByRelativePath(relativePath) ||
    getDocuments({ folderName }).find(
      (document) =>
        document.relative_path === relativePath ||
        document.original_name === originalName ||
        document.filename === filename
    ) ||
    null;
  const metadataVisibility = result.metadata.visibility === "private" ? "private" : "public";
  const visibility = documentRecord?.visibility || metadataVisibility;

  return {
    documentId: documentRecord?.id || null,
    folder: folderName,
    fileName: originalName,
    relativePath,
    chunkIndex: result.metadata.chunk_index,
    relevanceScore,
    visibility,
    downloadUrl:
      visibility === "public" && documentRecord?.id
        ? `/api/chat/documents/${documentRecord.id}/download`
        : null
  };
}

function formatDocumentRecordSource(documentRecord) {
  if (!documentRecord) {
    return null;
  }

  const visibility = documentRecord.visibility === "private" ? "private" : "public";

  return {
    documentId: documentRecord.id || null,
    folder: documentRecord.folder_name,
    fileName: documentRecord.original_name || documentRecord.filename,
    relativePath: documentRecord.relative_path,
    chunkIndex: null,
    relevanceScore: 1,
    visibility,
    downloadUrl:
      visibility === "public" && documentRecord.id
        ? `/api/chat/documents/${documentRecord.id}/download`
        : null
  };
}

function formatDocumentLinkSource(resource) {
  if (!resource) {
    return null;
  }

  return {
    documentId: `link-${resource.id}`,
    folder: "documentation",
    fileName: resource.title,
    relativePath: resource.link_url || "",
    chunkIndex: null,
    relevanceScore: Number(resource.priorityScore || 1),
    visibility: "public",
    downloadUrl: resource.link_url || null
  };
}

function normalizeIntentText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’]/g, "'");
}

function normalizeExtractedText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function splitChunkByCharacters(value, maxCharacters, overlapCharacters) {
  const text = String(value || "").trim();
  if (!text) {
    return [];
  }

  if (text.length <= maxCharacters) {
    return [text];
  }

  const chunks = [];
  const safeMaxCharacters = Math.max(300, maxCharacters);
  const safeOverlapCharacters = Math.max(0, Math.min(overlapCharacters, safeMaxCharacters - 50));
  let start = 0;

  while (start < text.length) {
    let end = Math.min(text.length, start + safeMaxCharacters);
    let slice = text.slice(start, end);

    if (end < text.length) {
      const breakCandidates = [
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf("\n"),
        slice.lastIndexOf(". "),
        slice.lastIndexOf(" ")
      ].filter((index) => index > safeMaxCharacters * 0.55);

      if (breakCandidates.length > 0) {
        const bestBreak = Math.max(...breakCandidates);
        end = start + bestBreak + 1;
        slice = text.slice(start, end);
      }
    }

    const normalizedSlice = slice.trim();
    if (normalizedSlice) {
      chunks.push(normalizedSlice);
    }

    if (end >= text.length) {
      break;
    }

    start = Math.max(end - safeOverlapCharacters, start + 1);
  }

  return chunks;
}

/**
 * Decoupe un texte en blocs structurels : un bloc "table" (lignes markdown/CSV
 * a base de "|" ou de tabulations regulieres) reste toujours entier tant qu'il
 * tient sous la limite de caracteres, pour ne jamais couper une ligne de
 * tableau en deux morceaux indexes separement. Le reste du texte est segmente
 * par titres markdown (#, ##...) pour eviter de melanger deux sections dans
 * un meme chunk de decoupage par tokens.
 */
function isTableLikeLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  const pipeCount = (trimmed.match(/\|/g) || []).length;
  if (pipeCount >= 2) {
    return true;
  }

  // Tableau markdown de separation, ex: |---|---|
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(trimmed);
}

function splitIntoStructuralBlocks(text) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  let currentLines = [];
  let currentIsTable = null;

  function flush() {
    if (currentLines.length === 0) {
      return;
    }
    const content = currentLines.join("\n").trim();
    if (content) {
      blocks.push({ type: currentIsTable ? "table" : "text", content });
    }
    currentLines = [];
  }

  lines.forEach((line) => {
    const isHeaderLine = /^#{1,6}\s+\S/.test(line.trim());
    const isTable = isTableLikeLine(line);

    if (isHeaderLine && currentLines.length > 0) {
      flush();
    }

    if (currentIsTable !== null && isTable !== currentIsTable) {
      flush();
    }

    currentLines.push(line);
    currentIsTable = isTable;
  });

  flush();
  return blocks;
}

function splitTableBlockByRows(content, maxCharacters) {
  if (content.length <= maxCharacters) {
    return [content];
  }

  const rows = content.split("\n");
  const groups = [];
  let currentGroup = [];
  let currentLength = 0;

  rows.forEach((row) => {
    const rowLength = row.length + 1;
    if (currentGroup.length > 0 && currentLength + rowLength > maxCharacters) {
      groups.push(currentGroup.join("\n"));
      currentGroup = [];
      currentLength = 0;
    }
    currentGroup.push(row);
    currentLength += rowLength;
  });

  if (currentGroup.length > 0) {
    groups.push(currentGroup.join("\n"));
  }

  return groups;
}

export async function buildIndexableChunks(text) {
  const normalizedText = normalizeExtractedText(text);
  const structuralBlocks = splitIntoStructuralBlocks(normalizedText);
  const splitter = new TokenTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50
  });

  const chunks = [];

  for (const block of structuralBlocks) {
    if (block.type === "table") {
      // Un tableau reste entier (ou coupe uniquement entre deux lignes completes,
      // jamais au milieu d'une cellule).
      const tableChunks = splitTableBlockByRows(block.content, maxEmbeddingChunkCharacters);
      tableChunks.forEach((chunk) => {
        const normalized = normalizeExtractedText(chunk);
        if (normalized) {
          chunks.push(normalized);
        }
      });
      continue;
    }

    const rawChunks = await splitter.splitText(block.content);
    rawChunks
      .map((chunk) => normalizeExtractedText(chunk))
      .filter(Boolean)
      .flatMap((chunk) =>
        splitChunkByCharacters(chunk, maxEmbeddingChunkCharacters, embeddingChunkCharacterOverlap)
      )
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .forEach((chunk) => chunks.push(chunk));
  }

  return chunks;
}

function isIdentityQuestion(question) {
  const normalized = normalizeIntentText(question);
  return /\b(qui es[- ]?tu|qui tu es|presente[- ]?toi|ton role|comment tu t'appelles|tu t'appelles comment|c'est quoi ton nom|quel est ton nom|ton nom|nom officiel|comment t'appelles[- ]tu)\b/.test(
    normalized
  );
}

function isCreationQuestion(question) {
  const normalized = normalizeIntentText(question);
  return /\b(qui t[' ]?a cre(?:e|er)|qui ta cre(?:e|er)|qui t[' ]?as cre(?:e|er)|comment tu as ete cre(?:e|er)|comment as[- ]?tu ete cre(?:e|er)|ta creation|ton createur|ta creatrice|qui est ton createur|par qui as[- ]?tu ete cre(?:e|er))\b/.test(
    normalized
  );
}

function isShortFollowUpQuestion(question) {
  const normalized = normalizeIntentText(question)
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return false;
  }

  const shortFollowUps = [
    "explique mieux",
    "explique davantage",
    "developpe",
    "developpe davantage",
    "pourquoi",
    "pourquoi ?",
    "et dans ce cas",
    "et dans ce cas ?",
    "et ensuite",
    "et ensuite ?",
    "plus de precision",
    "plus de precisions",
    "precise",
    "precise davantage",
    "tu peux preciser",
    "tu peux developper",
    "explique",
    "continue",
    "detaille",
    "detaille mieux",
    "dans ce cas",
    "et apres",
    "et apres ?"
  ];

  if (shortFollowUps.includes(normalized)) {
    return true;
  }

  return normalized.split(" ").length <= 6 && /^(et |mais |alors |donc |pourquoi|comment|precise|explique|developpe|detaille|dans ce cas)/.test(normalized);
}

function isDocumentAccessRequest(question) {
  const normalized = normalizeIntentText(question).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  return /(telecharge|telecharger|telechargement|ouvrir|ouvre|ouvrir le document|envoie|envoyer|envoie moi|envoies moi|donne moi|donnes moi|me donner|donner le fichier|passe moi|fournis moi|fournir le fichier|voir le fichier|voir le document|montrer le document|afficher le document|avoir le document|avoir acces|acceder|consulter)/.test(
    normalized
  );
}

function isSourceOnlyRequest(question) {
  const normalized = normalizeIntentText(question).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  if (!normalized.includes("source")) {
    return false;
  }

  return /^(tu peux |peux[- ]tu |je peux |je veux |je voudrais |donne|donne moi|donnes moi|montre|affiche|ouvre|quelle est )?(me )?(donner |montrer |afficher |ouvrir |voir )?(la |les )?source(s)?( utilisees?| utilisées?)? ?(\?)?$/.test(
    normalized
  );
}

function isDocumentInventoryRequest(question) {
  const normalized = normalizeIntentText(question).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  return /(tous les documents|toutes les sources|liste des documents|liste les documents|quels documents|quelles sources|documents que tu as|sources que tu as|donne moi les documents|montre moi les documents|fichiers que tu as|fichiers a disposition|fichiers a ta disposition|documents a disposition|documents a ta disposition|je veux les fichiers|je veux les documents|quels fichiers|quelles fichiers)/.test(
    normalized
  );
}

function normalizeDocumentName(value) {
  return normalizeIntentText(value).replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
}

function buildDocumentReferenceCandidates(document) {
  const rawCandidates = [
    document.original_name,
    document.filename,
    document.relative_path,
    `${document.folder_name}/${document.original_name || document.filename}`
  ].filter(Boolean);

  const normalizedCandidates = new Set();

  rawCandidates.forEach((value) => {
    const normalized = normalizeDocumentName(value);
    if (!normalized) {
      return;
    }

    normalizedCandidates.add(normalized);
    normalizedCandidates.add(normalized.replace(/\.[a-z0-9]+$/i, "").trim());
    normalizedCandidates.add(normalized.replace(/[-_ ]\d+(?=$|\.[a-z0-9]+$)/i, "").trim());
    normalizedCandidates.add(
      normalized
        .replace(/\.[a-z0-9]+$/i, "")
        .replace(/[-_ ]\d+$/i, "")
        .trim()
    );
  });

  return [...normalizedCandidates].filter(Boolean);
}

function scoreDocumentReferenceMatch(question, document) {
  const normalizedQuestion = normalizeDocumentName(question);
  if (!normalizedQuestion) {
    return 0;
  }

  const candidates = buildDocumentReferenceCandidates(document);

  let bestScore = 0;

  candidates.forEach((candidate) => {
    if (!candidate || candidate.length < 6) {
      return;
    }

    if (normalizedQuestion.includes(candidate)) {
      bestScore = Math.max(bestScore, 1);
      return;
    }

    const overlap = computeTextOverlapScore(normalizedQuestion, candidate);
    if (overlap >= 0.9) {
      bestScore = Math.max(bestScore, 0.92);
      return;
    }

    if (candidate.includes(".") && normalizedQuestion.includes(candidate.split(".")[0])) {
      bestScore = Math.max(bestScore, 0.82);
      return;
    }
  });

  return Number(bestScore.toFixed(3));
}

function extractRequestedFileNames(question) {
  const matches = String(question || "").match(
    /\b[a-zA-Z0-9][a-zA-Z0-9._-]*\.(pdf|txt|text|md|markdown|docx|html?|csv|tsv|json|jsonl|xml|ya?ml|log|sql)\b/gi
  );

  return [...new Set((matches || []).map((value) => value.trim()))];
}

function findExplicitDocumentRequest(question) {
  if (!isDocumentAccessRequest(question)) {
    return null;
  }

  const allDocuments = getDocuments();
  const explicitNames = extractRequestedFileNames(question);
  const normalizedQuestion = normalizeDocumentName(question);

  const exactMatches = allDocuments.filter((document) => {
    const candidates = buildDocumentReferenceCandidates(document);

    const explicitMatch =
      explicitNames.length > 0 &&
      explicitNames.some((name) => candidates.includes(normalizeDocumentName(name)));

    const contextualMatch =
      explicitNames.length === 0 &&
      candidates.some((candidate) => candidate && normalizedQuestion.includes(candidate));

    return explicitMatch || contextualMatch;
  });

  if (exactMatches.length === 0) {
    return null;
  }

  const rankedMatches = exactMatches.sort((left, right) => {
    const leftName = normalizeDocumentName(left.original_name || left.filename);
    const rightName = normalizeDocumentName(right.original_name || right.filename);
    const explicitNormalizedNames = explicitNames.map((value) => normalizeDocumentName(value));
    const leftExplicit = explicitNormalizedNames.includes(leftName) ? 1 : 0;
    const rightExplicit = explicitNormalizedNames.includes(rightName) ? 1 : 0;

    if (rightExplicit !== leftExplicit) {
      return rightExplicit - leftExplicit;
    }

    return leftName.length - rightName.length;
  });

  return {
    document: rankedMatches[0],
    matches: rankedMatches
  };
}

function findReferencedDocument(question) {
  const allDocuments = getDocuments();
  if (allDocuments.length === 0) {
    return null;
  }

  const explicitNames = extractRequestedFileNames(question).map((value) => normalizeDocumentName(value));
  const rankedMatches = allDocuments
    .map((document) => ({
      document,
      score: scoreDocumentReferenceMatch(question, document),
      explicitNameMatch:
        explicitNames.length > 0 &&
        [
          document.original_name,
          document.filename,
          document.relative_path
        ]
          .filter(Boolean)
          .map((value) => normalizeDocumentName(value))
          .some((value) => explicitNames.includes(value))
    }))
    .filter((entry) => entry.explicitNameMatch || entry.score >= 0.82)
    .sort((left, right) => {
      if (Number(right.explicitNameMatch) !== Number(left.explicitNameMatch)) {
        return Number(right.explicitNameMatch) - Number(left.explicitNameMatch);
      }

      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return String(left.document.original_name || left.document.filename).localeCompare(
        String(right.document.original_name || right.document.filename),
        "fr"
      );
    });

  return rankedMatches[0]?.document || null;
}

function extractDocumentSearchTerms(question) {
  const normalized = normalizeIntentText(question)
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return [];
  }

  const stopWords = new Set([
    "je",
    "veux",
    "les",
    "des",
    "de",
    "du",
    "que",
    "tu",
    "as",
    "a",
    "ta",
    "tes",
    "disposition",
    "fichiers",
    "fichier",
    "documents",
    "document",
    "sources",
    "source",
    "donne",
    "donnes",
    "moi",
    "montre",
    "liste",
    "quels",
    "quelles",
    "tous",
    "toutes",
    "avoir",
    "avec",
    "pour",
    "sur"
  ]);

  return [...new Set(
    normalized
      .split(" ")
      .filter(Boolean)
      .filter((token) => !stopWords.has(token))
      .filter((token) => token.length >= 2)
  )];
}

function findRequestedDocumentGroup(question) {
  if (!isDocumentInventoryRequest(question)) {
    return null;
  }

  const documents = getDocuments();
  const searchTerms = extractDocumentSearchTerms(question);

  if (documents.length === 0) {
    return {
      matches: [],
      searchTerms
    };
  }

  if (searchTerms.length === 0) {
    return {
      matches: documents,
      searchTerms
    };
  }

  const matches = documents.filter((document) => {
    const haystack = normalizeDocumentName(
      `${document.folder_name} ${document.original_name || ""} ${document.filename || ""} ${document.relative_path || ""}`
    );

    return searchTerms.every((term) => haystack.includes(term));
  });

  return {
    matches,
    searchTerms
  };
}

function tokenizeFrenchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => token.length > 2)
    .filter(
      (token) =>
        !new Set([
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
          "comment",
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
          "dans",
          "donc"
        ]).has(token)
    );
}

function normalizeFrenchStem(token) {
  let normalized = String(token || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");

  const suffixes = [
    "issements",
    "issement",
    "atrices",
    "ateurs",
    "ations",
    "ation",
    "utions",
    "ution",
    "ements",
    "ement",
    "tions",
    "tion",
    "sions",
    "sion",
    "ences",
    "ence",
    "ances",
    "ance",
    "iques",
    "ique",
    "ismes",
    "isme",
    "istes",
    "iste",
    "euses",
    "euse",
    "trices",
    "trice",
    "teurs",
    "teur",
    "ments",
    "ment",
    "ages",
    "age",
    "eurs",
    "eaux",
    "eau",
    "ures",
    "ure",
    "ives",
    "ive",
    "ifs",
    "if",
    "ions",
    "ion",
    "ees",
    "ee",
    "ers",
    "er",
    "ez",
    "es",
    "e",
    "s"
  ];

  for (const suffix of suffixes) {
    if (normalized.endsWith(suffix) && normalized.length - suffix.length >= 4) {
      normalized = normalized.slice(0, -suffix.length);
      break;
    }
  }

  return normalized;
}

function buildTokenSet(value) {
  return new Set(tokenizeFrenchText(value).map(normalizeFrenchStem).filter((token) => token.length >= 4));
}

function computeDomainKeywordScore(question, history = []) {
  const { lastUserMessage, lastAssistantMessage } = getConversationAnchors(history);
  const scopedText = [
    question,
    isShortFollowUpQuestion(question) ? lastUserMessage?.content || "" : "",
    isShortFollowUpQuestion(question) ? lastAssistantMessage?.content || "" : ""
  ]
    .filter(Boolean)
    .join(" ");

  const tokens = buildTokenSet(scopedText);
  if (tokens.size === 0) {
    return 0;
  }

  const domainKeywords = getDomainKeywords();
  let matches = 0;
  tokens.forEach((token) => {
    if (domainKeywords.has(token)) {
      matches += 1;
    }
  });

  return Number(Math.min(1, matches / 3).toFixed(3));
}

function computeProjectFocusScore(question, retrieval, history = []) {
  const domainKeywordScore = computeDomainKeywordScore(question, history);
  const manualScore =
    retrieval?.manualResources?.some((resource) => resource.isQuestionRelevant) ? 0.45 : 0;
  const documentLinkScore =
    retrieval?.documentLinkResources?.some((resource) => resource.isQuestionRelevant) ? 0.35 : 0;
  const feedbackRuleScore = retrieval?.improvementRules?.length > 0 ? 0.35 : 0;
  const documentScore =
    retrieval?.chunks?.length > 0
      ? Math.min(0.7, 0.35 + Number(retrieval.averagePriorityScore || 0) * 0.7)
      : 0;
  const followUpScore =
    isShortFollowUpQuestion(question) && getConversationAnchors(history).lastAssistantMessage
      ? 0.18
      : 0;

  return Number(
    Math.min(
      1.6,
      domainKeywordScore * 0.6 +
        manualScore +
        documentLinkScore +
        feedbackRuleScore +
        documentScore +
        followUpScore
    ).toFixed(3)
  );
}

function hasApproximateTokenMatch(sourceToken, candidateTokens) {
  for (const candidateToken of candidateTokens) {
    if (sourceToken === candidateToken) {
      return true;
    }

    const lengthGap = Math.abs(sourceToken.length - candidateToken.length);
    if (sourceToken.length >= 7 && candidateToken.length >= 7 && lengthGap <= 1) {
      if (sourceToken.slice(0, 6) === candidateToken.slice(0, 6)) {
        return true;
      }
    }
  }

  return false;
}

function computeTextOverlapScore(question, text) {
  const questionTokens = buildTokenSet(question);
  if (questionTokens.size === 0) {
    return 0;
  }

  const candidateTokens = buildTokenSet(text);
  if (candidateTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  questionTokens.forEach((token) => {
    if (hasApproximateTokenMatch(token, candidateTokens)) {
      overlap += 1;
    }
  });

  return overlap / questionTokens.size;
}

function computeManualOverlapScore(question, resource) {
  return computeTextOverlapScore(
    question,
    `${resource.title} ${resource.content} ${resource.link_url || ""}`
  );
}

function computeDocumentOverlapScore(question, result) {
  const sourceLabel = result.metadata.original_name || result.metadata.file_name || "";
  return computeTextOverlapScore(
    question,
    `${result.metadata.folder || ""} ${sourceLabel} ${result.pageContent || ""}`.slice(0, 6000)
  );
}

function computeSourceLabelScore(question, result) {
  return computeTextOverlapScore(
    question,
    `${result.metadata.folder || ""} ${result.metadata.original_name || ""} ${
      result.metadata.file_name || ""
    }`
  );
}

function computeExactDocumentMentionBonus(question, result) {
  const normalizedQuestion = normalizeDocumentName(question);
  const normalizedOriginalName = normalizeDocumentName(result.metadata.original_name || "");
  const normalizedFileName = normalizeDocumentName(result.metadata.file_name || "");
  const normalizedRelativePath = normalizeDocumentName(result.metadata.source_path || "");

  if (
    (normalizedOriginalName && normalizedQuestion.includes(normalizedOriginalName)) ||
    (normalizedFileName && normalizedQuestion.includes(normalizedFileName)) ||
    (normalizedRelativePath && normalizedQuestion.includes(normalizedRelativePath))
  ) {
    return 0.35;
  }

  return 0;
}

function computeManualPriorityScore(question, resource, explicitProfileQuestion) {
  const overlapScore = explicitProfileQuestion ? 1 : computeManualOverlapScore(question, resource);
  const exactDirectiveBonus = /reponds? exactement|utilise exactement|nom officiel|appelle[- ]toi/i.test(
    String(resource.content || "")
  )
    ? 0.2
    : 0;
  const titleBonus = computeTextOverlapScore(question, resource.title || "") * 0.15;

  return Number((Math.min(1.4, overlapScore + exactDirectiveBonus + titleBonus)).toFixed(3));
}

function prioritizeManualResources(
  question,
  resources,
  explicitProfileQuestion,
  limit = maxManualResourcesInPrompt
) {
  return resources
    .map((resource) => ({
      ...resource,
      overlapScore: computeManualOverlapScore(question, resource),
      priorityScore: computeManualPriorityScore(question, resource, explicitProfileQuestion),
      isQuestionRelevant:
        explicitProfileQuestion ||
        computeManualPriorityScore(question, resource, explicitProfileQuestion) >=
          minimumManualOverlapScore
    }))
    .sort((left, right) => right.priorityScore - left.priorityScore)
    .slice(0, Math.max(1, limit));
}

function prioritizeDocumentChunks(question, candidates) {
  const perDocumentCounts = new Map();

  return candidates
    .map((result) => {
      const relevanceScore = Number((1 / (1 + Math.max(result.score, 0))).toFixed(3));
      const lexicalOverlapScore = Number(computeDocumentOverlapScore(question, result).toFixed(3));
      const sourceLabelScore = Number(computeSourceLabelScore(question, result).toFixed(3));
      const exactMentionBonus = computeExactDocumentMentionBonus(question, result);
      const priorityScore = Number(
        (
          relevanceScore * 0.55 +
          lexicalOverlapScore * 0.3 +
          sourceLabelScore * 0.15 +
          exactMentionBonus
        ).toFixed(3)
      );

      return {
        ...result,
        relevanceScore,
        lexicalOverlapScore,
        sourceLabelScore,
        exactMentionBonus,
        priorityScore
      };
    })
    .filter(
      (result) =>
        result.exactMentionBonus > 0 ||
        (result.relevanceScore >= minimumVectorRelevanceScore &&
          result.lexicalOverlapScore >= minimumDocumentOverlapScore &&
          result.priorityScore >= minimumDocumentOverlapScore)
    )
    .sort((left, right) => right.priorityScore - left.priorityScore)
    .filter((result) => {
      const documentKey = result.metadata.source_path || `${result.metadata.folder}-${result.metadata.file_name}`;
      const currentCount = perDocumentCounts.get(documentKey) || 0;

      if (currentCount >= maxChunksPerDocument) {
        return false;
      }

      perDocumentCounts.set(documentKey, currentCount + 1);
      return true;
    })
    .slice(0, ragTopK);
}

function buildContextString(chunks) {
  let currentLength = 0;
  const sections = [];

  chunks.forEach((result, index) => {
    const section = `[DOC ${index + 1}] Dossier : ${result.metadata.folder}\nFichier : ${
      result.metadata.original_name || result.metadata.file_name
    }\nPriorite : ${result.priorityScore}\nExtrait :\n${result.pageContent}`;

    if (sections.length > 0 && currentLength + section.length > maxContextCharacters) {
      return;
    }

    sections.push(section);
    currentLength += section.length;
  });

  return sections.join("\n\n");
}

function getConversationHistoryLimit() {
  const configured = Number(getSetting("chatHistoryLimit", ""));
  if (Number.isInteger(configured) && configured > 0) {
    return configured;
  }

  return defaultConversationHistoryLimit;
}

function getRecentConversationEntries(history = [], limit = getConversationHistoryLimit()) {
  return Array.isArray(history) ? history.slice(-limit).filter((entry) => entry?.content) : [];
}

function getConversationAnchors(history = []) {
  const recentHistory = getRecentConversationEntries(history, 6);
  const lastUserMessage = [...recentHistory].reverse().find((entry) => entry.role === "user");
  const lastAssistantMessage = [...recentHistory]
    .reverse()
    .find((entry) => entry.role === "assistant");

  return {
    recentHistory,
    lastUserMessage,
    lastAssistantMessage
  };
}

function findSourceReferenceQuestion(history = []) {
  const recentUserMessages = getRecentConversationEntries(history, 10)
    .filter((entry) => entry.role === "user" && entry.content)
    .reverse();

  const primaryQuestion = recentUserMessages.find(
    (entry) =>
      !isSourceOnlyRequest(entry.content) &&
      !isShortFollowUpQuestion(entry.content) &&
      !isDocumentAccessRequest(entry.content)
  );

  if (primaryQuestion?.content) {
    return primaryQuestion.content.trim();
  }

  const fallbackQuestion = recentUserMessages.find((entry) => !isSourceOnlyRequest(entry.content));
  return String(fallbackQuestion?.content || "").trim();
}

function buildRetrievalFocusQuestion(question, history = []) {
  const baseQuestion = String(question || "").trim();
  const { lastUserMessage, lastAssistantMessage } = getConversationAnchors(history);
  const previousUserQuestion = String(lastUserMessage?.content || "").trim();
  const previousAssistantAnswer = String(lastAssistantMessage?.content || "").trim();

  if (isSourceOnlyRequest(baseQuestion)) {
    return [previousUserQuestion, previousAssistantAnswer].filter(Boolean).join("\n");
  }

  if (isShortFollowUpQuestion(baseQuestion) && previousUserQuestion) {
    return [baseQuestion, previousUserQuestion, previousAssistantAnswer.slice(0, 1200)]
      .filter(Boolean)
      .join("\n");
  }

  return baseQuestion;
}

function buildRetrievalQuery(question, history = []) {
  const shortFollowUpQuestion = isShortFollowUpQuestion(question);
  const sourceOnlyRequest = isSourceOnlyRequest(question);
  const { lastUserMessage, lastAssistantMessage } = getConversationAnchors(history);
  const retrievalParts = [question.trim()];

  if ((shortFollowUpQuestion || sourceOnlyRequest) && lastUserMessage?.content) {
    retrievalParts.push(`Question precedente : ${lastUserMessage.content.trim()}`);
  }

  if (sourceOnlyRequest && lastAssistantMessage?.content) {
    retrievalParts.push(
      `Reponse precedente : ${lastAssistantMessage.content.trim().slice(0, 1200)}`
    );
  }

  return retrievalParts.filter(Boolean).join("\n");
}

function shouldCarryConversationHistory(question, history = []) {
  if (isShortFollowUpQuestion(question) || isSourceOnlyRequest(question)) {
    return true;
  }

  const { lastUserMessage, lastAssistantMessage } = getConversationAnchors(history);
  const anchorText = [lastUserMessage?.content || "", lastAssistantMessage?.content || ""]
    .filter(Boolean)
    .join(" ");

  if (!anchorText.trim()) {
    return false;
  }

  const overlapWithAnchor = computeTextOverlapScore(question, anchorText);
  return overlapWithAnchor >= 0.2;
}

function buildSystemInstruction({ shortFollowUpQuestion, hasInternalContext, carriesHistory }) {
  const branding = getBranding();
  return `
Tu es l'assistant de ${branding.projectName}.
Ton domaine d'expertise est celui de ${branding.projectName} : ses machines, ses procedures, ses consignes, ses formations, ses projets, sa securite, ses ressources documentaires et son fonctionnement.
Tu dois repondre en priorite a partir des ressources internes du projet : personnalisations, feedbacks valides et documents internes.
Quand des extraits de documents internes ou des regles internes sont fournis et qu'ils sont pertinents pour la question, ils orientent la reponse et passent avant toute autre connaissance.
Toutes les personnalisations internes actives doivent etre traitees comme des consignes a respecter, pas comme de simples informations optionnelles.
Quand des personnalisations internes definissent ton nom, ta presentation, ton role, ta creation, ton ton, ta formulation ou n'importe quelle autre instruction, elles sont prioritaires sur toute formulation par defaut.
Si une personnalisation contient une consigne de type "reponds exactement", applique-la mot pour mot.
Ordre de priorite : 1. personnalisations internes, 2. feedbacks admin valides, 3. documents internes pertinents, 4. connaissance generale.
Utilise ta connaissance generale seulement en secours si les ressources internes ne suffisent pas a produire une bonne reponse.
Quand tu reponds surtout avec ta connaissance generale faute de contexte interne suffisant, reste prudent mais ne mentionne jamais explicitement que la reponse est basee sur l'IA, tes connaissances generales ou qu'elle pourrait etre moins fiable : reponds directement, sans annoncer cette nuance.
Si la question est dans le domaine mais que tu n'as pas assez d'informations fiables, dis clairement que tu ne sais pas, invite a verifier aupres d'un professeur, d'un responsable d'atelier ou d'une personne competente, et propose a l'utilisateur de completer par une recherche sur Internet.
Si le contexte interne contredit une connaissance generale, privilegie toujours le contexte interne pour ce sujet precis.
N'invente pas de fait specifique aux documents internes quand il n'est pas present dans les extraits fournis.
Tu peux combiner connaissance generale et contexte interne si c'est utile, en restant clair sur ce qui vient surtout des documents internes et des personnalisations.
Ne commence jamais ta reponse par une presentation de toi-meme, ton role ou ton identite, sauf si l'utilisateur te le demande explicitement.
Ne cite pas les noms de fichiers ni les labels techniques dans le corps de la reponse, sauf si l'utilisateur le demande explicitement.
Ne termine pas la reponse par une liste de sources : l'interface s'en charge.
Reponds toujours en francais, meme si la question est posee dans une autre langue.
N'utilise pas l'anglais sauf pour un terme technique indispensable ou un nom propre.
${carriesHistory ? "L'historique recent est pertinent pour cette reponse : tu peux t'y appuyer." : "Traite la question actuelle comme un nouveau sujet autonome. N'herite pas du theme des echanges precedents si la question actuelle change de sujet."}
${hasInternalContext ? "Des informations internes pertinentes sont fournies ci-dessous : base-toi d'abord sur elles pour cadrer la reponse." : "Aucun contexte interne suffisamment pertinent n'est fourni : reponds avec prudence a partir de tes connaissances generales, sans jamais mentionner explicitement que cette partie est basee sur l'IA ou moins fiable."}
${shortFollowUpQuestion ? "La question actuelle est une relance courte : appuie-toi d'abord sur le dernier echange utile avant d'elargir la reponse." : ""}
  `.trim();
}

function buildMessagesPreview(messages = []) {
  return messages
    .map((message) => `[${message.role.toUpperCase()}]\n${message.content}`)
    .join("\n\n");
}

function computeResponseChunkGroundingScore(answerText, chunk) {
  const responseOverlap = computeTextOverlapScore(answerText, chunk.pageContent || "");
  const score = responseOverlap * 0.75 + Number(chunk.priorityScore || 0) * 0.25;

  return {
    responseOverlap: Number(responseOverlap.toFixed(3)),
    score: Number(score.toFixed(3))
  };
}

export function selectVisibleSourcesForResponse(question, answerText, retrieval = {}) {
  const visibleSources = [];
  const seenSources = new Set();
  const safeAnswerText = String(answerText || "").trim();

  const appendSource = (source) => {
    if (!source || source.visibility !== "public") {
      return;
    }

    const key =
      source.documentId ||
      source.downloadUrl ||
      source.relativePath ||
      `${source.fileName}-${source.chunkIndex ?? "source"}`;

    if (seenSources.has(key)) {
      return;
    }

    seenSources.add(key);
    visibleSources.push(source);
  };

  const relevantDocumentLinkSources = (retrieval.documentLinkResources || [])
    .filter((resource) => resource.isQuestionRelevant)
    .map((resource) => {
      const answerOverlap = computeTextOverlapScore(
        safeAnswerText,
        `${resource.title || ""} ${resource.content || ""}`
      );

      return {
        resource,
        answerOverlap,
        score: Number(resource.priorityScore || 0) + answerOverlap * 0.4
      };
    })
    .filter(({ resource, answerOverlap }) => resource.isQuestionRelevant || answerOverlap >= 0.08)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ resource }) => formatDocumentLinkSource(resource))
    .filter(Boolean);

  const fallbackDocumentSources = (retrieval.effectiveChunks || [])
    .map((chunk) => ({
      chunk,
      source: formatSource(chunk)
    }))
    .filter(({ source }) => source?.visibility === "public")
    .sort((left, right) => {
      const rightPriority = Number(right.chunk?.priorityScore || 0);
      const leftPriority = Number(left.chunk?.priorityScore || 0);

      if (rightPriority !== leftPriority) {
        return rightPriority - leftPriority;
      }

      return Number(right.chunk?.relevanceScore || 0) - Number(left.chunk?.relevanceScore || 0);
    })
    .map(({ source }) => source);

  if (
    !retrieval?.hasStrongDocumentContext ||
    !Array.isArray(retrieval.effectiveChunks) ||
    retrieval.effectiveChunks.length === 0
  ) {
    relevantDocumentLinkSources.forEach(appendSource);
    return visibleSources;
  }

  if (isDocumentInventoryRequest(question) || isIdentityQuestion(question) || isCreationQuestion(question)) {
    return [];
  }

  if (!safeAnswerText) {
    relevantDocumentLinkSources.forEach(appendSource);
    return visibleSources;
  }

  const shouldForceTechnicalSources =
    Number(retrieval.domainKeywordScore || 0) >= 0.2 ||
    Number(retrieval.projectFocusScore || 0) >= 0.35;

  const groundedChunks = retrieval.effectiveChunks
    .map((chunk) => {
      const grounding = computeResponseChunkGroundingScore(safeAnswerText, chunk);
      return {
        ...chunk,
        groundingScore: grounding.score,
        responseOverlap: grounding.responseOverlap
      };
    })
    .filter((chunk) => {
      const exactMentionBonus = Number(chunk.exactMentionBonus || 0);
      const priorityScore = Number(chunk.priorityScore || 0);
      return (
        exactMentionBonus > 0 ||
        (chunk.responseOverlap >= 0.1 && chunk.groundingScore >= 0.24) ||
        (chunk.responseOverlap >= 0.18 && priorityScore >= 0.3)
      );
    })
    .sort((left, right) => {
      if (right.groundingScore !== left.groundingScore) {
        return right.groundingScore - left.groundingScore;
      }

      return Number(right.priorityScore || 0) - Number(left.priorityScore || 0);
    });

  if (groundedChunks.length === 0) {
    fallbackDocumentSources.slice(0, 3).forEach(appendSource);
    relevantDocumentLinkSources.forEach(appendSource);
    return visibleSources;
  }

  const bestChunkByDocument = new Map();

  groundedChunks.forEach((chunk) => {
    const key =
      chunk.metadata?.document_id ||
      chunk.metadata?.source_path ||
      `${chunk.metadata?.file_name || "document"}-${chunk.metadata?.chunk_index || 0}`;
    const existing = bestChunkByDocument.get(key);

    if (!existing || Number(chunk.groundingScore || 0) > Number(existing.groundingScore || 0)) {
      bestChunkByDocument.set(key, chunk);
    }
  });

  [...bestChunkByDocument.values()]
    .sort((left, right) => {
      if (right.groundingScore !== left.groundingScore) {
        return right.groundingScore - left.groundingScore;
      }

      return Number(right.priorityScore || 0) - Number(left.priorityScore || 0);
    })
    .slice(0, 3)
    .map((chunk) => formatSource(chunk))
    .forEach((source) => {
      appendSource(source);
    });

  relevantDocumentLinkSources.forEach(appendSource);
  return visibleSources;
}

function buildWebSearchSuggestion(question) {
  const safeQuestion = String(question || "").trim();
  if (!safeQuestion) {
    return "";
  }

  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(safeQuestion.slice(0, 300))}`;
  return `\n\nPour aller plus loin, vous pouvez vérifier sur Internet en [cliquant ici](${searchUrl}).`;
}

export function ensureGeneralAiDisclosure(answerText, visibleSources = [], retrieval = {}, question = "") {
  const safeText = String(answerText || "").trim();
  if (!safeText) {
    return safeText;
  }

  if (Array.isArray(visibleSources) && visibleSources.length > 0) {
    return safeText;
  }

  const normalizedAnswerText = normalizeIntentText(safeText);
  const alreadyDisclosed =
    /cette reponse est basee sur|reponse est basee sur|connaissances generales d.?ia|peut etre moins precise/i.test(
      normalizedAnswerText
    );

  // Le prompt systeme (voir buildSystemInstruction / buildChatMessages) demande
  // explicitement au modele de ne jamais annoncer qu'une reponse vient de ses
  // connaissances generales ou qu'elle serait moins fiable : aucune mention de ce
  // type n'est plus ajoutee ni conservee dans la reponse. Ce filet de securite
  // retire toute auto-mention residuelle si le modele l'ecrit quand meme.
  const disclaimerLeakPattern = /cette r[ée]ponse est bas[ée]e sur[^.]*pr[ée]cise[^.]*\.\s*/gi;

  // Le prompt systeme demande deja au modele de dire explicitement qu'il ne sait
  // pas quand ni le contexte interne ni sa connaissance generale ne suffisent
  // (voir buildSystemInstruction). On ne propose donc une recherche Internet que
  // si la reponse porte elle-meme cette marque d'incertitude : sinon la
  // connaissance generale a suffi a repondre, et suggerer Google serait
  // systematique/hors de propos (ex: une simple salutation).
  const hasUncertaintyMarker =
    /je ne sais pas|je n.?ai pas (d.?information|assez d.?information(s)?|trouve)|je ne dispose pas d.?information|je ne suis pas en mesure de|je ne peux pas( vous)? repondre|aucune information fiable|pas d.?information fiable/i.test(
      normalizedAnswerText
    );

  // Cas frequent : le modele se contente du disclaimer "connaissances generales
  // d'IA" sans y ajouter le moindre contenu (il n'a en realite rien a proposer).
  // Une fois ce disclaimer retire, s'il ne reste presque rien, c'est le meme
  // signal d'incertitude qu'un "je ne sais pas" explicite.
  const contentWithoutDisclosure = normalizedAnswerText
    .replace(/cette reponse est basee sur (l.?ia|mes connaissances generales d.?ia)[^.]*\.?/gi, "")
    .trim();
  const hasNoSubstantiveContent = alreadyDisclosed && contentWithoutDisclosure.length < 20;

  // Aucun document interne n'a fonde la reponse ET le modele signale lui-meme
  // ne pas savoir (ni contexte interne, ni connaissance generale utile) : on
  // oriente l'utilisateur vers une recherche Internet, sauf si un lien de
  // recherche est deja present dans la reponse.
  const shouldSuggestWebSearch =
    question &&
    !retrieval?.hasRelevantContext &&
    (hasUncertaintyMarker || hasNoSubstantiveContent) &&
    !/https?:\/\/(www\.)?google\.[a-z.]+\/search/i.test(safeText) &&
    !isIdentityQuestion(question) &&
    !isCreationQuestion(question);

  const suffix = shouldSuggestWebSearch ? buildWebSearchSuggestion(question) : "";

  // Le modele s'est contente du disclaimer sans jamais dire explicitement qu'il ne
  // sait pas : on remplace ce corps quasi vide par une phrase claire plutot que de
  // laisser une reponse qui a l'air incomplete/coupee.
  const bodyText = hasNoSubstantiveContent
    ? "Je ne sais pas répondre à cette question avec les informations dont je dispose."
    : (safeText.replace(disclaimerLeakPattern, "").trim() || safeText);

  return `${bodyText}${suffix}`;
}

function invalidateSearchCache(folderName = null) {
  if (!folderName) {
    searchCache.clear();
    return;
  }

  searchCache.delete(folderName);
}

async function loadCollectionRowsForSearch(folderName) {
  if (searchCache.has(folderName)) {
    return searchCache.get(folderName);
  }

  const collection = await getCollection(folderName);
  const result = await collection.get({
    include: ["documents", "metadatas"]
  });
  const rows =
    typeof result.rows === "function"
      ? result.rows()
      : (result.ids || []).map((id, index) => ({
          id,
          document: result.documents?.[index] || "",
          metadata: result.metadatas?.[index] || {}
        }));

  searchCache.set(folderName, rows);
  return rows;
}

async function getIndexedRowsForDocument(documentRecord) {
  if (!documentRecord?.folder_name || !documentRecord?.relative_path) {
    return [];
  }

  try {
    const collection = await getCollection(documentRecord.folder_name);
    const result = await collection.get({
      where: {
        source_path: documentRecord.relative_path
      },
      include: ["documents", "metadatas"]
    });

    const rows =
      typeof result.rows === "function"
        ? result.rows()
        : (result.ids || []).map((id, index) => ({
            id,
            document: result.documents?.[index] || "",
            metadata: result.metadatas?.[index] || {}
          }));

    return rows.map((row) => ({
      pageContent: row.document || "",
      metadata: row.metadata || {},
      score: 0
    }));
  } catch (error) {
    logger.warn("Chargement direct des chunks d'un document ignore.", {
      relativePath: documentRecord.relative_path,
      message: error.message
    });
    return [];
  }
}

async function buildDirectCandidatesForDocuments(question, documentRecords = []) {
  const candidates = [];

  for (const documentRecord of documentRecords) {
    if (!documentRecord?.relative_path) {
      continue;
    }

    try {
      const absolutePath = getAbsoluteDocumentPath(documentRecord.relative_path);
      const text = await readFileContent(absolutePath);
      const chunks = await buildIndexableChunks(text);

      const scoredChunks = chunks
        .map((chunk, index) => {
          const metadata = {
            document_id: documentRecord.id,
            source_path: documentRecord.relative_path,
            file_name: documentRecord.filename,
            original_name: documentRecord.original_name,
            folder: documentRecord.folder_name,
            visibility: documentRecord.visibility || "public",
            chunk_index: index
          };

          const lexicalOverlapScore = Number(
            computeDocumentOverlapScore(question, {
              pageContent: chunk,
              metadata
            }).toFixed(3)
          );
          const sourceLabelScore = Number(
            computeSourceLabelScore(question, {
              pageContent: chunk,
              metadata
            }).toFixed(3)
          );
          const exactMentionBonus = computeExactDocumentMentionBonus(question, {
            pageContent: chunk,
            metadata
          });
          const priorityScore = Number(
            (0.45 + lexicalOverlapScore * 0.35 + sourceLabelScore * 0.2 + exactMentionBonus).toFixed(3)
          );

          return {
            pageContent: chunk,
            metadata,
            score: 0,
            relevanceScore: 0.45,
            lexicalOverlapScore,
            sourceLabelScore,
            exactMentionBonus,
            priorityScore
          };
        })
        .filter(
          (chunk) =>
            chunk.exactMentionBonus > 0 ||
            chunk.lexicalOverlapScore >= minimumDocumentOverlapScore ||
            chunk.sourceLabelScore >= 0.2
        )
        .sort((left, right) => right.priorityScore - left.priorityScore)
        .slice(0, Math.max(1, maxChunksPerDocument));

      candidates.push(...scoredChunks);
    } catch (error) {
      logger.warn("Lecture directe du document ignoree pour le retrieval.", {
        relativePath: documentRecord.relative_path,
        message: error.message
      });
    }
  }

  return candidates;
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) {
    return 0;
  }

  let count = 0;
  let searchIndex = 0;

  while (searchIndex < haystack.length) {
    const nextIndex = haystack.indexOf(needle, searchIndex);
    if (nextIndex === -1) {
      break;
    }

    count += 1;
    searchIndex = nextIndex + needle.length;
  }

  return count;
}

function buildChunkSnippet(document, query) {
  const cleanDocument = String(document || "").replace(/\s+/g, " ").trim();
  if (!cleanDocument) {
    return "";
  }

  const loweredDocument = cleanDocument.toLowerCase();
  const loweredQuery = String(query || "").toLowerCase().trim();
  const matchIndex = loweredQuery ? loweredDocument.indexOf(loweredQuery) : -1;

  if (matchIndex === -1) {
    return cleanDocument.slice(0, 280);
  }

  const start = Math.max(0, matchIndex - 110);
  const end = Math.min(cleanDocument.length, matchIndex + loweredQuery.length + 170);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < cleanDocument.length ? "…" : "";

  return `${prefix}${cleanDocument.slice(start, end)}${suffix}`;
}

function scoreChunkSearch(query, row) {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedDocument = normalizeSearchText(row.document || "");
  const normalizedFileName = normalizeSearchText(
    row.metadata?.original_name || row.metadata?.file_name || ""
  );
  const normalizedFolder = normalizeSearchText(row.metadata?.folder || "");
  const queryTokens = normalizedQuery.split(" ").filter((token) => token.length >= 2);

  const phraseInDocument = normalizedQuery && normalizedDocument.includes(normalizedQuery);
  const phraseInFileName = normalizedQuery && normalizedFileName.includes(normalizedQuery);
  const phraseInFolder = normalizedQuery && normalizedFolder.includes(normalizedQuery);
  const occurrenceScore = countOccurrences(normalizedDocument, normalizedQuery);
  const tokenMatches = queryTokens.reduce(
    (total, token) => total + (normalizedDocument.includes(token) ? 1 : 0),
    0
  );

  const score =
    (phraseInDocument ? 12 : 0) +
    (phraseInFileName ? 8 : 0) +
    (phraseInFolder ? 4 : 0) +
    occurrenceScore * 3 +
    tokenMatches;

  return {
    score,
    matched: score > 0
  };
}

function buildGroundingSummary(retrieval = null) {
  if (!retrieval) {
    return {
      mode: "general",
      manualResourceCount: 0,
      documentChunkCount: 0,
      publicSourceCount: 0
    };
  }

  const hasManualResources = (retrieval.manualResources || []).some(
    (resource) => resource.isQuestionRelevant
  );
  const hasImprovementRules = (retrieval.improvementRules || []).length > 0;
  const hasDocumentChunks = (retrieval.chunks || []).length > 0;

  return {
    mode: (hasManualResources || hasImprovementRules) && hasDocumentChunks
      ? "hybrid"
      : hasManualResources || hasImprovementRules
        ? "manual"
        : hasDocumentChunks
          ? "documents"
          : "general",
    manualResourceCount: (retrieval.manualResources || []).length,
    relevantManualResourceCount: (retrieval.manualResources || []).filter(
      (resource) => resource.isQuestionRelevant
    ).length,
    improvementRuleCount: (retrieval.improvementRules || []).length,
    documentChunkCount: (retrieval.chunks || []).length,
    publicSourceCount: (retrieval.sources || []).length,
    averagePriorityScore: Number(retrieval.averagePriorityScore || 0)
  };
}

/**
 * Resume compact de ce qui a ete utilise pour construire une reponse : sert a
 * la tracabilite admin ("pourquoi cette reponse ?") sans stocker le contexte
 * complet (trop volumineux, redondant avec les documents deja indexes).
 */
export function buildRetrievalMetadataSummary(retrieval, grounding) {
  if (!retrieval) {
    return {
      groundingMode: grounding?.mode || "general",
      hasStrongDocumentContext: false,
      chunksUsed: [],
      manualResourcesUsed: [],
      improvementRulesUsed: []
    };
  }

  return {
    groundingMode: grounding?.mode || "general",
    hasStrongDocumentContext: Boolean(retrieval.hasStrongDocumentContext),
    averagePriorityScore: retrieval.averagePriorityScore ?? null,
    maxRelevanceScore: retrieval.maxRelevanceScore ?? null,
    domainKeywordScore: retrieval.domainKeywordScore ?? null,
    chunksUsed: (retrieval.effectiveChunks || []).map((chunk) => ({
      folder: chunk.metadata?.folder || null,
      fileName: chunk.metadata?.original_name || chunk.metadata?.file_name || null,
      priorityScore: chunk.priorityScore ?? null,
      relevanceScore: chunk.relevanceScore ?? null,
      lexicalOverlapScore: chunk.lexicalOverlapScore ?? null
    })),
    manualResourcesUsed: (retrieval.manualResources || [])
      .filter((resource) => resource.isQuestionRelevant)
      .map((resource) => resource.title),
    improvementRulesUsed: (retrieval.improvementRules || []).map((rule) =>
      String(rule.instruction || "").slice(0, 160)
    )
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Extrait et decoupe un document sans toucher a l'index vectoriel : permet a
 * l'admin de voir a l'avance comment un fichier sera segmente avant de
 * l'indexer pour de bon.
 */
export async function previewDocumentChunks(documentRecord, { maxChunks = 40 } = {}) {
  const absolutePath = getAbsoluteDocumentPath(documentRecord.relativePath);
  const fileStats = await fs.stat(absolutePath);

  if (!fileStats.size) {
    throw new Error("Le fichier est vide.");
  }

  const text = await readFileContent(absolutePath);
  if (!text || !text.trim()) {
    throw new Error("Le document ne contient aucun texte exploitable.");
  }

  const chunks = await buildIndexableChunks(text);

  return {
    totalChunks: chunks.length,
    truncated: chunks.length > maxChunks,
    chunks: chunks.slice(0, maxChunks).map((chunk, index) => ({
      index,
      charCount: chunk.length,
      content: chunk
    }))
  };
}

export async function indexDocument(documentRecord, { shouldAbort, beforeBatch, onProgress } = {}) {
  const abortIfNeeded = () => {
    if (typeof shouldAbort === "function" && shouldAbort()) {
      const error = new Error("Indexation interrompue.");
      error.name = "AbortError";
      throw error;
    }
  };

  const absolutePath = getAbsoluteDocumentPath(documentRecord.relativePath);
  abortIfNeeded();
  const fileStats = await fs.stat(absolutePath);

  if (!fileStats.size) {
    throw new Error("Le fichier est vide.");
  }

  const text = await readFileContent(absolutePath);

  if (!text || !text.trim()) {
    throw new Error("Le document ne contient aucun texte exploitable.");
  }

  abortIfNeeded();
  const chunks = await buildIndexableChunks(text);
  const documents = chunks
    .map(
      (chunk, index) =>
        new Document({
          pageContent: chunk,
          metadata: {
            document_id: documentRecord.id,
            source_path: documentRecord.relativePath,
            file_name: documentRecord.filename,
            original_name: documentRecord.originalName,
            folder: documentRecord.folderName,
            visibility: documentRecord.visibility || "public",
            chunk_index: index
          }
        })
    );

  if (documents.length === 0) {
    throw new Error("Aucun extrait indexable n'a ete genere pour ce document.");
  }

  await deleteDocumentFromIndex(documentRecord);
  const vectorStore = await getVectorStore(documentRecord.folderName);
  const batchSize = Number(process.env.RAG_INDEX_BATCH_SIZE || 8);

  try {
    for (let index = 0; index < documents.length; index += batchSize) {
      abortIfNeeded();
      if (typeof beforeBatch === "function") {
        await beforeBatch({
          currentBatchIndex: Math.floor(index / batchSize),
          totalBatches: Math.max(1, Math.ceil(documents.length / batchSize)),
          processedDocuments: index,
          totalDocuments: documents.length
        });
      }
      const batch = documents.slice(index, index + batchSize);
      await vectorStore.addDocuments(batch);
      if (typeof onProgress === "function") {
        await onProgress({
          currentBatchIndex: Math.floor(index / batchSize),
          totalBatches: Math.max(1, Math.ceil(documents.length / batchSize)),
          processedDocuments: Math.min(index + batch.length, documents.length),
          totalDocuments: documents.length,
          processedChunks: Math.min(index + batch.length, documents.length),
          totalChunks: documents.length
        });
      }
      await sleep(0);
    }
    invalidateSearchCache(documentRecord.folderName);
  } catch (error) {
    if (error.name === "AbortError") {
      await deleteDocumentFromIndex(documentRecord);
    }
    throw error;
  }

  logger.info("Document indexe dans ChromaDB.", {
    relativePath: documentRecord.relativePath,
    chunkCount: documents.length
  });

  return {
    chunkCount: documents.length
  };
}

export async function indexWebLinkResource(resource, pageText) {
  const chunks = await buildIndexableChunks(pageText);
  if (chunks.length === 0) {
    throw new Error("Aucun contenu textuel exploitable n'a ete extrait de cette page.");
  }

  const documents = chunks.map(
    (chunk, index) =>
      new Document({
        pageContent: chunk,
        metadata: {
          source_type: "web_link",
          link_id: Number(resource.id),
          original_name: resource.title || resource.link_url,
          file_name: resource.link_url || "",
          folder: "documentation",
          visibility: "public",
          chunk_index: index
        }
      })
  );

  await deleteWebLinkFromIndex(resource.id);
  const vectorStore = await getVectorStore(webLinksFolderKey);
  const batchSize = Number(process.env.RAG_INDEX_BATCH_SIZE || 8);

  for (let index = 0; index < documents.length; index += batchSize) {
    await vectorStore.addDocuments(documents.slice(index, index + batchSize));
    await sleep(0);
  }

  invalidateSearchCache(webLinksFolderKey);
  logger.info("Lien documentaire indexe dans ChromaDB.", {
    linkId: resource.id,
    url: resource.link_url,
    chunkCount: documents.length
  });

  return { chunkCount: documents.length };
}

export async function deleteWebLinkFromIndex(linkId) {
  try {
    const collection = await getCollection(webLinksFolderKey);
    await collection.delete({
      where: {
        link_id: Number(linkId)
      }
    });
    invalidateSearchCache(webLinksFolderKey);
  } catch (error) {
    logger.warn("Suppression Chroma d'un lien ignoree.", {
      linkId,
      message: error.message
    });
  }
}

export async function indexAttachmentText(attachment, text) {
  const chunks = await buildIndexableChunks(text);
  if (chunks.length === 0) {
    throw new Error("La piece jointe ne contient aucun texte exploitable.");
  }

  const documents = chunks.map(
    (chunk, index) =>
      new Document({
        pageContent: chunk,
        metadata: {
          source_type: "attachment",
          attachment_id: Number(attachment.id),
          original_name: attachment.original_name || attachment.filename,
          file_name: attachment.filename || "",
          folder: "pieces-jointes",
          visibility: "private",
          chunk_index: index
        }
      })
  );

  await deleteAttachmentFromIndex(attachment.id);
  const vectorStore = await getVectorStore(attachmentsFolderKey);
  const batchSize = Number(process.env.RAG_INDEX_BATCH_SIZE || 8);

  for (let index = 0; index < documents.length; index += batchSize) {
    await vectorStore.addDocuments(documents.slice(index, index + batchSize));
    await sleep(0);
  }

  invalidateSearchCache(attachmentsFolderKey);
  logger.info("Piece jointe utilisateur indexee dans ChromaDB.", {
    attachmentId: attachment.id,
    chunkCount: documents.length
  });

  return { chunkCount: documents.length };
}

export async function deleteAttachmentFromIndex(attachmentId) {
  try {
    const collection = await getCollection(attachmentsFolderKey);
    await collection.delete({
      where: {
        attachment_id: Number(attachmentId)
      }
    });
    invalidateSearchCache(attachmentsFolderKey);
  } catch (error) {
    logger.warn("Suppression Chroma d'une piece jointe ignoree.", {
      attachmentId,
      message: error.message
    });
  }
}

export async function deleteDocumentFromIndex(documentRecord) {
  try {
    const collection = await getCollection(documentRecord.folderName);
    await collection.delete({
      where: {
        source_path: documentRecord.relativePath
      }
    });
    invalidateSearchCache(documentRecord.folderName);
  } catch (error) {
    logger.warn("Suppression Chroma ignoree.", {
      relativePath: documentRecord.relativePath,
      message: error.message
    });
  }
}

export async function clearAllIndexes() {
  const folders = [...(await listFolders()), webLinksFolderKey, attachmentsFolderKey];
  let clearedCollections = 0;

  for (const folder of folders) {
    try {
      const deleted = await deleteCollectionIfExists(folder);
      if (deleted) {
        clearedCollections += 1;
      }
    } catch (error) {
      logger.warn("Suppression d'une collection Chroma ignoree.", {
        folder,
        message: error.message
      });
    }
  }

  logger.info("Toutes les indexations ont ete supprimees de ChromaDB.", {
    clearedCollections
  });
  invalidateSearchCache();

  return { clearedCollections };
}

export async function clearFolderIndex(folderName) {
  const deleted = await deleteCollectionIfExists(folderName);
  invalidateSearchCache(folderName);

  logger.info("Index du dossier supprime.", {
    folderName,
    deleted
  });

  return { deleted };
}

export async function searchIndexedChunks(query, { folderName = "all", limit = 30 } = {}) {
  const safeQuery = String(query || "").trim();
  if (!safeQuery) {
    return {
      total: 0,
      results: []
    };
  }

  const folders = folderName === "all" ? await listFolders() : [folderName];
  const results = [];

  for (const folder of folders) {
    try {
      const rows = await loadCollectionRowsForSearch(folder);

      rows.forEach((row) => {
        const { score, matched } = scoreChunkSearch(safeQuery, row);
        if (!matched) {
          return;
        }

        results.push({
          id: row.id,
          score,
          chunkIndex: Number(row.metadata?.chunk_index || 0),
          folder: row.metadata?.folder || folder,
          relativePath: row.metadata?.source_path || "",
          fileName: row.metadata?.original_name || row.metadata?.file_name || "Document",
          documentId: row.metadata?.document_id || null,
          visibility: row.metadata?.visibility === "private" ? "private" : "public",
          snippet: buildChunkSnippet(row.document || "", safeQuery)
        });
      });
    } catch (error) {
      logger.warn("Recherche textuelle ignoree pour une collection.", {
        folder,
        message: error.message
      });
    }
  }

  const orderedResults = results
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.fileName.localeCompare(right.fileName, "fr");
    })
    .slice(0, limit);

  return {
    total: results.length,
    results: orderedResults
  };
}

export async function retrieveContext(question, folderName = "all", history = []) {
  const retrievalQuery = buildRetrievalQuery(question, history);
  const retrievalFocusQuestion = buildRetrievalFocusQuestion(question, history) || question;
  const folders = folderName === "all" ? await listFolders() : [folderName];
  const candidates = [];
  const explicitProfileQuestion = isIdentityQuestion(question) || isCreationQuestion(question);
  const referencedDocument = findReferencedDocument(question);
  const instructionResources = getManualResources({ enabledOnly: true, resourceType: "instruction" });
  const documentationLinkResources = getManualResources({
    enabledOnly: true,
    resourceType: "document_link"
  });
  const manualResources = prioritizeManualResources(
    retrievalFocusQuestion,
    instructionResources,
    explicitProfileQuestion,
    Math.max(maxManualResourcesInPrompt, instructionResources.length)
  );
  const documentLinkResources = prioritizeManualResources(
    retrievalFocusQuestion,
    documentationLinkResources,
    false,
    maxDocumentLinksInPrompt
  );
  const improvementRules = getRelevantImprovementRules(retrievalFocusQuestion, { limit: 5 });
  const queryEmbedding = await getEmbeddings().embedQuery(retrievalQuery);

  if (referencedDocument) {
    const directDocumentRows = await getIndexedRowsForDocument(referencedDocument);
    directDocumentRows.forEach((row) => {
      candidates.push({
        ...row,
        score: -0.01
      });
    });

    if (directDocumentRows.length === 0) {
      const directFileCandidates = await buildDirectCandidatesForDocuments(retrievalFocusQuestion, [
        referencedDocument
      ]);
      candidates.push(...directFileCandidates);
    }
  }

  const foldersToQuery =
    referencedDocument?.folder_name && folders.includes(referencedDocument.folder_name)
      ? [referencedDocument.folder_name]
      : folders;

  // Les liens web scrapes et les pieces jointes utilisateur participent toujours
  // a la recherche : ce sont des sources internes au meme titre que les documents.
  const collectionsToQuery = [...foldersToQuery, webLinksFolderKey, attachmentsFolderKey];

  for (const folder of collectionsToQuery) {
    try {
      const collection = await getCollection(folder);
      const queryResult = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: ragTopK,
        include: ["documents", "metadatas", "distances"]
      });

      const rows = typeof queryResult.rows === "function" ? queryResult.rows()[0] || [] : [];

      rows.forEach((row) => {
        candidates.push({
          pageContent: row.document || "",
          metadata: row.metadata || {},
          score: Number(row.distance || 0)
        });
      });
    } catch (error) {
      logger.warn("Recherche vectorielle ignoree pour une collection.", {
        folder,
        message: error.message
      });
    }
  }

  const chunks = prioritizeDocumentChunks(retrievalFocusQuestion, candidates);
  const domainKeywordScore = computeDomainKeywordScore(retrievalFocusQuestion, history);
  const maxRelevanceScore =
    chunks.length > 0 ? Math.max(...chunks.map((chunk) => chunk.relevanceScore)) : 0;
  const averageRelevanceScore =
    chunks.length > 0
      ? Number(
          (
            chunks.reduce((total, chunk) => total + Number(chunk.relevanceScore || 0), 0) /
            chunks.length
          ).toFixed(3)
        )
      : 0;
  const averagePriorityScore =
    chunks.length > 0
      ? Number(
          (
            chunks.reduce((total, chunk) => total + Number(chunk.priorityScore || 0), 0) /
            chunks.length
          ).toFixed(3)
        )
      : 0;
  const hasStrongDocumentContext =
    chunks.length > 0 &&
    (chunks.some((chunk) => Number(chunk.exactMentionBonus || 0) > 0) ||
    averagePriorityScore >= 0.42 ||
      (averagePriorityScore >= 0.3 && (domainKeywordScore >= 0.2 || maxRelevanceScore >= 0.28)) ||
      (referencedDocument && chunks.some((chunk) => Number(chunk.exactMentionBonus || 0) > 0)));

  const effectiveChunks = hasStrongDocumentContext ? chunks : [];
  const formattedSources = effectiveChunks.map((result) => formatSource(result));
  const privateSources = formattedSources.filter((source) => source.visibility === "private");
  const publicPdfSources = formattedSources.filter(
    (source) =>
      source.visibility === "public" &&
      source.downloadUrl &&
      String(source.fileName || source.relativePath || "").toLowerCase().endsWith(".pdf")
  );

  const sources = [];
  const seenSources = new Set();

  formattedSources.forEach((source) => {
    if (source.visibility !== "public") {
      return;
    }

    const key = `${source.relativePath}-${source.chunkIndex}`;
    if (!seenSources.has(key)) {
      seenSources.add(key);
      sources.push(source);
    }
  });

  documentLinkResources
    .filter((resource) => resource.isQuestionRelevant)
    .slice(0, 3)
    .map((resource) => formatDocumentLinkSource(resource))
    .filter(Boolean)
    .forEach((source) => {
      const key = `${source.relativePath}-${source.fileName}`;
      if (!seenSources.has(key)) {
        seenSources.add(key);
        sources.push(source);
      }
    });

  const contextString = buildContextString(effectiveChunks);

  let ratingSignals = { goodExamples: [], badExamples: [] };
  try {
    ratingSignals = getRatingSignalsForQuestion(retrievalFocusQuestion);
  } catch (error) {
    logger.warn("Signaux d'evaluation ignores pour cette question.", {
      message: error.message
    });
  }

  try {
    const chunkScores = chunks.map((chunk) => Number(chunk.priorityScore || 0));
    insertRetrievalScoreLog({
      folderName: folderName || "all",
      candidateCount: candidates.length,
      retainedCount: effectiveChunks.length,
      minScore: chunkScores.length > 0 ? Math.min(...chunkScores) : null,
      maxScore: chunkScores.length > 0 ? Math.max(...chunkScores) : null,
      avgScore: chunkScores.length > 0 ? Number((chunkScores.reduce((a, b) => a + b, 0) / chunkScores.length).toFixed(3)) : null,
      outOfScope: !hasStrongDocumentContext
    });
  } catch (error) {
    // La journalisation des scores ne doit jamais faire echouer une reponse.
    logger.warn("Journalisation des scores de recuperation ignoree.", { message: error.message });
  }

  return {
    query: retrievalQuery,
    focusQuery: retrievalFocusQuestion,
    ratingSignals,
    chunks,
    effectiveChunks,
    manualResources,
    documentLinkResources,
    improvementRules,
    sources,
    privateSources,
    publicPdfSources,
    contextString,
    maxRelevanceScore,
    averageRelevanceScore,
    averagePriorityScore,
    domainKeywordScore,
    referencedDocument,
    hasStrongDocumentContext,
    hasRelevantContext:
      manualResources.some((resource) => resource.isQuestionRelevant) ||
      documentLinkResources.some((resource) => resource.isQuestionRelevant) ||
      improvementRules.length > 0 ||
      hasStrongDocumentContext
  };
}

export async function getConversationContextSummary(history = [], modelName) {
  const limit = getConversationHistoryLimit();
  const recentHistory = getRecentConversationEntries(history, limit);
  const characters = recentHistory.reduce(
    (total, entry) => total + String(entry.content || "").length,
    0
  );

  const resolvedModelName = modelName || getActiveModel();
  const modelContextWindow = await getModelContextLength(resolvedModelName);

  return {
    usedMessages: recentHistory.length,
    limit,
    characters,
    maxCharacters: maxConversationCharacters,
    modelName: resolvedModelName,
    modelContextWindow
  };
}

export function buildChatMessages(question, history = [], retrieval = {}) {
  const shortFollowUpQuestion = isShortFollowUpQuestion(question);
  const carriesHistory = shouldCarryConversationHistory(question, history);
  const recentHistory = (carriesHistory ? getRecentConversationEntries(history, getConversationHistoryLimit()) : []).map(
    (entry) => ({
      role: entry.role,
      content: entry.content.trim()
    })
  );

  const messages = [
    {
      role: "system",
      content: buildSystemInstruction({
        shortFollowUpQuestion,
        hasInternalContext: retrieval.hasRelevantContext,
        carriesHistory
      })
    },
    {
      role: "system",
      content:
        "Priorite absolue de reponse : suivre d'abord les personnalisations internes, puis les feedbacks admin valides, puis les documents internes pertinents. Utilise la connaissance generale seulement en dernier recours."
    }
  ];

  if (retrieval.manualResources?.length > 0) {
    messages.push({
      role: "system",
      content: `Consignes internes actives a respecter pour toutes les reponses. Elles font autorite sur le comportement, le nommage, les formulations et les regles du projet :\n\n${retrieval.manualResources
        .map(
          (resource, index) =>
            `[RÈGLE ${index + 1}] ${resource.title}\nPriorité : ${resource.priorityScore}\n${resource.content.trim()}`
        )
        .join("\n\n")}`
    });
  }

  if (retrieval.documentLinkResources?.some((resource) => resource.isQuestionRelevant)) {
    messages.push({
      role: "system",
      content: `Documentation web interne pertinente a utiliser comme contexte documentaire complémentaire :\n\n${retrieval.documentLinkResources
        .filter((resource) => resource.isQuestionRelevant)
        .slice(0, 4)
        .map(
          (resource, index) =>
            `[LIEN ${index + 1}] ${resource.title}\nPriorité : ${resource.priorityScore}\nDescription : ${resource.content.trim()}\nURL : ${resource.link_url || ""}`
        )
        .join("\n\n")}`
    });
  }

  if (retrieval.improvementRules?.length > 0) {
    const strongestRule = retrieval.improvementRules[0];
    messages.push({
      role: "system",
      content: `Corrections deja validees par l'administration. Si la situation actuelle correspond, applique-les comme des consignes prioritaires :\n\n${retrieval.improvementRules
        .map(
          (rule, index) =>
            `[CORRECTION ${index + 1}] Priorite : ${rule.priority}\nScore de correspondance : ${rule.matchScore || 0}\nInstruction : ${rule.instruction}${
              rule.exampleQuestion ? `\nQuestion de reference : ${rule.exampleQuestion}` : ""
            }${
              rule.correctedResponse ? `\nRéponse attendue : ${rule.correctedResponse}` : ""
            }`
        )
        .join("\n\n")}`
    });

    if (Number(strongestRule?.matchScore || 0) >= 18) {
      messages.push({
        role: "system",
        content:
          "La question actuelle correspond fortement a une correction deja validee. Suis cette correction tres fidelement et privilegie la reponse corrigee attendue, sauf si elle contredit clairement une personnalisation interne plus recente ou un document interne explicite."
      });
    }
  }

  if (retrieval.ratingSignals?.goodExamples?.length > 0) {
    messages.push({
      role: "system",
      content: `Reponses deja jugees satisfaisantes par les utilisateurs sur des questions proches. Inspire-toi de leur contenu et de leur niveau de detail :\n\n${retrieval.ratingSignals.goodExamples
        .map(
          (example, index) =>
            `[BON EXEMPLE ${index + 1}]\nQuestion : ${example.question}\nRéponse appréciée : ${example.answer}`
        )
        .join("\n\n")}`
    });
  }

  if (retrieval.ratingSignals?.badExamples?.length > 0) {
    messages.push({
      role: "system",
      content: `Reponses deja jugees insatisfaisantes par les utilisateurs sur des questions proches. Ne reproduis pas ces reponses telles quelles : corrige leurs manques, sois plus precis et plus utile :\n\n${retrieval.ratingSignals.badExamples
        .map(
          (example, index) =>
            `[REPONSE A AMELIORER ${index + 1}]\nQuestion : ${example.question}\nRéponse jugée insuffisante : ${example.answer}`
        )
        .join("\n\n")}`
    });
  }

  if (retrieval.contextString) {
    messages.push({
      role: "system",
      content: `Contexte interne issu des documents du projet (à suivre en priorité quand il répond à la question) :\n\n${retrieval.contextString}`
    });
  }

  if (!retrieval.hasRelevantContext) {
    messages.push({
      role: "system",
      content:
        "Comme aucun contexte interne suffisamment pertinent n'a ete trouve, si tu reponds quand meme a partir de tes connaissances generales, ne l'annonce jamais explicitement (aucune mention du type 'cette reponse est basee sur l'IA' ou 'peut etre moins precise')."
    });
  }

  messages.push(...recentHistory);
  messages.push({
    role: "user",
    content: question.trim()
  });

  return messages;
}

export async function buildRagPayload(question, folderName = "all", history = []) {
  if ((isDocumentInventoryRequest(question) || isDocumentAccessRequest(question)) && getDocuments().length === 0) {
    await syncFilesystemToDatabase();
  }

  const explicitIdentityQuestion = isIdentityQuestion(question);
  const explicitCreationQuestion = isCreationQuestion(question);
  const documentInventoryRequest = isDocumentInventoryRequest(question);
  const explicitDocumentRequest = findExplicitDocumentRequest(question);
  const requestedDocumentGroup = findRequestedDocumentGroup(question);
  const retrieval = await retrieveContext(question, folderName, history);
  retrieval.projectFocusScore = computeProjectFocusScore(question, retrieval, history);
  const grounding = buildGroundingSummary(retrieval);

  if (explicitIdentityQuestion && retrieval.manualResources.length === 0) {
    return {
      messages: null,
      promptPreview: "",
      sources: [],
      grounding,
      responseOverride: `Je suis l'assistant de ${getBranding().projectName}.`
    };
  }

  if (explicitCreationQuestion && retrieval.manualResources.length === 0) {
    return {
      messages: null,
      promptPreview: "",
      sources: [],
      grounding,
      // Reponse fixe, volontairement independante du branding : quelle que soit
      // l'organisation qui deploie cet assistant, l'origine doit rester visible.
      responseOverride: "J'ai été créé par Aymeric Millot — aymericmillot.com."
    };
  }

  if (explicitDocumentRequest?.document) {
    const source = formatDocumentRecordSource(explicitDocumentRequest.document);

    if (source?.visibility === "private") {
      return {
        messages: null,
        promptPreview: "",
        sources: [],
        grounding,
        responseOverride:
          "Le document demandé est privé. Je peux m'appuyer sur son contenu pour répondre s'il est indexé, mais je ne peux pas vous le fournir ni le proposer au téléchargement."
      };
    }

    if (source?.downloadUrl) {
      return {
        messages: null,
        promptPreview: "",
        sources: [source],
        grounding,
        responseOverride: "Oui, le voici."
      };
    }

    return {
      messages: null,
      promptPreview: "",
      sources: [],
      grounding,
      responseOverride: "Je n'ai pas pu retrouver ce document dans un format accessible."
    };
  }

  if (
    retrieval.referencedDocument &&
    !retrieval.hasStrongDocumentContext &&
    !documentInventoryRequest &&
    !isDocumentAccessRequest(question)
  ) {
    const indexedButUnavailable = retrieval.referencedDocument.indexing_status === "indexed";
    return {
      messages: null,
      promptPreview: "",
      sources:
        retrieval.referencedDocument.visibility === "public"
          ? [formatDocumentRecordSource(retrieval.referencedDocument)].filter(Boolean)
          : [],
      grounding,
      responseOverride:
        retrieval.referencedDocument.visibility === "private"
          ? "J'ai bien identifié le document demandé, mais il est privé et je ne peux pas m'appuyer dessus de manière fiable dans cette réponse."
          : indexedButUnavailable
            ? "J'ai bien identifié le document demandé, mais son contenu indexé n'est pas exploitable de manière fiable pour le moment. Il faut relancer ou vérifier son indexation avant que je puisse en parler correctement."
            : "J'ai bien identifié le document demandé, mais il n'est pas encore exploitable de manière fiable pour répondre correctement."
    };
  }

  if (documentInventoryRequest) {
    const matchedDocuments = requestedDocumentGroup?.matches || [];
    const matchedSources = matchedDocuments
      .map((document) => formatDocumentRecordSource(document))
      .filter(Boolean);
    const publicSources = matchedSources.filter((source) => source.visibility === "public");
    const privateCount = matchedSources.length - publicSources.length;

    if (matchedSources.length > 0) {
      return {
        messages: null,
        promptPreview: "",
        sources: publicSources,
        grounding,
        responseOverride:
          privateCount > 0 && publicSources.length === 0
            ? "J'ai trouvé des documents correspondants, mais ils sont privés et je ne peux pas vous les fournir depuis le chat."
            : privateCount > 0
              ? "Oui, voici les documents publics correspondants. Certains autres documents correspondants sont privés et ne peuvent pas être partagés ici."
              : "Oui, les voici."
      };
    }

    return {
      messages: null,
      promptPreview: "",
      sources: [],
      grounding,
      responseOverride:
        requestedDocumentGroup?.searchTerms?.length > 0
          ? `Je n'ai pas trouvé de document correspondant a ${requestedDocumentGroup.searchTerms.join(", ")} parmi les documents a ma disposition.`
          : "Je ne peux pas lister ou transmettre tous les documents depuis le chat. Utilisez l'administration ou l'onglet de recherche pour consulter les documents indexes."
    };
  }

  const normalizedQuestion = normalizeDocumentName(question);

  const isAskingForPrivateDocumentAccess =
    isDocumentAccessRequest(question) &&
    retrieval.privateSources.some((source) => {
      const normalizedFileName = normalizeDocumentName(source.fileName);
      const normalizedRelativePath = normalizeDocumentName(source.relativePath);
      return (
        normalizedQuestion.includes(normalizedFileName) ||
        normalizedQuestion.includes(normalizedRelativePath) ||
        /\.(pdf|txt|md|docx|html?)\b/.test(normalizedQuestion)
      );
    });

  if (isAskingForPrivateDocumentAccess) {
    return {
      messages: null,
      promptPreview: "",
      sources: [],
      grounding,
      responseOverride:
        "Le document demandé est privé. Je peux m'appuyer sur son contenu pour répondre s'il est indexé, mais je ne peux pas vous le fournir ni le proposer au téléchargement."
    };
  }

  if (isSourceOnlyRequest(question) && retrieval.sources.length > 0) {
    return {
      messages: null,
      promptPreview: "",
      sources: retrieval.sources,
      grounding,
      responseOverride: ""
    };
  }

  if (isSourceOnlyRequest(question) && retrieval.sources.length === 0) {
    const sourceReferenceQuestion = findSourceReferenceQuestion(history);

    if (sourceReferenceQuestion) {
      const sourceReferenceRetrieval = await retrieveContext(sourceReferenceQuestion, folderName, []);
      const sourceReferenceGrounding = buildGroundingSummary(sourceReferenceRetrieval);

      if (sourceReferenceRetrieval.sources.length > 0) {
        return {
          messages: null,
          promptPreview: "",
          sources: sourceReferenceRetrieval.sources,
          grounding: sourceReferenceGrounding,
          responseOverride: ""
        };
      }

      if (sourceReferenceRetrieval.privateSources.length > 0) {
        return {
          messages: null,
          promptPreview: "",
          sources: [],
          grounding: sourceReferenceGrounding,
          responseOverride:
            "Je n'ai pas de source publique à vous fournir pour cette réponse. Les documents les plus proches sont privés."
        };
      }
    }
  }

  if (isSourceOnlyRequest(question) && retrieval.sources.length === 0 && retrieval.privateSources.length > 0) {
    return {
      messages: null,
      promptPreview: "",
      sources: [],
      grounding,
      responseOverride:
        "Je n'ai pas de source publique PDF à vous fournir pour cette réponse. Les documents les plus proches sont privés."
    };
  }

  const messages = buildChatMessages(question, history, retrieval);

  return {
    messages,
    promptPreview: buildMessagesPreview(messages),
    sources: retrieval.sources,
    grounding,
    responseOverride: null,
    retrieval
  };
}
