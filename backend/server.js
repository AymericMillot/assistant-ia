import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import jwt from "jsonwebtoken";
import { Server as SocketIOServer } from "socket.io";
import { getSetting, initializeDatabase } from "./config/db.js";
import { synchronizeOwnerBootstrapPassword } from "./services/accessPasswordService.js";
import { logger, registerRealtimeEmitter } from "./config/logger.js";
import authRoutes from "./routes/auth.js";
import chatRoutes from "./routes/chat.js";
import adminRoutes from "./routes/admin.js";
import { syncFilesystemToDatabase } from "./services/fileService.js";
import { initializeQueueService, shutdownQueue } from "./services/queueService.js";
import {
  initializeSchedulerService,
  markInteractiveRequestFinished,
  markInteractiveRequestStarted,
  shutdownSchedulerService
} from "./services/schedulerService.js";
import { setSocketServer } from "./services/realtimeService.js";
import { getCurrentVersion } from "./services/appInfoService.js";
import { getPublicReleases } from "./services/updateService.js";
import { getBranding } from "./config/branding.js";
import { getActiveModelByRole } from "./services/ollamaService.js";
import { scheduleModelCatalogRefresh } from "./services/modelCatalogRefreshService.js";
import {
  createRateLimiter,
  enforceTrustedOrigin,
  isTrustedOrigin,
  securityHeaders
} from "./utils/security.js";

function resolveFrontendDistPath() {
  const candidates = [
    process.env.FRONTEND_DIST_DIR,
    "./public",
    "../frontend/dist"
  ]
    .filter(Boolean)
    .map((candidate) => path.resolve(process.cwd(), candidate));

  return (
    candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) ||
    candidates[0]
  );
}

function validateRuntimeConfiguration() {
  const requiredSecrets = ["JWT_SECRET", "CONFIG_ENCRYPTION_KEY"];
  const invalidSecrets = requiredSecrets.filter((key) => {
    const value = String(process.env[key] || "").trim();
    return value.length < 32 || /^(changeme|change_me)/i.test(value);
  });

  if (invalidSecrets.length > 0) {
    throw new Error(
      `Configuration non securisee : ${invalidSecrets.join(", ")} doit contenir un secret aleatoire d'au moins 32 caracteres. Relancez ./install.sh ou ./doctor.sh.`
    );
  }

  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT doit etre un entier compris entre 1 et 65535.");
  }
}

