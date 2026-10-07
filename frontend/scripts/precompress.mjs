// Precompression du build (brotli + gzip) : le backend sert directement ces
// fichiers aux navigateurs qui les acceptent (voir backend/utils/staticAssets.js),
// sans compresser a chaque requete.
//
//   node scripts/precompress.mjs [dossier]   (par defaut : dist)
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const distDir = path.resolve(process.argv[2] || "dist");
const compressibleExtensions = new Set([".js", ".mjs", ".css", ".svg", ".json", ".txt", ".map", ".webmanifest"]);
const minimumBytes = 1024;

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const absolutePath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(absolutePath) : [absolutePath];
    })
  );
  return nested.flat();
}

async function precompress(filePath) {
  const content = await fs.readFile(filePath);
  if (content.length < minimumBytes) {
    return null;
  }

  const [brotliContent, gzipContent] = await Promise.all([
    brotli(content, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: content.length
      }
    }),
    gzip(content, { level: zlib.constants.Z_BEST_COMPRESSION })
  ]);

  // Une version compressee plus lourde que l'original ne sert a rien.
  const written = [];
  if (brotliContent.length < content.length) {
    await fs.writeFile(`${filePath}.br`, brotliContent);
    written.push(brotliContent.length);
  }
  if (gzipContent.length < content.length) {
    await fs.writeFile(`${filePath}.gz`, gzipContent);
  }

  return { filePath, original: content.length, brotli: written[0] ?? content.length };
}

const files = (await listFiles(distDir)).filter((filePath) =>
  compressibleExtensions.has(path.extname(filePath).toLowerCase())
);
const results = (await Promise.all(files.map(precompress))).filter(Boolean);
const original = results.reduce((total, entry) => total + entry.original, 0);
const compressed = results.reduce((total, entry) => total + entry.brotli, 0);

console.log(
  `Precompression : ${results.length} fichier(s), ${(original / 1024).toFixed(0)} Ko -> ${(compressed / 1024).toFixed(0)} Ko (brotli).`
);
