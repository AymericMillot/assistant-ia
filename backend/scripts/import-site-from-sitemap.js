#!/usr/bin/env node

import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { load as loadHtml } from "cheerio";
import dotenv from "dotenv";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const backendRoot = path.resolve(scriptDir, "..");
const projectRoot = path.resolve(backendRoot, "..");
const dataRoot = path.join(backendRoot, "data", "site-imports");

process.chdir(backendRoot);
dotenv.config({ path: path.join(projectRoot, ".env") });

const fileService = await import(pathToFileURL(path.join(backendRoot, "services/fileService.js")).href);
const ragService = await import(pathToFileURL(path.join(backendRoot, "services/ragService.js")).href);
const db = await import(pathToFileURL(path.join(backendRoot, "config/db.js")).href);

db.initializeDatabase();

const htmlOnlyExtensions = new Set([
  "",
  ".html",
  ".htm",
  ".php",
  ".asp",
  ".aspx",
  ".jsp"
]);
const ignoredAssetExtensions = new Set([
  ".pdf",
  ".txt",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".csv",
  ".zip",
  ".rar",
  ".7z",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".mp3",
  ".mp4",
  ".webm",
  ".avi",
  ".mov",
  ".css",
  ".js",
  ".json",
  ".xml"
]);
const contentSelectors = [
  "main",
  "article",
  "[role='main']",
  ".main",
  "#main",
  ".content",
  "#content",
  ".page-content",
  ".entry-content",
  ".post-content"
];

function printUsage() {
  console.log(`Usage:
  node scripts/import-site-from-sitemap.js --url https://example.com

Options:
  --url URL                    Site ou sitemap.xml a importer
  --title TITRE                Titre lisible du site (optionnel)
  --folder DOSSIER             Dossier cible des documents (defaut: documentation-web)
  --max-pages N                Maximum de pages a recuperer (defaut: 200)
  --max-sitemaps N             Maximum de sitemaps a analyser (defaut: 25)
  --crawl-concurrency N        Parallele pour recuperer les pages (defaut: 12)
  --index-concurrency N        Parallele pour indexer les documents (defaut: 2)
  --timeout-ms N               Timeout reseau par requete (defaut: 15000)
  --dry-run                    Analyse sans rien ecrire ni indexer
  --no-index                   Ecrit les documents sans lancer l'indexation
`);
}

function parseArgs(argv) {
  const options = {
    url: "",
    title: "",
    folder: "documentation-web",
    maxPages: 200,
    maxSitemaps: 25,
    crawlConcurrency: 12,
    indexConcurrency: 2,
    timeoutMs: 15_000,
    dryRun: false,
    noIndex: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--no-index") {
      options.noIndex = true;
      continue;
    }

    const nextValue = argv[index + 1];

    switch (arg) {
      case "--url":
        options.url = String(nextValue || "");
        index += 1;
        break;
      case "--title":
        options.title = String(nextValue || "");
        index += 1;
        break;
      case "--folder":
        options.folder = String(nextValue || "") || options.folder;
        index += 1;
        break;
      case "--max-pages":
        options.maxPages = Number(nextValue || options.maxPages);
        index += 1;
        break;
      case "--max-sitemaps":
        options.maxSitemaps = Number(nextValue || options.maxSitemaps);
        index += 1;
        break;
      case "--crawl-concurrency":
        options.crawlConcurrency = Number(nextValue || options.crawlConcurrency);
        index += 1;
        break;
      case "--index-concurrency":
        options.indexConcurrency = Number(nextValue || options.indexConcurrency);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(nextValue || options.timeoutMs);
        index += 1;
        break;
      default:
        throw new Error(`Argument non reconnu: ${arg}`);
    }
  }

  if (!options.url) {
    throw new Error("Le parametre --url est obligatoire.");
  }

  options.maxPages = Math.max(1, Number.isFinite(options.maxPages) ? Math.floor(options.maxPages) : 200);
  options.maxSitemaps = Math.max(
    1,
    Number.isFinite(options.maxSitemaps) ? Math.floor(options.maxSitemaps) : 25
  );
  options.crawlConcurrency = Math.max(
    1,
    Number.isFinite(options.crawlConcurrency) ? Math.floor(options.crawlConcurrency) : 12
  );
  options.indexConcurrency = Math.max(
    1,
    Number.isFinite(options.indexConcurrency) ? Math.floor(options.indexConcurrency) : 2
  );
  options.timeoutMs = Math.max(
    1_000,
    Number.isFinite(options.timeoutMs) ? Math.floor(options.timeoutMs) : 15_000
  );

  return options;
}