function resolveCorsOrigin(origin, callback) {
  // isTrustedOrigin couvre deja tous les cas legitimes : FRONTEND_ORIGIN/APP_ORIGIN
  // configures, localhost, et tout le reseau local sur le port de l'app - donc
  // aucune origine hors de cette liste ne doit recevoir de reponse avec credentials.
  if (!origin || isTrustedOrigin(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error("Origine de requete non autorisee."));
}

function getRequestHostname(req) {
  const trustProxy = req.app?.get("trust proxy");
  const forwardedHost = trustProxy
    ? String(req.headers["x-forwarded-host"] || "").split(",")[0].trim()
    : "";
  const hostHeader = forwardedHost || String(req.headers.host || "").trim();

  if (!hostHeader) {
    return "";
  }

  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return hostHeader.replace(/:\d+$/, "").toLowerCase();
  }
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isPrivateIpv4Host(hostname) {
  return /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/.test(
    hostname
  );
}

function isPrivateIpv6Host(hostname) {
  return hostname === "::1" || /^fc/i.test(hostname) || /^fd/i.test(hostname);
}

function isAllowedAdminHostname(hostname) {
  const adminAccessMode = String(process.env.ADMIN_ACCESS_MODE || "any")
    .trim()
    .toLowerCase();

  if (adminAccessMode === "any" || adminAccessMode === "public") {
    return true;
  }

  if (!hostname) {
    return false;
  }

  if (isLoopbackHostname(hostname) || isPrivateIpv4Host(hostname) || isPrivateIpv6Host(hostname)) {
    return true;
  }

  if (hostname.endsWith(".local")) {
    return true;
  }

  if (adminAccessMode === "trusted") {
    const configuredOrigins = [process.env.FRONTEND_ORIGIN, process.env.APP_ORIGIN]
      .filter(Boolean)
      .map((value) => String(value).trim())
      .filter(Boolean);

    for (const origin of configuredOrigins) {
      try {
        if (new URL(origin).hostname.toLowerCase() === hostname) {
          return true;
        }
      } catch {
        // Ignore malformed configured origins.
      }
    }
  }

  return false;
}

function isPrivateClientAddress(remoteAddress) {
  const normalized = String(remoteAddress || "").replace(/^::ffff:/i, "");

  return (
    isLoopbackHostname(normalized) ||
    isPrivateIpv4Host(normalized) ||
    isPrivateIpv6Host(normalized)
  );
}

function enforceLocalAdminAccess(req, res, next) {
  const hostname = getRequestHostname(req);

  // L'en-tête Host est choisi par le client : en mode restreint, on vérifie
  // aussi l'adresse IP réelle de la connexion pour empêcher tout contournement.
  const adminAccessMode = String(process.env.ADMIN_ACCESS_MODE || "any").trim().toLowerCase();
  const clientAddressOk =
    adminAccessMode === "any" ||
    adminAccessMode === "public" ||
    isPrivateClientAddress(req.socket?.remoteAddress);

  if (clientAddressOk && isAllowedAdminHostname(hostname)) {
    next();
    return;
  }

  const isApiRequest = String(req.originalUrl || req.url || "").startsWith("/api/");
  const message =
    "L'administration est accessible uniquement depuis le PC serveur ou un appareil du reseau local prive.";

  if (isApiRequest) {
    res.status(403).json({ message });
    return;
  }

  res.status(404).send("Introuvable.");
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
const server = http.createServer(app);
const frontendDistPath = resolveFrontendDistPath();
const frontendIndexPath = path.join(frontendDistPath, "index.html");
const hasBundledFrontend = fs.existsSync(frontendIndexPath);
const io = new SocketIOServer(server, {
  cors: {
    origin: resolveCorsOrigin,
    credentials: true
  }
});

io.use((socket, next) => {
  const rawCookie = String(socket.handshake.headers.cookie || "");
  const tokenPair = rawCookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("token="));

  if (!tokenPair) {
    next(new Error("Authentification requise."));
    return;
  }

  try {
    const token = decodeURIComponent(tokenPair.slice("token=".length));
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload?.role) {
      throw new Error("Session invalide.");
    }
    socket.user = payload;
    next();
  } catch {
    next(new Error("Session invalide ou expiree."));
  }
});

validateRuntimeConfiguration();
initializeDatabase();

// Synchronise la configuration locale définie dans .env sans jamais
// écrire de secret réel dans le code source versionné ni dans les journaux.
if (process.env.OWNER_BOOTSTRAP_PASSWORD) {
  const ownerSync = await synchronizeOwnerBootstrapPassword();
  logger.info("Configuration locale synchronisee depuis le fichier .env.", ownerSync);
}

await syncFilesystemToDatabase().catch((error) => {
  logger.error("Echec de la synchronisation initiale des documents.", {
    message: error.message,
    stack: error.stack
  });
});
initializeQueueService();
initializeSchedulerService();
scheduleModelCatalogRefresh();

setSocketServer(io);
registerRealtimeEmitter((eventName, payload) => {
  io.emit(eventName, payload);
});

io.on("connection", (socket) => {
  socket.on("register", ({ clientId }) => {
    if (clientId) {
      socket.join(clientId);
    }
  });
});

