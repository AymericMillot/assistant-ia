import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const updateConfigPath = path.join(projectRoot, "update.config.json");

function normalizeVersion(version) {
  return String(version || "0")
    .trim()
    .split(".")
    .map((part) => Number(part) || 0);
}

function compareVersions(left, right) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  const maxLength = Math.max(a.length, b.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = a[index] || 0;
    const rightValue = b[index] || 0;
    if (leftValue > rightValue) {
      return 1;
    }
    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

function joinUrl(baseUrl, targetPath) {
  const normalizedBase = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedPath = String(targetPath || "").replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedPath}`;
}

function extractDirectoryLinksFromIndex(html) {
  const matches = [...String(html || "").matchAll(/<a\s+href="([^"]+\/)"/gi)];
  return matches
    .map((match) => String(match[1] || "").trim())
    .filter((href) => href && href !== "../" && !href.startsWith("?"))
    .map((href) => href.replace(/\/+$/, ""))
    .filter((name, index, array) => array.indexOf(name) === index);
}

function isVersionFolderName(value) {
  return /^\d+(?:\.\d+)*$/.test(String(value || "").trim());
}

function resolvePackageFileName(serverConfig, version) {
  const template = String(serverConfig.packageFileTemplate || "").trim();
  if (template) {
    return template.replace(/\{version\}/g, version);
  }

  const packageFile = String(serverConfig.packageFile || "").trim();
  if (packageFile.includes("{version}")) {
    return packageFile.replace(/\{version\}/g, version);
  }

  return packageFile || `fablab-ai-v${version}.tar.gz`;
}

async function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    import("fs").then((fsModule) => {
      const stream = fsModule.createReadStream(filePath);
      stream.on("error", reject);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
    }, reject);
  });
}

async function main() {
  const config = JSON.parse(await fs.readFile(updateConfigPath, "utf8"));
  const server = config.server || {};

  if (String(server.type || "http").toLowerCase() === "github-releases") {
    const repository = String(server.repository || "").trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error("Le dépôt GitHub de mise à jour est invalide.");
    }

    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!response.ok) {
      throw new Error(`Impossible de récupérer la dernière release GitHub (${response.status}).`);
    }

    const release = await response.json();
    const version = String(release.tag_name || "").replace(/^v/i, "");
    if (!isVersionFolderName(version)) {
      throw new Error("Le tag de la dernière release GitHub est invalide.");
    }
    const manifestName = String(server.manifestFileTemplate || "fablab-ai-v{version}.manifest.json").replace(
      /\{version\}/g,
      version
    );
    const manifestAsset = (release.assets || []).find((asset) => asset.name === manifestName);
    if (!manifestAsset?.browser_download_url) {
      throw new Error("Le manifest de vérification est absent de la dernière release GitHub.");
    }
    const manifestResponse = await fetch(manifestAsset.browser_download_url);
    if (!manifestResponse.ok) {
      throw new Error(`Impossible de télécharger le manifest (${manifestResponse.status}).`);
    }
    const manifest = await manifestResponse.json();
    const packageName = String(manifest.packageFile || resolvePackageFileName(server, version));
    const packageAsset = (release.assets || []).find((asset) => asset.name === packageName);
    if (!packageAsset?.browser_download_url) {
      throw new Error("L'archive de la dernière release GitHub est absente.");
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fablab-update-test-"));
    const archivePath = path.join(tempDir, "release.tar.gz");
    const archiveResponse = await fetch(packageAsset.browser_download_url);
    if (!archiveResponse.ok || !archiveResponse.body) {
      throw new Error(`Téléchargement impossible (${archiveResponse.status}).`);
    }
    await fs.writeFile(archivePath, Buffer.from(await archiveResponse.arrayBuffer()));
    const sha256 = await sha256OfFile(archivePath);
    await fs.rm(tempDir, { recursive: true, force: true });
    if (sha256.toLowerCase() !== String(manifest.sha256 || "").toLowerCase()) {
      throw new Error("Le SHA256 de l'archive GitHub ne correspond pas au manifest.");
    }

    console.log(JSON.stringify({ ok: true, version, packageSource: packageAsset.browser_download_url, sha256 }, null, 2));
    return;
  }

  const baseUrl = String(server.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("Aucune baseUrl n'est configuree dans update.config.json.");
  }

  const response = await fetch(`${baseUrl}/`);
  if (!response.ok) {
    throw new Error(`Impossible de lister les versions distantes (${response.status}).`);
  }

  const indexHtml = await response.text();
  const versions = extractDirectoryLinksFromIndex(indexHtml).filter(isVersionFolderName);
  if (versions.length === 0) {
    throw new Error("Aucune version exploitable n'a ete trouvee sur le serveur.");
  }

  versions.sort((left, right) => compareVersions(right, left));
  const version = versions[0];
  const releaseBaseUrl = joinUrl(baseUrl, version);
  const packageUrl = joinUrl(releaseBaseUrl, resolvePackageFileName(server, version));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fablab-update-test-"));
  const archivePath = path.join(tempDir, "release.tar.gz");

  const archiveResponse = await fetch(packageUrl);
  if (!archiveResponse.ok || !archiveResponse.body) {
    throw new Error(`Telechargement impossible (${archiveResponse.status}).`);
  }

  const arrayBuffer = await archiveResponse.arrayBuffer();
  await fs.writeFile(archivePath, Buffer.from(arrayBuffer));
  const stat = await fs.stat(archivePath);
  const sha256 = await sha256OfFile(archivePath);

  console.log(
    JSON.stringify(
      {
        ok: true,
        version,
        packageSource: packageUrl,
        downloadedBytes: stat.size,
        sha256
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