function sanitizeSlug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function buildSiteSlug(siteUrl, title = "") {
  const url = new URL(siteUrl);
  const titleSlug = sanitizeSlug(title);
  return titleSlug || sanitizeSlug(url.hostname.replace(/^www\./, ""));
}

function buildStorageManifestPath(siteSlug) {
  return path.join(dataRoot, `${siteSlug}.json`);
}

function resolveEntryUrl(input) {
  const parsed = new URL(input);
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("Seules les URLs http(s) sont prises en charge.");
  }
  return parsed;
}

async function fetchText(url, { timeoutMs, accept = "*/*" }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Assistant IA-Sitemap-Importer/1.0 (+local-rag)",
        Accept: accept,
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.6"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} sur ${url}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const currentIndex = cursor;
      cursor += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: safeConcurrency }, () => worker()));
  return results;
}

function parseRobotsSitemaps(robotsText) {
  return [...String(robotsText || "").matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)].map(
    (match) => match[1]
  );
}

async function discoverInitialSitemaps(entryUrl, timeoutMs) {
  const unique = new Set();

  if (entryUrl.pathname.endsWith(".xml")) {
    unique.add(entryUrl.toString());
  } else {
    unique.add(new URL("/sitemap.xml", entryUrl.origin).toString());
  }

  try {
    const robotsText = await fetchText(new URL("/robots.txt", entryUrl.origin), {
      timeoutMs,
      accept: "text/plain,text/*;q=0.9,*/*;q=0.5"
    });
    parseRobotsSitemaps(robotsText).forEach((url) => unique.add(url));
  } catch {
    // Pas bloquant si robots.txt est absent.
  }

  return [...unique];
}

function parseSitemapXml(xmlText) {
  const $ = loadHtml(xmlText, { xmlMode: true });
  const pageEntries = [];
  const nestedSitemaps = [];

  $("url").each((_, node) => {
    const loc = $(node).find("loc").text().trim();
    if (!loc) {
      return;
    }

    pageEntries.push({
      url: loc,
      lastmod: $(node).find("lastmod").text().trim() || null,
      changefreq: $(node).find("changefreq").text().trim() || null,
      priority: $(node).find("priority").text().trim() || null
    });
  });

  $("sitemap").each((_, node) => {
    const loc = $(node).find("loc").text().trim();
    if (!loc) {
      return;
    }

    nestedSitemaps.push(loc);
  });

  return {
    pageEntries,
    nestedSitemaps
  };
}

function isCandidatePageUrl(value, siteOrigin) {
  try {
    const url = new URL(value);
    if (url.origin !== siteOrigin) {
      return false;
    }

    url.hash = "";
    if (url.pathname.endsWith("/feed") || url.pathname.includes("/tag/")) {
      return false;
    }

    const extension = path.extname(url.pathname).toLowerCase();
    if (ignoredAssetExtensions.has(extension)) {
      return false;
    }

    return htmlOnlyExtensions.has(extension) || !extension;
  } catch {
    return false;
  }
}

function rankPageEntries(entries) {
  return [...entries].sort((left, right) => {
    const rightPriority = Number(right.priority || 0);
    const leftPriority = Number(left.priority || 0);
    if (rightPriority !== leftPriority) {
      return rightPriority - leftPriority;
    }

    const rightLastmod = right.lastmod ? Date.parse(right.lastmod) || 0 : 0;
    const leftLastmod = left.lastmod ? Date.parse(left.lastmod) || 0 : 0;
    if (rightLastmod !== leftLastmod) {
      return rightLastmod - leftLastmod;
    }

    const leftDepth = new URL(left.url).pathname.split("/").filter(Boolean).length;
    const rightDepth = new URL(right.url).pathname.split("/").filter(Boolean).length;
    if (leftDepth !== rightDepth) {
      return leftDepth - rightDepth;
    }

    return left.url.localeCompare(right.url, "fr");
  });
}

