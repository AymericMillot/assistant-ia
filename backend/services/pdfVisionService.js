// Indexation visuelle des PDF : les pages qui contiennent des images (photos,
// schemas, plans, captures, pictogrammes) ou qui sont scannees sont rendues en
// image puis decrites par le modele de vision. Ces descriptions sont indexees
// comme des extraits a part entiere du document, ce qui rend le contenu des
// images retrouvable par la recherche et utilisable dans les reponses.
//
// Outils : poppler (pdfimages / pdftoppm / pdftotext, installes dans l'image
// Docker) en priorite, pdf-parse (pdf.js) en secours.
import crypto from "crypto";
import { createReadStream } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { execFile } from "child_process";
import { PDFParse } from "pdf-parse";
import { getVisualDescription, saveVisualDescription } from "../config/db.js";
import { logger } from "../config/logger.js";
import { describeImage, getActiveModel, getActiveModelByRole, modelSupportsVision } from "./ollamaService.js";
import {
  VISION_PROMPT_VERSION,
  VISION_SYSTEM_PROMPT,
  buildVisionPrompt,
  cleanVisionDescription,
  parsePdfImagesList,
  selectPagesForVision
} from "./pdfVisionPages.js";

export { VISION_PROMPT_VERSION };

const execFileAsync = promisify(execFile);

function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getVisionSettings() {
  return {
    enabled: String(process.env.PDF_VISION_ENABLED || "true").toLowerCase() !== "false",
    analyzeAllPages: String(process.env.PDF_VISION_ALL_PAGES || "false").toLowerCase() === "true",
    maxPages: readNumberEnv("PDF_VISION_MAX_PAGES", 40),
    minImagePixels: readNumberEnv("PDF_VISION_MIN_IMAGE_PX", 80),
    renderWidth: readNumberEnv("PDF_VISION_RENDER_WIDTH", 1280),
    pageTimeoutMs: readNumberEnv("PDF_VISION_PAGE_TIMEOUT_MS", 5 * 60 * 1000),
    // En dessous de ce nombre de caracteres, une page est consideree comme
    // scannee ou purement graphique (plan, schema vectoriel...).
    lowTextThreshold: readNumberEnv("PDF_VISION_LOW_TEXT_CHARS", 40)
  };
}

