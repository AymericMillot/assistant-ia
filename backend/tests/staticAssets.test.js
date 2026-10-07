// Tests du service des fichiers du frontend : versions precompressees
// (brotli/gzip) choisies selon le navigateur et en-tetes de cache.
//
//   docker exec assistant-ia-backend npm test
//   (ou, en local : cd backend && npm test)
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, test } from "node:test";
import express from "express";
import { applyStaticCacheHeaders, createPrecompressedStaticMiddleware } from "../utils/staticAssets.js";

const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), "static-assets-test-"));
const script = "console.log('assistant');\n".repeat(200);
let server;
let baseUrl;

function request(urlPath, acceptEncoding) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${urlPath}`, { headers: { "Accept-Encoding": acceptEncoding } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ headers: res.headers, status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
  });
}

before(async () => {
  const assetsDir = path.join(distRoot, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "index-AbCd1234.js"), script);
  fs.writeFileSync(path.join(assetsDir, "index-AbCd1234.js.br"), zlib.brotliCompressSync(script));
  fs.writeFileSync(path.join(assetsDir, "index-AbCd1234.js.gz"), zlib.gzipSync(script));
  fs.writeFileSync(path.join(assetsDir, "theme.css"), "body{}");

  const app = express();
  app.use(createPrecompressedStaticMiddleware(distRoot));
  app.use(express.static(distRoot, { setHeaders: applyStaticCacheHeaders }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(distRoot, { recursive: true, force: true });
});

test("brotli est prefere quand le navigateur l'accepte", async () => {
  const response = await request("/assets/index-AbCd1234.js", "gzip, deflate, br");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], "br");
  assert.match(response.headers["content-type"], /javascript/);
  assert.match(response.headers["cache-control"], /immutable/);
  assert.match(response.headers.vary, /Accept-Encoding/);
  assert.equal(zlib.brotliDecompressSync(response.body).toString(), script);
});

test("gzip sert de repli", async () => {
  const response = await request("/assets/index-AbCd1234.js", "gzip");
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.equal(zlib.gunzipSync(response.body).toString(), script);
});

test("sans compression acceptee, le fichier d'origine est servi", async () => {
  const response = await request("/assets/index-AbCd1234.js", "identity");
  assert.equal(response.headers["content-encoding"], undefined);
  assert.match(response.headers.vary, /Accept-Encoding/);
  assert.equal(response.body.toString(), script);
});

test("un fichier sans version compressee est servi normalement", async () => {
  const response = await request("/assets/theme.css", "br");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], undefined);
  assert.equal(response.body.toString(), "body{}");
});