async function collectSitemapPageEntries(siteUrl, { timeoutMs, maxSitemaps, maxPages }) {
  const entryUrl = resolveEntryUrl(siteUrl);
  const sitemapQueue = await discoverInitialSitemaps(entryUrl, timeoutMs);
  const visitedSitemaps = new Set();
  const seenPages = new Set();
  const pageEntries = [];

  while (sitemapQueue.length > 0 && visitedSitemaps.size < maxSitemaps) {
    const sitemapUrl = sitemapQueue.shift();
    if (!sitemapUrl || visitedSitemaps.has(sitemapUrl)) {
      continue;
    }

    visitedSitemaps.add(sitemapUrl);

    let xmlText = "";
    try {
      xmlText = await fetchText(sitemapUrl, {
        timeoutMs,
        accept: "application/xml,text/xml;q=0.9,*/*;q=0.5"
      });
    } catch (error) {
      console.warn(`Sitemap ignore (${sitemapUrl}) : ${error.message}`);
      continue;
    }

    const { pageEntries: discoveredPages, nestedSitemaps } = parseSitemapXml(xmlText);

    nestedSitemaps.forEach((nestedUrl) => {
      if (!visitedSitemaps.has(nestedUrl)) {
        sitemapQueue.push(nestedUrl);
      }
    });

    for (const entry of discoveredPages) {
      if (!isCandidatePageUrl(entry.url, entryUrl.origin)) {
        continue;
      }

      const normalizedUrl = new URL(entry.url);
      normalizedUrl.hash = "";
      const normalizedKey = normalizedUrl.toString();

      if (seenPages.has(normalizedKey)) {
        continue;
      }

      seenPages.add(normalizedKey);
      pageEntries.push({
        ...entry,
        url: normalizedKey
      });

      if (pageEntries.length >= maxPages) {
        break;
      }
    }

    if (pageEntries.length >= maxPages) {
      break;
    }
  }

  return {
    entryOrigin: entryUrl.origin,
    visitedSitemaps: [...visitedSitemaps],
    pageEntries: rankPageEntries(pageEntries).slice(0, maxPages)
  };
}

function extractBestPageText(html, pageUrl) {
  const $ = loadHtml(html);

  $("script, style, noscript, svg, canvas, iframe, form, header, footer, nav, aside").remove();
  $("img").each((_, node) => {
    const alt = $(node).attr("alt");
    $(node).replaceWith(alt ? ` ${alt} ` : " ");
  });

  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").first().text().trim() ||
    "";
  const description =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    "";

  const candidateBodies = contentSelectors
    .map((selector) => $(selector).first())
    .filter((node) => node && node.length > 0)
    .map((node) => normalizeWhitespace(node.text()))
    .filter((text) => text.length >= 120);

  const mainText = candidateBodies.sort((left, right) => right.length - left.length)[0];
  const fallbackText = normalizeWhitespace($("body").text());
  const text = mainText || fallbackText;

  return {
    url: pageUrl,
    title,
    description,
    text
  };
}

async function fetchPageRecord(pageEntry, { timeoutMs }) {
  try {
    const html = await fetchText(pageEntry.url, {
      timeoutMs,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"
    });
    const extracted = extractBestPageText(html, pageEntry.url);
    if (!extracted.text || extracted.text.length < 120) {
      return null;
    }

    return {
      ...pageEntry,
      ...extracted,
      charCount: extracted.text.length,
      wordCount: extracted.text.split(/\s+/).filter(Boolean).length,
      contentHash: crypto.createHash("md5").update(extracted.text).digest("hex")
    };
  } catch (error) {
    return {
      ...pageEntry,
      failed: true,
      error: error.message
    };
  }
}