app.use(
  cors({
    origin: resolveCorsOrigin,
    credentials: true
  })
);
app.use(securityHeaders);
app.use(enforceTrustedOrigin);
app.use(
  "/api",
  createRateLimiter({
    windowMs: 60 * 1000,
    max: Number(process.env.API_RATE_LIMIT_PER_MINUTE || 240),
    keyPrefix: "api-global",
    message: "Trop de requetes en peu de temps. Reessayez dans une minute."
  })
);
app.use(
  "/api/auth",
  createRateLimiter({
    windowMs: 60 * 1000,
    max: Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE || 30),
    keyPrefix: "auth-global",
    message: "Trop de requetes d'authentification. Reessayez dans une minute."
  })
);
app.use(
  "/api/admin",
  createRateLimiter({
    windowMs: 60 * 1000,
    max: Number(process.env.ADMIN_RATE_LIMIT_PER_MINUTE || 180),
    keyPrefix: "admin-global",
    message: "Trop de requetes d'administration. Reessayez dans une minute."
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use((req, res, next) => {
  markInteractiveRequestStarted();

  let finished = false;
  const finalize = () => {
    if (finished) {
      return;
    }

    finished = true;
    markInteractiveRequestFinished();
  };

  res.on("finish", finalize);
  res.on("close", finalize);
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    version: getCurrentVersion()
  });
});

app.get("/api/branding", (_req, res) => {
  const branding = getBranding();
  res.json({
    projectName: branding.projectName,
    shortName: branding.shortName,
    welcomeMessage: branding.welcomeMessage,
    supportEmail: branding.supportEmail,
    supportEmailUrgent: branding.supportEmailUrgent,
    tabTitle: branding.tabTitle,
    faviconDataUrl: branding.faviconDataUrl,
    attachmentsEnabled: getSetting("attachmentsEnabled", "true") === "true",
    reasoningModelAvailable: Boolean(getActiveModelByRole("reasoning"))
  });
});

app.get("/api/releases", async (_req, res, next) => {
  try {
    const payload = await getPublicReleases();
    res.json(payload);
  } catch (error) {
    if (error?.code === "UPDATER_UNAVAILABLE") {
      return res.status(503).json({
        message: "Le service de mise a jour est temporairement indisponible.",
        releases: [],
        latestVersion: null
      });
    }

    next(error);
  }
});

app.use("/api/auth", enforceLocalAdminAccess, authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/admin", enforceLocalAdminAccess, adminRoutes);

if (hasBundledFrontend) {
  app.get(/^\/admin(?:\/.*)?$/, enforceLocalAdminAccess, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(frontendIndexPath);
  });
  app.use(
    express.static(frontendDistPath, {
      etag: true,
      maxAge: "1h",
      setHeaders: (res, filePath) => {
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
    })
  );
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(frontendIndexPath);
  });
}

app.use((error, _req, res, _next) => {
  logger.error("Erreur HTTP non geree.", {
    message: error.message,
    stack: error.stack
  });

  let statusCode = error.statusCode || 500;
  let message = error.message || "Requete invalide.";

  if (error?.name === "MulterError") {
    if (error.code === "LIMIT_FILE_SIZE") {
      statusCode = 413;
      const maxMegabytes = Math.max(
        1,
        Math.floor(Number(process.env.DOCUMENT_UPLOAD_MAX_BYTES || 100 * 1024 * 1024) / 1024 / 1024)
      );
      message = `Le fichier depasse la taille maximale autorisee de ${maxMegabytes} Mo.`;
    } else if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_PART_COUNT") {
      statusCode = 413;
      message = "Trop de fichiers ont ete envoyes en une seule fois.";
    } else {
      statusCode = 400;
      message = "Le televersement du fichier a echoue.";
    }
  }

  const isServerError = statusCode >= 500;

  res.status(statusCode).json({
    message: isServerError ? "Erreur interne du serveur." : message
  });
});

const port = Number(process.env.PORT || 3000);
server.keepAliveTimeout = Number(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS || 65000);
server.headersTimeout = Number(process.env.SERVER_HEADERS_TIMEOUT_MS || 70000);
server.requestTimeout = Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 0);
server.listen(port, "0.0.0.0", () => {
  logger.info("Serveur backend demarre.", {
    port,
    environment: process.env.NODE_ENV || "production",
    servesFrontend: hasBundledFrontend
  });
});

const shutdown = async () => {
  logger.info("Arret du serveur backend...");
  shutdownSchedulerService();
  await shutdownQueue();
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
