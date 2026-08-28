import dns from "dns/promises";
import net from "net";
import { load as loadHtml } from "cheerio";
import {
  getManualResourceById,
  insertManualResourceScrapePage,
  updateManualResourceScrapeState
} from "../config/db.js";
import { logger } from "../config/logger.js";
import { deleteWebLinkFromIndex, indexWebLinkResource } from "./ragService.js";

const scrapeTimeoutMs = Number(process.env.WEB_SCRAPE_TIMEOUT_MS || 20000);
const scrapeMaxBytes = Number(process.env.WEB_SCRAPE_MAX_BYTES || 3 * 1024 * 1024);
const scrapeMaxChars = Number(process.env.WEB_SCRAPE_MAX_CHARS || 200000);
const scrapeUserAgent =
  process.env.WEB_SCRAPE_USER_AGENT || "Assistant IA-Assistant/1.0 (indexation documentaire interne)";
// Par defaut, les adresses privees sont refusees (protection SSRF). Un atelier
// disposant d'une documentation intranet peut l'autoriser explicitement.
const allowPrivateTargets = process.env.WEB_SCRAPE_ALLOW_PRIVATE === "1";

const inFlightScrapes = new Set();

function scrapeError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function isPrivateIpAddress(address) {
  const normalized = String(address || "").replace(/^::ffff:/i, "");

  if (net.isIPv4(normalized)) {
    return (
      /^(10\.|127\.|0\.|169\.254\.|192\.168\.)/.test(normalized) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)
    );
  }

  if (net.isIPv6(normalized)) {
    return (
      normalized === "::1" ||
      /^f[cd]/i.test(normalized) ||
      /^fe80/i.test(normalized)
    );
  }

  return true;
}

async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw scrapeError("Lien invalide.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw scrapeError("Seuls les liens http(s) sont autorisés.");
  }

  if (allowPrivateTargets) {
    return parsed;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw scrapeError(
      "Ce lien pointe vers une adresse interne et ne peut pas être analysé. (Définir WEB_SCRAPE_ALLOW_PRIVATE=1 pour autoriser les sites du réseau local.)"
    );
  }

  if (net.isIP(hostname) && isPrivateIpAddress(hostname)) {
    throw scrapeError(
      "Ce lien pointe vers une adresse interne et ne peut pas être analysé. (Définir WEB_SCRAPE_ALLOW_PRIVATE=1 pour autoriser les sites du réseau local.)"
    );
  }

  if (!net.isIP(hostname)) {
    let resolved;
    try {
      resolved = await dns.lookup(hostname, { all: true });
    } catch {
      throw scrapeError("Le site du lien est introuvable (résolution DNS impossible).");
    }

    if (resolved.some((entry) => isPrivateIpAddress(entry.address))) {
      throw scrapeError(
        "Ce lien pointe vers une adresse interne et ne peut pas être analysé. (Définir WEB_SCRAPE_ALLOW_PRIVATE=1 pour autoriser les sites du réseau local.)"
      );
    }
  }

  return parsed;
}

async function readBodyWithLimit(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return text.slice(0, scrapeMaxBytes);
  }

  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    received += value.byteLength;
    text += decoder.decode(value, { stream: true });

    if (received >= scrapeMaxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }

  return text;
}

export function extractReadableText(html, { baseUrl = "" } = {}) {
  const $ = loadHtml(html);

  $("script, style, noscript, svg, iframe, form, nav, header, footer, aside").remove();
  $("[role='navigation'], [role='banner'], [role='contentinfo'], [aria-hidden='true']").remove();

  const title = $("title").first().text().trim();
  const mainCandidates = ["main", "article", "[role='main']", "#content", ".content", "body"];
  let mainText = "";

  for (const selector of mainCandidates) {
    const candidateText = $(selector).first().text() || "";
    if (candidateText.replace(/\s+/g, " ").trim().length >= 200) {
      mainText = candidateText;
      break;
    }
  }

  if (!mainText) {
    mainText = $("body").text() || "";
  }

  const normalized = mainText
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, scrapeMaxChars);

  return {
    title,
    text: normalized,
    baseUrl
  };
}

