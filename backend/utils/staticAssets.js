import fs from "fs";
import path from "path";

// Les assets du build sont precompresses (frontend/scripts/precompress.mjs) :
// on sert directement la version brotli ou gzip quand le navigateur l'accepte,
// sans compresser a la volee (CPU) et sans toucher aux flux SSE du chat.
function collectPrecompressedAssets(rootDir) {
  const available = new Set();

  const walk = (directory) => {
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (/\.(br|gz)$/.test(entry.name)) {
        available.add(`/${path.relative(rootDir, absolutePath).split(path.sep).join("/")}`);
      }
    }
  };

  walk(rootDir);
  return available;
}

export function applyStaticCacheHeaders(res, filePath) {
  if (filePath.endsWith("index.html")) {
    res.setHeader("Cache-Control", "no-store");
    return;
  }

  if (/[.-][A-Za-z0-9_-]{6,}\.(js|css)$/.test(filePath)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=3600");
}

export function createPrecompressedStaticMiddleware(rootDir) {
  const available = collectPrecompressedAssets(rootDir);
  const encodings = [
    { name: "br", extension: ".br", pattern: /\bbr\b/ },
    { name: "gzip", extension: ".gz", pattern: /\bgzip\b/ }
  ];

  return (req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || available.size === 0) {
      next();
      return;
    }

    // Seuls les chemins effectivement presents dans le build sont servis :
    // aucune construction de chemin a partir de l'URL hors de cet ensemble.
    const requestPath = req.path;
    const variants = encodings.filter(({ extension }) => available.has(`${requestPath}${extension}`));
    if (variants.length === 0) {
      next();
      return;
    }

    res.setHeader("Vary", "Accept-Encoding");
    const accepted = String(req.headers["accept-encoding"] || "");
    const encoding = variants.find(({ pattern }) => pattern.test(accepted));
    if (!encoding) {
      next();
      return;
    }

    const originalPath = path.join(rootDir, requestPath);
    res.setHeader("Content-Encoding", encoding.name);
    res.type(path.extname(originalPath));
    applyStaticCacheHeaders(res, originalPath);
    res.sendFile(`${originalPath}${encoding.extension}`, { lastModified: true, etag: true }, (error) => {
      if (error && !res.headersSent) {
        res.removeHeader("Content-Encoding");
        next();
      }
    });
  };
}