export async function computeFileHash(absolutePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    createReadStream(absolutePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function withPdfParser(absolutePath, callback) {
  const parser = new PDFParse({ data: await fs.readFile(absolutePath) });
  try {
    return await callback(parser);
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/**
 * Texte page par page : sert de contexte au modele de vision (legendes, titre
 * de la page) et a reperer les pages scannees.
 */
export async function readPdfPages(absolutePath) {
  try {
    const result = await withPdfParser(absolutePath, (parser) => parser.getText());
    const pages = (result.pages || []).map((page) => ({ pageNumber: page.num, text: String(page.text || "") }));
    if (pages.length > 0) {
      return pages;
    }
  } catch (error) {
    logger.warn("Lecture page par page via pdf-parse impossible, repli pdftotext.", { message: error.message });
  }

  const { stdout } = await execFileAsync("pdftotext", ["-enc", "UTF-8", absolutePath, "-"], {
    maxBuffer: 50 * 1024 * 1024
  });
  // pdftotext separe les pages par un saut de page (\f), y compris apres la derniere.
  const parts = String(stdout || "").split("\f");
  if (parts.length > 1 && !parts[parts.length - 1].trim()) {
    parts.pop();
  }
  return parts.map((text, index) => ({ pageNumber: index + 1, text }));
}

async function listPdfImages(absolutePath, minImagePixels) {
  try {
    const { stdout } = await execFileAsync("pdfimages", ["-list", absolutePath], {
      maxBuffer: 20 * 1024 * 1024
    });
    return parsePdfImagesList(stdout);
  } catch (error) {
    logger.info("pdfimages indisponible, detection des images via pdf-parse.", { message: error.message });
  }

  const result = await withPdfParser(absolutePath, (parser) =>
    parser.getImage({ imageThreshold: minImagePixels, imageBuffer: false, imageDataUrl: false })
  );
  return (result.pages || []).flatMap((page) =>
    (page.images || []).map((image) => ({
      pageNumber: page.pageNumber,
      type: "image",
      width: Number(image.width || 0),
      height: Number(image.height || 0),
      // Les noms pdf.js ne sont pas stables d'une page a l'autre : pas de
      // detection des logos repetes dans ce mode.
      objectId: `${page.pageNumber}:${image.name}`
    }))
  );
}

async function renderPageWithPdftoppm(absolutePath, pageNumber, renderWidth) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-ia-page-"));
  const outputBase = path.join(tempDir, "page");

  try {
    await execFileAsync(
      "pdftoppm",
      ["-f", String(pageNumber), "-l", String(pageNumber), "-png", "-singlefile", "-scale-to", String(renderWidth), absolutePath, outputBase],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    return await fs.readFile(`${outputBase}.png`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function renderPdfPage(absolutePath, pageNumber, { renderWidth = 1280 } = {}) {
  try {
    return await renderPageWithPdftoppm(absolutePath, pageNumber, renderWidth);
  } catch (error) {
    logger.info("pdftoppm indisponible, rendu de la page via pdf-parse.", { message: error.message });
  }

  const result = await withPdfParser(absolutePath, (parser) =>
    parser.getScreenshot({ partial: [pageNumber], desiredWidth: renderWidth, imageBuffer: true, imageDataUrl: false })
  );
  const page = (result.pages || [])[0];
  if (!page?.data?.length) {
    throw new Error(`Rendu de la page ${pageNumber} impossible.`);
  }
  return Buffer.from(page.data);
}

function isFatalVisionError(error) {
  const message = String(error?.message || "");
  return /model .* not found|pull it first|does not support|requires more system memory|insufficient memory|not enough memory|ECONNREFUSED|fetch failed/i.test(
    message
  );
}

/**
 * Modele utilise pour l'indexation visuelle : le modele "image" configure dans
 * l'admin, sinon le modele de conversation s'il sait lire les images
 * (ex: gemma3, qwen2.5vl, mistral-small3.1). null si aucun ne convient.
 */
export async function resolveVisionModel() {
  const imageModel = String(getActiveModelByRole("image") || "").trim();
  if (imageModel && (await modelSupportsVision(imageModel))) {
    return imageModel;
  }

  if (imageModel) {
    logger.warn("Le modele image configure ne declare pas la capacite vision : il est ignore pour l'indexation des PDF.", {
      model: imageModel
    });
  }

  const textModel = String(getActiveModel() || "").trim();
  if (textModel && (await modelSupportsVision(textModel))) {
    return textModel;
  }

  return null;
}

/**
 * Decrit le contenu visuel d'un PDF.
 *
 * mode "full" : appelle le modele de vision pour les pages sans description en
 * cache ; "cache-only" : n'utilise que le cache (apercu du decoupage).
 *
 * Renvoie { model, sections: [{ pageNumber, content, pageText }], stats } ;
 * sections est vide si la vision est desactivee, indisponible ou inutile.
 */
export async function analyzePdfVisualContent(
  absolutePath,
  { documentLabel, fileHash = null, pages = null, mode = "full", shouldAbort, beforePage, onProgress } = {}
) {
  const settings = getVisionSettings();
  const emptyResult = (reason, extra = {}) => ({
    model: null,
    sections: [],
    stats: { reason, candidatePages: 0, analyzedPages: 0, cachedPages: 0, emptyPages: 0, failedPages: 0, skippedPages: 0, ...extra }
  });

  if (!settings.enabled) {
    return emptyResult("disabled");
  }

  const model = await resolveVisionModel();
  if (!model) {
    return emptyResult("no-vision-model");
  }

  const pageTexts = pages || (await readPdfPages(absolutePath));
  if (pageTexts.length === 0) {
    return emptyResult("no-pages");
  }

  let images = [];
  try {
    images = await listPdfImages(absolutePath, settings.minImagePixels);
  } catch (error) {
    logger.warn("Detection des images du PDF impossible : seules les pages sans texte seront analysees.", {
      message: error.message
    });
  }

  const { selected, skipped } = selectPagesForVision(pageTexts, images, settings);
  if (selected.length === 0) {
    return { ...emptyResult("no-visual-pages"), model };
  }

  if (skipped > 0) {
    logger.warn("Document tres illustre : seules les pages les plus riches en images sont analysees.", {
      documentLabel,
      analysed: selected.length,
      skipped,
      limit: settings.maxPages
    });
  }

  const hash = fileHash || (await computeFileHash(absolutePath));
  const textByPage = new Map(pageTexts.map((page) => [page.pageNumber, page.text]));
  const stats = {
    reason: "ok",
    candidatePages: selected.length,
    analyzedPages: 0,
    cachedPages: 0,
    emptyPages: 0,
    failedPages: 0,
    skippedPages: skipped
  };
  const sections = [];

  for (const [index, candidate] of selected.entries()) {
    if (typeof shouldAbort === "function" && shouldAbort()) {
      const error = new Error("Indexation interrompue.");
      error.name = "AbortError";
      throw error;
    }

    const cacheKey = { fileHash: hash, model, pageNumber: candidate.pageNumber, promptVersion: VISION_PROMPT_VERSION };
    let description = getVisualDescription(cacheKey);

    if (description !== null) {
      stats.cachedPages += 1;
    } else if (mode === "full") {
      if (typeof beforePage === "function") {
        await beforePage({ pageNumber: candidate.pageNumber, index, total: selected.length });
      }

      try {
        const image = await renderPdfPage(absolutePath, candidate.pageNumber, settings);
        const { text } = await describeImage({
          model,
          system: VISION_SYSTEM_PROMPT,
          prompt: buildVisionPrompt({
            documentLabel,
            pageNumber: candidate.pageNumber,
            totalPages: pageTexts.length,
            pageText: textByPage.get(candidate.pageNumber),
            reason: candidate.reason
          }),
          imageBase64: image.toString("base64"),
          signal: AbortSignal.timeout(settings.pageTimeoutMs)
        });
        description = cleanVisionDescription(text);
        saveVisualDescription({ ...cacheKey, description });
        stats.analyzedPages += 1;
      } catch (error) {
        stats.failedPages += 1;
        logger.warn("Description visuelle d'une page impossible.", {
          documentLabel,
          pageNumber: candidate.pageNumber,
          model,
          message: error.message
        });

        if (isFatalVisionError(error)) {
          // Modele absent ou memoire insuffisante : inutile d'insister sur les
          // pages suivantes, le document reste indexe avec son texte.
          stats.reason = "vision-model-error";
          break;
        }
      }
    }

    if (description) {
      sections.push({
        pageNumber: candidate.pageNumber,
        content: description,
        pageText: textByPage.get(candidate.pageNumber) || ""
      });
    } else if (description === "") {
      stats.emptyPages += 1;
    }

    if (typeof onProgress === "function") {
      await onProgress({ processedPages: index + 1, totalPages: selected.length, pageNumber: candidate.pageNumber });
    }
  }

  return { model, sections, stats };
}