export async function fetchPageText(rawUrl) {
  const parsedUrl = await assertPublicHttpUrl(rawUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("timeout")), scrapeTimeoutMs);

  let response;
  try {
    response = await fetch(parsedUrl.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": scrapeUserAgent,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"
      }
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw scrapeError("Le site du lien met trop de temps à répondre.");
    }
    throw scrapeError("Impossible de joindre le site du lien.");
  } finally {
    clearTimeout(timeoutId);
  }

  // Les redirections peuvent renvoyer vers une adresse interne : on revalide l'URL finale.
  if (response.url && response.url !== parsedUrl.toString()) {
    await assertPublicHttpUrl(response.url);
  }

  if (!response.ok) {
    throw scrapeError(`Le site du lien a répondu avec une erreur (${response.status}).`);
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType && !/text\/html|application\/xhtml|text\/plain/.test(contentType)) {
    throw scrapeError("Ce lien ne pointe pas vers une page texte lisible (HTML ou texte).");
  }

  const body = await readBodyWithLimit(response);

  if (/text\/plain/.test(contentType)) {
    return {
      title: parsedUrl.hostname,
      text: body.replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, scrapeMaxChars),
      baseUrl: parsedUrl.toString()
    };
  }

  return extractReadableText(body, { baseUrl: parsedUrl.toString() });
}

/**
 * Scrape la page d'un lien documentaire et indexe son contenu dans ChromaDB.
 * Met a jour l'etat de scraping du lien (pending -> ok/error) pour l'admin.
 */
export async function scrapeAndIndexLinkResource(resourceId) {
  const resource = getManualResourceById(resourceId);
  if (!resource || resource.resource_type !== "document_link" || !resource.link_url) {
    throw scrapeError("Lien documentaire introuvable.");
  }

  if (inFlightScrapes.has(resource.id)) {
    return { alreadyRunning: true };
  }

  inFlightScrapes.add(resource.id);
  updateManualResourceScrapeState(resource.id, { scrapeStatus: "pending", scrapeError: null });

  try {
    const page = await fetchPageText(resource.link_url);

    if (!page.text || page.text.length < 80) {
      throw scrapeError(
        "La page ne contient pas assez de texte exploitable pour être indexée."
      );
    }

    const { chunkCount } = await indexWebLinkResource(resource, page.text);
    const fetchedAt = new Date().toISOString();

    updateManualResourceScrapeState(resource.id, {
      scrapeStatus: "ok",
      scrapedAt: fetchedAt,
      scrapeError: null,
      scrapedChars: page.text.length
    });
    insertManualResourceScrapePage({
      manualResourceId: resource.id,
      url: resource.link_url,
      status: "success",
      fetchedAt,
      characters: page.text.length
    });

    logger.info("Scraping et indexation d'un lien documentaire termines.", {
      linkId: resource.id,
      url: resource.link_url,
      chars: page.text.length,
      chunkCount
    });

    return { chunkCount, chars: page.text.length, title: page.title };
  } catch (error) {
    updateManualResourceScrapeState(resource.id, {
      scrapeStatus: "error",
      scrapeError: error.message || "Analyse du lien impossible."
    });
    insertManualResourceScrapePage({
      manualResourceId: resource.id,
      url: resource.link_url,
      status: "error",
      fetchedAt: new Date().toISOString(),
      errorMessage: error.message || "Analyse du lien impossible."
    });
    throw error;
  } finally {
    inFlightScrapes.delete(resource.id);
  }
}

/**
 * Lance le scraping en tache de fond sans bloquer la reponse HTTP.
 */
export function scheduleLinkScrape(resourceId) {
  scrapeAndIndexLinkResource(resourceId).catch((error) => {
    logger.warn("Scraping d'un lien documentaire echoue.", {
      linkId: resourceId,
      message: error.message
    });
  });
}

export async function removeLinkFromIndex(resourceId) {
  await deleteWebLinkFromIndex(resourceId);
}