function buildPageDocumentFileName(siteSlug, page, index) {
  const url = new URL(page.url);
  const pageSlug =
    sanitizeSlug(page.title) ||
    sanitizeSlug(url.pathname.replace(/^\/+|\/+$/g, "").replace(/\//g, "-")) ||
    "page";
  const paddedIndex = String(index + 1).padStart(4, "0");
  return `${siteSlug}-${paddedIndex}-${pageSlug}.txt`;
}

function buildPageDocumentContent(siteTitle, page) {
  return normalizeWhitespace(`
${page.title || siteTitle || "Page web"}

URL source: ${page.url}
${page.lastmod ? `Derniere mise a jour sitemap: ${page.lastmod}` : ""}
${page.description ? `Description: ${page.description}` : ""}

${page.text}
  `);
}

async function loadExistingManifest(siteSlug) {
  try {
    const raw = await fs.readFile(buildStorageManifestPath(siteSlug), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function purgeManagedDocuments(manifest) {
  if (!manifest?.documents?.length) {
    return { removedCount: 0 };
  }

  let removedCount = 0;

  for (const managedDocument of manifest.documents) {
    if (!managedDocument?.relativePath) {
      continue;
    }

    const row = db.getDocumentByRelativePath(managedDocument.relativePath);
    if (row) {
      const documentRecord = fileService.getDocumentRecord(row.id);
      try {
        await ragService.deleteDocumentFromIndex(documentRecord);
      } catch {
        // Purge best-effort.
      }
      await fileService.deleteDocument(row.id).catch(() => undefined);
      removedCount += 1;
      continue;
    }

    const absolutePath = fileService.getAbsoluteDocumentPath(managedDocument.relativePath);
    await fs.rm(absolutePath, { force: true }).catch(() => undefined);
  }

  return { removedCount };
}

async function persistImportedPages({
  siteUrl,
  siteTitle,
  folderName,
  pages,
  visitedSitemaps,
  noIndex,
  indexConcurrency
}) {
  const safeFolderName = await fileService.createFolder(folderName);
  const siteSlug = buildSiteSlug(siteUrl, siteTitle);
  const existingManifest = await loadExistingManifest(siteSlug);
  const purgeResult = await purgeManagedDocuments(existingManifest);
  const folderPath = path.join(fileService.getUploadsRoot(), safeFolderName);
  const importedDocuments = [];

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const filename = buildPageDocumentFileName(siteSlug, page, index);
    const relativePath = path.join(safeFolderName, filename);
    const absolutePath = path.join(folderPath, filename);
    const documentContent = buildPageDocumentContent(siteTitle, page);

    await fs.writeFile(absolutePath, `${documentContent}\n`, "utf8");

    const md5Hash = await fileService.computeFileMd5(absolutePath);
    const existing = db.getDocumentByRelativePath(relativePath);
    const row = db.upsertDocument({
      folderName: safeFolderName,
      filename,
      originalName: `${page.title || new URL(page.url).hostname}.txt`,
      relativePath,
      visibility: existing?.visibility || "public",
      mimeType: "text/plain; charset=utf-8",
      size: Buffer.byteLength(documentContent, "utf8"),
      md5Hash,
      indexedMd5Hash: null,
      indexingStatus: noIndex ? "pending" : "pending",
      chunkCount: 0,
      lastIndexedAt: null,
      lastError: null
    });

    importedDocuments.push({
      id: row.id,
      relativePath,
      title: page.title || "",
      url: page.url,
      lastmod: page.lastmod || null
    });
  }

  const manifest = {
    siteUrl,
    siteTitle,
    siteSlug,
    folderName: safeFolderName,
    importedAt: new Date().toISOString(),
    visitedSitemaps,
    stats: {
      removedBeforeImport: purgeResult.removedCount,
      pageCount: pages.length
    },
    documents: importedDocuments
  };

  await fs.mkdir(dataRoot, { recursive: true });
  await fs.writeFile(buildStorageManifestPath(siteSlug), JSON.stringify(manifest, null, 2), "utf8");

  if (!noIndex && importedDocuments.length > 0) {
    await mapWithConcurrency(importedDocuments, indexConcurrency, async (managedDocument) => {
      const documentRecord = fileService.getDocumentRecord(managedDocument.id);

      try {
        const result = await ragService.indexDocument(documentRecord);
        db.updateDocumentRow(managedDocument.id, {
          indexing_status: "indexed",
          chunk_count: result.chunkCount,
          indexed_md5_hash: documentRecord.md5Hash,
          last_error: null,
          last_indexed_at: new Date().toISOString()
        });
      } catch (error) {
        db.updateDocumentRow(managedDocument.id, {
          indexing_status: "error",
          chunk_count: 0,
          indexed_md5_hash: null,
          last_error: error.message,
          last_indexed_at: null
        });
      }
    });
  }

  return manifest;
}

async function importSiteFromSitemap(options) {
  const siteUrl = resolveEntryUrl(options.url).toString();
  const siteSlug = buildSiteSlug(siteUrl, options.title);

  console.log(`\nAnalyse du site : ${siteUrl}`);
  console.log(`Dossier cible : ${options.folder}`);
  console.log(`Mode : ${options.dryRun ? "dry-run" : options.noIndex ? "import sans indexation" : "import + indexation"}`);

  const discovery = await collectSitemapPageEntries(siteUrl, {
    timeoutMs: options.timeoutMs,
    maxSitemaps: options.maxSitemaps,
    maxPages: options.maxPages
  });

  if (discovery.pageEntries.length === 0) {
    throw new Error("Aucune page exploitable n'a ete trouvee dans le sitemap.");
  }

  console.log(`Sitemaps analyses : ${discovery.visitedSitemaps.length}`);
  console.log(`Pages candidates : ${discovery.pageEntries.length}`);

  const crawledPages = await mapWithConcurrency(
    discovery.pageEntries,
    options.crawlConcurrency,
    async (pageEntry) => fetchPageRecord(pageEntry, { timeoutMs: options.timeoutMs })
  );

  const successfulPages = crawledPages.filter((page) => page && !page.failed);
  const failedPages = crawledPages.filter((page) => page?.failed);

  console.log(`Pages texte extraites : ${successfulPages.length}`);
  if (failedPages.length > 0) {
    console.log(`Pages ignorees ou en erreur : ${failedPages.length}`);
  }

  const siteTitle =
    options.title ||
    successfulPages.find((page) => page.title)?.title ||
    resolveEntryUrl(siteUrl).hostname.replace(/^www\./, "");

  const dryRunManifest = {
    siteUrl,
    siteTitle,
    siteSlug,
    folderName: options.folder,
    visitedSitemaps: discovery.visitedSitemaps,
    pages: successfulPages.slice(0, 10).map((page) => ({
      url: page.url,
      title: page.title,
      chars: page.charCount,
      words: page.wordCount
    })),
    failures: failedPages.slice(0, 10).map((page) => ({
      url: page.url,
      error: page.error
    }))
  };

  if (options.dryRun) {
    return {
      dryRun: true,
      summary: dryRunManifest
    };
  }

  const manifest = await persistImportedPages({
    siteUrl,
    siteTitle,
    folderName: options.folder,
    pages: successfulPages,
    visitedSitemaps: discovery.visitedSitemaps,
    noIndex: options.noIndex,
    indexConcurrency: options.indexConcurrency
  });

  return {
    dryRun: false,
    summary: {
      siteUrl,
      siteTitle,
      siteSlug,
      folderName: manifest.folderName,
      pageCount: successfulPages.length,
      indexed: !options.noIndex,
      manifestPath: buildStorageManifestPath(siteSlug),
      failures: failedPages.slice(0, 10).map((page) => ({
        url: page.url,
        error: page.error
      }))
    }
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = await importSiteFromSitemap(options);

  console.log("\nResume :");
  console.log(JSON.stringify(result.summary, null, 2));
} catch (error) {
  console.error(`\nErreur : ${error.message}`);
  process.exitCode = 1;
}
